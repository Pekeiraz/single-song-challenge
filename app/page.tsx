import { getResultRows, listOpenChallenges } from "@/lib/db";
import { config } from "@/lib/config";
import { HomeExperience } from "@/components/HomeExperience";
import { getCoverArtUrl } from "@/lib/cover-art";
import { getCanonicalResultRows } from "@/lib/musicbrainz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams?: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = (await searchParams) ?? {};
  const challenges = listOpenChallenges();
  const resultRows = await getCanonicalResultRows(challenges[0] ? getResultRows(challenges[0].id) : []);
  const resultCounts = new Map<string, { artist: string; track: string; count: number }>();
  for (const row of resultRows) {
    const key = `${row.musicbrainz_artist_id ?? row.artist_name.toLocaleLowerCase("en-US")}::${row.musicbrainz_recording_id ?? row.track_name.toLocaleLowerCase("en-US")}`;
    const current = resultCounts.get(key) ?? { artist: row.artist_name, track: row.track_name, count: 0 };
    current.count++;
    resultCounts.set(key, current);
  }
  const topResults = [...resultCounts.values()]
    .sort((a, b) => b.count - a.count || a.artist.localeCompare(b.artist))
    .slice(0, 5);
  const topResultRows = topResults.map((result) => resultRows.find((row) => row.artist_name === result.artist && row.track_name === result.track));
  const topResultsWithArt = await Promise.all(topResults.map(async (result, index) => ({
    ...result,
    coverArtUrl: topResultRows[index] ? await getCoverArtUrl(topResultRows[index].musicbrainz_recording_id) : null,
  })));

  return <HomeExperience
    challenges={challenges.map(({ id, name, slug }) => ({ id, name, slug }))}
    providers={{ spotify: config.spotifyConfigured, youtube: config.youtubeConfigured }}
    challengeLinks={challenges.map((challenge) => ({ slug: challenge.slug, name: challenge.name }))}
    topResults={topResultsWithArt}
    notice={notice}
    error={error}
  />;
}
