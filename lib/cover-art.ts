import { config } from "@/lib/config";

type MusicBrainzRecording = { releases?: Array<{ id?: string }> };
type CoverArtRelease = { images?: Array<{ front?: boolean; thumbnails?: { [size: string]: string } }> };

export async function getCoverArtUrl(musicbrainzRecordingId: string | null) {
  if (!musicbrainzRecordingId) return null;

  try {
    const recordingResponse = await fetch(`https://musicbrainz.org/ws/2/recording/${encodeURIComponent(musicbrainzRecordingId)}?inc=releases&fmt=json`, {
      headers: { "User-Agent": config.musicBrainzUserAgent, Accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!recordingResponse.ok) return null;

    const recording = await recordingResponse.json() as MusicBrainzRecording;
    const releaseId = recording.releases?.find((release) => release.id)?.id;
    if (!releaseId) return null;

    const coverResponse = await fetch(`https://coverartarchive.org/release/${encodeURIComponent(releaseId)}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!coverResponse.ok) return null;

    const cover = await coverResponse.json() as CoverArtRelease;
    const front = cover.images?.find((image) => image.front) ?? cover.images?.[0];
    const url = front?.thumbnails?.["250"] ?? front?.thumbnails?.small ?? null;
    return url?.replace(/^http:\/\//, "https://") ?? null;
  } catch {
    return null;
  }
}