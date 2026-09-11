"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { SubmitForm } from "@/components/SubmitForm";
import { SiteNav } from "@/components/SiteNav";
import { CoverArtLoader } from "@/components/CoverArtLoader";

type Challenge = { id: string; name: string; slug: string };
type Providers = { spotify: boolean; youtube: boolean; tidal: boolean };

export function HomeExperience({
  challenges,
  providers,
  challengeLinks,
  topResults,
  missingCoverArtIds,
  notice,
  error,
}: {
  challenges: Challenge[];
  providers: Providers;
  challengeLinks: { slug: string; name: string }[];
  topResults: { artist: string; track: string; count: number; coverArtUrl: string | null; recordingId?: string | null }[];
  missingCoverArtIds?: string[];
  notice?: string;
  error?: string;
}) {
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const [selectedChallengeId, setSelectedChallengeId] = useState(challenges[0]?.id ?? "");
  const [hovered, setHovered] = useState<{ r: number; c: number; t: number } | null>(null);
  const [now, setNow] = useState(0);
  const [showNotice, setShowNotice] = useState(!!notice);
  const [showError, setShowError] = useState(!!error);
  const floorRef = useRef<HTMLDivElement>(null);
  const [floorSize, setFloorSize] = useState({ w: 0, h: 0 });

  // Tick while hovering so the glow can decay / fan out when the mouse stops.
  useEffect(() => {
    if (!hovered) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [hovered?.r, hovered?.c]);

  // Reset visibility when a new notice/error arrives (e.g. after OAuth redirect).
  useEffect(() => { setShowNotice(!!notice); }, [notice]);
  useEffect(() => { setShowError(!!error); }, [error]);

  // Auto-dismiss after 6s and strip ?notice/?error from the URL so a
  // refresh doesn't bring the banner back.
  useEffect(() => {
    if (!showNotice && !showError) return;
    const id = setTimeout(() => {
      setShowNotice(false);
      setShowError(false);
      window.history.replaceState(null, "", window.location.pathname);
    }, 6000);
    return () => clearTimeout(id);
  }, [showNotice, showError, notice, error]);

  const ROWS = 11;
  const GAP = 3;
  const FLOOR_PAD = 3;
  useEffect(() => {
    const el = floorRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setFloorSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ceil (not floor) so tiles slightly overflow and get clipped by
  // overflow:hidden instead of underfilling and leaving a black strip.
  const tileSize = floorSize.h > 0 ? Math.ceil((floorSize.h - GAP * (ROWS - 1) - FLOOR_PAD * 2) / ROWS) : 0;
  const COLS = tileSize > 0 && floorSize.w > 0 ? Math.max(1, Math.ceil((floorSize.w - FLOOR_PAD * 2 + GAP) / (tileSize + GAP))) : 36;
  // Stable random colors so resizing doesn't reshuffle the pattern.
  const discoColors = useMemo(() => {
    const palette = ["#ff2fb3", "#00e5ff", "#ffe600", "#7cff00", "#ff6b00", "#9d00ff", "#ff003c", "#00ff9d"];
    return Array.from({ length: 120 * ROWS }, () => palette[Math.floor(Math.random() * palette.length)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const discoTiles = useMemo(() => {
    return Array.from({ length: COLS * ROWS }, (_, i) => {
      const r = Math.floor(i / COLS);
      const c = i % COLS;
      return { id: i, r, c, color: discoColors[i % discoColors.length] };
    });
  }, [COLS, discoColors]);

  function handleFloorMove(e: React.MouseEvent<HTMLElement>) {
    if (!tileSize || !floorRef.current) return;
    const rect = floorRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - FLOOR_PAD;
    const y = e.clientY - rect.top - FLOOR_PAD;
    const step = tileSize + GAP;
    const c = Math.floor(x / step);
    const r = Math.floor(y / step);
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) {
      setHovered(null);
      return;
    }
    const t = Date.now();
    setHovered((prev) => (prev?.r === r && prev?.c === c ? { ...prev, t } : { r, c, t }));
    setNow(t);
  }

  function openSubmit() {
    setSelectedChallengeId((current) => current || challenges[0]?.id || "");
    setIsSubmitOpen(true);
  }

  return <main className="home-shell">
    <SiteNav
      active="home"
      resultsHref={challengeLinks[0] ? `/challenge/${challengeLinks[0].slug}/results` : "#challenges-title"}
      topHref={challengeLinks[0] ? `/challenge/${challengeLinks[0].slug}/toplist` : "#challenges-title"}
    />
    <section className="hero-banner disco-banner" aria-labelledby="home-title" onMouseMove={handleFloorMove} onMouseLeave={() => setHovered(null)}>
      <div
        ref={floorRef}
        className="disco-floor"
        aria-hidden="true"
        style={
          tileSize
            ? {
                display: "grid",
                gridTemplateColumns: `repeat(${COLS}, ${tileSize}px)`,
                gridAutoRows: `${tileSize}px`,
                gap: GAP,
                padding: FLOOR_PAD,
                justifyContent: "start",
                alignContent: "start",
              }
            : undefined
        }
      >
        {discoTiles.map((tile) => {
          // Square Chebyshev neighborhood. When the mouse stops, the glow
          // fans out (radius grows, intensity decays) instead of sitting hot.
          const idleMs = hovered ? Math.max(0, now - hovered.t) : 0;
          const spread = hovered ? Math.min(3, Math.floor(idleMs / 350)) : 0;
          const decay = hovered ? Math.max(0.25, 1 - idleMs / 1600) : 0;
          let glow = 0;
          if (hovered) {
            const d = Math.max(Math.abs(tile.r - hovered.r), Math.abs(tile.c - hovered.c));
            const radius = 2 + spread;
            if (d <= radius) {
              const edge = d / (radius + 1);
              glow = (1 - edge) * decay;
            }
          }
          const bright = glow > 0 ? 1 + glow * 1.35 : 1;
          return (
            <span
              key={tile.id}
              className="disco-tile"
              style={
                {
                  width: tileSize ? `${tileSize}px` : undefined,
                  height: tileSize ? `${tileSize}px` : undefined,
                  background: tile.color,
                  opacity: glow > 0 ? 0.5 + glow * 0.5 : 0.5,
                  boxShadow: glow > 0 ? `0 0 ${Math.round(glow * 63)}px ${tile.color}, 0 0 ${Math.round(glow * 15)}px #fff inset` : "0 0 0px transparent",
                  filter: glow > 0 ? `brightness(${bright.toFixed(2)}) saturate(1.6)` : "brightness(1) saturate(1)",
                  zIndex: glow > 0 ? 1 : 0,
                } as React.CSSProperties
              }
            />
          );
        })}
      </div>
      <div className="hero-glow" aria-hidden="true" />
      {showError && error && <p className="error" role="alert">{error}</p>}
      {showNotice && notice && <p className="notice" role="status">{notice}</p>}
      <div className="hero-copy">
        <p className="eyebrow">Playlist Challenge / 2026</p>
        <h1 id="home-title">Find the one song<br /><em>that stays with you.</em></h1>
        {/*<p className="hero-lede">One playlist. One track per artist. No excuses.</p>*/}
      </div>
      <button className="submit-launcher" type="button" onClick={openSubmit} disabled={!challenges.length}>
        <span className="launcher-icon" aria-hidden="true">+</span>
        <span><strong>Submit a playlist</strong><small>{challenges.length ? "Join the challenge" : "No open challenge"}</small></span>
      </button>
    </section>

    <section className="rules-section" aria-labelledby="rules-title">
      <div className="section-heading">
        <p className="eyebrow">How it works</p>
        <h2 id="rules-title">The rules are simple.</h2>
      </div>
      <div className="rules-grid">
        <article className="rule-item"><span>01</span><h3>One playlist</h3><p>Submit exactly one playlist per challenge.</p></article>
        <article className="rule-item"><span>02</span><h3>One song per artist</h3><p>Each artist can appear only once.</p></article>
        <article className="rule-item"><span>03</span><h3>Your taste</h3><p>Choose songs you genuinely want to keep.</p></article>
      </div>
    </section>

    <section className="results-preview" aria-labelledby="results-title">
      <div className="section-heading compact"><p className="eyebrow">Leaderboard</p><h2 id="results-title">Top 5 results</h2>{challengeLinks[0] && <Link className="top-link" href={`/challenge/${challengeLinks[0].slug}/toplist`}>View full Top 500 →</Link>}</div>
      {!topResults.length && <p className="muted">No results yet.</p>}
      {topResults.map((result, index) => <div className="result-row" key={`${result.artist}-${result.track}`}><span className="result-rank">{String(index + 1).padStart(2, "0")}</span>{result.coverArtUrl ? <Image className="result-art" src={result.coverArtUrl} alt="" width={56} height={56} /> : <span className="result-art result-art-fallback" data-cover-id={result.recordingId ?? undefined} aria-hidden="true" />}<span className="result-song"><strong>{result.track}</strong><small>{result.artist}</small></span><strong className="result-count">{result.count}</strong></div>)}
      {missingCoverArtIds && missingCoverArtIds.length > 0 && <CoverArtLoader ids={missingCoverArtIds} />}
    </section>

    {isSubmitOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsSubmitOpen(false); }}>
      <div className="submission-modal" role="dialog" aria-modal="true" aria-labelledby="submit-title">
        <button className="modal-close" type="button" aria-label="Close window" onClick={() => setIsSubmitOpen(false)}>x</button>
        <p className="eyebrow">Your submission</p>
        <h2 id="submit-title">Bring your playlist.</h2>
        {challenges.length > 1 && <label className="challenge-picker">Challenge<select value={selectedChallengeId} onChange={(event) => setSelectedChallengeId(event.target.value)}>{challenges.map((challenge) => <option key={challenge.id} value={challenge.id}>{challenge.name}</option>)}</select></label>}
        {selectedChallengeId && <SubmitForm challengeId={selectedChallengeId} providers={providers} />}
      </div>
    </div>}
  </main>;
}