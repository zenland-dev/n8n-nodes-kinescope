import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { EVENT_OPTIONS } from '../../../shared/events';
import {
	compact,
	requiredText,
	returnAllProperties,
	text,
	wantedRows,
} from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages } from '../../../shared/transport';
import { idProperty, idSegment } from '../props';

/**
 * Kinescope returns the Basic Auth password of a webhook in plain text, though
 * its reference shows it redacted. It is left out unless the user asks.
 */
function shown(webhook: IDataObject, withPassword: boolean): IDataObject {
	if (withPassword) return webhook;
	const rest = { ...webhook };
	delete rest.password;
	return rest;
}

const includePassword = {
	displayName: 'Include Password',
	name: 'includePassword',
	type: 'boolean' as const,
	default: false,
	description: 'Whether to output the Basic Auth password Kinescope stores for the endpoint',
};

const webhookId = idProperty(
	'Webhook ID',
	'webhookId',
	'The ID of the webhook, as Get Many returns it',
);

function eventsOf(ctx: IExecuteFunctions, itemIndex: number, name: string): string[] {
	return ((ctx.getNodeParameter(name, itemIndex, []) as string[]) ?? []).filter((e) => e !== '');
}

/** Finds one webhook: the route has no single-webhook read, so the list is searched. */
async function findWebhook(
	this: IExecuteFunctions,
	id: string,
	itemIndex: number,
): Promise<IDataObject> {
	const all = await readPages.call(this, '/v1/webhooks', {}, undefined, itemIndex);
	const found = all.find((webhook) => String(webhook.id) === id);
	if (found === undefined) {
		throw new NodeOperationError(this.getNode(), `No webhook ${id} in this workspace`, {
			itemIndex,
			description: 'Take the ID from Webhook → Get Many.',
		});
	}
	return found;
}

export const webhookResource: Resource = {
	value: 'webhook',
	name: 'Webhook',
	description: 'Subscriptions that make Kinescope post its events to an address',
	operations: [
		{
			value: 'create',
			name: 'Create',
			action: 'Create a webhook',
			description:
				'Make Kinescope post the chosen events to an address. To start a workflow on them, the Kinescope Trigger node does this by itself.',
			properties: [
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					required: true,
					default: '',
					placeholder: 'CRM sync',
				},
				{
					displayName: 'Endpoint URL',
					name: 'endpoint',
					type: 'string',
					required: true,
					default: '',
					placeholder: 'https://example.com/kinescope',
					description: 'Where Kinescope posts the events, as JSON',
				},
				{
					displayName: 'Events',
					name: 'events',
					type: 'multiOptions',
					required: true,
					default: ['media.update.status'],
					options: EVENT_OPTIONS,
				},
				{
					displayName: 'Additional Fields',
					name: 'additionalFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{
							displayName: 'Login',
							name: 'login',
							type: 'string',
							default: '',
							description:
								'Basic Auth login Kinescope sends to the endpoint. Kinescope does not sign deliveries; this is the only way the endpoint can tell them apart.',
						},
						{
							displayName: 'Password',
							name: 'password',
							type: 'string',
							typeOptions: { password: true },
							default: '',
							description:
								'Basic Auth password for the endpoint. Never a Kinescope account password.',
						},
					],
				},
			],
			async execute(itemIndex) {
				const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
				const body = {
					name: requiredText(this, 'name', itemIndex, 'Name'),
					endpoint: requiredText(this, 'endpoint', itemIndex, 'Endpoint URL'),
					login: String(fields.login ?? ''),
					password: String(fields.password ?? ''),
					events: eventsOf(this, itemIndex, 'events'),
				};
				const created = dataOf(
					await kinescopeRequest.call(this, 'POST', '/v1/webhooks', {
						body,
						itemIndex,
						retry: false,
					}),
				);
				return shown(created, false);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many webhooks',
			description: 'List the webhooks of the workspace with their addresses and events',
			properties: [...returnAllProperties('webhooks'), includePassword],
			async execute(itemIndex) {
				const withPassword = this.getNodeParameter('includePassword', itemIndex, false) as boolean;
				const rows = await readPages.call(
					this,
					'/v1/webhooks',
					{},
					wantedRows(this, itemIndex),
					itemIndex,
				);
				return rows.map((row) => shown(row, withPassword));
			},
		},
		{
			value: 'update',
			name: 'Update',
			action: 'Update a webhook',
			description:
				'Change the name, address, credentials or events of a webhook. Fields left out keep their values.',
			properties: [
				webhookId,
				{
					displayName: 'Update Fields',
					name: 'updateFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{ displayName: 'Endpoint URL', name: 'endpoint', type: 'string', default: '' },
						{
							displayName: 'Events',
							name: 'events',
							type: 'multiOptions',
							default: [],
							options: EVENT_OPTIONS,
							description: 'Replaces the list of events',
						},
						{ displayName: 'Login', name: 'login', type: 'string', default: '' },
						{ displayName: 'Name', name: 'name', type: 'string', default: '' },
						{
							displayName: 'Password',
							name: 'password',
							type: 'string',
							typeOptions: { password: true },
							default: '',
						},
					],
				},
			],
			async execute(itemIndex) {
				const id = requiredText(this, 'webhookId', itemIndex, 'Webhook ID');
				const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
				// The route replaces the whole webhook and refuses an empty endpoint or
				// event list, so the current values fill whatever is not being changed.
				const current = await findWebhook.call(this, id, itemIndex);
				const changes = compact({
					name: String(fields.name ?? '').trim(),
					endpoint: String(fields.endpoint ?? '').trim(),
					login: fields.login as string | undefined,
					password: fields.password as string | undefined,
					events: fields.events as string[] | undefined,
				});
				const body = {
					name: current.name,
					endpoint: current.endpoint,
					login: current.login ?? '',
					password: current.password ?? '',
					events: current.events,
					...changes,
				};
				const updated = dataOf(
					await kinescopeRequest.call(
						this,
						'PUT',
						`/v1/webhooks/${idSegment(this, 'webhookId', itemIndex, 'Webhook ID')}`,
						{
							body,
							itemIndex,
						},
					),
				);
				return shown(updated, false);
			},
		},
		{
			value: 'delete',
			name: 'Delete',
			action: 'Delete a webhook',
			description: 'Stop Kinescope posting to this webhook',
			properties: [webhookId],
			async execute(itemIndex) {
				await kinescopeRequest.call(
					this,
					'DELETE',
					`/v1/webhooks/${idSegment(this, 'webhookId', itemIndex, 'Webhook ID')}`,
					{ itemIndex },
				);
				return { success: true, id: text(this, 'webhookId', itemIndex) };
			},
		},
	],
};
