import { config } from "./config";
import { getCachedCoverArt, setCachedCoverArt } from "./db";

type MusicBrainzRelease = {
  id?: string;
  status?: string;
  date?: string;
  country?: string | null;
  quality?: string;
  packaging?: string | null;
  "artist-credit"?: Array<{ name?: string; artist?: { id?: string; name?: string } }>;
  "release-group"?: { id?: string; "primary-type"?: string; "secondary-types"?: string[] };
};
type MusicBrainzRecording = {
  releases?: MusicBrainzRelease[];
  "artist-credit"?: Array<{ name?: string; artist?: { id?: string; name?: string } }>;
};
type CoverArtImage = { front?: boolean; types?: string[]; thumbnails?: { [size: string]: string } };
type CoverArtRelease = { images?: CoverArtImage[] };

const PERMANENT_TTL_SECONDS: number | null = null;

/** Front image per CAA convention: types contains FRONT (like Last.fm's IsFrontImage). */
function pickFrontImage(cover: CoverArtRelease): CoverArtImage | null {
  const images = cover.images ?? [];
  return images.find((image) => image.front || image.types?.some((t) => t.toUpperCase() === "FRONT")) ?? images[0] ?? null;
}

function frontImageUrl(cover: CoverArtRelease): string | null {
  const front = pickFrontImage(cover);
  const url = front?.thumbnails?.["250"] ?? front?.thumbnails?.small ?? null;
  return url?.replace(/^http:\/\//, "https://") ?? null;
}

async function fetchCoverArtJson(url: string): Promise<CoverArtRelease | null> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return null;
    return await response.json() as CoverArtRelease;
  } catch {
    return null;
  }
}

/**
 * Pick the most "original" release-group id from the recording's releases:
 * prefer Album/Single/EP over Compilation/Soundtrack. CAA maps one
 * release's art to the group (usually the original album), which avoids
 * generic pop-chart sampler covers. (MusicBrainz has no top-level
 * release-groups on recordings — groups only come via releases[].)
 */
function pickOriginalReleaseGroup(recording: MusicBrainzRecording): string | null {
  const seen = new Map<string, { id: string; score: number }>();
  for (const release of recording.releases ?? []) {
    const group = release["release-group"];
    if (!group?.id || seen.has(group.id)) continue;
    let score = 0;
    const primary = group["primary-type"] ?? "";
    const secondary = group["secondary-types"] ?? [];
    // Original album first, then Single/EP; compilations last.
    // (Soundtrack albums can be the original, e.g. Pat Garrett & Billy
    // the Kid, so only penalize them lightly.)
    if (primary === "Album" && !secondary.includes("Compilation")) score += 50;
    else if (primary === "Single" || primary === "EP") score += 25;
    else if (primary === "Compilation") score -= 50;
    if (secondary.includes("Compilation")) score -= 50;
    else if (secondary.includes("Soundtrack")) score -= 10;
    if (secondary.includes("Live")) score -= 20;
    seen.set(group.id, { id: group.id, score });
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score);
  return ranked[0]?.id ?? null;
}

/**
 * Pick the most "original" release for cover art: prefer Official status,
 * Album/Single/EP over Compilation/Soundtrack, earliest date, and a
 * release whose artist matches the recording artist. This avoids generic
 * pop-chart sampler covers that MusicBrainz lists first. Used only as a
 * fallback when the release-group endpoint has no art.
 */
function pickOriginalRelease(recording: MusicBrainzRecording): MusicBrainzRelease | null {
  const releases = (recording.releases ?? []).filter((r) => r.id);
  if (!releases.length) return null;
  const recordingArtistIds = new Set(
    (recording["artist-credit"] ?? []).map((c) => c.artist?.id).filter((id): id is string => !!id),
  );
  const recordingArtistNames = new Set(
    (recording["artist-credit"] ?? []).map((c) => (c.name ?? c.artist?.name ?? "").toLowerCase()).filter(Boolean),
  );
  const scored = releases.map((release) => {
    let score = 0;
    // Official releases first; bootlegs/promotions last.
    if (release.status === "Official") score += 100;
    else if (release.status === "Promotion" || release.status === "Bootleg" || release.status === "Pseudo-Release") score -= 100;
    // Original album first, then Single/EP; compilations last.
    const primary = release["release-group"]?.["primary-type"] ?? "";
    const secondary = release["release-group"]?.["secondary-types"] ?? [];
    if (primary === "Album" && !secondary.includes("Compilation")) score += 50;
    else if (primary === "Single" || primary === "EP") score += 25;
    else if (primary === "Compilation") score -= 50;
    if (secondary.includes("Compilation")) score -= 50;
    else if (secondary.includes("Soundtrack")) score -= 10;
    if (secondary.includes("Live")) score -= 20;
    // Same artist as the recording beats Various Artists samplers.
    const credits = release["artist-credit"] ?? [];
    const sameArtist = credits.some(
      (c) => (c.artist?.id && recordingArtistIds.has(c.artist.id)) ||
        recordingArtistNames.has((c.name ?? c.artist?.name ?? "").toLowerCase()),
    );
    if (sameArtist) score += 75;
    else if (credits.some((c) => /various artists/i.test(c.name ?? c.artist?.name ?? ""))) score -= 75;
    return { release, score, date: release.date ?? "9999" };
  });
  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return scored[0].release;
}

async function fetchFromNetwork(musicbrainzRecordingId: string): Promise<{ releaseId: string | null; url: string | null }> {
  try {
    const recordingResponse = await fetch(`https://musicbrainz.org/ws/2/recording/${encodeURIComponent(musicbrainzRecordingId)}?inc=releases+artists+release-groups&fmt=json`, {
      headers: { "User-Agent": config.musicBrainzUserAgent, Accept: "application/json" },
      cache: "no-store",
    });
    if (!recordingResponse.ok) return { releaseId: null, url: null };

    const recording = await recordingResponse.json() as MusicBrainzRecording;

    // 1. Release-group endpoint first (like lastfm/coverartarchive-api):
    // CAA maps one representative cover to the group, usually the
    // original album rather than a sampler.
    const releaseGroupId = pickOriginalReleaseGroup(recording);
    if (releaseGroupId) {
      const groupCover = await fetchCoverArtJson(`https://coverartarchive.org/release-group/${encodeURIComponent(releaseGroupId)}`);
      const groupUrl = groupCover ? frontImageUrl(groupCover) : null;
      if (groupUrl) return { releaseId: releaseGroupId, url: groupUrl };
    }

    // 2. Fall back to the best individual release.
    const releaseId = pickOriginalRelease(recording)?.id ?? null;
    if (!releaseId) return { releaseId: releaseGroupId, url: null };

    const releaseCover = await fetchCoverArtJson(`https://coverartarchive.org/release/${encodeURIComponent(releaseId)}`);
    if (!releaseCover) return { releaseId, url: null };
    return { releaseId, url: frontImageUrl(releaseCover) };
  } catch {
    return { releaseId: null, url: null };
  }
}

/** Fetch a single recording's art and persist it (positive + negative caching). */
export async function fetchAndCacheCoverArt(musicbrainzRecordingId: string): Promise<string | null> {
  const { releaseId, url } = await fetchFromNetwork(musicbrainzRecordingId);
  try {
    setCachedCoverArt(musicbrainzRecordingId, releaseId, url, PERMANENT_TTL_SECONDS);
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