const MUSICBRAINZ = "https://musicbrainz.org/ws/2";
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || "PlaylistChallenge-debug/0.2.0 (contact: configure MUSICBRAINZ_USER_AGENT)";

function escapeLucene(value) {
  return value.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function normalize(value) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("en-US")
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

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
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

function scoreCandidate(candidate, title, artist) {
  const candidateTitle = normalize(candidate.title ?? "");
  const candidateCredits = (candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").filter(Boolean);
  const titleVariants = new Set(searchVariants(title).map((variant) => normalize(variant)));
  const titleScore = titleVariants.has(candidateTitle) ? 1 : similarity(candidateTitle, normalize(title));
  const artistScore = artistScoreValue(candidateCredits, artist);
  const apiScore = Math.min(1, Number(candidate.score ?? 0) / 100);
  return { total: titleScore * 0.55 + artistScore * 0.35 + apiScore * 0.1, titleScore, artistScore };
}

async function mbFetch(path) {
  const url = `${MUSICBRAINZ}${path}${path.includes("?") ? "&" : "?"}fmt=json`;
  console.log(`FETCH ${url}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    console.log(`STATUS ${response.status} attempt=${attempt + 1}`);
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) throw new Error(`MusicBrainz ${response.status}`);
    const delayMs = Math.min(60000, 2 ** (attempt + 1) * 1000);
    console.log(`RETRY in ${delayMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("MusicBrainz request failed");
}

const [rawArtist, rawTitle] = process.argv.slice(2);
if (!rawArtist || !rawTitle) {
  console.error('Usage: npm run debug:mb -- "Artist" "Title"');
  process.exit(1);
}

const title = searchValue(rawTitle);
const artist = searchValue(rawArtist);
console.log(`INPUT artist=${JSON.stringify(rawArtist)} title=${JSON.stringify(rawTitle)}`);
console.log(`CLEANED artist=${JSON.stringify(artist)} title=${JSON.stringify(title)}`);
console.log(`TITLE VARIANTS ${JSON.stringify(searchVariants(title))}`);
console.log(`NORMALIZED artist=${JSON.stringify(normalize(artist))} title=${JSON.stringify(normalize(title))}`);

let candidates = [];
for (const titleVariant of searchVariants(title)) {
  const query = `recording:"${escapeLucene(titleVariant)}" AND artist:${normalize(artist).split(" ").join(" AND artist:")}`;
  console.log(`QUERY ${query}`);
  const data = await mbFetch(`/recording?query=${encodeURIComponent(query)}&limit=25`);
  console.log(`COUNT ${data.count}`);
  candidates.push(...(data.recordings ?? []));
  if (candidates.length) break;
}
if (!candidates.length) {
  for (const titleVariant of searchVariants(title)) {
    const fallback = `recording:"${escapeLucene(titleVariant)}"`;
    console.log(`FALLBACK QUERY ${fallback}`);
    const data = await mbFetch(`/recording?query=${encodeURIComponent(fallback)}&limit=25`);
    console.log(`COUNT ${data.count}`);
    candidates.push(...(data.recordings ?? []));
    if (candidates.length) break;
  }
}

const ranked = candidates
  .map((candidate) => ({ candidate, ...scoreCandidate(candidate, title, artist) }))
  .sort((a, b) => b.total - a.total)
  .slice(0, 10);

if (!ranked.length) {
  console.log("RESULT no candidates");
  process.exit(0);
}

for (const { candidate, total, titleScore, artistScore } of ranked) {
  const name = (candidate["artist-credit"] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? "").join(" & ");
  console.log(`${total.toFixed(3)} title=${titleScore.toFixed(3)} artist=${artistScore.toFixed(3)} api=${candidate.score} :: ${candidate.title} | ${name} | ${candidate.id}`);
}
const best = ranked[0];
const verdict = !best || best.titleScore < 0.75 || best.artistScore < 0.55 || best.total < 0.72 ? "unmatched" : "matched-or-ambiguous";
console.log(`VERDICT ${verdict}`);
