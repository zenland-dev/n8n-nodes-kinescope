import type { IDataObject, INode, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { SPEAK_EVENTS_REFUSED } from './events';

/**
 * What a catch block rethrows. Errors from the transport and from parameter reading
 * are already n8n errors carrying a message the user can act on, and pass through
 * untouched; anything else is wrapped so n8n can show it against the node.
 */
export function asNodeError(
	node: INode,
	error: unknown,
	itemIndex?: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeOperationError(node, error instanceof Error ? error : String(error), {
		itemIndex,
	});
}

/** A Kinescope failure, read from the body and the status. */
export interface KinescopeFailure {
	/** Kinescope's numeric code, e.g. 400404; 0 when the body names none. */
	code: number;
	/** Kinescope's short English text; not stable, so never branched on. */
	message: string;
	/** Extra context Kinescope sometimes adds: a parse position, the rejected value. */
	detail: string;
	/** Per-field breakdown of a validation failure. */
	invalidParams: IDataObject[];
	status: number;
}

/**
 * Reads a failure out of a response, or returns undefined for a success.
 *
 * Every Kinescope error is `{ error: { code, message, detail?, invalid_params? } }`
 * with a 4xx or 5xx status. A missing object answers 404 with code 400404, a
 * validation failure 400 with 400400.
 */
export function readFailure(body: unknown, status: number): KinescopeFailure | undefined {
	if (status >= 200 && status < 300) return undefined;

	const object =
		body !== null && typeof body === 'object' && !Array.isArray(body)
			? (body as IDataObject)
			: undefined;
	const error =
		object?.error !== null && typeof object?.error === 'object'
			? (object.error as IDataObject)
			: {};

	return {
		code: Number(error.code) || 0,
		message: String(error.message ?? (typeof body === 'string' ? body : '')).trim(),
		detail: String(error.detail ?? '').trim(),
		invalidParams: Array.isArray(error.invalid_params)
			? (error.invalid_params as IDataObject[])
			: [],
		status,
	};
}

/** What to tell a person, per Kinescope code. Codes not listed fall back to the status. */
const HINTS: Record<number, string> = {
	100101: 'The request reached Kinescope without a token. Open the credential and paste the token.',
	400216:
		'Kinescope cannot sort by this field. Sort Order takes field.direction pairs such as created_at.desc.',
	400289: 'A Speak room holds at most 15 restream destinations.',
	400301:
		'Kinescope could not read the ID. It must be a UUID as Kinescope returns it, without spaces or quotes.',
	400302:
		'Kinescope could not read the ID. It must be a UUID as Kinescope returns it, without spaces or quotes.',
	400315:
		'A key with this Signing Key ID is registered already. Give the credential another Signing Key ID, or delete the old key with Signing Key → Delete first.',
	400404:
		'Nothing with this ID exists in the workspace of this token. A participant, call or restream is looked up only inside the room you name.',
	404404:
		'Nothing with this ID exists in the workspace of this token. A restream is looked up only inside the room you name.',
	409293:
		'The transcript of this call is in a state that does not allow this yet. Try again later.',
	409298:
		'This restream destination is live right now and cannot be changed. Stop it in the room first.',
	422100:
		'The transcript is not ready yet. Check its status with Call → Get Transcript and download it once the status is done.',
};

/** What to tell a person when the code says nothing more, per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
	401: 'Kinescope did not accept the token. It may be revoked, or issued in another workspace.',
	402: 'The plan or balance of the workspace does not cover this operation.',
	403: 'The token is valid but lacks permission for this operation. Issue a token with the read, write or delete permission it needs.',
	404: 'Nothing with this ID exists in the workspace of this token.',
	413: 'The request is larger than Kinescope accepts (10 MB).',
	429: 'Kinescope refused the call for its rate limit. The nodes waited and retried; lower the number of parallel executions using this token.',
};

/** The validation breakdown as one line a person can read, or undefined. */
function describeInvalid(params: IDataObject[]): string | undefined {
	const parts = params
		.map((entry) => {
			const name = String(entry.name ?? '')
				.trim()
				.replace(/\[\d+\]/g, '[]');
			const text = String(entry.message ?? entry.reason ?? '').trim();
			if (name === '' && text === '') return '';
			return name === '' ? text : `${name}: ${text || 'invalid'}`;
		})
		.filter((part) => part !== '');
	// A refused list repeats the same message once per entry.
	const unique = [...new Set(parts)];
	return unique.length > 0 ? `Kinescope points at ${unique.join('; ')}.` : undefined;
}

/** Turns a Kinescope failure into the error n8n shows, with advice where there is any. */
export function toNodeApiError(
	node: INode,
	label: string,
	failure: KinescopeFailure,
	body: unknown,
	itemIndex?: number,
): NodeApiError {
	const text = failure.message !== '' ? failure.message : `HTTP ${failure.status}`;
	const message = failure.code !== 0 ? `${text} [${failure.code}]` : text;

	// A webhook subscription naming an event the route does not take: so far, the
	// Speak events, which Kinescope documents but has been seen to refuse.
	const refusedEvent = failure.invalidParams.some(
		(entry) =>
			String(entry.name ?? '').startsWith('events[') &&
			String(entry.reason ?? '') === 'oneof' &&
			!String(entry.message ?? '').includes('speak.'),
	);

	const hint = refusedEvent
		? SPEAK_EVENTS_REFUSED
		: (HINTS[failure.code] ?? STATUS_HINTS[failure.status]);
	const description = [
		hint,
		describeInvalid(failure.invalidParams),
		failure.detail !== '' ? `Details: ${failure.detail}` : undefined,
	]
		.filter((part) => part !== undefined)
		.join(' ');

	return new NodeApiError(
		node,
		(body !== null && typeof body === 'object' ? body : {}) as JsonObject,
		{
			message: `Kinescope ${label}: ${message}`,
			description: description === '' ? undefined : description,
			httpCode: String(failure.status),
			itemIndex,
		},
	);
}
