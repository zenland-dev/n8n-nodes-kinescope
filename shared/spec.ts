import type {
	IDataObject,
	IDisplayOptions,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { asNodeError } from './errors';

/**
 * One operation of one resource.
 *
 * Keeping operations as data lets the node share one dispatcher, one error
 * policy and one pairing rule instead of repeating them per resource.
 */
export interface Operation {
	/** Stored in workflows. Never rename once published. */
	value: string;
	name: string;
	/** Becomes the tool name an AI agent sees, e.g. "Send a message". */
	action: string;
	/** Printed verbatim in n8n's node catalog. */
	description: string;
	/** Parameters of this operation. Resource and operation conditions are added for you. */
	properties?: INodeProperties[];
	/**
	 * Handles one input item. Return one object per output item. `undefined` yields
	 * a single `{ success: true }`; an empty array yields nothing, as an empty list should.
	 */
	execute?(
		this: IExecuteFunctions,
		itemIndex: number,
	): Promise<IDataObject | IDataObject[] | undefined>;
	/**
	 * Handles every input item at once, for operations that pack items into one
	 * request. Takes precedence over `execute`; it pairs and error-handles itself.
	 */
	executeAll?(this: IExecuteFunctions): Promise<INodeExecutionData[]>;
}

export interface Resource {
	/** Stored in workflows. Never rename once published. */
	value: string;
	name: string;
	description: string;
	operations: Operation[];
}

function byName<T extends { name: string }>(a: T, b: T): number {
	return a.name.localeCompare(b.name);
}

function withConditions(
	property: INodeProperties,
	resource: string,
	operation: string,
): INodeProperties {
	const show: IDisplayOptions['show'] = {
		...(property.displayOptions?.show ?? {}),
		resource: [resource],
		operation: [operation],
	};
	return { ...property, displayOptions: { ...property.displayOptions, show } };
}

/** The Resource selector, one Operation selector per resource, and every parameter. */
export function buildProperties(resources: Resource[], defaultResource: string): INodeProperties[] {
	const resourceProperty: INodeProperties = {
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		default: defaultResource,
		options: [...resources]
			.sort(byName)
			.map((r) => ({ name: r.name, value: r.value, description: r.description })),
	};

	const properties: INodeProperties[] = [resourceProperty];

	for (const resource of resources) {
		const operations = [...resource.operations].sort(byName);
		properties.push({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { resource: [resource.value] } },
			default: operations[0].value,
			options: operations.map((o) => ({
				name: o.name,
				value: o.value,
				action: o.action,
				description: o.description,
			})),
		});
	}

	for (const resource of resources) {
		for (const operation of resource.operations) {
			for (const property of operation.properties ?? []) {
				properties.push(withConditions(property, resource.value, operation.value));
			}
		}
	}

	return properties;
}

/** The item a failed input turns into when the node continues on fail. */
export function errorItem(error: unknown, itemIndex: number): INodeExecutionData {
	return {
		json: { error: error instanceof Error ? error.message : String(error) },
		pairedItem: { item: itemIndex },
	};
}

/** Runs the selected resource and operation once per input item. */
export async function executeResources(
	this: IExecuteFunctions,
	resources: Resource[],
): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const resourceValue = this.getNodeParameter('resource', 0) as string;
	const operationValue = this.getNodeParameter('operation', 0) as string;

	const operation = resources
		.find((r) => r.value === resourceValue)
		?.operations.find((o) => o.value === operationValue);

	if (operation?.executeAll !== undefined) return [await operation.executeAll.call(this)];

	const execute = operation?.execute;
	if (execute === undefined) {
		throw new NodeOperationError(
			this.getNode(),
			`Unknown operation "${operationValue}" for resource "${resourceValue}"`,
		);
	}

	const output: INodeExecutionData[] = [];

	for (let index = 0; index < items.length; index++) {
		try {
			const result = await execute.call(this, index);

			if (result === undefined) {
				output.push({ json: { success: true }, pairedItem: { item: index } });
				continue;
			}

			// An empty list is an answer, not a failure: no rows, no items.
			for (const row of Array.isArray(result) ? result : [result]) {
				output.push({ json: row, pairedItem: { item: index } });
			}
		} catch (error) {
			if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
			output.push(errorItem(error, index));
		}
	}

	return [output];
}
