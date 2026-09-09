import { notFound } from "next/navigation";
import { getOpenChallengeBySlug } from "@/lib/db";
import { SubmitForm } from "@/components/SubmitForm";
import { config } from "@/lib/config";

export const runtime = "nodejs";

export default async function ChallengePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { slug } = await params;
  const { error, notice } = await searchParams;
  const challenge = getOpenChallengeBySlug(slug);
  if (!challenge) notFound();
  return <main className="container">
    <h1>{challenge.name}</h1>
    <p className="muted">One submission per participant. One playlist, one song per artist.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <SubmitForm challengeId={challenge.id} providers={{ spotify: config.spotifyConfigured, youtube: config.youtubeConfigured }} />
    <div className="card"><a className="button" href={`/challenge/${slug}/results`}>Ergebnisse ansehen</a></div>
  </main>;
}
