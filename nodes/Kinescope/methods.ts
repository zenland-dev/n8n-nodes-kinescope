import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { cached, CONFIG_TTL_MS } from '../../shared/cache';
import { readPages, workspaceKey } from '../../shared/transport';

function byName(a: INodePropertyOptions, b: INodePropertyOptions): number {
	return a.name.localeCompare(b.name);
}

/** A whole list, memoised briefly per token so that several pickers share one read. */
async function list(this: ILoadOptionsFunctions, path: string): Promise<IDataObject[]> {
	const key = await workspaceKey.call(this);
	return await cached(
		`${key}:${path}`,
		async () => await readPages.call(this, path, {}, undefined),
		CONFIG_TTL_MS,
	);
}

export const loadOptions = {
	async getRooms(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return (await list.call(this, '/v1/speak/rooms'))
			.map((room) => ({
				name: String(room.name ?? '') || String(room.code ?? room.id),
				value: String(room.id),
				description: `${String(room.code ?? '')} · ${String(room.type ?? '').replace(/_/g, ' ')}`,
			}))
			.sort(byName);
	},

	async getUsers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return (await list.call(this, '/v1/users'))
			.map((user) => ({
				name: String(user.full_name ?? '').trim() || String(user.email ?? user.id),
				value: String(user.id),
				description: String(user.email ?? ''),
			}))
			.sort(byName);
	},

	async getFolders(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		const project = String(this.getCurrentNodeParameter('projectId') ?? '').trim();
		if (project === '' || project.startsWith('=')) return [];
		return (await list.call(this, `/v1/projects/${encodeURIComponent(project)}/folders`))
			.map((folder) => ({
				name: String(folder.name ?? '').trim() || String(folder.id),
				value: String(folder.id),
				description: `${String(folder.items_count ?? 0)} items`,
			}))
			.sort(byName);
	},

	async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return (await list.call(this, '/v1/projects'))
			.map((project) => ({
				name: String(project.name ?? project.id),
				value: String(project.id),
				description: `${String(project.items_count ?? 0)} items`,
			}))
			.sort(byName);
	},
};
