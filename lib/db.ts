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
  provider: "spotify" | "youtube" | "tidal";
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
        provider TEXT NOT NULL CHECK (provider IN ('spotify','youtube','tidal')),
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

      CREATE TABLE IF NOT EXISTS cover_art_cache (
        recording_id TEXT PRIMARY KEY,
        release_id TEXT,
        image_url TEXT,
        fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_tracks_submission ON submission_tracks(submission_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_match_status ON submission_tracks(musicbrainz_match_status);
      CREATE INDEX IF NOT EXISTS idx_tracks_recording ON submission_tracks(musicbrainz_recording_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_challenge_submitted ON submissions(challenge_id, submitted_at);
    `);
    const submissionsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'submissions'").get() as { sql?: string } | undefined;
    if (submissionsSchema?.sql && !submissionsSchema.sql.includes("'tidal'")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        DROP INDEX IF EXISTS idx_submissions_challenge;
        CREATE TABLE submissions_new (
          id TEXT PRIMARY KEY,
          challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
          participant_key TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('spotify','youtube','tidal')),
          playlist_id TEXT NOT NULL,
          playlist_name TEXT NOT NULL,
          playlist_url TEXT NOT NULL,
          snapshot_id TEXT,
          submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (challenge_id, participant_key),
          UNIQUE (challenge_id, provider, playlist_id)
        );
        INSERT INTO submissions_new SELECT * FROM submissions;
        DROP TABLE submissions;
        ALTER TABLE submissions_new RENAME TO submissions;
        CREATE INDEX idx_submissions_challenge ON submissions(challenge_id);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }
    for (const column of ["musicbrainz_track_name", "musicbrainz_artist_name", "musicbrainz_match_status", "musicbrainz_match_confidence", "musicbrainz_candidates_json", "musicbrainz_match_error"]) {
      try { db.exec(`ALTER TABLE submission_tracks ADD COLUMN ${column} TEXT`); } catch {}
    }
    // Cover-art cache table for older DBs created before it existed.
    db.exec(`
      CREATE TABLE IF NOT EXISTS cover_art_cache (
        recording_id TEXT PRIMARY KEY,
        release_id TEXT,
        image_url TEXT,
        fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_submission ON submission_tracks(submission_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_match_status ON submission_tracks(musicbrainz_match_status);
      CREATE INDEX IF NOT EXISTS idx_tracks_recording ON submission_tracks(musicbrainz_recording_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_challenge_submitted ON submissions(challenge_id, submitted_at);
    `);
    globalForDb.__playlistDb = db;
  }
  // Self-heal for long-lived/HMR-persisted connections that were opened
  // before cover_art_cache existed: IF NOT EXISTS is cheap, run every time.
  try {
    globalForDb.__playlistDb.exec(`
      CREATE TABLE IF NOT EXISTS cover_art_cache (
        recording_id TEXT PRIMARY KEY,
        release_id TEXT,
        image_url TEXT,
        fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch {
    // Best effort; callers fall back to empty cache below.
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
    // Snapshot old match results before delete so resubmissions only
    // re-queue tracks that actually changed (same provider_track_id +
    // same names/isrc => carry over the previous MusicBrainz result).
    const oldByProviderTrackId = new Map<string, Array<{
      track_name: string; artist_name: string; provider_artist_id: string | null; isrc: string | null;
      musicbrainz_recording_id: string | null; musicbrainz_artist_id: string | null; musicbrainz_match_method: string | null;
      musicbrainz_track_name: string | null; musicbrainz_artist_name: string | null; musicbrainz_match_status: string;
      musicbrainz_match_confidence: number | null; musicbrainz_candidates_json: string | null; musicbrainz_match_error: string | null;
    }>>();
    if (current) {
      const oldRows = db.prepare(`
        SELECT track_name, artist_name, provider_artist_id, isrc,
               provider_track_id,
               musicbrainz_recording_id, musicbrainz_artist_id, musicbrainz_match_method,
               musicbrainz_track_name, musicbrainz_artist_name, musicbrainz_match_status,
               musicbrainz_match_confidence, musicbrainz_candidates_json, musicbrainz_match_error
        FROM submission_tracks WHERE submission_id = ?
      `).all(current.id) as Array<{
        track_name: string; artist_name: string; provider_artist_id: string | null; isrc: string | null;
        provider_track_id: string;
        musicbrainz_recording_id: string | null; musicbrainz_artist_id: string | null; musicbrainz_match_method: string | null;
        musicbrainz_track_name: string | null; musicbrainz_artist_name: string | null; musicbrainz_match_status: string;
        musicbrainz_match_confidence: number | null; musicbrainz_candidates_json: string | null; musicbrainz_match_error: string | null;
      }>;
      for (const row of oldRows) {
        const list = oldByProviderTrackId.get(row.provider_track_id) ?? [];
        list.push(row);
        oldByProviderTrackId.set(row.provider_track_id, list);
      }
    }
    if (current) db.prepare("DELETE FROM submissions WHERE id = ?").run(current.id);

    const submissionId = newId();
    db.prepare(`
      INSERT INTO submissions (id,challenge_id,participant_key,provider,playlist_id,playlist_name,playlist_url,snapshot_id,submitted_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).run(submissionId, input.challengeId, input.participantKey, input.provider, input.playlistId, input.playlistName, input.playlistUrl, input.snapshotId);

    const insertTrack = db.prepare(`
      INSERT INTO submission_tracks
      (id,submission_id,position,provider_track_id,track_name,artist_name,provider_artist_id,isrc,musicbrainz_recording_id,musicbrainz_artist_id,musicbrainz_match_method,musicbrainz_track_name,musicbrainz_artist_name,musicbrainz_match_status,musicbrainz_match_confidence,musicbrainz_candidates_json,musicbrainz_match_error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    let reused = 0;
    for (const track of input.tracks) {
      const candidates = oldByProviderTrackId.get(track.providerTrackId);
      let carried: {
        musicbrainz_recording_id: string | null; musicbrainz_artist_id: string | null; musicbrainz_match_method: string | null;
        musicbrainz_track_name: string | null; musicbrainz_artist_name: string | null; musicbrainz_match_status: string;
        musicbrainz_match_confidence: number | null; musicbrainz_candidates_json: string | null; musicbrainz_match_error: string | null;
      } | null = null;
      if (candidates?.length) {
        const idx = candidates.findIndex((old) =>
          old.track_name === track.trackName &&
          old.artist_name === track.artistName &&
          (old.isrc ?? null) === (track.isrc ?? null) &&
          (old.provider_artist_id ?? null) === (track.providerArtistId ?? null),
        );
        if (idx >= 0) {
          const [old] = candidates.splice(idx, 1);
          const attempted = old.musicbrainz_recording_id !== null || old.musicbrainz_match_confidence !== null || old.musicbrainz_candidates_json !== null;
          if (attempted) {
            carried = old;
            reused++;
          }
        }
      }
      if (carried) {
        insertTrack.run(newId(), submissionId, track.position, track.providerTrackId, track.trackName, track.artistName, track.providerArtistId, track.isrc, carried.musicbrainz_recording_id, carried.musicbrainz_artist_id, carried.musicbrainz_match_method, carried.musicbrainz_track_name, carried.musicbrainz_artist_name, carried.musicbrainz_match_status, carried.musicbrainz_match_confidence, carried.musicbrainz_candidates_json, carried.musicbrainz_match_error);
      } else {
        insertTrack.run(newId(), submissionId, track.position, track.providerTrackId, track.trackName, track.artistName, track.providerArtistId, track.isrc, track.musicbrainzRecordingId, track.musicbrainzArtistId, track.musicbrainzMatchMethod, null, null, "unmatched", null, null, null);
      }
    }

    db.exec("COMMIT");
    return { submissionId, replaced: Boolean(current), reused, queued: input.tracks.length - reused };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function updateSubmissionTrackMatches(submissionId: string, position: number, recordingId: string | null, artistId: string | null, method: string | null, trackName: string | null = null, artistName: string | null = null, status: "matched" | "ambiguous" | "unmatched" = recordingId ? "matched" : "unmatched", confidence: number | null = null, candidatesJson: string | null = null) {
  getDb().prepare(`
    UPDATE submission_tracks
    SET musicbrainz_recording_id = ?, musicbrainz_artist_id = ?, musicbrainz_match_method = ?, musicbrainz_track_name = ?, musicbrainz_artist_name = ?, musicbrainz_match_status = ?, musicbrainz_match_confidence = ?, musicbrainz_candidates_json = ?, musicbrainz_match_error = NULL
    WHERE submission_id = ? AND position = ?
  `).run(recordingId, artistId, method, trackName, artistName, status, confidence, candidatesJson, submissionId, position);
}

export function recordMatchError(submissionId: string, position: number, message: string) {
  getDb().prepare(`
    UPDATE submission_tracks
    SET musicbrainz_match_error = ?
    WHERE submission_id = ? AND position = ?
  `).run(message, submissionId, position);
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

// --- Decoupled read path: aggregated, paginated, DB-only. ---
// Pages must never call MusicBrainz directly; matching happens in a
// background worker and only stored canonical rows are read here.

export type TopSong = { artist: string; track: string; recordingId: string | null; artistId: string | null; count: number };

const CANONICAL_FILTER = `st.musicbrainz_match_status = 'matched'
  AND st.musicbrainz_recording_id IS NOT NULL
  AND st.musicbrainz_track_name IS NOT NULL
  AND st.musicbrainz_artist_name IS NOT NULL`;

export function getTopSongs(challengeId: string, options: { query?: string; limit: number; offset: number }): { items: Array<TopSong & { rank: number }>; total: number } {
  const db = getDb();
  const q = (options.query ?? "").trim().toLocaleLowerCase("de-DE");
  const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const whereQuery = like
    ? `AND (LOWER(st.musicbrainz_artist_name) LIKE ? ESCAPE '\\' OR LOWER(st.musicbrainz_track_name) LIKE ? ESCAPE '\\')`
    : "";
  const countRow = db.prepare(`
    SELECT COUNT(*) as n FROM (
      SELECT st.musicbrainz_recording_id
      FROM submission_tracks st
      JOIN submissions s ON s.id = st.submission_id
      WHERE s.challenge_id = ? AND ${CANONICAL_FILTER} ${whereQuery}
      GROUP BY st.musicbrainz_recording_id
    )
  `).get(...(like ? [challengeId, like, like] : [challengeId])) as { n: number };
  const total = Number(countRow?.n ?? 0);
  // Rank over the FULL unfiltered set, then apply the search filter on the
  // outer query — so matches keep their global rank (e.g. #654) even when
  // they sit outside the Top 500.
  const outerFilter = like
    ? `AND (LOWER(artist) LIKE ? ESCAPE '\\' OR LOWER(track) LIKE ? ESCAPE '\\')`
    : "";
  const items = db.prepare(`
    SELECT artist, track, recording_id as recordingId, artist_id as artistId, count, rank FROM (
      SELECT
        st.musicbrainz_artist_name as artist,
        st.musicbrainz_track_name as track,
        st.musicbrainz_recording_id as recording_id,
        MIN(st.musicbrainz_artist_id) as artist_id,
        COUNT(*) as count,
        ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, st.musicbrainz_artist_name ASC, st.musicbrainz_track_name ASC) as rank
      FROM submission_tracks st
      JOIN submissions s ON s.id = st.submission_id
      WHERE s.challenge_id = ? AND ${CANONICAL_FILTER}
      GROUP BY st.musicbrainz_recording_id
    )
    WHERE 1 = 1 ${outerFilter}
    ORDER BY rank ASC
    LIMIT ? OFFSET ?
  `).all(...(like ? [challengeId, like, like, options.limit, options.offset] : [challengeId, options.limit, options.offset])) as Array<TopSong & { rank: number; count: number }>;
  return { items: items.map((r) => ({ ...r, count: Number(r.count), rank: Number(r.rank) })), total };
}

export function getTopPreview(challengeId: string, limit = 5): TopSong[] {
  return getTopSongs(challengeId, { limit, offset: 0 }).items;
}

export type ArtistGroup = { artist: string; artistKey: string; artistId: string | null; songCount: number; totalVotes: number };
export type ArtistSong = { track: string; recordingId: string | null; count: number };

export function getArtistGroups(challengeId: string, options: { query?: string; limit: number; offset: number }): { groups: ArtistGroup[]; totalArtists: number; totalSongs: number } {
  const db = getDb();
  const q = (options.query ?? "").trim().toLocaleLowerCase("de-DE");
  const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  // When searching we must keep songs whose track matches even if the
  // artist name does not, so filter at the song level first.
  const whereQuery = like
    ? `AND (LOWER(st.musicbrainz_artist_name) LIKE ? ESCAPE '\\' OR LOWER(st.musicbrainz_track_name) LIKE ? ESCAPE '\\')`
    : "";
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(st.musicbrainz_artist_id, 'name:' || LOWER(st.musicbrainz_artist_name))) as artists,
           COUNT(DISTINCT st.musicbrainz_recording_id) as songs
    FROM submission_tracks st
    JOIN submissions s ON s.id = st.submission_id
    WHERE s.challenge_id = ? AND ${CANONICAL_FILTER} ${whereQuery}
  `).get(...(like ? [challengeId, like, like] : [challengeId])) as { artists: number; songs: number };
  const groups = db.prepare(`
    SELECT
      MIN(st.musicbrainz_artist_name) as artist,
      COALESCE(st.musicbrainz_artist_id, 'name:' || LOWER(st.musicbrainz_artist_name)) as artistKey,
      st.musicbrainz_artist_id as artistId,
      COUNT(DISTINCT st.musicbrainz_recording_id) as songCount,
      COUNT(*) as totalVotes
    FROM submission_tracks st
    JOIN submissions s ON s.id = st.submission_id
    WHERE s.challenge_id = ? AND ${CANONICAL_FILTER} ${whereQuery}
    GROUP BY COALESCE(st.musicbrainz_artist_id, 'name:' || LOWER(st.musicbrainz_artist_name))
    ORDER BY MIN(st.musicbrainz_artist_name) COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(...(like ? [challengeId, like, like, options.limit, options.offset] : [challengeId, options.limit, options.offset])) as Array<{ artist: string; artistKey: string; artistId: string | null; songCount: number; totalVotes: number }>;
  return {
    groups: groups.map((g) => ({ ...g, songCount: Number(g.songCount), totalVotes: Number(g.totalVotes) })),
    totalArtists: Number(totals?.artists ?? 0),
    totalSongs: Number(totals?.songs ?? 0),
  };
}

export function getArtistSongs(challengeId: string, artistKeys: string[]): Map<string, ArtistSong[]> {
  const out = new Map<string, ArtistSong[]>();
  if (!artistKeys.length) return out;
  const placeholders = artistKeys.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT
      COALESCE(st.musicbrainz_artist_id, 'name:' || LOWER(st.musicbrainz_artist_name)) as artistKey,
      st.musicbrainz_track_name as track,
      st.musicbrainz_recording_id as recordingId,
      COUNT(*) as count
    FROM submission_tracks st
    JOIN submissions s ON s.id = st.submission_id
    WHERE s.challenge_id = ? AND ${CANONICAL_FILTER}
      AND COALESCE(st.musicbrainz_artist_id, 'name:' || LOWER(st.musicbrainz_artist_name)) IN (${placeholders})
    GROUP BY artistKey, st.musicbrainz_recording_id
    ORDER BY count DESC, track COLLATE NOCASE ASC
  `).all(challengeId, ...artistKeys) as Array<{ artistKey: string; track: string; recordingId: string | null; count: number }>;
  for (const row of rows) {
    const list = out.get(row.artistKey) ?? [];
    list.push({ track: row.track, recordingId: row.recordingId, count: Number(row.count) });
    out.set(row.artistKey, list);
  }
  return out;
}

// --- Cover-art cache (DB-backed, TTL). Pages read this only. ---

export function getCachedCoverArt(recordingIds: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(recordingIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    const rows = getDb().prepare(`
      SELECT recording_id, image_url FROM cover_art_cache
      WHERE recording_id IN (${placeholders}) AND expires_at > ?
    `).all(...ids, now) as Array<{ recording_id: string; image_url: string | null }>;
    for (const row of rows) out.set(row.recording_id, row.image_url);
  } catch {
    // Table may not exist yet on very old DBs / stale connections —
    // callers treat a miss as "lazy-load later".
  }
  return out;
}

export function getMissingCoverArtIds(recordingIds: string[]): string[] {
  const cached = getCachedCoverArt(recordingIds);
  return [...new Set(recordingIds.filter(Boolean))].filter((id) => !cached.has(id));
}

export function setCachedCoverArt(recordingId: string, releaseId: string | null, imageUrl: string | null, ttlSeconds = 7 * 24 * 3600) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO cover_art_cache (recording_id, release_id, image_url, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(recording_id) DO UPDATE SET
      release_id = excluded.release_id,
      image_url = excluded.image_url,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(recordingId, releaseId, imageUrl, new Date(now).toISOString(), new Date(now + ttlSeconds * 1000).toISOString());
}

// --- Background matching queue: tracks never matched yet. ---

export type PendingTrack = { submission_id: string; position: number; track_name: string; artist_name: string; isrc: string | null };

export function getPendingMatchTracks(limit = 50): PendingTrack[] {
  return getDb().prepare(`
    SELECT st.submission_id, st.position, st.track_name, st.artist_name, st.isrc
    FROM submission_tracks st
    WHERE st.musicbrainz_match_confidence IS NULL
      AND st.musicbrainz_candidates_json IS NULL
      AND st.musicbrainz_recording_id IS NULL
    ORDER BY st.rowid ASC
    LIMIT ?
  `).all(limit) as PendingTrack[];
}

export function countPendingMatchTracks(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as n FROM submission_tracks st
    WHERE st.musicbrainz_match_confidence IS NULL
      AND st.musicbrainz_candidates_json IS NULL
      AND st.musicbrainz_recording_id IS NULL
  `).get() as { n: number };
  return Number(row?.n ?? 0);
}
