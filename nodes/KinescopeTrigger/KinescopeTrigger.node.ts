import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { normalizeApiToken } from '../../credentials/KinescopeWorkspaceApi.credentials';
import { EVENT_OPTIONS, isSpeakEvent } from '../../shared/events';
import { idList } from '../../shared/params';
import { CREDENTIAL, dataOf, kinescopeRequest, readPages, segment } from '../../shared/transport';

/** Addresses Kinescope cannot reach from its own servers. */
const UNREACHABLE_HOST = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i;

/** The Basic Auth login this node registers. The password is what keeps others out. */
const LOGIN = 'n8n';

type Context = IHookFunctions | IWebhookFunctions;

/** Compares two secrets without leaking their contents through timing. */
function secretMatches(expected: string, received: string): boolean {
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(received, 'utf8');
	if (a.length === 0 || a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * The Basic Auth password registered with the webhook.
 *
 * Kinescope signs nothing it posts; HTTP Basic credentials set on the webhook
 * are the only thing a delivery carries that a stranger would not know. The
 * password is derived from the token and the node's webhook ID rather than
 * stored, so the test and production registrations of one node share it and
 * nothing has to survive between activation and delivery.
 */
async function deliveryPassword(this: Context): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL);
	const node = this.getNode();
	return createHmac('sha256', normalizeApiToken(credentials.apiToken))
		.update(`kinescope-trigger:${node.webhookId ?? node.id}`)
		.digest('hex')
		.slice(0, 32);
}

/** The address Kinescope is told to post to. */
function destination(this: IHookFunctions): string {
	const url = this.getNodeWebhookUrl('default');

	if (url === undefined || url === '') {
		throw new NodeOperationError(this.getNode(), 'This node has no webhook URL yet', {
			description: 'Save the workflow, then activate it so n8n can give Kinescope an address.',
		});
	}

	if (UNREACHABLE_HOST.test(url)) {
		throw new NodeOperationError(this.getNode(), `Kinescope cannot reach ${url}`, {
			description:
				'Webhooks come from Kinescope’s servers, so this n8n instance needs an address reachable from the internet. Set WEBHOOK_URL to the public address, or put a tunnel in front of n8n.',
		});
	}

	return url;
}

function selectedEvents(this: Context): string[] {
	return (this.getNodeParameter('events', []) as string[]) ?? [];
}

function registersItself(this: Context): boolean {
	return this.getNodeParameter('registration', 'automatic') === 'automatic';
}

function sameEvents(a: unknown, b: string[]): boolean {
	const left = new Set(Array.isArray(a) ? a.map(String) : []);
	return left.size === new Set(b).size && b.every((event) => left.has(event));
}

/** The webhooks of the workspace that post to `endpoint`. */
async function webhooksTo(this: IHookFunctions, endpoint: string): Promise<IDataObject[]> {
	const all = await readPages.call(this, '/v1/webhooks', {}, undefined);
	return all.filter((webhook) => String(webhook.endpoint ?? '') === endpoint);
}

