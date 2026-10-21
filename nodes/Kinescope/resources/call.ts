import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { asNodeError } from '../../../shared/errors';
import {
	compact,
	orderProperty,
	returnAllProperties,
	text,
	wantedRows,
} from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { errorItem } from '../../../shared/spec';
import { dataOf, kinescopeRequest, readPages } from '../../../shared/transport';
import { idProperty, idSegment, roomProperty } from '../props';

const callId = idProperty(
	'Call ID',
	'callId',
	'The ID of one meeting held in the room, as Get Many or a Speak webhook gives it',
);

function callsPath(ctx: IExecuteFunctions, itemIndex: number): string {
	return `/v1/speak/rooms/${idSegment(ctx, 'roomId', itemIndex, 'Room')}/calls`;
}

function callPath(ctx: IExecuteFunctions, itemIndex: number): string {
	return `${callsPath(ctx, itemIndex)}/${idSegment(ctx, 'callId', itemIndex, 'Call ID')}`;
}

/** One line of a transcript: who said what, and when. */
export interface TranscriptSegment {
	start: string;
	end: string;
	startSeconds: number;
	endSeconds: number;
	speaker: string;
	text: string;
}

/** `MM:SS.T` or `HH:MM:SS.T` in seconds. */
function seconds(stamp: string): number {
	return stamp
		.split(':')
		.map(Number)
		.reduce((total, part) => total * 60 + part, 0);
}

const LINE = /^\[(\d+(?::\d+)+(?:\.\d+)?)\s*-\s*(\d+(?::\d+)+(?:\.\d+)?)\]\s*(?:([^:]*?):\s)?(.*)$/;

/**
 * Splits the transcript file into segments. Each line is
 * `[MM:SS.T-MM:SS.T] Speaker: Text`; a line in another shape is kept as text
 * of the segment before it, so nothing Kinescope wrote is dropped.
 */
export function parseTranscript(content: string): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];

	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '') continue;

		const match = LINE.exec(line);
		if (match === null) {
			const last = segments[segments.length - 1];
			if (last !== undefined) last.text = `${last.text}\n${line}`;
			else
				segments.push({
					start: '',
					end: '',
					startSeconds: 0,
					endSeconds: 0,
					speaker: '',
					text: line,
				});
			continue;
		}

		segments.push({
			start: match[1],
			end: match[2],
			startSeconds: Math.round(seconds(match[1]) * 10) / 10,
			endSeconds: Math.round(seconds(match[2]) * 10) / 10,
			speaker: (match[3] ?? '').trim(),
			text: match[4].trim(),
		});
	}

	return segments;
}

/** Per speaker: how many segments and how long they spoke. */
export function speakerTotals(segments: TranscriptSegment[]): IDataObject[] {
	const totals = new Map<
		string,
		{ segments: number; seconds: number; firstAt: number; lastAt: number }
	>();

	for (const segment of segments) {
		const entry = totals.get(segment.speaker) ?? {
			segments: 0,
			seconds: 0,
			firstAt: segment.startSeconds,
			lastAt: segment.endSeconds,
		};
		entry.segments += 1;
		entry.seconds += Math.max(0, segment.endSeconds - segment.startSeconds);
		entry.firstAt = Math.min(entry.firstAt, segment.startSeconds);
		entry.lastAt = Math.max(entry.lastAt, segment.endSeconds);
		totals.set(segment.speaker, entry);
	}

	return [...totals.entries()]
		.map(([speaker, entry]) => ({
			speaker,
			segments: entry.segments,
			speakingSeconds: Math.round(entry.seconds * 10) / 10,
			firstSpokeAtSeconds: entry.firstAt,
			lastSpokeAtSeconds: entry.lastAt,
		}))
		.sort((a, b) => b.speakingSeconds - a.speakingSeconds);
}

/**
 * How Kinescope titles a Speak recording: "Record <room name> 2026-10-21 22:15:21",
 * the time being when recording started, in UTC. Neither the video nor the call
 * names the other, so the title is the only link between them.
 */
const RECORDING_TITLE = /^Record (.+) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

export function parseRecordingTitle(
	title: string,
): { roomName: string; recordingStartedAt: string } | undefined {
	const match = RECORDING_TITLE.exec(title.trim());
	if (match === null) return undefined;
	return { roomName: match[1], recordingStartedAt: `${match[2]}T${match[3]}Z` };
}

/** How far outside a call's own timestamps a recording start still counts as the call's. */
const MARGIN_MS = 15_000;

/**
 * The recordings of one call: videos titled after the room whose recording
 * started while the call ran. A call's updated_at has been its end in every
 * call observed; the room's current call is taken to run until now.
 */
async function callRecordings(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const roomPath = `/v1/speak/rooms/${idSegment(this, 'roomId', itemIndex, 'Room')}`;
	const room = dataOf(await kinescopeRequest.call(this, 'GET', roomPath, { itemIndex }));
	const call = dataOf(
		await kinescopeRequest.call(this, 'GET', callPath(this, itemIndex), { itemIndex }),
	);
	const newest = (await readPages.call(this, `${roomPath}/calls`, {}, 1, itemIndex))[0];

	const start = Date.parse(String(call.created_at ?? ''));
	const ongoing = String(room.status ?? '') === 'active' && newest?.id === call.id;
	const end = ongoing ? Date.now() : Date.parse(String(call.updated_at ?? call.created_at ?? ''));
	const name = String(room.name ?? '');

	const videos = await readPages.call(
		this,
		'/v1/videos',
		{ q: name, order: 'created_at.desc' },
		undefined,
		itemIndex,
	);

	return videos.flatMap((video) => {
		const parsed = parseRecordingTitle(String(video.title ?? ''));
		if (parsed === undefined || parsed.roomName !== name) return [];
		const at = Date.parse(parsed.recordingStartedAt);
		if (at < start - MARGIN_MS || at > end + MARGIN_MS) return [];
		return [
			{ ...video, roomId: room.id, callId: call.id, recordingStartedAt: parsed.recordingStartedAt },
		];
	});
}

