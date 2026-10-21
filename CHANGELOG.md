# Changelog

## 0.1.0

The first version: the Kinescope node, the Kinescope Trigger and the Kinescope API credential.

- **Room**: create Speak rooms with automatic recording and transcription, the waiting room, Wait for
  Host and restream destinations; get, list by status, type and name, update, delete. The link is
  filled in where Kinescope's list leaves it empty. Get Admin Link signs a link that lets a person in
  as room admin, with a private key kept in the credential.
- **Participant**: add a workspace user as admin or manager, get, list by role and name, rename,
  remove.
- **Call**: get, list, find the recordings of a call by the title Kinescope gives them, transcript
  status, and the transcript as phrases, talk time per speaker, text or a .txt file.
- **Restream Destination**: list and update, stream keys hidden unless asked for.
- **Video**: get, list by project, status, title and IDs, delete, and download the best MP4, the
  original, one quality or the audio track — into binary data or as a signed link.
- **User**: list the users of the workspace, for room owners and participants.
- **Webhook**: create, list, update without resending every field, delete; passwords hidden unless
  asked for.
- **Signing Key**: register the public half of the credential's key, list, delete.
- **Custom Request**: any route of the API with the same token and rate limit.
- **Kinescope Trigger**: thirteen documented events; registers its own webhook with Basic Auth and
  removes it on deactivation; filters by video status and room.

Checked on a live workspace except a real transcript, which Kinescope never produced; see "What was checked" in the
README. Kinescope refused the Speak webhook events at the time of release.
