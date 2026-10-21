import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import type { Resource } from '../../shared/spec';
import { buildProperties, executeResources } from '../../shared/spec';
import { CREDENTIAL } from '../../shared/transport';
import { loadOptions } from './methods';
import { callResource } from './resources/call';
import { customRequestResource } from './resources/customRequest';
import { folderResource } from './resources/folder';
import { participantResource } from './resources/participant';
import { projectResource } from './resources/project';
import { restreamResource } from './resources/restream';
import { roomResource } from './resources/room';
import { signingKeyResource } from './resources/signingKey';
import { subtitleResource } from './resources/subtitle';
import { userResource } from './resources/user';
import { videoResource } from './resources/video';
import { webhookResource } from './resources/webhook';

const resources: Resource[] = [
	roomResource,
	participantResource,
	callResource,
	restreamResource,
	videoResource,
	subtitleResource,
	projectResource,
	folderResource,
	userResource,
	webhookResource,
	signingKeyResource,
	customRequestResource,
];

export class Kinescope implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Kinescope',
		name: 'kinescope',
		// The same drawing in both themes: the mark sits on its own orange disc.
		icon: { light: 'file:../../icons/kinescope.svg', dark: 'file:../../icons/kinescope.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description:
			'Create Speak meeting rooms, read their calls and transcripts, and download videos and meeting recordings from Kinescope',
		defaults: { name: 'Kinescope' },
		usableAsTool: true,
		builderHint: {
			searchHint:
				'Kinescope is a video hosting platform; Speak is its video meeting tool. Room → Create needs an owner ID from User → Get Many and returns the link people join by; recording and transcription can start automatically. Each meeting held in a room is a Call: Call → Download Transcript gives phrases with speaker and time, or talk time per speaker, once Get Transcript reports status done. Meeting recordings land in the catalog as videos: Video → Download gets the original file or a signed link for Google Drive, Yandex Disk or S3; duration is in seconds. Automatic recording starts only when the owner joins; Room → Get Admin Link signs a link that lets a host in as admin, after the signing key of the credential is registered once with Signing Key → Register. Subtitle → Generate (Wait for Recognition on) then Subtitle → Download as Text gives the text of a recording without speaker names. Video → Update renames a recording, Video → Move files it into a project or folder from Project → Get Many and Folder → Get Many. Who joined a meeting is not in the API, only in Speak webhooks. Custom Request reaches every other route. Tokens are per workspace.',
			relatedNodes: [
				{
					nodeType: 'n8n-nodes-kinescope.kinescopeTrigger',
					relationHint:
						'Starts a workflow when a video is ready, a live stream changes state, or a Speak meeting or recording starts and ends',
				},
			],
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: buildProperties(resources, 'room'),
	};

	methods = { loadOptions };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await executeResources.call(this, resources);
	}
}
