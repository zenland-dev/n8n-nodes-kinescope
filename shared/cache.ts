/**
 * A short-lived memo for the reads that fill dropdowns.
 *
 * Opening a node with several workspace-aware pickers fires several requests, and
 * the editor re-runs them whenever a dependent parameter changes, so those reads
 * are shared for a short while, per token.
 */
const TTL_MS = 60_000;

/**
 * The window for workspace configuration: rooms, users, projects. They change
 * now and then, not in a stream.
 *
 * Two minutes rather than more, because n8n's Refresh List action in a dropdown
 * cannot reach past this memo — a refresh that does nothing for ten minutes reads
 * as a broken button, so the window is short enough to be waited out.
 */
export const CONFIG_TTL_MS = 120_000;

const entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

function prune(now: number): void {
	for (const [key, entry] of entries) {
		if (entry.expiresAt <= now) entries.delete(key);
	}
}

/**
 * Runs `fetch` unless an identical call is already memoised.
 *
 * A rejection is never remembered: the usual cause is a credential the user is
 * still filling in, and they would otherwise have to wait out the TTL. The
 * rejection still reaches this caller.
 */
export async function cached<T>(key: string, fetch: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
	const now = Date.now();
	prune(now);

	const hit = entries.get(key);
	if (hit !== undefined) return (await hit.value) as T;

	const value = fetch();
	entries.set(key, { expiresAt: now + ttlMs, value });
	void value.catch(() => entries.delete(key));

	return await value;
}

/** Test seam: forget every memoised read. */
export function resetCache(): void {
	entries.clear();
}
