import { getDb } from "../lib/db.ts";

const MUSICBRAINZ = "https://musicbrainz.org/ws/2";
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || "PlaylistChallenge-rematch/0.2.0 (contact: configure MUSICBRAINZ_USER_AGENT)";
const matchCache = new Map();
const MIN_REQUEST_INTERVAL_MS = 1500;
let lastRequestAt = 0;

async function mbFetch(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now() + Math.floor(Math.random() * 250);
    const response = await fetch(`${MUSICBRAINZ}${path}${path.includes("?") ? "&" : "?"}fmt=json`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) throw new Error(`MusicBrainz ${response.status}`);
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter)
      ? Number(retryAfter)
      : retryAfter
        ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000)
        : 0;
    const backoffSeconds = Math.min(60, 2 ** (attempt + 1));
    const delayMs = Math.max(MIN_REQUEST_INTERVAL_MS, retryAfterSeconds * 1000, backoffSeconds * 1000);
    console.warn(`MusicBrainz ${response.status}; retrying in ${Math.ceil(delayMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("MusicBrainz request failed");
}

function escapeLucene(value) {
  return value.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function normalize(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-US")
    .replace(/\b(?:official|video|audio|lyrics?|visualizer|remaster(?:ed)?|live|version|edit|topic|hd|4k)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeArtist(value) {
  return normalize(value).split(" ").filter(Boolean).sort().join(" ");
}

function searchVariants(value) {
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

function searchValue(value) {
  return value.replace(/\s+-\s+Topic\s*$/i, "")
    .replace(/\s*[\(\[]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|remix|mono|stereo|single version|anniversary(?: edition)?|deluxe(?: edition)?|explicit|clean|radio edit)[^)\]]*[\)\]]\s*$/i, "")
    .replace(/\s*\((?:official\s+)?(?:video|audio|lyrics?|live|remaster(?:ed)?|single version)[^)]*\)\s*$/i, "")
    .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[\)\]]\s*$/i, "")
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+.+$/i, "")
    .replace(/\s*\(\s*\d{4}\s*\)\s*$/g, "")
    .replace(/\s*\(\s*\)\s*$/g, "")
    .trim();
}

function artistScoreValue(candidateCredits, artist) {
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

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function score(candidate, title, artist) {
  const candidateTitle = normalize(candidate.title ?? "");
  const candidateCredits = (candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").filter(Boolean);
  const titleVariants = new Set(searchVariants(title).map((variant) => normalize(variant)));
  const titleScore = titleVariants.has(candidateTitle) ? 1 : similarity(candidateTitle, normalize(title));
  const artistScore = artistScoreValue(candidateCredits, artist);
  return { total: titleScore * 0.55 + artistScore * 0.35 + Math.min(1, Number(candidate.score ?? 0) / 100) * 0.1, titleScore, artistScore };
}

function summary(candidate, value) {
  return { recordingId: candidate.id, title: candidate.title ?? null, artist: (candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" & ") || null, score: Number(value.total.toFixed(3)) };
}

async function matchRecording({ title, artist, isrc }) {
  const cacheKey = JSON.stringify([title, artist, isrc ?? null]);
  if (matchCache.has(cacheKey)) return matchCache.get(cacheKey);
  let result = null;
  if (isrc) {
    const data = await mbFetch(`/recording?query=isrc:${encodeURIComponent(isrc)}&limit=10`);
    if (data.recordings?.[0]) result = { ...data.recordings[0], status: "matched", confidence: 1, candidates: [summary(data.recordings[0], { total: 1 })] };
  }
  if (!result) {
    title = searchValue(title);
    artist = searchValue(artist);
    let candidates = [];
    for (const titleVariant of searchVariants(title)) {
      const query = `recording:"${escapeLucene(titleVariant)}" AND artist:${normalize(artist).split(" ").join(" AND artist:")}`;
      const data = await mbFetch(`/recording?query=${encodeURIComponent(query)}&limit=25`);
      candidates.push(...(data.recordings ?? []));
      if (candidates.length) break;
    }
    if (!candidates.length) {
      for (const titleVariant of searchVariants(title)) {
        const fallback = await mbFetch(`/recording?query=${encodeURIComponent(`recording:"${escapeLucene(titleVariant)}"`)}&limit=25`);
        candidates.push(...(fallback.recordings ?? []));
        if (candidates.length) break;
      }
    }
    const ranked = candidates.map((candidate) => ({ candidate, ...score(candidate, title, artist) })).sort((a, b) => b.total - a.total);
    const best = ranked[0];
    const bestGroupKey = best ? `${normalize(best.candidate.title ?? "")}||${normalizeArtist((best.candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" "))}` : null;
    const runnerUp = ranked.find((entry) => `${normalize(entry.candidate.title ?? "")}||${normalizeArtist((entry.candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" "))}` !== bestGroupKey);
    const exactTitleAndArtist = best && best.titleScore === 1 && best.artistScore === 1;
    const candidateSummaries = ranked.slice(0, 5).map(({ candidate, ...value }) => summary(candidate, value));
    if (!best || best.titleScore < 0.75 || best.artistScore < 0.55 || best.total < 0.72) result = { status: "unmatched", confidence: best?.total ?? 0, candidates: candidateSummaries };
    else if (!exactTitleAndArtist && runnerUp && best.total - runnerUp.total < 0.08 && runnerUp.artistScore >= 0.55) result = { status: "ambiguous", confidence: best.total, candidates: candidateSummaries };
    else result = { ...best.candidate, status: "matched", confidence: best.total, candidates: candidateSummaries };
  }
  matchCache.set(cacheKey, result);
  return result;
}

const db = getDb();
const retryUnmatched = process.argv.includes("--retry-unmatched");
const retryAmbiguous = process.argv.includes("--retry-ambiguous");
const requestedLimit = Number.parseInt(process.argv.find((argument) => /^\d+$/.test(argument)) ?? "", 10);
const limitClause = Number.isFinite(requestedLimit) && requestedLimit > 0 ? ` LIMIT ${requestedLimit}` : "";
const tracks = db.prepare(`
  SELECT st.submission_id, st.position, st.track_name, st.artist_name, st.isrc
  FROM submission_tracks st
  WHERE NOT (st.musicbrainz_recording_id IS NOT NULL AND st.musicbrainz_match_method IS NOT NULL AND st.musicbrainz_match_method <> 'rematch')
    AND (
      st.musicbrainz_match_status IS NULL
      OR (${retryUnmatched ? "st.musicbrainz_match_status = 'unmatched'" : "0"})
      OR (${retryAmbiguous ? "st.musicbrainz_match_status = 'ambiguous'" : "0"})
      OR st.musicbrainz_match_confidence IS NULL
      OR st.musicbrainz_candidates_json IS NULL
      OR st.musicbrainz_match_error IS NOT NULL
      OR (st.musicbrainz_match_status = 'matched' AND (
        st.musicbrainz_recording_id IS NULL
        OR st.musicbrainz_track_name IS NULL
        OR st.musicbrainz_artist_name IS NULL
      ))
    )
  ORDER BY st.submission_id, st.position
  ${limitClause}
`).all();
const update = db.prepare(`
  UPDATE submission_tracks
  SET musicbrainz_recording_id = ?, musicbrainz_artist_id = ?, musicbrainz_match_method = ?, musicbrainz_track_name = ?, musicbrainz_artist_name = ?, musicbrainz_match_status = ?, musicbrainz_match_confidence = ?, musicbrainz_candidates_json = ?, musicbrainz_match_error = NULL
  WHERE submission_id = ? AND position = ?
`);
const recordFailure = db.prepare(`
  UPDATE submission_tracks
  SET musicbrainz_match_error = ?
  WHERE submission_id = ? AND position = ?
`);

let matched = 0;
let rejected = 0;
for (const track of tracks) {
  try {
    const result = await matchRecording({ title: track.track_name, artist: track.artist_name, isrc: track.isrc ?? undefined });
    const artistName = result?.status === "matched" ? (result["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" & ") || null : null;
    update.run(result?.status === "matched" ? result.id : null, result?.status === "matched" ? result["artist-credit"]?.[0]?.artist?.id ?? null : null, result?.status === "matched" ? "rematch" : null, result?.status === "matched" ? result.title ?? null : null, artistName, result?.status ?? "unmatched", result?.confidence ?? null, result?.candidates ? JSON.stringify(result.candidates) : null, track.submission_id, track.position);
    if (result?.status === "matched") { matched++; console.log(`Matched ${track.artist_name} - ${track.track_name}`); }
    else if (result?.status === "ambiguous") { rejected++; console.log(`Ambiguous ${track.artist_name} - ${track.track_name}`); }
    else { rejected++; console.log(`Unmatched ${track.artist_name} - ${track.track_name}`); }
  } catch (error) {
    recordFailure.run(error instanceof Error ? error.message : String(error), track.submission_id, track.position);
    console.error(`Failed ${track.artist_name} - ${track.track_name}:`, error instanceof Error ? error.message : error);
  }
}

console.log(`Rematched ${matched} and rejected ${rejected} of ${tracks.length} tracks.`);