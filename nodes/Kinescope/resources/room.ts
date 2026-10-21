import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

import {
	compact,
	orderProperty,
	requiredText,
	returnAllProperties,
	text,
	wantedRows,
} from '../../../shared/params';
import { signingKey, signJwt } from '../../../shared/jwt';
import type { Resource } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages } from '../../../shared/transport';
import { idSegment, roomProperty, SPEAK_ORIGIN, userProperty } from '../props';
import { shown } from './restream';

const ROOM_TYPES = [
	{
		name: 'Permanent Meeting',
		value: 'permanent_meeting',
		description: 'One link for many meetings, e.g. a weekly call or a teacher’s room',
	},
	{
		name: 'Scheduled Meeting',
		value: 'scheduled_meeting',
		description: 'A meeting planned for a later time',
	},
	{
		name: 'Instant Meeting',
		value: 'instant_meeting',
		description: 'A meeting that starts now',
	},
];

/** Room statuses seen in answers. Kinescope documents no full list. */
const ROOM_STATUSES = [
	{ name: 'Cancelled', value: 'cancelled' },
	{ name: 'Pending', value: 'pending' },
	{ name: 'Scheduled', value: 'scheduled' },
];

/**
 * A room as the node returns it. The list route leaves `link` empty while the
 * single-room route fills it, so the link is rebuilt from the code when missing.
 * Restream stream keys come back in plain text and are left out: Restream
 * Destination → Get Many outputs them on request.
 */
export function withLink(room: IDataObject): IDataObject {
	const code = String(room.code ?? '').trim();
	const out: IDataObject = { ...room };
	if (String(room.link ?? '') === '' && code !== '') out.link = `${SPEAK_ORIGIN}/${code}`;
	if (Array.isArray(room.restreams)) {
		out.restreams = (room.restreams as IDataObject[]).map((d) => shown(d, false));
	}
	return out;
}

function roomPath(ctx: IExecuteFunctions, itemIndex: number): string {
	return `/v1/speak/rooms/${idSegment(ctx, 'roomId', itemIndex, 'Room')}`;
}

