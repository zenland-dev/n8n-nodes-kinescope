import type { IDataObject } from 'n8n-workflow';

import { compact } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { dataOf, kinescopeRequest } from '../../../shared/transport';
import { idProperty, idSegment, roomProperty } from '../props';

/** A destination without its stream key, unless the user asked for it. */
export function shown(destination: IDataObject, withKey: boolean): IDataObject {
	if (withKey) return destination;
	const rest = { ...destination };
	delete rest.stream_key;
	return rest;
}

const includeKey = {
	displayName: 'Include Stream Key',
	name: 'includeStreamKey',
	type: 'boolean' as const,
	default: false,
	description:
		'Whether to output the stream key. Kinescope returns it in plain text, and anyone holding it can broadcast to that platform account.',
};

export const restreamResource: Resource = {
	value: 'roomRestream',
	name: 'Restream Destination',
	description:
		'Where the host of a Speak room can stream the meeting. Destinations are added when the room is created; the host switches them on in the room.',
	operations: [
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get the restream destinations of a room',
			description: 'List the restream destinations saved in a Speak room',
			properties: [roomProperty(), includeKey],
			async execute(itemIndex) {
				const room = dataOf(
					await kinescopeRequest.call(
						this,
						'GET',
						`/v1/speak/rooms/${idSegment(this, 'roomId', itemIndex, 'Room')}`,
						{ itemIndex },
					),
				);
				const withKey = this.getNodeParameter('includeStreamKey', itemIndex, false) as boolean;
				return ((room.restreams ?? []) as IDataObject[]).map((d) => shown(d, withKey));
			},
		},
		{
			value: 'update',
			name: 'Update',
			action: 'Update a restream destination',
			description:
				'Change the name, RTMP URL or stream key of a destination, e.g. after the platform reissued the key. A destination that is streaming cannot be changed.',
			properties: [
				roomProperty(),
				idProperty(
					'Restream ID',
					'restreamId',
					'The ID of the destination, as Get Many returns it. It is looked up only inside the room above.',
				),
				{
					displayName: 'Update Fields',
					name: 'updateFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{ displayName: 'Name', name: 'name', type: 'string', default: '' },
						{
							displayName: 'RTMP URL',
							name: 'url',
							type: 'string',
							default: '',
							placeholder: 'rtmp://a.rtmp.youtube.com/live2',
							description:
								'The platform’s RTMP address without the stream key. Kinescope works out the platform from it again.',
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
				includeKey,
			],
			async execute(itemIndex) {
				const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
				const body = compact({
					name: String(fields.name ?? '').trim(),
					url: String(fields.url ?? '').trim(),
					stream_key: String(fields.streamKey ?? '').trim(),
				});
				const room = idSegment(this, 'roomId', itemIndex, 'Room');
				const id = idSegment(this, 'restreamId', itemIndex, 'Restream ID');
				const updated = dataOf(
					await kinescopeRequest.call(this, 'PATCH', `/v1/speak/rooms/${room}/restreams/${id}`, {
						body,
						itemIndex,
					}),
				);
				return shown(
					updated,
					this.getNodeParameter('includeStreamKey', itemIndex, false) as boolean,
				);
			},
		},
	],
};
