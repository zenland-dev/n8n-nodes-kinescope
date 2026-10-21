import type { IDataObject } from 'n8n-workflow';

import {
	compact,
	idList,
	orderProperty,
	requiredText,
	returnAllProperties,
	text,
	wantedRows,
} from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages } from '../../../shared/transport';
import { idSegment, projectProperty } from '../props';

/** Who may watch the videos of a project when embedded. */
export const PRIVACY_TYPES = [
	{ name: 'Anywhere', value: 'anywhere', description: 'Any site may embed the player' },
	{
		name: 'Listed Domains Only',
		value: 'custom',
		description: 'Only the domains listed in Privacy Domains',
	},
	{ name: 'Nowhere', value: 'nowhere', description: 'No site may embed the player' },
];

export const projectResource: Resource = {
	value: 'project',
	name: 'Project',
	description: 'Top-level sections of the Kinescope catalog that hold videos and folders',
	operations: [
		{
			value: 'create',
			name: 'Create',
			action: 'Create a project',
			description: 'Create a project in the catalog for videos or for live streams',
			properties: [
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					required: true,
					default: '',
				},
				{
					displayName: 'Additional Fields',
					name: 'additionalFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{
							displayName: 'Catalog Type',
							name: 'catalogType',
							type: 'options',
							default: 'vod',
							options: [
								{ name: 'Videos', value: 'vod' },
								{ name: 'Live Streams', value: 'live' },
							],
						},
						{
							displayName: 'Privacy',
							name: 'privacyType',
							type: 'options',
							default: 'anywhere',
							options: PRIVACY_TYPES,
						},
						{
							displayName: 'Privacy Domains',
							name: 'privacyDomains',
							type: 'string',
							default: '',
							placeholder: 'example.com, school.example.com',
							description: 'Domains that may embed the player, for Listed Domains Only',
						},
					],
				},
			],
			async execute(itemIndex) {
				const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
				const body = {
					name: requiredText(this, 'name', itemIndex, 'Name'),
					// Kinescope requires both privacy fields on creation.
					privacy_type: String(fields.privacyType ?? 'anywhere') || 'anywhere',
					privacy_domains: idList(fields.privacyDomains),
					...compact({ catalog_type: fields.catalogType as string | undefined }),
				};
				return dataOf(
					await kinescopeRequest.call(this, 'POST', '/v1/projects', {
						body,
						itemIndex,
						retry: false,
					}),
				);
			},
		},
		{
			value: 'get',
			name: 'Get',
			action: 'Get a project',
			description: 'Get one project with its folders, size and number of items',
			properties: [projectProperty()],
			async execute(itemIndex) {
				const id = idSegment(this, 'projectId', itemIndex, 'Project');
				return dataOf(
					await kinescopeRequest.call(this, 'GET', `/v1/projects/${id}`, { itemIndex }),
				);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many projects',
			description: 'List the projects of the catalog',
			properties: [...returnAllProperties('projects'), orderProperty('name.asc')],
			async execute(itemIndex) {
				return await readPages.call(
					this,
					'/v1/projects',
					compact({ order: text(this, 'order', itemIndex) }),
					wantedRows(this, itemIndex),
					itemIndex,
				);
			},
		},
	],
};
