import { matchRecording } from "@/lib/musicbrainz";
import { updateSubmissionTrackMatches } from "@/lib/db";

export async function enrichSubmissionTracks(submissionId: string, tracks: Array<{ position: number; trackName: string; artistName: string; isrc?: string | null }>) {
  for (const track of tracks) {
    try {
      const match = await matchRecording({ title: track.trackName, artist: track.artistName, isrc: track.isrc ?? undefined });
      updateSubmissionTrackMatches(submissionId, track.position, match?.recordingId ?? null, match?.artistId ?? null, match?.method ?? null, match?.trackName ?? null, match?.artistName ?? null, match?.status ?? "unmatched", match?.confidence ?? null, match?.candidates ? JSON.stringify(match.candidates) : null);
    } catch {
      // Matching is optional; the provider's artist and track names remain available.
    }
  }
}