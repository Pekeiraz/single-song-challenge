import { getDb } from "../lib/db.ts";

const BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || "PlaylistChallenge-backfill-work/0.2.0 (contact: configure MUSICBRAINZ_USER_AGENT)";
const MIN_REQUEST_INTERVAL_MS = 1500;
let nextRequestAt = 0;

async function getWorkId(recordingId) {
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS + Math.floor(Math.random() * 250);
  const response = await fetch(`${BASE}/recording/${encodeURIComponent(recordingId)}?inc=work-rels&fmt=json`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`MusicBrainz ${response.status}`);
  const data = await response.json();
  for (const rel of data.relations ?? []) {
    if (rel["target-type"] === "work" && rel.work?.id) return rel.work.id;
  }
  return null;
}

const db = getDb();
const rows = db.prepare(`
  SELECT submission_id, position, musicbrainz_recording_id
  FROM submission_tracks
  WHERE musicbrainz_recording_id IS NOT NULL
    AND musicbrainz_work_id IS NULL
  ORDER BY submission_id, position
`).all();
const update = db.prepare(`
  UPDATE submission_tracks
  SET musicbrainz_work_id = ?
  WHERE submission_id = ? AND position = ?
`);

let updated = 0;
let missing = 0;
for (const row of rows) {
  try {
    const workId = await getWorkId(row.musicbrainz_recording_id);
    if (workId) {
      update.run(workId, row.submission_id, row.position);
      updated++;
      console.log(`Work ${workId} for ${row.musicbrainz_recording_id}`);
    } else {
      missing++;
      console.log(`No work for ${row.musicbrainz_recording_id} (falls back to name grouping)`);
    }
  } catch (error) {
    console.error(`Failed ${row.musicbrainz_recording_id}:`, error instanceof Error ? error.message : error);
  }
}

console.log(`Backfilled work ids for ${updated} of ${rows.length} recordings (${missing} without work).`);
