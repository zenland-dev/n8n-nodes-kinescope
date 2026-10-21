import { createHash } from 'node:crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, randomInt, sleep } from 'n8n-workflow';

import { API_ORIGIN, normalizeApiToken } from '../credentials/KinescopeWorkspaceApi.credentials';
import { readFailure, toNodeApiError } from './errors';
import { acquireSlot } from './rateLimiter';

/** Every context these nodes make API calls from. */
export type KinescopeContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

export const CREDENTIAL = 'kinescopeWorkspaceApi';

/**
 * Kinescope publishes 10 requests a second and 300 a minute per token. Its own
 * reference says the figures do not hold in practice, but they are the only
 * ones published, so the nodes stay under the per-second one.
 */
const REQUESTS_PER_SECOND = 10;

/** How long to wait after a 429: Kinescope sends no Retry-After and advises at least five seconds. */
const RATE_LIMIT_PAUSE_MS = 5000;

/** The page size the list routes take at most. */
export const PAGE_SIZE = 100;

/** Stops a Return All run that never reaches the total. 1,000 pages is 100,000 rows. */
const MAX_PAGES = 1000;

export interface KinescopeRequestOptions {
	qs?: IDataObject;
	body?: unknown;
	/** Item the call is made for, so an error points at it. */
	itemIndex?: number;
	/**
	 * Whether a server error or a dropped connection may be repeated. Kinescope
	 * supports no idempotency key, so a POST that timed out may already have
	 * created its object: creating calls pass false.
	 */
	retry?: boolean;
	/** Total attempts, including the first one. */
	maxAttempts?: number;
	/** Read the answer as text rather than JSON, for the transcript file. */
	text?: boolean;
	/** Send to the upload host rather than the API host. */
	uploader?: boolean;
	/** Extra request headers, e.g. the X-Video-* metadata of an upload. */
	headers?: Record<string, string>;
	/** A body sent as bytes, e.g. a multipart form; the answer is still read as JSON. */
	rawBody?: { data: Buffer; contentType: string };
}

/** The host uploads go to. Like the API host, it is fixed: nothing a user types can change it. */
export const UPLOADER_ORIGIN = 'https://uploader.kinescope.io';

/** A short, stable name for a token, for caches and the rate limiter. Never the token itself. */
export function tokenFingerprint(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** The fingerprint of the token in the credential. */
export async function workspaceKey(this: KinescopeContext): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL);
	return tokenFingerprint(normalizeApiToken(credentials.apiToken));
}

function backoffDelay(attempt: number): number {
	return Math.min(2 ** (attempt - 1) * 1000, 8000) + randomInt(250);
}

