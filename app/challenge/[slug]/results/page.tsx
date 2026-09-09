import { notFound } from "next/navigation";
import { getChallengeBySlug, getResultRows } from "@/lib/db";
import { getCoverArtUrl } from "@/lib/cover-art";
import { getCanonicalResultRows } from "@/lib/musicbrainz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Results({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const challenge = getChallengeBySlug(slug);
  if (!challenge) notFound();

  const rows = await getCanonicalResultRows(getResultRows(challenge.id));
  const counts = new Map<string, { artist: string; track: string; musicbrainzRecordingId: string | null; count: number }>();
  for (const row of rows) {
    const artistKey = row.musicbrainz_artist_id ?? `name:${row.artist_name.toLocaleLowerCase("de-DE")}`;
    const trackKey = row.musicbrainz_recording_id ?? `${row.track_name.toLocaleLowerCase("de-DE")}`;
    const key = `${artistKey}::${trackKey}`;
    const current = counts.get(key) ?? { artist: row.artist_name, track: row.track_name, musicbrainzRecordingId: row.musicbrainz_recording_id, count: 0 };
    current.count++;
    counts.set(key, current);
  }

  const sorted = [...counts.values()].sort((a,b) => b.count-a.count || a.artist.localeCompare(b.artist));
  // Fetch cover art in small batches to avoid hammering MusicBrainz/CAA
  // with 100+ concurrent requests (caused fetch failures / 500s).
  const ranked: Array<(typeof sorted)[number] & { coverArtUrl: string | null }> = [];
  for (let i = 0; i < sorted.length; i += 10) {
    const chunk = sorted.slice(i, i + 10);
    const withArt = await Promise.all(chunk.map(async (result) => ({
      ...result,
      coverArtUrl: await getCoverArtUrl(result.musicbrainzRecordingId),
    })));
    ranked.push(...withArt);
  }
  return <main className="container"><p><a className="button" href={`/challenge/${slug}`}>Back to challenge</a></p><h1>{challenge.name}: Results</h1><div className="card">
    {!ranked.length && <p className="muted">No results yet.</p>}
    {ranked.map((r,i) => <div className="track result-track" key={`${r.artist}-${r.track}`}>{r.coverArtUrl ? <img className="result-art" src={r.coverArtUrl} alt="" width={56} height={56} loading="lazy" /> : <span className="result-art result-art-fallback" aria-hidden="true" />}<span><strong>#{i+1} {r.track}</strong><br/><span className="muted">{r.artist}</span></span><strong>{r.count}</strong></div>)}
  </div></main>;
}
