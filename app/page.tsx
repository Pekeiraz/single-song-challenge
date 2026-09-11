import { getTopPreview, listOpenChallenges } from "@/lib/db";
import { config } from "@/lib/config";
import { HomeExperience } from "@/components/HomeExperience";
import { getCachedCoverArtUrls } from "@/lib/cover-art";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams?: Promise<{ error?: string; notice?: string }> }) {
  const { error, notice } = (await searchParams) ?? {};
  const challenges = listOpenChallenges();
  // DB-only: top songs aggregated in SQL, cover art from cache only.
  const topResults = challenges[0] ? getTopPreview(challenges[0].id, 5) : [];
  const artMap = getCachedCoverArtUrls(topResults.map((r) => r.recordingId));
  const missingIds = topResults.map((r) => r.recordingId).filter((id): id is string => !!id && !artMap.has(id));
  const topResultsWithArt = topResults.map((result) => ({
    ...result,
    coverArtUrl: result.recordingId ? artMap.get(result.recordingId) ?? null : null,
    recordingId: result.recordingId,
  }));

  return <HomeExperience
    challenges={challenges.map(({ id, name, slug }) => ({ id, name, slug }))}
    providers={{ spotify: config.spotifyConfigured, youtube: config.youtubeConfigured, tidal: config.tidalConfigured }}
    challengeLinks={challenges.map((challenge) => ({ slug: challenge.slug, name: challenge.name }))}
    topResults={topResultsWithArt}
    missingCoverArtIds={missingIds}
    notice={notice}
    error={error}
  />;
}
