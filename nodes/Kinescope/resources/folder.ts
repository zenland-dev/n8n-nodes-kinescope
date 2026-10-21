import {
	compact,
	requiredText,
	returnAllProperties,
	text,
	wantedRows,
} from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages } from '../../../shared/transport';
import { folderProperty, idSegment, projectProperty } from '../props';

export const folderResource: Resource = {
	value: 'folder',
	name: 'Folder',
	description: 'Folders inside a project of the catalog',
	operations: [
		{
			value: 'create',
			name: 'Create',
			action: 'Create a folder',
			description: 'Create a folder in a project, at its root or inside another folder',
			properties: [
				projectProperty(),
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					required: true,
					default: '',
				},
				folderProperty({
					displayName: 'Parent Folder Name or ID',
					name: 'parentId',
					description:
						'The folder to create it in; empty for the project root. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				}),
			],
			async execute(itemIndex) {
				const project = idSegment(this, 'projectId', itemIndex, 'Project');
				const body = compact({
					name: requiredText(this, 'name', itemIndex, 'Name'),
					parent_id: text(this, 'parentId', itemIndex),
				});
				return dataOf(
					await kinescopeRequest.call(this, 'POST', `/v1/projects/${project}/folders`, {
						body,
						itemIndex,
						retry: false,
					}),
				);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many folders',
			description: 'List the folders of a project with their size and number of items',
			properties: [projectProperty(), ...returnAllProperties('folders')],
			async execute(itemIndex) {
				const project = idSegment(this, 'projectId', itemIndex, 'Project');
				return await readPages.call(
					this,
					`/v1/projects/${project}/folders`,
					{},
					wantedRows(this, itemIndex),
					itemIndex,
				);
			},
		},
	],
};
