import { matchRecording } from "@/lib/musicbrainz";
import { countPendingMatchTracks, getPendingMatchTracks, recordMatchError, updateSubmissionTrackMatches } from "@/lib/db";

const BATCH = Number.parseInt(process.argv.find((a) => /^\d+$/.test(a)) ?? "", 10) || 50;
const LOOP = process.argv.includes("--loop");
const LOOP_DELAY_MS = 10_000;

async function processBatch(): Promise<number> {
  const pending = countPendingMatchTracks();
  console.log(`[match-worker] ${pending} pending tracks; processing up to ${BATCH}.`);
  const tracks = getPendingMatchTracks(BATCH);
  let matched = 0;
  for (const track of tracks) {
    try {
      const match = await matchRecording({ title: track.track_name, artist: track.artist_name, isrc: track.isrc ?? undefined });
      updateSubmissionTrackMatches(
        track.submission_id,
        track.position,
        match && "recordingId" in match ? match.recordingId ?? null : null,
        match && "artistId" in match ? match.artistId ?? null : null,
        match && "method" in match ? match.method ?? null : null,
        match && "trackName" in match ? match.trackName ?? null : null,
        match && "artistName" in match ? match.artistName ?? null : null,
        match?.status ?? "unmatched",
        match?.confidence ?? null,
        match?.candidates ? JSON.stringify(match.candidates) : null,
      );
      if (match?.status === "matched") matched++;
      console.log(`[match-worker] ${match?.status ?? "error"}: ${track.artist_name} - ${track.track_name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        recordMatchError(track.submission_id, track.position, message);
      } catch {
        // Best effort; the track stays pending for the next run.
      }
      console.error(`[match-worker] failed ${track.artist_name} - ${track.track_name}: ${message}`);
    }
  }
  console.log(`[match-worker] done: ${matched}/${tracks.length} matched.`);
  return tracks.length;
}

async function main() {
  if (!LOOP) {
    await processBatch();
    return;
  }
  console.log(`[match-worker] loop mode: batch=${BATCH}, delay=${LOOP_DELAY_MS}ms. Ctrl+C to stop.`);
  for (;;) {
    const n = await processBatch();
    if (n === 0) console.log("[match-worker] queue empty, sleeping…");
    await new Promise((resolve) => setTimeout(resolve, LOOP_DELAY_MS));
  }
}

main().catch((error) => {
  console.error("[match-worker] fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