export const roomResource: Resource = {
	value: 'room',
	name: 'Room',
	description: 'Speak video meeting rooms: the link people join by and its recording settings',
	operations: [
		{
			value: 'create',
			name: 'Create',
			action: 'Create a room',
			description:
				'Create a Speak room and get its link. Recording, transcription, the waiting room and restream destinations can be switched on here.',
			properties: [
				{
					displayName: 'Name',
					name: 'name',
					type: 'string',
					required: true,
					default: '',
					placeholder: 'Weekly sync',
					description: 'The room name participants see',
				},
				userProperty(
					'Owner Name or ID',
					'ownerId',
					'The workspace user who owns the room. Automatic recording starts when the owner joins',
				),
				{
					displayName: 'Type',
					name: 'type',
					type: 'options',
					default: 'permanent_meeting',
					options: ROOM_TYPES,
				},
				{
					displayName: 'Additional Fields',
					name: 'additionalFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{
							displayName: 'Automatic Recording',
							name: 'autorecording',
							type: 'boolean',
							default: false,
							description:
								'Whether to start recording as soon as the owner joins and any audio or video appears. Recordings are saved to the Kinescope catalog.',
						},
						{
							displayName: 'Automatic Transcription',
							name: 'transcriptionAutostart',
							type: 'boolean',
							default: false,
							description:
								'Whether to start transcribing the call as soon as the first participant joins',
						},
						{
							displayName: 'Restream Destinations',
							name: 'restreams',
							type: 'fixedCollection',
							typeOptions: { multipleValues: true },
							placeholder: 'Add Destination',
							default: {},
							description:
								'Where the host can stream the meeting with one switch: YouTube, Twitch, Telegram or any RTMP server. Up to 15; they can only be added when the room is created.',
							options: [
								{
									name: 'destination',
									displayName: 'Destination',
									values: [
										{
											displayName: 'Name',
											name: 'name',
											type: 'string',
											default: '',
											placeholder: 'YouTube Live',
										},
										{
											displayName: 'RTMP URL',
											name: 'url',
											type: 'string',
											default: '',
											placeholder: 'rtmp://a.rtmp.youtube.com/live2',
											description: 'The platform’s RTMP address without the stream key',
										},
										{
											displayName: 'Stream Key',
											name: 'streamKey',
											type: 'string',
											typeOptions: { password: true },
											default: '',
										},
									],
								},
							],
						},
						{
							displayName: 'Wait for Host',
							name: 'waitForHost',
							type: 'boolean',
							default: false,
							description:
								'Whether participants wait until the owner or an admin joins. Can only be set when the room is created.',
						},
						{
							displayName: 'Waiting Room',
							name: 'waitingRoom',
							type: 'boolean',
							default: false,
							description:
								'Whether the owner or an admin admits each participant by hand. Can only be set when the room is created.',
						},
					],
				},
			],
			async execute(itemIndex) {
				const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
				const restreams = (
					((fields.restreams as IDataObject | undefined)?.destination ?? []) as IDataObject[]
				).map((row) => ({
					name: String(row.name ?? '').trim(),
					url: String(row.url ?? '').trim(),
					stream_key: String(row.streamKey ?? '').trim(),
				}));

				const body = compact({
					name: requiredText(this, 'name', itemIndex, 'Name'),
					owner_id: requiredText(
						this,
						'ownerId',
						itemIndex,
						'Owner',
						'Pick a workspace user, or map a user ID from User → Get Many.',
					),
					type: text(this, 'type', itemIndex) || 'permanent_meeting',
					autorecording: fields.autorecording as boolean | undefined,
					transcription_autostart: fields.transcriptionAutostart as boolean | undefined,
					waiting_room: fields.waitingRoom as boolean | undefined,
					wait_for_host: fields.waitForHost as boolean | undefined,
					restreams,
				});

				// No idempotency key: a repeated POST after a timeout would make a second room.
				return withLink(
					dataOf(
						await kinescopeRequest.call(this, 'POST', '/v1/speak/rooms', {
							body,
							itemIndex,
							retry: false,
						}),
					),
				);
			},
		},
		{
			value: 'get',
			name: 'Get',
			action: 'Get a room',
			description:
				'Get one Speak room with its link, settings, participants and restream destinations',
			properties: [roomProperty()],
			async execute(itemIndex) {
				return withLink(
					dataOf(
						await kinescopeRequest.call(this, 'GET', roomPath(this, itemIndex), { itemIndex }),
					),
				);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many rooms',
			description: 'List the Speak rooms of the workspace, optionally by status, type or name',
			properties: [
				...returnAllProperties('rooms'),
				{
					displayName: 'Filters',
					name: 'filters',
					type: 'collection',
					placeholder: 'Add Filter',
					default: {},
					options: [
						{
							displayName: 'Search',
							name: 'q',
							type: 'string',
							default: '',
							description: 'Text to look for in room names',
						},
						{
							displayName: 'Status',
							name: 'status',
							type: 'multiOptions',
							default: [],
							options: ROOM_STATUSES,
						},
						{
							displayName: 'Type',
							name: 'type',
							type: 'multiOptions',
							default: [],
							options: ROOM_TYPES.map(({ name, value }) => ({ name, value })),
						},
					],
				},
				orderProperty('created_at.desc,name.asc'),
			],
			async execute(itemIndex) {
				const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
				const qs = compact({
					q: String(filters.q ?? '').trim(),
					status: filters.status as string[] | undefined,
					type: filters.type as string[] | undefined,
					order: text(this, 'order', itemIndex),
				});
				const rows = await readPages.call(
					this,
					'/v1/speak/rooms',
					qs,
					wantedRows(this, itemIndex),
					itemIndex,
				);
				return rows.map(withLink);
			},
		},
		{
			value: 'update',
			name: 'Update',
			action: 'Update a room',
			description:
				'Rename a Speak room or switch automatic recording and transcription. The waiting room and Wait for Host cannot be changed after creation.',
			properties: [
				roomProperty(),
				{
					displayName: 'Update Fields',
					name: 'updateFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{
							displayName: 'Automatic Recording',
							name: 'autorecording',
							type: 'boolean',
							default: false,
							description:
								'Whether to start recording as soon as the owner joins and any audio or video appears',
						},
						{
							displayName: 'Automatic Transcription',
							name: 'transcriptionAutostart',
							type: 'boolean',
							default: false,
							description:
								'Whether to start transcribing the call as soon as the first participant joins',
						},
						{
							displayName: 'Name',
							name: 'name',
							type: 'string',
							default: '',
						},
					],
				},
			],
			async execute(itemIndex) {
				const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
				const body = compact({
					name: String(fields.name ?? '').trim(),
					autorecording: fields.autorecording as boolean | undefined,
					transcription_autostart: fields.transcriptionAutostart as boolean | undefined,
				});
				return withLink(
					dataOf(
						await kinescopeRequest.call(this, 'PATCH', roomPath(this, itemIndex), {
							body,
							itemIndex,
						}),
					),
				);
			},
		},
		{
			value: 'delete',
			name: 'Delete',
			action: 'Delete a room',
			description:
				'Delete a Speak room for good: the call ends, participants are disconnected and its restream destinations go with it',
			properties: [roomProperty()],
			async execute(itemIndex) {
				const path = roomPath(this, itemIndex);
				// Kinescope answers success for a room that is already gone, so a retry is safe.
				await kinescopeRequest.call(this, 'DELETE', path, { itemIndex });
				return { success: true, id: decodeURIComponent(path.split('/').pop() ?? '') };
			},
		},
		{
			value: 'getAdminLink',
			name: 'Get Admin Link',
			action: 'Get an admin link to a room',
			description:
				'Sign a Speak link that lets whoever opens it into the room as admin: recording, access control, the waiting room. Needs the signing key of the credential, registered with Signing Key → Register.',
			properties: [
				roomProperty(),
				{
					displayName: 'Valid For (Minutes)',
					name: 'validMinutes',
					type: 'number',
					typeOptions: { minValue: 1 },
					default: 180,
					description:
						'How long the link lets people in. Keep it close to the length of the meeting: anyone holding the link is admin until then.',
				},
			],
			async execute(itemIndex) {
				const { key, kid } = await signingKey.call(this, itemIndex);
				const room = dataOf(
					await kinescopeRequest.call(this, 'GET', roomPath(this, itemIndex), { itemIndex }),
				);
				const code = String(room.code ?? '').trim();
				const minutes = Math.max(
					1,
					Number(this.getNodeParameter('validMinutes', itemIndex, 180)) || 180,
				);
				const now = Math.floor(Date.now() / 1000);
				const expires = now + Math.round(minutes * 60);

				// Kinescope reads the room from the code in the link, not from its ID, and
				// takes admin as the only role. nbf is set a little back for clock skew.
				const token = signJwt(key, kid, {
					aud: 'speak',
					room_id: code,
					role: 'admin',
					iat: now,
					nbf: now - 60,
					exp: expires,
				});

				return {
					roomId: room.id,
					code,
					link: `${SPEAK_ORIGIN}/${code}?token=${token}`,
					expiresAt: new Date(expires * 1000).toISOString(),
				};
			},
		},
	],
};
