import type { INodePropertyOptions } from 'n8n-workflow';

/**
 * Every event Kinescope documents for outgoing webhooks.
 *
 * The Speak events are documented, but on 22.10.2026 the webhook route refused
 * them: its validation accepted only media.update.status and the live.* events.
 * They stay in the list so that a workspace where Kinescope accepts them can
 * use them; where it does not, the error says so (see SPEAK_EVENTS_REFUSED).
 */
export const EVENT_OPTIONS: INodePropertyOptions[] = [
	{
		name: 'Live: Cancelled',
		value: 'live.cancelled',
		description: 'A live stream was cancelled',
	},
	{
		name: 'Live: Created',
		value: 'live.created',
		description: 'A live stream event was created, in the API or the interface',
	},
	{
		name: 'Live: Enabled',
		value: 'live.enabled',
		description: 'A live stream became available to viewers',
	},
	{
		name: 'Live: Finished',
		value: 'live.finished',
		description:
			'A live stream ended; video_id is its recording, or a nil UUID when it was not recorded',
	},
	{
		name: 'Live: Streamer Connected',
		value: 'live.connected',
		description: 'The RTMP signal started arriving',
	},
	{
		name: 'Live: Streamer Disconnected',
		value: 'live.disconnected',
		description: 'The RTMP signal stopped',
	},
	{
		name: 'Media: Status Updated',
		value: 'media.update.status',
		description:
			'A video changed status. Status done means its files can be downloaded — Speak recordings included.',
	},
	{
		name: 'Speak: Call Finished',
		value: 'speak.call.finished',
		description: 'A meeting in a Speak room ended',
	},
	{
		name: 'Speak: Call Started',
		value: 'speak.call.started',
		description: 'A meeting in a Speak room started',
	},
	{
		name: 'Speak: Participant Joined',
		value: 'speak.participant.joined',
		description: 'Someone joined a meeting: their name, role and connection ID',
	},
	{
		name: 'Speak: Participant Left',
		value: 'speak.participant.left',
		description: 'Someone left a meeting',
	},
	{
		name: 'Speak: Recording Finished',
		value: 'speak.record.finished',
		description:
			'Recording stopped: complete, failed, aborted or limit_reached. The video still has to be processed in the catalog.',
	},
	{
		name: 'Speak: Recording Started',
		value: 'speak.record.started',
		description: 'Recording of a meeting started',
	},
];

export const EVENT_VALUES = EVENT_OPTIONS.map((option) => String(option.value));

/** Whether an event belongs to Speak and carries room_id and call_id. */
export function isSpeakEvent(event: string): boolean {
	return event.startsWith('speak.');
}

/** What to say when Kinescope refuses an event name in a webhook subscription. */
export const SPEAK_EVENTS_REFUSED =
	'Kinescope does not accept this event in a webhook subscription for this workspace. It documents the Speak events, but its webhook route has been seen to accept only Media: Status Updated and the Live events. Ask Kinescope support to enable Speak webhooks, or leave the Speak events out.';
