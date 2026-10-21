import type { IDataObject, IExecuteFunctions, IHttpRequestMethods } from 'n8n-workflow';
import { jsonParse, NodeOperationError } from 'n8n-workflow';

import { API_ORIGIN } from '../../../credentials/KinescopeWorkspaceApi.credentials';
import type { Resource } from '../../../shared/spec';
import { apiPath, kinescopeRequest, readPages } from '../../../shared/transport';

/**
 * The escape hatch: any call to the Kinescope API, through the same token, rate
 * limit and error messages as the modelled operations.
 *
 * It exists so that a route this node does not model — playlists, live events,
 * analytics and the rest of the reference — never forces a bare HTTP Request
 * node, which the credential is deliberately kept out of.
 */
const METHODS: IHttpRequestMethods[] = ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'];

/** Methods whose request carries a body. Kinescope's playlist route deletes with one. */
const METHODS_WITH_BODY = ['DELETE', 'PATCH', 'POST', 'PUT'];

function readMethod(ctx: IExecuteFunctions, itemIndex: number): IHttpRequestMethods {
	const method = String(ctx.getNodeParameter('method', itemIndex, 'GET')).toUpperCase();
	if (!METHODS.includes(method as IHttpRequestMethods)) {
		throw new NodeOperationError(ctx.getNode(), `"${method}" is not a method this node sends`, {
			itemIndex,
			description: `Pick one of ${METHODS.join(', ')}.`,
		});
	}
	return method as IHttpRequestMethods;
}

/**
 * The path, checked before it is sent. A full URL is refused rather than
 * stripped: the request always goes to the Kinescope API with the token
 * attached, and one that looks like it points elsewhere is a mistake worth stopping.
 */
function readPath(ctx: IExecuteFunctions, itemIndex: number): string {
	const path = String(ctx.getNodeParameter('path', itemIndex, '') ?? '').trim();

	if (path === '') {
		throw new NodeOperationError(ctx.getNode(), 'A custom request needs a path', {
			itemIndex,
			description: 'For example /v1/playlists.',
		});
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('//')) {
		throw new NodeOperationError(ctx.getNode(), 'The path must not be a full URL', {
			itemIndex,
			description: `Keep only the path, as in /v1/playlists. Every request goes to ${API_ORIGIN}; this node cannot call another host, the uploader included.`,
		});
	}

	return apiPath(path);
}

function readQuery(ctx: IExecuteFunctions, itemIndex: number): IDataObject {
	const ui = ctx.getNodeParameter('queryParameters', itemIndex, {}) as IDataObject;
	const qs: IDataObject = {};
	for (const row of (ui.parameter ?? []) as IDataObject[]) {
		const name = String(row.name ?? '').trim();
		if (name === '') continue;
		// status[]=a&status[]=b: a repeated name collects its values.
		const key = name.replace(/\[\]$/, '');
		const previous = qs[key];
		if (name.endsWith('[]') || previous !== undefined) {
			qs[key] = [
				...(Array.isArray(previous) ? previous : previous === undefined ? [] : [previous]),
				row.value,
			] as IDataObject[];
		} else {
			qs[key] = row.value;
		}
	}
	return qs;
}

function readBody(ctx: IExecuteFunctions, itemIndex: number, method: IHttpRequestMethods): unknown {
	if (!METHODS_WITH_BODY.includes(method)) return undefined;

	const raw = ctx.getNodeParameter('body', itemIndex, '') as unknown;
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw === 'object') return raw;

	const value = String(raw).trim();
	if (value === '') return undefined;

	try {
		return jsonParse<unknown>(value);
	} catch (error) {
		throw new NodeOperationError(ctx.getNode(), 'The body is not valid JSON', {
			itemIndex,
			description: `${error instanceof Error ? error.message : String(error)}. Kinescope takes JSON; an expression returning an object or an array works too.`,
		});
	}
}

