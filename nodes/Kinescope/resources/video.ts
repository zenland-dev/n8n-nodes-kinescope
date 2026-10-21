import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { asNodeError } from '../../../shared/errors';
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
import { errorItem } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages } from '../../../shared/transport';
import { folderProperty, idProperty, idSegment, projectProperty } from '../props';
import { PRIVACY_TYPES } from './project';

/**
 * An upload header value. Headers carry Latin-1 only, so text is percent-encoded;
 * Kinescope decodes it — a title such as "Встреча 21.10" arrives intact.
 */
function headerText(value: string): string {
	return encodeURIComponent(value);
}

const VIDEO_STATUSES = [
	{ name: 'Aborted', value: 'aborted' },
	{ name: 'Done', value: 'done' },
	{ name: 'Error', value: 'error' },
	{ name: 'Pending', value: 'pending' },
	{ name: 'Pre-Processing', value: 'pre-processing' },
	{ name: 'Processing', value: 'processing' },
	{ name: 'Suspended', value: 'suspended' },
	{ name: 'Uploading', value: 'uploading' },
];

const videoId = idProperty(
	'Video ID',
	'videoId',
	'The ID of the video in the Kinescope catalog',
	'7127f2d7-0e96-40d0-9a03-2e987c096466',
);

const MIME_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	ts: 'video/mp2t',
	webm: 'video/webm',
	mkv: 'video/x-matroska',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
};

/** Height in pixels of a quality label such as 1080p; 0 for anything else. */
function height(quality: unknown): number {
	const match = /^(\d+)p$/.exec(String(quality ?? ''));
	return match === null ? 0 : Number(match[1]);
}

/**
 * The file to download. Original is the file as uploaded; Best is the largest
 * encoded MP4; Audio is the first audio track; a quality label picks that
 * rendition. Speak recordings come with encoded MP4s and an audio track but no
 * original once processed.
 */
export function pickAsset(video: IDataObject, wanted: string): IDataObject | undefined {
	const assets = (video.assets ?? []) as IDataObject[];
	if (wanted === 'audio') {
		const track = ((video.audio_tracks ?? []) as IDataObject[])[0];
		return track === undefined
			? undefined
			: { ...track, quality: 'audio', extension: 'm4a', mimeType: 'audio/mp4' };
	}
	if (wanted === 'best') {
		return [...assets]
			.filter((asset) => height(asset.quality) > 0)
			.sort((a, b) => height(b.quality) - height(a.quality))[0];
	}
	return assets.find((asset) => String(asset.quality) === wanted);
}

/** Where to fetch an asset from: the signed storage link, else the CDN link. */
function assetUrl(asset: IDataObject): string {
	return String(asset.download_link ?? '').trim() || String(asset.url ?? '').trim();
}

/** A file name a disk will accept, from the video title. */
function fileName(video: IDataObject, asset: IDataObject): string {
	const extension =
		String(asset.extension ?? asset.filetype ?? 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
	const base =
		String(video.title ?? '')
			.split('')
			.map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? ' ' : char))
			.join('')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 150) || String(video.id ?? 'video');
	return `${base}.${extension}`;
}

async function download(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const output: INodeExecutionData[] = [];

	for (let index = 0; index < items.length; index++) {
		try {
			const id = idSegment(this, 'videoId', index, 'Video ID');
			const video = dataOf(
				await kinescopeRequest.call(this, 'GET', `/v1/videos/${id}`, { itemIndex: index }),
			);
			const assets = (video.assets ?? []) as IDataObject[];
			const wanted = text(this, 'quality', index) || 'best';
			const asset = pickAsset(video, wanted);

			const status = String(video.status ?? '');
			if (['error', 'aborted'].includes(status) && asset === undefined) {
				throw new NodeOperationError(
					this.getNode(),
					`Kinescope could not process the video: its status is ${status}`,
					{
						itemIndex: index,
						description:
							'There is no file to download. A Speak recording of a few seconds, or one without sound, has been seen to end this way.',
					},
				);
			}
			if (status !== 'done' && asset === undefined) {
				throw new NodeOperationError(
					this.getNode(),
					`The video is not ready yet: its status is ${status}`,
					{
						itemIndex: index,
						description:
							'Kinescope adds the files once processing ends. Wait for the Media Status Updated event with status done, or check the status with Video → Get.',
					},
				);
			}

			const url = asset === undefined ? '' : assetUrl(asset);
			if (asset === undefined || url === '') {
				const available =
					[
						...assets.map((a) => String(a.quality)),
						...(((video.audio_tracks ?? []) as IDataObject[]).length > 0 ? ['audio'] : []),
					].join(', ') || 'none';
				throw new NodeOperationError(
					this.getNode(),
					`The video has no ${wanted} file to download`,
					{
						itemIndex: index,
						description: `Files Kinescope lists for this video: ${available}.`,
					},
				);
			}

			const info: IDataObject = compact({
				videoId: video.id,
				projectId: video.project_id,
				title: video.title,
				duration: video.duration,
				createdAt: video.created_at,
				quality: asset.quality,
				resolution: asset.resolution,
				language: asset.language,
				fileType: asset.filetype,
				// For a Speak recording Kinescope lists the size of the video stream alone;
				// the file carries the audio too and comes out larger.
				listedFileSize: asset.file_size,
				md5: asset.md5,
				fileName: fileName(video, asset),
			});

			if (text(this, 'mode', index) === 'link') {
				output.push({ json: { ...info, downloadUrl: url }, pairedItem: { item: index } });
				continue;
			}

			// The link is signed storage, not the API: no token goes with it. The file is
			// streamed into n8n's binary storage rather than read into memory first.
			const stream = (await this.helpers.httpRequest({
				method: 'GET',
				url,
				encoding: 'stream',
				timeout: 0,
			})) as Buffer;
			const property = text(this, 'binaryPropertyName', index) || 'data';
			const binary = await this.helpers.prepareBinaryData(
				stream,
				String(info.fileName),
				String(
					asset.mimeType ??
						MIME_TYPES[String(asset.filetype ?? '').toLowerCase()] ??
						'application/octet-stream',
				),
			);
			output.push({ json: info, binary: { [property]: binary }, pairedItem: { item: index } });
		} catch (error) {
			if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
			output.push(errorItem(error, index));
		}
	}

	return output;
}

