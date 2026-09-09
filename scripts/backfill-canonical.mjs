import { getDb } from "../lib/db.ts";

const BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || "PlaylistChallenge-backfill/0.2.0 (contact: configure MUSICBRAINZ_USER_AGENT)";
const MIN_REQUEST_INTERVAL_MS = 1500;
let nextRequestAt = 0;

async function getRecording(recordingId) {
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS + Math.floor(Math.random() * 250);
  const response = await fetch(`${BASE}/recording/${encodeURIComponent(recordingId)}?inc=artists&fmt=json`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`MusicBrainz ${response.status}`);
  return response.json();
}

const db = getDb();
const rows = db.prepare(`
  SELECT submission_id, position, musicbrainz_recording_id
  FROM submission_tracks
  WHERE musicbrainz_recording_id IS NOT NULL
    AND (musicbrainz_track_name IS NULL OR musicbrainz_artist_name IS NULL)
  ORDER BY submission_id, position
`).all();
const update = db.prepare(`
  UPDATE submission_tracks
  SET musicbrainz_track_name = ?, musicbrainz_artist_name = ?
  WHERE submission_id = ? AND position = ?
`);

let updated = 0;
for (const row of rows) {
  try {
    const recording = await getRecording(row.musicbrainz_recording_id);
    const artistName = (recording["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" & ");
    if (!recording.title || !artistName) continue;
    update.run(recording.title, artistName, row.submission_id, row.position);
    updated++;
    console.log(`Backfilled ${artistName} - ${recording.title}`);
  } catch (error) {
    console.error(`Failed ${row.musicbrainz_recording_id}:`, error instanceof Error ? error.message : error);
  }
}

console.log(`Backfilled ${updated} of ${rows.length} matched tracks.`);