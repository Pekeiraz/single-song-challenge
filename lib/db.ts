import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dataDir = join(process.cwd(), "data");
const dbPath = join(dataDir, "playlist-challenge.db");
mkdirSync(dataDir, { recursive: true });

const globalForDb = globalThis as typeof globalThis & { __playlistDb?: DatabaseSync };

export type Challenge = {
  id: string;
  name: string;
  slug: string;
  status: "draft" | "open" | "closed";
  starts_at: string | null;
  ends_at: string | null;
};

export type SubmissionTrackInput = {
  position: number;
  providerTrackId: string;
  trackName: string;
  artistName: string;
  providerArtistId: string | null;
  isrc: string | null;
  musicbrainzRecordingId: string | null;
  musicbrainzArtistId: string | null;
  musicbrainzMatchMethod: string | null;
};

export type SubmissionInput = {
  challengeId: string;
  participantKey: string;
  provider: "spotify" | "youtube";
  playlistId: string;
  playlistName: string;
  playlistUrl: string;
  snapshotId: string | null;
  tracks: SubmissionTrackInput[];
};

export function getDb(): DatabaseSync {
  if (!globalForDb.__playlistDb) {
    const db = new DatabaseSync(dbPath, { timeout: 5000 });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('draft','open','closed')),
        starts_at TEXT,
        ends_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        participant_key TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('spotify','youtube')),
        playlist_id TEXT NOT NULL,
        playlist_name TEXT NOT NULL,
        playlist_url TEXT NOT NULL,
        snapshot_id TEXT,
        submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (challenge_id, participant_key),
        UNIQUE (challenge_id, provider, playlist_id)
      );

      CREATE INDEX IF NOT EXISTS idx_submissions_challenge ON submissions(challenge_id);

      CREATE TABLE IF NOT EXISTS submission_tracks (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        provider_track_id TEXT NOT NULL,
        track_name TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        provider_artist_id TEXT,
        isrc TEXT,
        musicbrainz_recording_id TEXT,
        musicbrainz_artist_id TEXT,
        musicbrainz_match_method TEXT,
        musicbrainz_track_name TEXT,
        musicbrainz_artist_name TEXT,
        musicbrainz_match_status TEXT NOT NULL DEFAULT 'unmatched',
        musicbrainz_match_confidence REAL,
        musicbrainz_candidates_json TEXT,
        musicbrainz_match_error TEXT,
        UNIQUE (submission_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_submission_tracks_artist
        ON submission_tracks(musicbrainz_artist_id, track_name);

      CREATE TABLE IF NOT EXISTS youtube_playlist_cache (
        playlist_id TEXT PRIMARY KEY,
        playlist_name TEXT NOT NULL,
        owner_channel_id TEXT,
        playlist_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        items_json TEXT NOT NULL
      );
    `);
    for (const column of ["musicbrainz_track_name", "musicbrainz_artist_name", "musicbrainz_match_status", "musicbrainz_match_confidence", "musicbrainz_candidates_json", "musicbrainz_match_error"]) {
      try { db.exec(`ALTER TABLE submission_tracks ADD COLUMN ${column} TEXT`); } catch {}
    }
    globalForDb.__playlistDb = db;
  }
  return globalForDb.__playlistDb;
}

export function newId() {
  return crypto.randomUUID();
}

export function getOpenChallengeBySlug(slug: string): Challenge | null {
  return (getDb().prepare("SELECT id,name,slug,status,starts_at,ends_at FROM challenges WHERE slug = ? AND status = 'open'").get(slug) as Challenge | undefined) ?? null;
}


export function getChallengeBySlug(slug: string): Challenge | null {
  return (getDb().prepare("SELECT id,name,slug,status,starts_at,ends_at FROM challenges WHERE slug = ?").get(slug) as Challenge | undefined) ?? null;
}

export function getChallengeById(id: string): Challenge | null {
  return (getDb().prepare("SELECT id,name,slug,status,starts_at,ends_at FROM challenges WHERE id = ?").get(id) as Challenge | undefined) ?? null;
}

export function listOpenChallenges(): Challenge[] {
  return getDb().prepare("SELECT id,name,slug,status,starts_at,ends_at FROM challenges WHERE status = 'open' ORDER BY starts_at IS NULL, starts_at ASC").all() as Challenge[];
}

export function getCachedYouTubePlaylist(playlistId: string, maxAgeSeconds: number) {
  const row = getDb().prepare("SELECT playlist_id,playlist_name,owner_channel_id,playlist_url,fetched_at,item_count,items_json FROM youtube_playlist_cache WHERE playlist_id = ?").get(playlistId) as {
    playlist_id: string; playlist_name: string; owner_channel_id: string | null; playlist_url: string; fetched_at: string; item_count: number; items_json: string;
  } | undefined;
  if (!row) return null;
  const age = (Date.now() - new Date(row.fetched_at).getTime()) / 1000;
  if (age > maxAgeSeconds) return null;
  return { ...row, items: JSON.parse(row.items_json) as unknown[] };
}

export function upsertYouTubePlaylistCache(input: {
  playlistId: string;
  playlistName: string;
  ownerChannelId: string | null;
  playlistUrl: string;
  items: unknown[];
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO youtube_playlist_cache (playlist_id,playlist_name,owner_channel_id,playlist_url,fetched_at,item_count,items_json)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(playlist_id) DO UPDATE SET
      playlist_name=excluded.playlist_name,
      owner_channel_id=excluded.owner_channel_id,
      playlist_url=excluded.playlist_url,
      fetched_at=excluded.fetched_at,
      item_count=excluded.item_count,
      items_json=excluded.items_json
  `).run(input.playlistId, input.playlistName, input.ownerChannelId, input.playlistUrl, new Date().toISOString(), input.items.length, JSON.stringify(input.items));
}

