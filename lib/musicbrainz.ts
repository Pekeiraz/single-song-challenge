import { config } from "./config.ts";
import type { ResultRow } from "./db.ts";

const BASE = "https://musicbrainz.org/ws/2";
const MIN_REQUEST_INTERVAL_MS = 1500;
const RESPONSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const responseCache = new Map<string, { expiresAt: number; data: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

type ArtistCredit = { name?: string; artist?: { id?: string; name?: string } };
type Recording = { id: string; title?: string; score?: number; "artist-credit"?: ArtistCredit[] };
type RecordingSearchResponse = { recordings?: Recording[] };
type RecordingDetails = { title?: string; "artist-credit"?: ArtistCredit[] };

async function waitForRequestSlot() {
  await new Promise<void>((resolve) => {
    const turn = requestQueue.then(async () => {
      const wait = Math.max(0, nextRequestAt - Date.now());
      if (wait) await new Promise((done) => setTimeout(done, wait));
      nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
      resolve();
    });
    requestQueue = turn.catch(() => undefined);
  });
}

async function mbFetch<T>(path: string): Promise<T> {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}fmt=json`;
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data as T;
  responseCache.delete(url);
  const current = inFlight.get(url);
  if (current) return current as Promise<T>;

  const request = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitForRequestSlot();
      const response = await fetch(url, {
        headers: { "User-Agent": config.musicBrainzUserAgent, Accept: "application/json" },
        cache: "no-store",
      });
      if (response.ok) {
        const data = await response.json();
        responseCache.set(url, { expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS, data });
        return data;
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) throw new Error(`MusicBrainz ${response.status}`);
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : retryAfter
          ? Math.max(0, Date.parse(retryAfter) - Date.now())
          : 0;
      const backoffMs = Math.min(60_000, 2 ** (attempt + 1) * 1000);
      nextRequestAt = Math.max(nextRequestAt, Date.now() + Math.max(MIN_REQUEST_INTERVAL_MS, retryAfterMs, backoffMs));
    }
    throw new Error("MusicBrainz request failed");
  })();
  inFlight.set(url, request);
  try {
    return await request;
  } finally {
    inFlight.delete(url);
  }
}

export async function getRecordingDetails(recordingId: string) {
  const data = await mbFetch<RecordingDetails>(`/recording/${encodeURIComponent(recordingId)}?inc=artists`);
  const artist = data["artist-credit"]?.[0];
  return {
    trackName: data.title ?? null,
    artistName: artist?.name ?? artist?.artist?.name ?? null,
  };
}

export async function getCanonicalResultRows(rows: ResultRow[]) {
  const canonicalRows: ResultRow[] = [];
  for (const row of rows) {
    if (row.musicbrainz_match_status === "matched" && row.musicbrainz_recording_id && row.musicbrainz_track_name && row.musicbrainz_artist_name) {
      canonicalRows.push({ ...row, track_name: row.musicbrainz_track_name, artist_name: row.musicbrainz_artist_name });
    }
  }
  return canonicalRows;
}

function escapeLucene(value: string) {
  return value.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/\b(?:official|video|audio|lyrics?|visualizer|remaster(?:ed)?|live|version|edit|topic|hd|4k)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeArtist(value: string) {
  return normalize(value).split(" ").filter(Boolean).sort().join(" ");
}

function searchVariants(value: string) {
  const variants = [value];
  const partMatch = value.match(/\b(?:pt|part)\.?\s+(\d+)\b/i);
  if (partMatch) {
    const number = Number(partMatch[1]);
    variants.push(value.replace(partMatch[0], `Part ${number}`));
    const roman = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][number];
    if (roman) variants.push(value.replace(partMatch[0], roman));
  }
  return [...new Set(variants)];
}

function searchValue(value: string) {
  return value
    .replace(/\s+-\s+Topic\s*$/i, "")
    .replace(/\s*[\(\[]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|remix|mono|stereo|single version|anniversary(?: edition)?|deluxe(?: edition)?|explicit|clean|radio edit)[^)\]]*[\)\]]\s*$/i, "")
    .replace(/\s*\((?:official\s+)?(?:video|audio|lyrics?|live|remaster(?:ed)?|single version)[^)]*\)\s*$/i, "")
    .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[\)\]]\s*$/i, "")
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+.+$/i, "")
    .replace(/\s*\(\s*\d{4}\s*\)\s*$/g, "")
    .replace(/\s*\(\s*\)\s*$/g, "")
    .trim();
}

function artistScoreValue(candidateCredits: string[], artist: string) {
  const submittedNorm = normalize(artist);
  const candidateJoined = normalizeArtist(candidateCredits.join(" "));
  const submitted = normalizeArtist(artist);
  if (candidateJoined === submitted) return 1;
  for (const credit of candidateCredits) {
    if (normalize(credit) === submittedNorm && submittedNorm.length > 0) return 0.95;
  }
  const candidateTokens = new Set(candidateJoined.split(" ").filter(Boolean));
  const submittedTokens = new Set(submitted.split(" ").filter(Boolean));
  const smaller = candidateTokens.size <= submittedTokens.size ? candidateTokens : submittedTokens;
  const larger = candidateTokens.size <= submittedTokens.size ? submittedTokens : candidateTokens;
  if (smaller.size >= 2 && [...smaller].every((token) => larger.has(token))) return 0.9;
  return similarity(candidateJoined, submitted);
}

function similarity(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function candidateScore(candidate: Recording, title: string, artist: string) {
  const candidateTitle = normalize(candidate.title ?? "");
  const candidateCredits = candidate["artist-credit"]?.map((credit) => credit.name ?? credit.artist?.name ?? "").filter(Boolean) ?? [];
  const titleVariants = new Set(searchVariants(title).map((variant) => normalize(variant)));
  const titleScore = titleVariants.has(candidateTitle) ? 1 : similarity(candidateTitle, normalize(title));
  const artistScore = artistScoreValue(candidateCredits, artist);
  const apiScore = Math.min(1, Number(candidate.score ?? 0) / 100);
  return { total: titleScore * 0.55 + artistScore * 0.35 + apiScore * 0.1, titleScore, artistScore };
}

function candidateSummary(candidate: Recording, score: { total: number; titleScore: number; artistScore: number }) {
  return {
    recordingId: candidate.id,
    title: candidate.title ?? null,
    artist: candidate["artist-credit"]?.map((credit) => credit.name ?? credit.artist?.name ?? "").join(" & ") ?? null,
    score: Number(score.total.toFixed(3)),
  };
}

export async function matchRecording(input: { title: string; artist: string; isrc?: string }) {
  if (input.isrc) {
    const data = await mbFetch<RecordingSearchResponse>(`/recording?query=isrc:${encodeURIComponent(input.isrc)}&limit=10`);
    const first = data.recordings?.[0];
    if (first) return {
      recordingId: first.id,
      artistId: first["artist-credit"]?.[0]?.artist?.id ?? null,
      trackName: first.title ?? null,
      artistName: first["artist-credit"]?.map((credit) => credit.name ?? credit.artist?.name ?? "").join(" & ") ?? null,
      method: "isrc",
      status: "matched" as const,
      confidence: 1,
      candidates: [candidateSummary(first, { total: 1, titleScore: 1, artistScore: 1 })],
    };
  }

  const title = searchValue(input.title);
  const artist = searchValue(input.artist);
  const candidates: Recording[] = [];
  for (const titleVariant of searchVariants(title)) {
    const q = `recording:"${escapeLucene(titleVariant)}" AND artist:${normalize(artist).split(" ").join(" AND artist:")}`;
    const data = await mbFetch<RecordingSearchResponse>(`/recording?query=${encodeURIComponent(q)}&limit=25`);
    candidates.push(...(data.recordings ?? []));
    if (candidates.length) break;
  }
  if (!candidates.length) {
    for (const titleVariant of searchVariants(title)) {
      const fallback = await mbFetch<RecordingSearchResponse>(`/recording?query=${encodeURIComponent(`recording:"${escapeLucene(titleVariant)}"`)}&limit=25`);
      candidates.push(...(fallback.recordings ?? []));
      if (candidates.length) break;
    }
  }
  const ranked = candidates
    .map((candidate) => ({ candidate, ...candidateScore(candidate, title, artist) }))
    .sort((left, right) => right.total - left.total);
  const best = ranked[0];
  const bestGroupKey = best ? `${normalize(best.candidate.title ?? "")}||${normalizeArtist((best.candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" "))}` : null;
  const runnerUp = ranked.find((entry) => `${normalize(entry.candidate.title ?? "")}||${normalizeArtist((entry.candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" "))}` !== bestGroupKey);
  const candidateSummaries = ranked.slice(0, 5).map((entry) => candidateSummary(entry.candidate, entry));
  if (!best) return { status: "unmatched" as const, confidence: 0, candidates: candidateSummaries };
  if (best.titleScore < 0.75 || best.artistScore < 0.55 || best.total < 0.72) {
    return { status: "unmatched" as const, confidence: Number(best.total.toFixed(3)), candidates: candidateSummaries };
  }
  const exactTitleAndArtist = best.titleScore === 1 && best.artistScore === 1;
  if (!exactTitleAndArtist && runnerUp && best.total - runnerUp.total < 0.08 && runnerUp.artistScore >= 0.55) {
    return { status: "ambiguous" as const, confidence: Number(best.total.toFixed(3)), candidates: candidateSummaries };
  }
  const first = best.candidate;
  return {
    recordingId: first.id,
    artistId: first["artist-credit"]?.[0]?.artist?.id ?? null,
    trackName: first.title ?? null,
    artistName: first["artist-credit"]?.map((credit) => credit.name ?? credit.artist?.name ?? "").join(" & ") ?? null,
    method: `search:${best.total.toFixed(2)}`,
    status: "matched" as const,
    confidence: Number(best.total.toFixed(3)),
    candidates: candidateSummaries,
  };
}
