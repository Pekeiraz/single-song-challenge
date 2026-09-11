import { config } from "@/lib/config";
import { getCachedCoverArt, setCachedCoverArt } from "@/lib/db";

type MusicBrainzRecording = { releases?: Array<{ id?: string }> };
type CoverArtRelease = { images?: Array<{ front?: boolean; thumbnails?: { [size: string]: string } }> };

const NULL_TTL_SECONDS = 24 * 3600;
const POSITIVE_TTL_SECONDS = 7 * 24 * 3600;

async function fetchFromNetwork(musicbrainzRecordingId: string): Promise<{ releaseId: string | null; url: string | null }> {
  try {
    const recordingResponse = await fetch(`https://musicbrainz.org/ws/2/recording/${encodeURIComponent(musicbrainzRecordingId)}?inc=releases&fmt=json`, {
      headers: { "User-Agent": config.musicBrainzUserAgent, Accept: "application/json" },
      cache: "no-store",
    });
    if (!recordingResponse.ok) return { releaseId: null, url: null };

    const recording = await recordingResponse.json() as MusicBrainzRecording;
    const releaseId = recording.releases?.find((release) => release.id)?.id ?? null;
    if (!releaseId) return { releaseId: null, url: null };

    const coverResponse = await fetch(`https://coverartarchive.org/release/${encodeURIComponent(releaseId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!coverResponse.ok) return { releaseId, url: null };

    const cover = await coverResponse.json() as CoverArtRelease;
    const front = cover.images?.find((image) => image.front) ?? cover.images?.[0];
    const url = front?.thumbnails?.["250"] ?? front?.thumbnails?.small ?? null;
    return { releaseId, url: url?.replace(/^http:\/\//, "https://") ?? null };
  } catch {
    return { releaseId: null, url: null };
  }
}

/** Fetch a single recording's art and persist it (positive + negative caching). */
export async function fetchAndCacheCoverArt(musicbrainzRecordingId: string): Promise<string | null> {
  const { releaseId, url } = await fetchFromNetwork(musicbrainzRecordingId);
  try {
    setCachedCoverArt(musicbrainzRecordingId, releaseId, url, url ? POSITIVE_TTL_SECONDS : NULL_TTL_SECONDS);
  } catch {
    // Cache write is best-effort; still return the fetched URL.
  }
  return url;
}

/**
 * Fast DB-only read for server rendering. Never hits the network —
 * missing ids are simply absent so the page can stream immediately
 * and the client lazy-loads them via /api/cover-art.
 */
export function getCachedCoverArtUrls(recordingIds: Array<string | null>): Map<string, string | null> {
  return getCachedCoverArt(recordingIds.filter((id): id is string => !!id));
}

/** Backwards-compatible helper: cache-first, network on miss. */
export async function getCoverArtUrl(musicbrainzRecordingId: string | null) {
  if (!musicbrainzRecordingId) return null;
  const cached = getCachedCoverArt([musicbrainzRecordingId]);
  if (cached.has(musicbrainzRecordingId)) return cached.get(musicbrainzRecordingId) ?? null;
  return fetchAndCacheCoverArt(musicbrainzRecordingId);
}

/** Batch helper for the API route: cached first, then fetch misses with limited concurrency. */
export async function getBatchCoverArtUrls(recordingIds: string[], concurrency = 5): Promise<Record<string, string | null>> {
  const ids = [...new Set(recordingIds.filter(Boolean))].slice(0, 100);
  const out: Record<string, string | null> = {};
  const cached = getCachedCoverArt(ids);
  for (const [id, url] of cached) out[id] = url;
  const missing = ids.filter((id) => !(id in out));
  for (let i = 0; i < missing.length; i += concurrency) {
    const chunk = missing.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(async (id) => ({ id, url: await fetchAndCacheCoverArt(id) })));
    for (const { id, url } of results) out[id] = url;
  }
  return out;
}