async function transcriptText(this: IExecuteFunctions, itemIndex: number): Promise<string> {
	const body = await kinescopeRequest.call(
		this,
		'GET',
		`${callPath(this, itemIndex)}/transcript/content.txt`,
		{
			itemIndex,
			text: true,
		},
	);
	return typeof body === 'string' ? body : String(body ?? '');
}

/**
 * Download Transcript can answer with a file, so it builds items itself rather
 * than through the shared per-item loop.
 */
async function downloadTranscript(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const output: INodeExecutionData[] = [];

	for (let index = 0; index < items.length; index++) {
		try {
			const format = text(this, 'output', index) || 'segments';
			const content = await transcriptText.call(this, index);
			const ids = { roomId: text(this, 'roomId', index), callId: text(this, 'callId', index) };
			const pairedItem = { item: index };

			if (format === 'file') {
				const property = text(this, 'binaryPropertyName', index) || 'data';
				const binary = await this.helpers.prepareBinaryData(
					Buffer.from(content, 'utf8'),
					`transcript-${ids.callId}.txt`,
					'text/plain',
				);
				output.push({
					json: { ...ids, characters: content.length },
					binary: { [property]: binary },
					pairedItem,
				});
				continue;
			}

			if (format === 'text') {
				output.push({ json: { ...ids, text: content }, pairedItem });
				continue;
			}

			const segments = parseTranscript(content);
			const rows: IDataObject[] =
				format === 'speakers'
					? speakerTotals(segments)
					: segments.map((segment) => ({ ...segment }));
			for (const row of rows) output.push({ json: { ...ids, ...row }, pairedItem });
		} catch (error) {
			if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, index);
			output.push(errorItem(error, index));
		}
	}

	return output;
}

export const callResource: Resource = {
	value: 'call',
	name: 'Call',
	description: 'Meetings held in a Speak room, and their transcripts',
	operations: [
		{
			value: 'get',
			name: 'Get',
			action: 'Get a call',
			description:
				'Get one meeting held in a Speak room. Kinescope returns its ID, the transcript ID and timestamps.',
			properties: [roomProperty(), callId],
			async execute(itemIndex) {
				return dataOf(
					await kinescopeRequest.call(this, 'GET', callPath(this, itemIndex), { itemIndex }),
				);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many calls',
			description: 'List the meetings held in a Speak room, newest first',
			properties: [
				roomProperty(),
				...returnAllProperties('calls'),
				orderProperty('created_at.desc'),
			],
			async execute(itemIndex) {
				return await readPages.call(
					this,
					callsPath(this, itemIndex),
					compact({ order: text(this, 'order', itemIndex) }),
					wantedRows(this, itemIndex),
					itemIndex,
				);
			},
		},
		{
			value: 'getRecordings',
			name: 'Get Recordings',
			action: 'Get the recordings of a call',
			description:
				'Find the videos recorded during a meeting, with status, duration in seconds and files. Kinescope does not link them; they are matched by the room name and start time in the video title.',
			properties: [roomProperty(), callId],
			execute: callRecordings,
		},
		{
			value: 'getTranscript',
			name: 'Get Transcript',
			action: 'Get the transcript status of a call',
			description:
				'Get the transcript of a meeting: its status and timestamps. Download it once the status is done.',
			properties: [roomProperty(), callId],
			async execute(itemIndex) {
				return dataOf(
					await kinescopeRequest.call(this, 'GET', `${callPath(this, itemIndex)}/transcript`, {
						itemIndex,
					}),
				);
			},
		},
		{
			value: 'downloadTranscript',
			name: 'Download Transcript',
			action: 'Download the transcript of a call',
			description:
				'Download what was said in a meeting: one item per phrase with speaker and time, talk time per speaker, the whole text, or a .txt file. Works once the transcript status is done.',
			properties: [
				roomProperty(),
				callId,
				{
					displayName: 'Output',
					name: 'output',
					type: 'options',
					default: 'segments',
					options: [
						{
							name: 'Phrases',
							value: 'segments',
							description: 'One item per phrase: speaker, text, start and end in seconds',
						},
						{
							name: 'Talk Time per Speaker',
							value: 'speakers',
							description:
								'One item per speaker: how many phrases, how many seconds spoken, first and last time heard',
						},
						{
							name: 'Text',
							value: 'text',
							description: 'One item with the whole transcript as Kinescope writes it',
						},
						{
							name: 'File',
							value: 'file',
							description: 'One item with the transcript as a .txt file in binary data',
						},
					],
				},
				{
					displayName: 'Put Output File in Field',
					name: 'binaryPropertyName',
					type: 'string',
					default: 'data',
					displayOptions: { show: { output: ['file'] } },
					hint: 'The name of the output binary field to put the file in',
				},
			],
			executeAll: downloadTranscript,
		},
	],
};