export function replaceSubmission(input: SubmissionInput) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const challenge = getChallengeById(input.challengeId);
    if (!challenge || challenge.status !== "open") throw new Error("Challenge ist nicht offen.");

    const claimed = db.prepare(`SELECT id, participant_key FROM submissions WHERE challenge_id = ? AND provider = ? AND playlist_id = ?`).get(input.challengeId, input.provider, input.playlistId) as {id: string; participant_key: string} | undefined;
    if (claimed && claimed.participant_key !== input.participantKey) {
      throw new Error("Diese Playlist wurde in dieser Challenge bereits von einem anderen Teilnehmer eingereicht.");
    }

    const current = db.prepare(`SELECT id FROM submissions WHERE challenge_id = ? AND participant_key = ?`).get(input.challengeId, input.participantKey) as {id: string} | undefined;
    if (current) db.prepare("DELETE FROM submissions WHERE id = ?").run(current.id);

    const submissionId = newId();
    db.prepare(`
      INSERT INTO submissions (id,challenge_id,participant_key,provider,playlist_id,playlist_name,playlist_url,snapshot_id,submitted_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).run(submissionId, input.challengeId, input.participantKey, input.provider, input.playlistId, input.playlistName, input.playlistUrl, input.snapshotId);

    const insertTrack = db.prepare(`
      INSERT INTO submission_tracks
      (id,submission_id,position,provider_track_id,track_name,artist_name,provider_artist_id,isrc,musicbrainz_recording_id,musicbrainz_artist_id,musicbrainz_match_method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const track of input.tracks) {
      insertTrack.run(newId(), submissionId, track.position, track.providerTrackId, track.trackName, track.artistName, track.providerArtistId, track.isrc, track.musicbrainzRecordingId, track.musicbrainzArtistId, track.musicbrainzMatchMethod);
    }

    db.exec("COMMIT");
    return { submissionId, replaced: Boolean(current) };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function updateSubmissionTrackMatches(submissionId: string, position: number, recordingId: string | null, artistId: string | null, method: string | null, trackName: string | null = null, artistName: string | null = null, status: "matched" | "ambiguous" | "unmatched" = recordingId ? "matched" : "unmatched", confidence: number | null = null, candidatesJson: string | null = null) {
  getDb().prepare(`
    UPDATE submission_tracks
    SET musicbrainz_recording_id = ?, musicbrainz_artist_id = ?, musicbrainz_match_method = ?, musicbrainz_track_name = ?, musicbrainz_artist_name = ?, musicbrainz_match_status = ?, musicbrainz_match_confidence = ?, musicbrainz_candidates_json = ?
    WHERE submission_id = ? AND position = ?
  `).run(recordingId, artistId, method, trackName, artistName, status, confidence, candidatesJson, submissionId, position);
}

export type ResultRow = { artist_name: string; track_name: string; provider_track_id: string; musicbrainz_artist_id: string | null; musicbrainz_recording_id: string | null; musicbrainz_track_name: string | null; musicbrainz_artist_name: string | null; musicbrainz_match_status: string; musicbrainz_match_confidence: number | null; musicbrainz_candidates_json: string | null; provider: string; submission_id: string };
export function getResultRows(challengeId: string): ResultRow[] {
  return getDb().prepare(`
    SELECT st.artist_name, st.track_name, st.provider_track_id, st.musicbrainz_artist_id, st.musicbrainz_recording_id, st.musicbrainz_track_name, st.musicbrainz_artist_name, st.musicbrainz_match_status, st.musicbrainz_match_confidence, st.musicbrainz_candidates_json, s.provider, s.id as submission_id
    FROM submission_tracks st
    JOIN submissions s ON s.id = st.submission_id
    WHERE s.challenge_id = ?
    ORDER BY s.submitted_at ASC, st.position ASC
  `).all(challengeId) as ResultRow[];
}
