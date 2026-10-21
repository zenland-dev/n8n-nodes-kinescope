import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError, randomInt, sleep } from 'n8n-workflow';

import { asNodeError } from '../../../shared/errors';
import { compact, idList, requiredText, text } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { errorItem } from '../../../shared/spec';
import { asList, dataOf, kinescopeRequest } from '../../../shared/transport';
import { idProperty, idSegment } from '../props';

const videoId = idProperty(
	'Video ID',
	'videoId',
	'The ID of the video in the Kinescope catalog',
	'7127f2d7-0e96-40d0-9a03-2e987c096466',
);

const subtitleId = idProperty(
	'Subtitle ID',
	'subtitleId',
	'The ID of the subtitle track, as Generate or Get Many returns it',
);

function subtitlesPath(ctx: IExecuteFunctions, itemIndex: number): string {
	return `/v1/videos/${idSegment(ctx, 'videoId', itemIndex, 'Video ID')}/subtitles`;
}

function subtitlePath(ctx: IExecuteFunctions, itemIndex: number): string {
	return `${subtitlesPath(ctx, itemIndex)}/${idSegment(ctx, 'subtitleId', itemIndex, 'Subtitle ID')}`;
}

/** Statuses a recognition can end in. */
const FINISHED = ['done', 'error', 'failed', 'canceled', 'cancelled'];

/** How often a waiting Generate asks for the status. */
const POLL_MS = 10_000;

/** One cue of a subtitle track. */
export interface Cue {
	start: string;
	end: string;
	startSeconds: number;
	endSeconds: number;
	text: string;
}

/** `HH:MM:SS.mmm`, `MM:SS.mmm` or `HH:MM:SS,mmm` in seconds. */
function seconds(stamp: string): number {
	return stamp
		.replace(',', '.')
		.split(':')
		.map(Number)
		.reduce((total, part) => total * 60 + part, 0);
}

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

/** Cues of a WebVTT or SRT file. Notes, styles and cue settings are left out. */
export function parseCues(content: string): Cue[] {
	const cues: Cue[] = [];
	const blocks = content.replace(/\r\n?/g, '\n').split(/\n{2,}/);

	for (const block of blocks) {
		const lines = block.split('\n').filter((line) => line.trim() !== '');
		const at = lines.findIndex((line) => TIMING.test(line.trim()));
		if (at < 0) continue;
		const match = TIMING.exec(lines[at].trim());
		if (match === null) continue;
		const textLines = lines.slice(at + 1).map((line) => line.replace(/<[^>]+>/g, '').trim());
		cues.push({
			start: match[1],
			end: match[2],
			startSeconds: Math.round(seconds(match[1]) * 1000) / 1000,
			endSeconds: Math.round(seconds(match[2]) * 1000) / 1000,
			text: textLines.join('\n'),
		});
	}

	return cues;
}

