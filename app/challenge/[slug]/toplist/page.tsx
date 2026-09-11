import Link from "next/link";
import { notFound } from "next/navigation";
import { getChallengeBySlug, getTopSongs } from "@/lib/db";
import { getCachedCoverArtUrls } from "@/lib/cover-art";
import { CoverArtLoader } from "@/components/CoverArtLoader";
import { SearchBox } from "@/components/SearchBox";
import { SiteNav } from "@/components/SiteNav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOP_LIMIT = 500;
const PAGE_SIZE = 100;

export default async function Toplist({
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

  // DB-only read path: aggregated in SQL, no MusicBrainz calls.
  // Matching happens in the background worker (npm run db:match-once).
  const isSearching = query.length > 0;
  const parsedPage = Number.parseInt(pageParam ?? "1", 10);
  if (isSearching) {
    // Search across the FULL ranking (no TOP_LIMIT cap): rank is global,
    // so a song at #654 with 5 votes shows exactly that.
    const searchPage = Number.isFinite(parsedPage) ? Math.max(parsedPage, 1) : 1;
    const searchOffset = (searchPage - 1) * PAGE_SIZE;
    const { items, total } = getTopSongs(challenge.id, { query, limit: PAGE_SIZE, offset: searchOffset });
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(searchPage, totalPages);
    const startIndex = (page - 1) * PAGE_SIZE;
    return renderToplist({ slug, challengeName: challenge.name, query, pageItems: items, total, page, totalPages, startIndex, isSearching: true });
  }
  const page0 = Number.isFinite(parsedPage) ? Math.max(parsedPage, 1) : 1;
  const offset = (page0 - 1) * PAGE_SIZE;
  // Fetch one extra to know whether a next page exists without COUNT(*).
  const { items } = getTopSongs(challenge.id, { limit: PAGE_SIZE + 1, offset });
  const hasNext = items.length > PAGE_SIZE;
  const pageItems = items.slice(0, PAGE_SIZE);
  const totalPages = hasNext ? page0 + 1 : page0;
  return renderToplist({ slug, challengeName: challenge.name, query, pageItems, total: -1, page: page0, totalPages, startIndex: offset, isSearching: false, hasNext });
}

function renderToplist({ slug, challengeName, query, pageItems, total, page, totalPages, startIndex, isSearching, hasNext }: {
  slug: string; challengeName: string; query: string;
  pageItems: Array<{ artist: string; track: string; recordingId: string | null; count: number; rank: number }>;
  total: number; page: number; totalPages: number; startIndex: number; isSearching: boolean; hasNext?: boolean;
}) {
  // DB-cached cover art only — never blocks on the network.
  const artMap = getCachedCoverArtUrls(pageItems.map((r) => r.recordingId));
  const missingIds = pageItems.map((r) => r.recordingId).filter((id): id is string => !!id && !artMap.has(id));
  const ranked = pageItems.map((result) => ({
    ...result,
    coverArtUrl: result.recordingId ? artMap.get(result.recordingId) ?? null : null,
  }));
  const endIndex = startIndex + ranked.length;
  const baseHref = `/challenge/${slug}/toplist`;
  const resultsHref = `/challenge/${slug}/results`;
  const pageHref = (n: number) => query ? `${baseHref}?page=${n}&q=${encodeURIComponent(query)}` : `${baseHref}?page=${n}`;
  const heading = isSearching
    ? (total === 0 ? `No matches for “${query}”.` : `${total} ${total === 1 ? "match" : "matches"} for “${query}” · overall rank shown`)
    : (ranked.length || startIndex > 0 ? `Showing ${startIndex + 1}–${endIndex}` : "No results yet.");
  return <main className="home-shell"><SiteNav active="top" resultsHref={resultsHref} topHref={baseHref} /><div className="container"><h1>{challengeName}: Top 500</h1><p className="muted">{heading}</p>
  <SearchBox baseHref={baseHref} initialQuery={query} />
  <div className="card">
    {!ranked.length && <p className="muted">{isSearching ? "No songs match your search." : "No results yet."}</p>}
    {ranked.map((r) => <div className="track result-track toplist-row" key={`${r.artist}-${r.track}`}><span className="toplist-rank">#{r.rank}</span>{r.coverArtUrl ? <img className="result-art" src={r.coverArtUrl} alt="" width={56} height={56} loading="lazy" /> : <span className="result-art result-art-fallback" data-cover-id={r.recordingId ?? undefined} aria-hidden="true" />}<span className="toplist-song"><strong>{r.track}</strong><span className="muted">{r.artist}</span></span><strong className="toplist-count">{r.count}</strong></div>)}
  </div>
  {missingIds.length > 0 && <CoverArtLoader ids={missingIds} />}
  {isSearching ? (totalPages > 1 && <nav className="pager" aria-label="Search result pages">
    <Link className={page <= 1 ? "pager-btn pager-disabled" : "pager-btn"} aria-disabled={page <= 1} href={page <= 1 ? pageHref(1) : pageHref(page - 1)}>← Prev</Link>
    {Array.from({ length: totalPages }, (_, n) => n + 1).map((n) => <Link key={n} href={pageHref(n)} aria-current={n === page ? "page" : undefined} className={n === page ? "pager-btn pager-current" : "pager-btn"}>{n}</Link>)}
    <Link className={page >= totalPages ? "pager-btn pager-disabled" : "pager-btn"} aria-disabled={page >= totalPages} href={page >= totalPages ? pageHref(totalPages) : pageHref(page + 1)}>Next →</Link>
  </nav>) : ((page > 1 || hasNext) && <nav className="pager" aria-label="Top 500 pages">
    <Link className={page <= 1 ? "pager-btn pager-disabled" : "pager-btn"} aria-disabled={page <= 1} href={page <= 1 ? pageHref(1) : pageHref(page - 1)}>← Prev</Link>
    <span className="pager-label">Page {page}</span>
    {hasNext
      ? <Link className="pager-btn" href={pageHref(page + 1)}>Next →</Link>
      : <span className="pager-btn pager-disabled" aria-disabled="true">Next →</span>}
  </nav>)}</div></main>;
}
