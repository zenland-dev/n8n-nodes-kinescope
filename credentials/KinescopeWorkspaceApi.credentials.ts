import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * The one host Kinescope serves its API on.
 *
 * A token belongs to one workspace and Kinescope finds the workspace from the
 * token alone, so the credential has no address field: nothing to type, and
 * nothing that could point the token at another server.
 */
export const API_ORIGIN = 'https://api.kinescope.io';

/**
 * The token as it is sent, as an n8n expression. Whitespace from a careless
 * copy and a pasted "Bearer " prefix are dropped.
 */
const TOKEN_EXPRESSION = 'String($credentials.apiToken || "").trim().replace(/^Bearer\\s+/i, "")';

/** The same normalisation in plain TypeScript, for the transport and the trigger. */
export function normalizeApiToken(raw: unknown): string {
	return String(raw ?? '')
		.trim()
		.replace(/^Bearer\s+/i, '');
}

export class KinescopeWorkspaceApi implements ICredentialType {
	name = 'kinescopeWorkspaceApi';

	displayName = 'Kinescope API';

	documentationUrl = 'https://docs.kinescope.com/api/getting-started/authentication/';

	icon: Icon = { light: 'file:../icons/kinescope.svg', dark: 'file:../icons/kinescope.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'e51e55a1-7615-493e-9055-10ac9cc44ccd',
			description:
				'A token from Settings → API tokens in Kinescope. It acts for the whole workspace it was issued in; give each integration its own token so one can be revoked without breaking the others.',
		},
		{
			displayName:
				'The two fields below are needed only for Room → Get Admin Link, which signs Speak links that let a person in as room admin. Leave them empty otherwise.',
			name: 'signingNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Signing Private Key',
			name: 'signingPrivateKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: '-----BEGIN PRIVATE KEY----- …',
			description:
				'An RSA private key in PEM form, e.g. from: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048. It never leaves n8n; Signing Key → Register gives Kinescope its public half.',
		},
		{
			displayName: 'Signing Key ID',
			name: 'signingKeyId',
			type: 'string',
			default: '',
			placeholder: 'n8n-2026-10',
			description:
				'A name for the key, unique in the workspace (Kinescope calls it kid). It goes into every signed link so Kinescope knows which public key to check it with.',
		},
		{
			// n8n injects this field into every credential with an `authenticate` block,
			// defaulting to "all" — enough for anyone who can edit a workflow to pick
			// this credential in an HTTP Request node, type any URL and have n8n attach
			// the token to it. Declaring it here skips the injection, so there is no
			// switch to flip. The nodes' own calls go through
			// httpRequestWithAuthentication, which never reads it.
			displayName: 'Allowed HTTP Request Domains',
			name: 'allowedHttpRequestDomains',
			type: 'hidden',
			default: 'none',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: `=Bearer {{ ${TOKEN_EXPRESSION} }}`,
			},
		},
	};

	/** A one-row page of rooms: open to every token with read access, cheap for any workspace. */
	test: ICredentialTestRequest = {
		request: {
			baseURL: API_ORIGIN,
			url: '/v1/speak/rooms',
			method: 'GET',
			qs: { page: 1, per_page: 1 },
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'Kinescope did not accept the token. Copy it again from Settings → API tokens; a revoked token, or one from another workspace, answers this way.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'The token is valid but may not read Speak rooms. Issue a token with read permission for the API.',
				},
			},
		],
	};
}