function isEmpty(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** A path as it is sent: always with a leading slash, under the version it names. */
export function apiPath(path: string): string {
	const trimmed = path.trim();
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** An ID as a path segment. */
export function segment(id: string): string {
	return encodeURIComponent(id.trim());
}

/**
 * One call to the Kinescope API, rate-limited and retried where that is safe.
 *
 * 429 is repeated for every route after a pause. Server errors and network
 * failures are repeated unless `retry` is false. Anything else becomes a
 * NodeApiError carrying Kinescope's code and, where there is one, advice.
 *
 * Returns the body as Kinescope sent it, normally `{ data }` or `{ meta, data }`.
 */
export async function kinescopeRequest(
	this: KinescopeContext,
	method: IHttpRequestMethods,
	path: string,
	options: KinescopeRequestOptions = {},
): Promise<unknown> {
	const credentials = await this.getCredentials(CREDENTIAL);
	const token = normalizeApiToken(credentials.apiToken);

	if (token === '') {
		throw new NodeOperationError(this.getNode(), 'The Kinescope credential has no API token', {
			description: 'Open the credential and paste a token from Settings → API tokens in Kinescope.',
			itemIndex: options.itemIndex,
		});
	}

	const limiterKey = `kinescope:${tokenFingerprint(token)}`;
	const route = apiPath(path);
	const label = `${method} ${route}`;

	// Bytes go out unencoded, so the answer comes back as text and is parsed below.
	const asText = options.text === true || options.rawBody !== undefined;
	const request: IHttpRequestOptions = {
		method,
		url: `${options.uploader === true ? UPLOADER_ORIGIN : API_ORIGIN}${route}`,
		json: !asText,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		// Kinescope's list filters are written status[]=a&status[]=b.
		arrayFormat: 'brackets',
		headers: {
			Accept: options.text === true ? 'text/plain, application/json' : 'application/json',
			...(options.headers ?? {}),
		},
	};
	if (asText) request.encoding = 'text';
	if (options.rawBody !== undefined) {
		request.body = options.rawBody.data;
		(request.headers as IDataObject)['Content-Type'] = options.rawBody.contentType;
	}
	if (!isEmpty(options.qs)) request.qs = options.qs;
	if (options.body !== undefined) request.body = options.body as IDataObject;

	const retry = options.retry !== false;
	const maxAttempts = options.maxAttempts ?? 4;

	for (let attempt = 1; ; attempt++) {
		// The limit is the token's, so every workflow on this instance using the same
		// token draws from one window.
		await acquireSlot(limiterKey, REQUESTS_PER_SECOND, 1000);

		let response: IN8nHttpFullResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				CREDENTIAL,
				request,
			)) as IN8nHttpFullResponse;
		} catch (error) {
			if (retry && attempt < maxAttempts) {
				await sleep(backoffDelay(attempt));
				continue;
			}
			throw new NodeApiError(this.getNode(), { message: 'Network error' } as JsonObject, {
				message: `Kinescope ${label}: the API could not be reached`,
				description: error instanceof Error ? error.message : undefined,
				itemIndex: options.itemIndex,
			});
		}

		const status = Number(response.statusCode) || 0;
		let body: unknown = response.body;
		// An error answer to a text request still comes as JSON text, and so does every
		// answer to a request whose body went out as bytes.
		if (
			typeof body === 'string' &&
			((options.text === true && status >= 400) || options.rawBody !== undefined)
		) {
			try {
				body = JSON.parse(body) as unknown;
			} catch {
				// Not JSON after all; the text itself becomes the message.
			}
		}
		const failure = readFailure(body, status);

		if (failure === undefined) return body;

		const retryable = status === 429 || (retry && status >= 500);
		if (retryable && attempt < maxAttempts) {
			await sleep(status === 429 ? RATE_LIMIT_PAUSE_MS + randomInt(500) : backoffDelay(attempt));
			continue;
		}

		throw toNodeApiError(this.getNode(), label, failure, body, options.itemIndex);
	}
}

/** The `data` object of an answer, or the answer itself when it has none. */
export function dataOf(body: unknown): IDataObject {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
	const record = body as IDataObject;
	const data = record.data;
	if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data as IDataObject;
	return record;
}

/** The rows of a list answer: `data` when it is an array. */
export function asList(body: unknown): IDataObject[] {
	if (Array.isArray(body)) return body as IDataObject[];
	if (body !== null && typeof body === 'object') {
		const data = (body as IDataObject).data;
		if (Array.isArray(data)) return data as IDataObject[];
	}
	return [];
}

/** The total a list answer reports in meta.pagination, or undefined. */
function totalOf(body: unknown): number | undefined {
	const meta = (body as IDataObject | undefined)?.meta as IDataObject | undefined;
	const total = Number((meta?.pagination as IDataObject | undefined)?.total);
	return Number.isFinite(total) ? total : undefined;
}

/**
 * Reads a list route page by page.
 *
 * Every list answers `{ meta: { pagination: { page, per_page, total } }, data }`
 * and takes `page` from 1 and `per_page`. A short page is the end; so is
 * reaching `total`. `limit` stops early and shrinks the last page.
 */
export async function readPages(
	this: KinescopeContext,
	path: string,
	qs: IDataObject,
	limit: number | undefined,
	itemIndex?: number,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];

	for (let page = 1; page <= MAX_PAGES; page++) {
		const perPage = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - rows.length);
		const body = await kinescopeRequest.call(this, 'GET', path, {
			qs: { ...qs, page, per_page: perPage },
			itemIndex,
		});
		const list = asList(body);
		rows.push(...list);

		if (limit !== undefined && rows.length >= limit) return rows.slice(0, limit);
		if (list.length < perPage) return rows;
		const total = totalOf(body);
		if (total !== undefined && rows.length >= total) return rows;
	}

	return rows;
}
