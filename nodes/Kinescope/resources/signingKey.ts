import type { IDataObject } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { publicJwk, signingKey } from '../../../shared/jwt';
import { requiredText, returnAllProperties, wantedRows } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages, segment } from '../../../shared/transport';
import { idProperty } from '../props';

/**
 * Public keys Kinescope checks signed links with: Speak admin links here, and
 * the stream chat tokens of live events, which use the same keys.
 */
export const signingKeyResource: Resource = {
	value: 'signingKey',
	name: 'Signing Key',
	description:
		'Public keys Kinescope checks signed Speak admin links and stream chat tokens against',
	operations: [
		{
			value: 'register',
			name: 'Register',
			action: 'Register the credential signing key',
			description:
				'Give Kinescope the public half of the private key in the credential, under its Signing Key ID, so that Room → Get Admin Link works. Do this once per key.',
			properties: [
				{
					displayName: 'Expires At',
					name: 'expiresAt',
					type: 'dateTime',
					required: true,
					default: '',
					description:
						'When Kinescope stops accepting links signed with this key. Kinescope requires a date.',
				},
			],
			async execute(itemIndex) {
				const { key, kid } = await signingKey.call(this, itemIndex);
				const expires = new Date(requiredText(this, 'expiresAt', itemIndex, 'Expires At'));
				if (Number.isNaN(expires.getTime())) {
					throw new NodeOperationError(this.getNode(), 'Expires At is not a date', { itemIndex });
				}
				const body = {
					...publicJwk(key, kid),
					expires_at: expires.toISOString().replace(/\.\d+Z$/, 'Z'),
				};
				return dataOf(
					await kinescopeRequest.call(this, 'POST', '/v1/jwk', { body, itemIndex, retry: false }),
				);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many signing keys',
			description: 'List the public keys registered in the workspace with their IDs and expiry',
			properties: returnAllProperties('keys'),
			async execute(itemIndex) {
				return await readPages.call(this, '/v1/jwk', {}, wantedRows(this, itemIndex), itemIndex);
			},
		},
		{
			value: 'delete',
			name: 'Delete',
			action: 'Delete a signing key',
			description:
				'Remove a public key: every link and chat token signed with it stops working at once. Use it when a private key leaked.',
			properties: [
				idProperty(
					'Key Record ID',
					'jwkId',
					'The jwk_id of the key as Get Many or Register returns it, not its Signing Key ID',
				),
			],
			async execute(itemIndex) {
				const id = requiredText(this, 'jwkId', itemIndex, 'Key Record ID');
				// Kinescope answers success for a key already gone, so a retry is safe.
				await kinescopeRequest.call(this, 'DELETE', `/v1/jwk/${segment(id)}`, { itemIndex });
				return { success: true, id } as IDataObject;
			},
		},
	],
};