function srtStamp(totalSeconds: number): string {
	const ms = Math.round(totalSeconds * 1000);
	const pad = (value: number, size = 2) => String(value).padStart(size, '0');
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** The cues as an SRT file. */
export function toSrt(cues: Cue[]): string {
	return cues
		.map(
			(cue, index) =>
				`${index + 1}\n${srtStamp(cue.startSeconds)} --> ${srtStamp(cue.endSeconds)}\n${cue.text}\n`,
		)
		.join('\n');
}

/** A subtitle track's file, fetched from its signed link. No token goes with it. */
async function trackContent(
	this: IExecuteFunctions,
	track: IDataObject,
	itemIndex: number,
): Promise<string> {
	const url = String(track.url ?? '').trim();
	if (url === '') {
		const status = String(track.status ?? '');
		throw new NodeOperationError(this.getNode(), 'The subtitle track has no file yet', {
			itemIndex,
			description:
				status !== '' && status !== 'done'
					? `Its status is ${status}. Recognition takes a while; download once Get reports status done, or use Generate with Wait for Recognition on.`
					: 'Kinescope lists no file link for this track.',
		});
	}
	const body = (await this.helpers.httpRequest({
		method: 'GET',
		url,
		encoding: 'text',
		json: false,
	})) as unknown;
	return typeof body === 'string' ? body : String(body ?? '');
}

/** Waits until every track has finished recognition, or the time runs out. */
async function waitForTracks(
	this: IExecuteFunctions,
	path: string,
	tracks: IDataObject[],
	minutes: number,
	itemIndex: number,
): Promise<IDataObject[]> {
	const deadline = Date.now() + minutes * 60_000;
	let current = tracks;

	while (!current.every((track) => FINISHED.includes(String(track.status ?? 'done')))) {
		if (Date.now() >= deadline) {
			throw new NodeOperationError(this.getNode(), `Recognition did not finish in ${minutes} min`, {
				itemIndex,
				description: `Tracks still running: ${current
					.filter((track) => !FINISHED.includes(String(track.status ?? 'done')))
					.map((track) => `${String(track.language)} (${String(track.id)})`)
					.join(', ')}. They go on in Kinescope; read them later with Subtitle → Get.`,
			});
		}
		await sleep(POLL_MS + randomInt(1000));
		current = await Promise.all(
			current.map(async (track) =>
				FINISHED.includes(String(track.status ?? 'done'))
					? track
					: dataOf(
							await kinescopeRequest.call(this, 'GET', `${path}/${String(track.id)}`, {
								itemIndex,
							}),
						),
			),
		);
	}

	return current;
}

/** Download builds file items itself, so it runs over all items at once. */
async function download(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const output: INodeExecutionData[] = [];

	for (let index = 0; index < items.length; index++) {
		try {
			const track = dataOf(
				await kinescopeRequest.call(this, 'GET', subtitlePath(this, index), { itemIndex: index }),
			);
			const content = await trackContent.call(this, track, index);
			const format = text(this, 'output', index) || 'segments';
			const ids = { videoId: track.video_id, subtitleId: track.id, language: track.language };
			const pairedItem = { item: index };
			const cues = parseCues(content);

			if (format === 'vtt' || format === 'srt') {
				const property = text(this, 'binaryPropertyName', index) || 'data';
				const fileContent = format === 'vtt' ? content : toSrt(cues);
				const binary = await this.helpers.prepareBinaryData(
					Buffer.from(fileContent, 'utf8'),
					`subtitles-${String(track.language ?? 'track')}-${String(track.id)}.${format}`,
					format === 'vtt' ? 'text/vtt' : 'application/x-subrip',
				);
				output.push({
					json: { ...ids, cues: cues.length },
					binary: { [property]: binary },
					pairedItem,
				});
				continue;
			}

			if (format === 'text') {
				output.push({ json: { ...ids, text: cues.map((cue) => cue.text).join('\n') }, pairedItem });
				continue;
			}

			for (const cue of cues) output.push({ json: { ...ids, ...cue }, pairedItem });
		} catch (error) {
			if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
			output.push(errorItem(error, index));
		}
	}

	return output;
}

/**
 * A subtitle file as multipart/form-data, encoded by hand: the form-data package
 * would be a dependency, which a community node may not have.
 */
function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }) {
	const boundary = `----n8nKinescope${Date.now().toString(36)}${randomInt(1_000_000)}`;
	const parts: Buffer[] = [];
	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
				'utf8',
			),
		);
	}
	const fileName = file.name.replace(/["\r\n]/g, '_');
	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
			'utf8',
		),
		file.data,
		Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
	);
	return { data: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const languageDescription =
	'An ISO 639-1 code, e.g. ru, en, de. Kinescope rejects a code it does not know.';

export const subtitleResource: Resource = {
	value: 'subtitle',
	name: 'Subtitle',
	description:
		'Subtitle tracks of a video: speech recognised by Kinescope, or a VTT or SRT file of your own',
	operations: [
		{
			value: 'generate',
			name: 'Generate',
			action: 'Generate subtitles by speech recognition',
			description:
				'Have Kinescope recognise the speech of a video and make one subtitle track per language — e.g. a transcript of a Speak meeting recording, without speaker names. Can wait until recognition ends.',
			properties: [
				videoId,
				{
					displayName: 'Languages',
					name: 'languages',
					type: 'string',
					required: true,
					default: 'ru',
					placeholder: 'ru, en',
					description:
						'ISO 639-1 codes of the languages spoken, separated by commas; one track per language. Kinescope rejects a code it does not know, and then creates none of the tracks.',
				},
				{
					displayName: 'Wait for Recognition',
					name: 'wait',
					type: 'boolean',
					default: false,
					description:
						'Whether to wait until every track is done or failed before going on. Off, the tracks come back with status pending.',
				},
				{
					displayName: 'Wait at Most (Minutes)',
					name: 'waitMinutes',
					type: 'number',
					typeOptions: { minValue: 1 },
					default: 15,
					displayOptions: { show: { wait: [true] } },
					description:
						'After this long the node fails with the tracks still running; they go on in Kinescope',
				},
			],
			async execute(itemIndex) {
				const languages = idList(this.getNodeParameter('languages', itemIndex, ''));
				if (languages.length === 0) {
					throw new NodeOperationError(this.getNode(), 'No languages given', {
						itemIndex,
						description: 'Enter at least one ISO 639-1 code, e.g. ru.',
					});
				}
				const path = subtitlesPath(this, itemIndex);
				// Kinescope creates all tracks or none, but a repeat after a timeout would
				// make them twice, so the request is not retried.
				const tracks = asList(
					await kinescopeRequest.call(this, 'POST', `${path}/auto`, {
						body: { languages },
						itemIndex,
						retry: false,
					}),
				);
				if (!(this.getNodeParameter('wait', itemIndex, false) as boolean)) return tracks;
				const minutes = Math.max(
					1,
					Number(this.getNodeParameter('waitMinutes', itemIndex, 15)) || 15,
				);
				return await waitForTracks.call(this, path, tracks, minutes, itemIndex);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get the subtitle tracks of a video',
			description: 'List the subtitle tracks of a video with their language, status and file link',
			properties: [videoId],
			async execute(itemIndex) {
				// Kinescope answers {"data": null} for a video without subtitles.
				return asList(
					await kinescopeRequest.call(this, 'GET', subtitlesPath(this, itemIndex), { itemIndex }),
				);
			},
		},
		{
			value: 'get',
			name: 'Get',
			action: 'Get a subtitle track',
			description: 'Get one subtitle track: its status, language and file link',
			properties: [videoId, subtitleId],
			async execute(itemIndex) {
				return dataOf(
					await kinescopeRequest.call(this, 'GET', subtitlePath(this, itemIndex), { itemIndex }),
				);
			},
		},
		{
			value: 'download',
			name: 'Download',
			action: 'Download a subtitle track',
			description:
				'Download a subtitle track as one item per cue with start and end in seconds, as plain text, or as a VTT or SRT file',
			properties: [
				videoId,
				subtitleId,
				{
					displayName: 'Output',
					name: 'output',
					type: 'options',
					default: 'segments',
					options: [
						{
							name: 'Cues',
							value: 'segments',
							description: 'One item per cue: text, start and end in seconds',
						},
						{
							name: 'SRT File',
							value: 'srt',
							description: 'The track converted to SubRip, in binary data',
						},
						{
							name: 'Text',
							value: 'text',
							description: 'One item with the text of every cue, one per line',
						},
						{
							name: 'VTT File',
							value: 'vtt',
							description: 'The track as Kinescope stores it, in binary data',
						},
					],
				},
				{
					displayName: 'Put Output File in Field',
					name: 'binaryPropertyName',
					type: 'string',
					default: 'data',
					displayOptions: { show: { output: ['vtt', 'srt'] } },
					hint: 'The name of the output binary field to put the file in',
				},
			],
			executeAll: download,
		},
		{
			value: 'upload',
			name: 'Upload',
			action: 'Upload a subtitle file',
			description: 'Attach a VTT or SRT file from binary data to a video as a subtitle track',
			properties: [
				videoId,
				{
					displayName: 'Input Binary Field',
					name: 'binaryPropertyName',
					type: 'string',
					required: true,
					default: 'data',
					hint: 'The name of the input binary field holding the VTT or SRT file',
				},
				{
					displayName: 'Language',
					name: 'language',
					type: 'string',
					required: true,
					default: 'ru',
					description: languageDescription,
				},
				{
					displayName: 'Description',
					name: 'description',
					type: 'string',
					default: '',
					description: 'A label for the track, shown in the Kinescope interface',
				},
			],
			async execute(itemIndex) {
				const property = requiredText(this, 'binaryPropertyName', itemIndex, 'Input Binary Field');
				const meta = this.helpers.assertBinaryData(itemIndex, property);
				const data = await this.helpers.getBinaryDataBuffer(itemIndex, property);
				const form = multipart(
					compact({
						language: requiredText(this, 'language', itemIndex, 'Language'),
						description: text(this, 'description', itemIndex),
					}) as Record<string, string>,
					{ name: meta.fileName ?? 'subtitles.vtt', data },
				);
				return dataOf(
					await kinescopeRequest.call(this, 'POST', subtitlesPath(this, itemIndex), {
						rawBody: form,
						itemIndex,
						retry: false,
					}),
				);
			},
		},
		{
			value: 'update',
			name: 'Update',
			action: 'Update a subtitle track',
			description: 'Change the language or the label of a subtitle track',
			properties: [
				videoId,
				subtitleId,
				{
					displayName: 'Update Fields',
					name: 'updateFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					options: [
						{ displayName: 'Description', name: 'description', type: 'string', default: '' },
						{
							displayName: 'Language',
							name: 'language',
							type: 'string',
							default: '',
							description: languageDescription,
						},
					],
				},
			],
			async execute(itemIndex) {
				const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
				const body = compact({
					language: String(fields.language ?? '').trim(),
					description: fields.description as string | undefined,
				});
				return dataOf(
					await kinescopeRequest.call(this, 'PATCH', subtitlePath(this, itemIndex), {
						body,
						itemIndex,
					}),
				);
			},
		},
		{
			value: 'delete',
			name: 'Delete',
			action: 'Delete a subtitle track',
			description: 'Remove a subtitle track from a video for good',
			properties: [videoId, subtitleId],
			async execute(itemIndex) {
				await kinescopeRequest.call(this, 'DELETE', subtitlePath(this, itemIndex), { itemIndex });
				return { success: true, id: text(this, 'subtitleId', itemIndex) };
			},
		},
	],
};
