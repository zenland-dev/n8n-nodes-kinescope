import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

import {
	compact,
	orderProperty,
	requiredText,
	returnAllProperties,
	text,
	wantedRows,
} from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages } from '../../../shared/transport';
import { idProperty, idSegment, roomProperty, userProperty } from '../props';

const ROLES = [
	{
		name: 'Admin',
		value: 'admin',
		description: 'Full rights in the room: recording, access control, the waiting room',
	},
	{ name: 'Manager', value: 'manager' },
];

const participantId = idProperty(
	'Participant ID',
	'participantId',
	'The ID of the room participant, as Add or Get Many return it. It is not the user ID.',
);

function participantsPath(ctx: IExecuteFunctions, itemIndex: number): string {
	return `/v1/speak/rooms/${idSegment(ctx, 'roomId', itemIndex, 'Room')}/participants`;
}

function participantPath(ctx: IExecuteFunctions, itemIndex: number): string {
	return `${participantsPath(ctx, itemIndex)}/${idSegment(ctx, 'participantId', itemIndex, 'Participant ID')}`;
}

export const participantResource: Resource = {
	value: 'participant',
	name: 'Participant',
	description:
		'Workspace users given a role in a Speak room ahead of a meeting. Who actually joined a call comes from webhooks, not from here.',
	operations: [
		{
			value: 'add',
			name: 'Add',
			action: 'Add a participant to a room',
			description:
				'Give a workspace user a role in a Speak room. Each user can be added once; the owner is already in the room.',
			properties: [
				roomProperty(),
				userProperty('User Name or ID', 'userId', 'The workspace user to add'),
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					required: true,
					default: '',
					description: 'The name shown for this participant in the room',
				},
				{
					displayName: 'Role',
					name: 'role',
					type: 'options',
					default: 'admin',
					options: ROLES,
					description:
						'The role cannot be changed later; remove the participant and add them again',
				},
			],
			async execute(itemIndex) {
				const body = {
					user_id: requiredText(this, 'userId', itemIndex, 'User'),
					name: requiredText(this, 'name', itemIndex, 'Name'),
					role: text(this, 'role', itemIndex) || 'admin',
				};
				// A repeat after a timeout fails with "User already added", so it is not retried.
				return dataOf(
					await kinescopeRequest.call(this, 'POST', participantsPath(this, itemIndex), {
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
			action: 'Get a participant',
			description: 'Get one participant of a Speak room',
			properties: [roomProperty(), participantId],
			async execute(itemIndex) {
				return dataOf(
					await kinescopeRequest.call(this, 'GET', participantPath(this, itemIndex), { itemIndex }),
				);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many participants',
			description: 'List the participants of a Speak room, optionally by role or name',
			properties: [
				roomProperty(),
				...returnAllProperties('participants'),
				{
					displayName: 'Filters',
					name: 'filters',
					type: 'collection',
					placeholder: 'Add Filter',
					default: {},
					options: [
						{
							displayName: 'Role',
							name: 'role',
							type: 'multiOptions',
							default: [],
							options: ROLES.map(({ name, value }) => ({ name, value })),
						},
						{
							displayName: 'Search',
							name: 'q',
							type: 'string',
							default: '',
							description: 'Text to look for in participant names',
						},
					],
				},
				orderProperty('created_at.desc,name.asc'),
			],
			async execute(itemIndex) {
				const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
				const qs = compact({
					q: String(filters.q ?? '').trim(),
					role: filters.role as string[] | undefined,
					order: text(this, 'order', itemIndex),
				});
				return await readPages.call(
					this,
					participantsPath(this, itemIndex),
					qs,
					wantedRows(this, itemIndex),
					itemIndex,
				);
			},
		},
		{
			value: 'update',
			name: 'Update',
			action: 'Rename a participant',
			description: 'Change the name shown for a participant. Kinescope ignores a new role here.',
			properties: [
				roomProperty(),
				participantId,
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					required: true,
					default: '',
				},
			],
			async execute(itemIndex) {
				return dataOf(
					await kinescopeRequest.call(this, 'PATCH', participantPath(this, itemIndex), {
						body: { name: requiredText(this, 'name', itemIndex, 'Name') },
						itemIndex,
					}),
				);
			},
		},
		{
			value: 'remove',
			name: 'Remove',
			action: 'Remove a participant from a room',
			description: 'Take a participant’s role in a Speak room away',
			properties: [roomProperty(), participantId],
			async execute(itemIndex) {
				// Kinescope answers success for a participant already removed, so a retry is safe.
				await kinescopeRequest.call(this, 'DELETE', participantPath(this, itemIndex), {
					itemIndex,
				});
				return { success: true, id: text(this, 'participantId', itemIndex) };
			},
		},
	],
};
