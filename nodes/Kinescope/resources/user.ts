import { returnAllProperties, wantedRows } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { readPages } from '../../../shared/transport';

/**
 * `GET /v1/users` is not in Kinescope's API reference, yet it is the only route
 * that names the workspace users a room owner and a participant must be. It
 * ignores a search parameter.
 */
export const userResource: Resource = {
	value: 'user',
	name: 'User',
	description: 'People in the workspace: the IDs a room owner and a room participant are given by',
	operations: [
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many users',
			description:
				'List the users of the workspace with their ID, email and full name, e.g. to find the owner ID for Room → Create',
			properties: returnAllProperties('users'),
			async execute(itemIndex) {
				return await readPages.call(this, '/v1/users', {}, wantedRows(this, itemIndex), itemIndex);
			},
		},
	],
};
