import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { jsonParse, NodeOperationError } from 'n8n-workflow';

/**
 * Reads a JSON parameter that may arrive as text (typed into the editor) or as an
 * object (produced by an expression). Empty text is `fallback`.
 */
export function jsonParameter<T = IDataObject>(
	ctx: IExecuteFunctions,
	name: string,
	itemIndex: number,
	fallback: T,
	label = name,
): T {
	const raw = ctx.getNodeParameter(name, itemIndex, fallback) as unknown;
	if (raw === undefined || raw === null) return fallback;
	if (typeof raw !== 'string') return raw as T;
	if (raw.trim() === '') return fallback;

	try {
		return jsonParse<T>(raw);
	} catch {
		throw new NodeOperationError(ctx.getNode(), `"${label}" is not valid JSON`, {
			itemIndex,
			description: 'Check the brackets and quotes, or build the value with an expression instead.',
		});
	}
}

/** A trimmed string parameter; '' when it is empty or missing. */
export function text(ctx: IExecuteFunctions, name: string, itemIndex: number): string {
	const raw = ctx.getNodeParameter(name, itemIndex, '') as unknown;
	if (raw === undefined || raw === null) return '';
	return String(raw).trim();
}

/** A string parameter that must not be empty; `label` names it in the error. */
export function requiredText(
	ctx: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
	hint?: string,
): string {
	const value = text(ctx, name, itemIndex);
	if (value === '') {
		throw new NodeOperationError(ctx.getNode(), `${label} is empty`, {
			itemIndex,
			description: hint,
		});
	}
	return value;
}

/**
 * A list of values from a comma-separated string, a JSON array typed as text, or
 * an array produced by an expression. Empty entries are dropped, duplicates kept once.
 */
export function idList(raw: unknown): string[] {
	let values: unknown[];

	if (Array.isArray(raw)) {
		values = raw;
	} else if (raw === undefined || raw === null) {
		values = [];
	} else {
		const textValue = String(raw).trim();
		if (textValue.startsWith('[')) {
			try {
				const parsed = jsonParse<unknown>(textValue);
				values = Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				values = textValue.split(',');
			}
		} else {
			values = textValue.split(',');
		}
	}

	return [...new Set(values.map((v) => String(v ?? '').trim()).filter((v) => v !== ''))];
}

/** Drops keys whose value is undefined, null, an empty string or an empty list. */
export function compact(object: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(object)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value) && value.length === 0) continue;
		out[key] = value;
	}
	return out;
}

// ── Reusable parameter descriptions ────────────────────────────────────────

export function returnAllProperties(what: string): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 50,
			displayOptions: { show: { returnAll: [false] } },
			description: `Max number of ${what} to return`,
		},
	];
}

/** How many rows the caller wants: undefined for all of them. */
export function wantedRows(ctx: IExecuteFunctions, itemIndex: number): number | undefined {
	if (ctx.getNodeParameter('returnAll', itemIndex, false) as boolean) return undefined;
	return Math.max(1, Number(ctx.getNodeParameter('limit', itemIndex, 50)) || 50);
}

/** The sort order parameter, for the list routes that accept `order`. */
export function orderProperty(example: string): INodeProperties {
	return {
		displayName: 'Sort Order',
		name: 'order',
		type: 'string',
		default: '',
		placeholder: example,
		description:
			'Fields to sort by as field.direction pairs separated by commas, e.g. created_at.desc,name.asc. Empty keeps Kinescope’s default order, newest first.',
	};
}