export const videoResource: Resource = {
	value: 'video',
	name: 'Video',
	description: 'Videos in the Kinescope catalog, Speak meeting recordings among them',
	operations: [
		{
			value: 'get',
			name: 'Get',
			action: 'Get a video',
			description:
				'Get one video: title, status, duration in seconds, project and folder, and its files with download links',
			properties: [videoId],
			async execute(itemIndex) {
				const id = idSegment(this, 'videoId', itemIndex, 'Video ID');
				return dataOf(await kinescopeRequest.call(this, 'GET', `/v1/videos/${id}`, { itemIndex }));
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many videos',
			description: 'List videos of the catalog, optionally from one project, by status or by title',
			properties: [
				...returnAllProperties('videos'),
				{
					displayName: 'Filters',
					name: 'filters',
					type: 'collection',
					placeholder: 'Add Filter',
					default: {},
					options: [
						{
							displayName: 'Project Name or ID',
							name: 'projectId',
							type: 'options',
							typeOptions: { loadOptionsMethod: 'getProjects' },
							default: '',
							description:
								'Only videos of this project. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
						},
						{
							displayName: 'Search',
							name: 'q',
							type: 'string',
							default: '',
							description: 'Text to look for in video titles',
						},
						{
							displayName: 'Status',
							name: 'status',
							type: 'multiOptions',
							default: [],
							options: VIDEO_STATUSES,
						},
						{
							displayName: 'Video IDs',
							name: 'videoIds',
							type: 'string',
							default: '',
							description: 'Only these videos: a comma-separated list or an array',
						},
					],
				},
				orderProperty('created_at.desc,title.asc'),
			],
			async execute(itemIndex) {
				const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
				const qs = compact({
					project_id: String(filters.projectId ?? '').trim(),
					q: String(filters.q ?? '').trim(),
					status: filters.status as string[] | undefined,
					video_ids: idList(filters.videoIds),
					order: text(this, 'order', itemIndex),
				});
				return await readPages.call(this, '/v1/videos', qs, wantedRows(this, itemIndex), itemIndex);
			},
		},
		{
			value: 'download',
			name: 'Download',
			action: 'Download a video file',
			description:
				'Download the original file of a video, or one of its encoded qualities, to pass on to Google Drive, Yandex Disk, S3 or any other storage node. Can also return just the signed link.',
			properties: [
				videoId,
				{
					displayName: 'File',
					name: 'quality',
					type: 'options',
					default: 'best',
					options: [
						{ name: '1080p', value: '1080p' },
						{ name: '1440p', value: '1440p' },
						{ name: '360p', value: '360p' },
						{ name: '480p', value: '480p' },
						{ name: '720p', value: '720p' },
						{
							name: 'Audio Only',
							value: 'audio',
							description:
								'The audio track as M4A, e.g. for a speech-to-text service. Speak recordings have one.',
						},
						{
							name: 'Best MP4',
							value: 'best',
							description:
								'The encoded MP4 with the highest resolution. Works for Speak recordings, which keep no original.',
						},
						{
							name: 'Original',
							value: 'original',
							description:
								'The file as uploaded, in its own format. Speak recordings have none once processed.',
						},
					],
				},
				{
					displayName: 'Mode',
					name: 'mode',
					type: 'options',
					default: 'binary',
					options: [
						{
							name: 'File',
							value: 'binary',
							description: 'Download the file into the item’s binary data',
						},
						{
							name: 'Link Only',
							value: 'link',
							description:
								'Return the signed link without downloading, e.g. for Yandex Disk’s upload by URL. The link expires.',
						},
					],
				},
				{
					displayName: 'Put Output File in Field',
					name: 'binaryPropertyName',
					type: 'string',
					default: 'data',
					displayOptions: { show: { mode: ['binary'] } },
					hint: 'The name of the output binary field to put the file in',
				},
			],
			executeAll: download,
		},
		{
			value: 'update',
			name: 'Update',
			action: 'Update a video',
			description:
				'Change the title, description or embedding privacy of a video, e.g. rename a Speak recording after the meeting it holds',
			properties: [
				videoId,
				{
					displayName: 'Update Fields',
					name: 'updateFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{ displayName: 'Description', name: 'description', type: 'string', default: '' },
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
						{ displayName: 'Title', name: 'title', type: 'string', default: '' },
					],
				},
			],
			async execute(itemIndex) {
				const id = idSegment(this, 'videoId', itemIndex, 'Video ID');
				const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
				const body = compact({
					title: String(fields.title ?? '').trim(),
					description: fields.description as string | undefined,
					privacy_type: fields.privacyType as string | undefined,
					privacy_domains:
						fields.privacyDomains === undefined ? undefined : idList(fields.privacyDomains),
				});
				return dataOf(
					await kinescopeRequest.call(this, 'PATCH', `/v1/videos/${id}`, { body, itemIndex }),
				);
			},
		},
		{
			value: 'move',
			name: 'Move',
			action: 'Move a video',
			description:
				'Move a video to another project or folder, e.g. a Speak recording out of Speak Records. Its ID and links stay the same.',
			properties: [videoId, projectProperty(), folderProperty()],
			async execute(itemIndex) {
				const id = idSegment(this, 'videoId', itemIndex, 'Video ID');
				const body = compact({
					project_id: requiredText(this, 'projectId', itemIndex, 'Project'),
					folder_id: text(this, 'folderId', itemIndex),
				});
				await kinescopeRequest.call(this, 'PUT', `/v1/videos/${id}/move`, { body, itemIndex });
				return dataOf(await kinescopeRequest.call(this, 'GET', `/v1/videos/${id}`, { itemIndex }));
			},
		},
		{
			value: 'uploadFromUrl',
			name: 'Upload From URL',
			action: 'Upload a video from a URL',
			description:
				'Have Kinescope download a video from a direct link or a YouTube address into a project or folder. Returns at once with status uploading; Media: Status Updated tells when it is done.',
			properties: [
				projectProperty(),
				folderProperty(),
				{
					displayName: 'Video URL',
					name: 'url',
					type: 'string',
					required: true,
					default: '',
					placeholder: 'https://example.com/media/lesson-1.mp4',
					description:
						'A direct link to the file, reachable without signing in, or a YouTube address (youtube.com/watch?v=… or youtu.be/…)',
				},
				{
					displayName: 'Title',
					name: 'title',
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
						{ displayName: 'Description', name: 'description', type: 'string', default: '' },
						{
							displayName: 'File Name',
							name: 'fileName',
							type: 'string',
							default: '',
							placeholder: 'lesson-1.mp4',
						},
					],
				},
			],
			async execute(itemIndex) {
				const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
				const parent =
					text(this, 'folderId', itemIndex) ||
					requiredText(this, 'projectId', itemIndex, 'Project');
				const headers: Record<string, string> = {
					'X-Parent-ID': parent,
					'X-Video-URL': requiredText(this, 'url', itemIndex, 'Video URL'),
					'X-Video-Title': headerText(requiredText(this, 'title', itemIndex, 'Title')),
				};
				const description = String(fields.description ?? '').trim();
				if (description !== '') headers['X-Video-Description'] = headerText(description);
				const fileName = String(fields.fileName ?? '').trim();
				if (fileName !== '') headers['X-File-Name'] = headerText(fileName);
				// A repeat after a timeout would import the video twice: no retry.
				return dataOf(
					await kinescopeRequest.call(this, 'POST', '/v2/video', {
						uploader: true,
						headers,
						itemIndex,
						retry: false,
					}),
				);
			},
		},
		{
			value: 'delete',
			name: 'Delete',
			action: 'Delete a video',
			description: 'Delete a video from the Kinescope catalog for good',
			properties: [videoId],
			async execute(itemIndex) {
				const id = idSegment(this, 'videoId', itemIndex, 'Video ID');
				await kinescopeRequest.call(this, 'DELETE', `/v1/videos/${id}`, { itemIndex });
				return { success: true, id: decodeURIComponent(id) };
			},
		},
	],
};