function webhookName(this: IHookFunctions): string {
	const workflow = this.getWorkflow();
	const name = `n8n: ${workflow.name ?? workflow.id ?? ''}`.trim();
	return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

/** The credentials out of an `Authorization: Basic …` header, or undefined. */
function basicCredentials(header: unknown): { login: string; password: string } | undefined {
	const match = /^Basic\s+(.+)$/i.exec(String(header ?? '').trim());
	if (match === null) return undefined;
	const decoded = Buffer.from(match[1], 'base64').toString('utf8');
	const colon = decoded.indexOf(':');
	if (colon < 0) return undefined;
	return { login: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export class KinescopeTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Kinescope Trigger',
		name: 'kinescopeTrigger',
		// The same drawing in both themes: the mark sits on its own orange disc.
		icon: { light: 'file:../../icons/kinescope.svg', dark: 'file:../../icons/kinescope.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{ $parameter["events"].join(", ") }}',
		description:
			'Starts a workflow when a Kinescope video is ready, a live stream changes state, or a Speak meeting or its recording starts and ends',
		defaults: { name: 'Kinescope Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['media.update.status'],
				options: EVENT_OPTIONS,
				description:
					'What starts the workflow. A Speak meeting recording arrives as Media: Status Updated once its video is processed.',
			},
			{
				displayName: 'Registration',
				name: 'registration',
				type: 'options',
				noDataExpression: true,
				default: 'automatic',
				options: [
					{
						name: 'Automatic',
						value: 'automatic',
						description:
							'Create a Kinescope webhook to this node when the workflow is activated and delete it when it is deactivated; refuse deliveries without its Basic Auth password',
					},
					{
						name: 'Manual',
						value: 'manual',
						description:
							'Leave Kinescope’s webhooks alone. You point a webhook at this node yourself; deliveries are not checked.',
					},
				],
			},
			{
				displayName:
					'Create a webhook to the Production URL above yourself, for example with the Webhook → Create operation of the Kinescope node, with the events selected here.',
				name: 'manualNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { registration: ['manual'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Room IDs',
						name: 'roomIds',
						type: 'string',
						default: '',
						placeholder: '0f8c3a52-6b1e-4c2d-9a47-3e5b8d1f2c60',
						description:
							'Only Speak events of these rooms: a comma-separated list or an array. Other events are not affected.',
					},
					{
						displayName: 'Video Statuses',
						name: 'videoStatuses',
						type: 'multiOptions',
						default: [],
						options: [
							{ name: 'Aborted', value: 'aborted' },
							{ name: 'Done', value: 'done' },
							{ name: 'Error', value: 'error' },
							{ name: 'Pending', value: 'pending' },
							{ name: 'Pre-Processing', value: 'pre-processing' },
							{ name: 'Processing', value: 'processing' },
							{ name: 'Suspended', value: 'suspended' },
							{ name: 'Uploading', value: 'uploading' },
						],
						description:
							'Only Media: Status Updated events with these statuses, e.g. Done to act once a video can be downloaded. Empty passes all.',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				// On Manual there is nothing to register, and n8n must not try.
				if (!registersItself.call(this)) return true;

				const events = selectedEvents.call(this);
				const existing = (await webhooksTo.call(this, destination.call(this))).find((webhook) =>
					sameEvents(webhook.events, events),
				);
				if (existing === undefined) return false;

				this.getWorkflowStaticData('node').webhookId = existing.id;
				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				if (!registersItself.call(this)) return true;

				const events = selectedEvents.call(this);
				if (events.length === 0) {
					throw new NodeOperationError(this.getNode(), 'No events are selected', {
						description: 'Pick at least one entry under Events.',
					});
				}

				const endpoint = destination.call(this);
				const body = {
					name: webhookName.call(this),
					endpoint,
					login: LOGIN,
					password: await deliveryPassword.call(this),
					events,
				};

				// A webhook to this address left over from an earlier activation is reused
				// rather than duplicated, so Kinescope never posts each event twice.
				const leftover = (await webhooksTo.call(this, endpoint))[0];
				const answer = leftover
					? await kinescopeRequest.call(
							this,
							'PUT',
							`/v1/webhooks/${segment(String(leftover.id))}`,
							{ body },
						)
					: await kinescopeRequest.call(this, 'POST', '/v1/webhooks', { body, retry: false });

				this.getWorkflowStaticData('node').webhookId = dataOf(answer).id;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				if (!registersItself.call(this)) return true;

				const staticData = this.getWorkflowStaticData('node');
				const remembered = String(staticData.webhookId ?? '');
				delete staticData.webhookId;

				// Deactivation must not fail over Kinescope being unreachable or the token
				// having been revoked; the log says why the webhook was left in place.
				try {
					const ids = new Set<string>(remembered === '' ? [] : [remembered]);
					for (const webhook of await webhooksTo.call(this, destination.call(this))) {
						ids.add(String(webhook.id));
					}
					for (const id of ids) {
						await kinescopeRequest.call(this, 'DELETE', `/v1/webhooks/${segment(id)}`, {
							maxAttempts: 2,
						});
					}
				} catch (error) {
					this.logger.warn(
						`Kinescope Trigger could not delete its webhook: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const receivedAt = new Date().toISOString();

		if (registersItself.call(this)) {
			const given = basicCredentials(this.getHeaderData().authorization);
			if (
				given === undefined ||
				given.login !== LOGIN ||
				!secretMatches(await deliveryPassword.call(this), given.password)
			) {
				this.getResponseObject()
					.status(401)
					.json({ error: 'The delivery lacks the credentials this workflow registered.' });
				return { noWebhookResponse: true };
			}
		}

		const body = this.getBodyData();
		const event = String(body.event ?? '');
		const data =
			body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data)
				? (body.data as IDataObject)
				: {};

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const roomIds = idList(options.roomIds);
		const statuses = (options.videoStatuses ?? []) as string[];

		const wanted =
			selectedEvents.call(this).includes(event) &&
			(!isSpeakEvent(event) ||
				roomIds.length === 0 ||
				roomIds.includes(String(data.room_id ?? ''))) &&
			(event !== 'media.update.status' ||
				statuses.length === 0 ||
				statuses.includes(String(data.status ?? '')));

		// A delivery this workflow does not want is still acknowledged.
		if (!wanted) return { webhookResponse: 'OK' };

		// Kinescope's events carry no time of their own; when n8n received one is the
		// closest there is, e.g. for how long a meeting lasted.
		return { workflowData: [[{ json: { event, receivedAt, ...data } }]] };
	}
}
