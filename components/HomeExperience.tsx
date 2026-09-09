"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { SubmitForm } from "@/components/SubmitForm";

type Challenge = { id: string; name: string; slug: string };
type Providers = { spotify: boolean; youtube: boolean };

export function HomeExperience({
  challenges,
  providers,
  challengeLinks,
  topResults,
}: {
  challenges: Challenge[];
  providers: Providers;
  challengeLinks: { slug: string; name: string }[];
  topResults: { artist: string; track: string; count: number; coverArtUrl: string | null }[];
}) {
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const [selectedChallengeId, setSelectedChallengeId] = useState(challenges[0]?.id ?? "");

  function openSubmit() {
    setSelectedChallengeId((current) => current || challenges[0]?.id || "");
    setIsSubmitOpen(true);
  }

  return <main className="home-shell">
    <nav className="site-nav" aria-label="Main navigation">
      <Link className="brand-mark" href="/">Playlist Challenge</Link>
      <div className="nav-links">
        <Link className="active" href="/">Home</Link>
        <Link href={challengeLinks[0] ? `/challenge/${challengeLinks[0].slug}/results` : "#challenges-title"}>Results</Link>
      </div>
    </nav>
    <section className="hero-banner" aria-labelledby="home-title">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-copy">
        <p className="eyebrow">Playlist Challenge / 2026</p>
        <h1 id="home-title">Find the one song<br /><em>that stays with you.</em></h1>
        <p className="hero-lede">One playlist. One track per artist. No excuses.</p>
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
      <div className="section-heading compact"><p className="eyebrow">Leaderboard</p><h2 id="results-title">Top 5 results</h2></div>
      {!topResults.length && <p className="muted">No results yet.</p>}
      {topResults.map((result, index) => <div className="result-row" key={`${result.artist}-${result.track}`}><span className="result-rank">{String(index + 1).padStart(2, "0")}</span>{result.coverArtUrl ? <Image className="result-art" src={result.coverArtUrl} alt="" width={56} height={56} /> : <span className="result-art result-art-fallback" aria-hidden="true" />}<span className="result-song"><strong>{result.track}</strong><small>{result.artist}</small></span><strong className="result-count">{result.count}</strong></div>)}
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