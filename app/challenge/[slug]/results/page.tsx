import Link from "next/link";
import { notFound } from "next/navigation";
import { getArtistGroups, getArtistSongs, getChallengeBySlug } from "@/lib/db";
import { getCachedCoverArtUrls } from "@/lib/cover-art";
import { CoverArtLoader } from "@/components/CoverArtLoader";
import { ArtistCard } from "@/components/ArtistCard";
import { SearchBox } from "@/components/SearchBox";
import { SiteNav } from "@/components/SiteNav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARTISTS_PER_PAGE = 20;

export default async function Results({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ page?: string; q?: string }>;
}) {
  const { slug } = await params;
  const { page: pageParam, q: qParam } = (await searchParams) ?? {};
  const query = (qParam ?? "").trim();
  const challenge = getChallengeBySlug(slug);
  if (!challenge) notFound();

  // DB-only read path: SQL GROUP BY + LIMIT/OFFSET, no MusicBrainz calls.
  const parsedPage = Number.parseInt(pageParam ?? "1", 10);
  const page0 = Number.isFinite(parsedPage) ? Math.max(parsedPage, 1) : 1;
  const offset = (page0 - 1) * ARTISTS_PER_PAGE;
  // One extra group to detect a next page without COUNT(*) on every load.
  const { groups, totalArtists, totalSongs } = getArtistGroups(challenge.id, { query, limit: ARTISTS_PER_PAGE + 1, offset });
  const hasNext = groups.length > ARTISTS_PER_PAGE;
  const pageGroups = groups.slice(0, ARTISTS_PER_PAGE);
  const songsByArtist = getArtistSongs(challenge.id, pageGroups.map((g) => g.artistKey));
  const pageArtists = pageGroups.map((g) => ({ ...g, songs: songsByArtist.get(g.artistKey) ?? [] }));
  // DB-cached cover art only — never blocks on the network.
  const artIds = [...new Set(pageArtists.flatMap((a) => a.songs.map((s) => s.recordingId)).filter((id): id is string => !!id))];
  const artMap = getCachedCoverArtUrls(artIds);
  const missingIds = artIds.filter((id) => !artMap.has(id));
  const endIndex = offset + pageArtists.length;
  const baseHref = `/challenge/${slug}/results`;
  const topHref = `/challenge/${slug}/toplist`;
  const pageHref = (n: number) => query ? `${baseHref}?page=${n}&q=${encodeURIComponent(query)}` : `${baseHref}?page=${n}`;
  return <main className="home-shell"><SiteNav active="results" resultsHref={baseHref} topHref={topHref} /><div className="container"><h1>{challenge.name}: Results</h1><p className="muted">{totalArtists ? `${totalArtists} artists · ${totalSongs} songs${query ? ` · filter “${query}”` : ""} · showing artists ${offset + 1}–${endIndex}` : query ? `No artists match “${query}”.` : "No results yet."}</p>
  <SearchBox baseHref={baseHref} initialQuery={query} />
  {!pageArtists.length && <div className="card"><p className="muted">{query ? "No artists match your search." : "No results yet."}</p></div>}
  {pageArtists.map((a) => <ArtistCard key={a.artistKey} artist={a.artist} artistKey={a.artistKey} songCount={a.songs.length} totalVotes={a.totalVotes} songs={a.songs.map((s) => ({ track: s.track, recordingId: s.recordingId, count: s.count, coverArtUrl: s.recordingId ? artMap.get(s.recordingId) ?? null : null }))} />)}
  {missingIds.length > 0 && <CoverArtLoader ids={missingIds} />}
  {(page0 > 1 || hasNext) && <nav className="pager" aria-label="Artist pages">
    <Link className={page0 <= 1 ? "pager-btn pager-disabled" : "pager-btn"} aria-disabled={page0 <= 1} href={page0 <= 1 ? pageHref(1) : pageHref(page0 - 1)}>← Prev</Link>
    <span className="pager-label">Page {page0}</span>
    {hasNext
      ? <Link className="pager-btn" href={pageHref(page0 + 1)}>Next →</Link>
      : <span className="pager-btn pager-disabled" aria-disabled="true">Next →</span>}
  </nav>}</div></main>;
}
