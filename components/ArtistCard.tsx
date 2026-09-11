"use client";

import { useState } from "react";

export type ArtistCardSong = {
  track: string;
  recordingId: string | null;
  count: number;
  coverArtUrl: string | null;
};

export function ArtistCard({
  artist,
  songCount,
  totalVotes,
  songs,
}: {
  artist: string;
  artistKey: string;
  songCount: number;
  totalVotes: number;
  songs: ArtistCardSong[];
}) {
  const PREVIEW = 6;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? songs : songs.slice(0, PREVIEW);
  const hidden = songs.length - visible.length;

  return (
    <section className="card artist-card" aria-label={artist}>
      <header className="artist-header">
        <h2>{artist}</h2>
        <span className="muted">
          {songCount} {songCount === 1 ? "song" : "songs"} · {totalVotes}{" "}
          {totalVotes === 1 ? "vote" : "votes"}
        </span>
      </header>
      <div className="artist-grid">
        {visible.map((s) => (
          <div
            className="track result-track artist-tile"
            key={`${s.recordingId ?? s.track}`}
            title={`${s.track} · ${s.count}×`}
          >
            {s.coverArtUrl ? (
              <img
                className="result-art"
                src={s.coverArtUrl}
                alt=""
                width={56}
                height={56}
                loading="lazy"
              />
            ) : (
              <span
                className="result-art result-art-fallback"
                data-cover-id={s.recordingId ?? undefined}
                aria-hidden="true"
              />
            )}
            <span className="artist-tile-info">
              <strong>{s.track}</strong>
            </span>
            <strong>{s.count}×</strong>
          </div>
        ))}
      </div>
      {songs.length > PREVIEW && (
        <button
          type="button"
          className="pager-btn artist-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show all ${songs.length} songs (+${hidden})`}
        </button>
      )}
    </section>
  );
}
