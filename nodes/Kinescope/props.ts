import type { IExecuteFunctions, INodeProperties } from 'n8n-workflow';

import { requiredText } from '../../shared/params';
import { segment } from '../../shared/transport';

/** A Speak room picked from the workspace's list, or given as an ID by expression. */
export function roomProperty(overrides: Partial<INodeProperties> = {}): INodeProperties {
	return {
		displayName: 'Room Name or ID',
		name: 'roomId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getRooms' },
		required: true,
		default: '',
		description:
			'The Speak room. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		...overrides,
	};
}

/**
 * A workspace user picked from the list, or given as an ID by expression.
 * `description` is one sentence without its final period.
 */
export function userProperty(
	displayName: string,
	name: string,
	description: string,
): INodeProperties {
	return {
		displayName,
		name,
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getUsers' },
		required: true,
		default: '',
		description: `${description}. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.`,
	};
}

/** A plain ID typed or mapped by the user. */
export function idProperty(
	displayName: string,
	name: string,
	description: string,
	placeholder = '5d2e9b14-7a3c-4f8e-b061-92c4a7e3d815',
): INodeProperties {
	return {
		displayName,
		name,
		type: 'string',
		required: true,
		default: '',
		placeholder,
		description,
	};
}

/** A path segment made of an ID parameter; the ID must not be empty. */
export function idSegment(
	ctx: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): string {
	return segment(requiredText(ctx, name, itemIndex, label));
}

/** Where a Speak room's link points, built from its code. */
export const SPEAK_ORIGIN = 'https://speak.kinescope.io';

/** A project picked from the workspace's list, or given as an ID by expression. */
export function projectProperty(overrides: Partial<INodeProperties> = {}): INodeProperties {
	return {
		displayName: 'Project Name or ID',
		name: 'projectId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getProjects' },
		required: true,
		default: '',
		description:
			'The project of the catalog. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		...overrides,
	};
}

/** A folder of the project chosen above, or none. */
export function folderProperty(overrides: Partial<INodeProperties> = {}): INodeProperties {
	return {
		displayName: 'Folder Name or ID',
		name: 'folderId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getFolders', loadOptionsDependsOn: ['projectId'] },
		default: '',
		description:
			'A folder inside that project; empty for the project root. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		...overrides,
	};
}
