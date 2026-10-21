import { createPrivateKey, createPublicKey, createSign, type KeyObject } from 'node:crypto';
import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { CREDENTIAL } from './transport';

/**
 * A PEM block put back into shape. A key pasted into a single-line field
 * reaches the node with its line breaks turned into spaces, or as literal \n.
 */
export function normalizePem(raw: string): string {
	const text = raw.replace(/\\n/g, '\n').trim();
	const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
	if (match === null) return text;
	const body = match[2].replace(/\s+/g, '');
	const lines = body.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${match[1]}-----\n${lines.join('\n')}\n-----END ${match[1]}-----\n`;
}

/** The signing key and its ID from the credential, or an error saying what is missing. */
export async function signingKey(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<{ key: KeyObject; kid: string }> {
	const credentials = await this.getCredentials(CREDENTIAL);
	const pem = String(credentials.signingPrivateKey ?? '').trim();
	const kid = String(credentials.signingKeyId ?? '').trim();

	if (pem === '' || kid === '') {
		throw new NodeOperationError(this.getNode(), 'The credential has no signing key', {
			itemIndex,
			description:
				'Fill in Signing Private Key and Signing Key ID in the Kinescope API credential, then register the key once with Signing Key → Register.',
		});
	}

	let key: KeyObject;
	try {
		key = createPrivateKey(normalizePem(pem));
	} catch {
		throw new NodeOperationError(this.getNode(), 'The signing private key cannot be read', {
			itemIndex,
			description:
				'Paste an RSA private key in PEM form, with its BEGIN and END lines, e.g. one made by: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048',
		});
	}

	if (key.asymmetricKeyType !== 'rsa') {
		throw new NodeOperationError(this.getNode(), 'The signing key must be an RSA key', {
			itemIndex,
			description: 'Kinescope verifies tokens with RS256 only.',
		});
	}

	return { key, kid };
}

/** The public half of the key in the JWK form Kinescope stores. */
export function publicJwk(key: KeyObject, kid: string): IDataObject {
	const jwk = createPublicKey(key).export({ format: 'jwk' });
	return { kty: 'RSA', e: jwk.e, n: jwk.n, use: 'sig', alg: 'RS256', kid };
}

function base64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** An RS256 JSON Web Token, with the key ID in its header. */
export function signJwt(key: KeyObject, kid: string, claims: IDataObject): string {
	const head = base64url({ alg: 'RS256', typ: 'JWT', kid });
	const body = base64url(claims);
	const signature = createSign('RSA-SHA256')
		.update(`${head}.${body}`)
		.sign(key)
		.toString('base64url');
	return `${head}.${body}.${signature}`;
}