/** One output row per list entry in Automatic mode; the body as it came otherwise. */
function toRows(body: unknown, format: string): IDataObject[] {
	if (body === undefined || body === null || body === '') return [{ success: true }];
	if (typeof body !== 'object') return [{ data: body as string }];

	if (format === 'auto') {
		const record = body as IDataObject;
		const data = Array.isArray(body) ? body : record.data;
		if (Array.isArray(data)) {
			return (data as unknown[]).map((row) =>
				row !== null && typeof row === 'object' && !Array.isArray(row)
					? (row as IDataObject)
					: { value: row as string },
			);
		}
		if (data !== null && typeof data === 'object') return [data as IDataObject];
	}

	return Array.isArray(body) ? [{ data: body as IDataObject[] }] : [body as IDataObject];
}

async function request(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const method = readMethod(this, itemIndex);
	const path = readPath(this, itemIndex);
	const qs = readQuery(this, itemIndex);
	const body = readBody(this, itemIndex, method);
	const format = String(this.getNodeParameter('responseFormat', itemIndex, 'auto'));

	// Kinescope has no idempotency key: a POST that timed out may already have
	// created its object, so only the other methods are repeated.
	const retry = method !== 'POST';

	const followPages =
		method === 'GET' && (this.getNodeParameter('followPages', itemIndex, false) as boolean);
	if (followPages) return await readPages.call(this, path, qs, undefined, itemIndex);

	return toRows(
		await kinescopeRequest.call(this, method, path, { qs, body, itemIndex, retry }),
		format,
	);
}

export const customRequestResource: Resource = {
	value: 'customRequest',
	name: 'Custom Request',
	description:
		'Any Kinescope API call the other operations do not cover, with the same token and rate limit',
	operations: [
		{
			value: 'request',
			name: 'Request',
			action: 'Make a custom API call',
			description:
				'Send any request to the Kinescope API — playlists, live events, analytics, players and every other route of its reference — with authentication, the rate limit and error messages handled as everywhere else',
			properties: [
				{
					displayName: 'Method',
					name: 'method',
					type: 'options',
					default: 'GET',
					options: METHODS.map((m) => ({ name: m, value: m })),
				},
				{
					displayName: 'Path',
					name: 'path',
					type: 'string',
					required: true,
					default: '',
					placeholder: '/v1/playlists',
					description: `Path on ${API_ORIGIN} with its version, as in the Kinescope API reference`,
				},
				{
					displayName: 'Query Parameters',
					name: 'queryParameters',
					type: 'fixedCollection',
					typeOptions: { multipleValues: true },
					placeholder: 'Add Query Parameter',
					default: {},
					options: [
						{
							name: 'parameter',
							displayName: 'Parameter',
							values: [
								{
									displayName: 'Name',
									name: 'name',
									type: 'string',
									default: '',
									placeholder: 'status[]',
									description:
										'A name ending in [] is sent as a list, as Kinescope’s filters want: add one row per value',
								},
								{ displayName: 'Value', name: 'value', type: 'string', default: '' },
							],
						},
					],
				},
				{
					displayName: 'Body',
					name: 'body',
					type: 'json',
					default: '',
					displayOptions: { show: { method: METHODS_WITH_BODY } },
					description: 'JSON sent exactly as written. Leave empty for no body.',
				},
				{
					displayName: 'Follow Pages',
					name: 'followPages',
					type: 'boolean',
					default: false,
					displayOptions: { show: { method: ['GET'] } },
					description:
						'Whether to read every page of a list route (page = 1, 2, 3… with 100 rows each) up to the total Kinescope reports. Each row becomes an item.',
				},
				{
					displayName: 'Response Format',
					name: 'responseFormat',
					type: 'options',
					default: 'auto',
					displayOptions: { show: { followPages: [false] } },
					options: [
						{
							name: 'Automatic',
							value: 'auto',
							description:
								'One item per row when data is a list, the data object when it is one, the answer as it came otherwise',
						},
						{
							name: 'Whole Response',
							value: 'whole',
							description: 'One item holding the answer as Kinescope sent it, meta included',
						},
					],
				},
			],
			execute: request,
		},
	],
};
