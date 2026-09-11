"use client";

import { useState } from "react";

type Provider = "spotify" | "youtube" | "tidal";

function detectProviderFromUrl(input: string): Provider | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("spotify.com") || value.startsWith("spotify:playlist:")) return "spotify";
  if (value.includes("tidal.com") || value.startsWith("tidal:playlist:")) return "tidal";
  if (
    value.includes("youtube.com") ||
    value.includes("youtu.be") ||
    value.includes("youtube-nocookie.com") ||
    value.includes("music.youtube.com")
  )
    return "youtube";
  return null;
}

export function SubmitForm({ challengeId, providers }: { challengeId: string; providers: Record<Provider, boolean> }) {
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [hasError, setHasError] = useState(false);

  const detected = detectProviderFromUrl(url);
  const detectedLabel = detected === "youtube" ? "YouTube" : detected === "spotify" ? "Spotify" : detected === "tidal" ? "Tidal" : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!detected) {
      setHasError(true);
      setMessage("Paste a Spotify, YouTube, or Tidal playlist link to continue.");
      return;
    }
    if (!providers[detected]) {
      setHasError(true);
      setMessage(`${detected === "youtube" ? "YouTube" : detected === "tidal" ? "Tidal" : "Spotify"} imports are not enabled.`);
      return;
    }
    setHasError(false);
    setMessage("Preparing playlist …");
    const endpoint = detected === "youtube" ? "/api/submissions/youtube/start" : detected === "tidal" ? "/api/submissions/tidal/start" : "/api/submissions/start";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeId, playlistUrl: url }) });
      const text = await response.text();
      let data: { error?: string; authorizeUrl?: string } = {};
      try { data = JSON.parse(text) as typeof data; } catch {}
      if (!response.ok) { setHasError(true); setMessage(data.error ?? (text.slice(0, 300) || "Import failed.")); return; }
      if (!data.authorizeUrl) { setHasError(true); setMessage("The import could not be started."); return; }
      window.location.href = data.authorizeUrl;
    } catch {
      setHasError(true);
      setMessage("The import could not be started.");
    }
  }

  return <div className="card">
    <h2>Submit a playlist</h2>
    <p className="muted">You do not need an account here. Your music provider will handle authentication.</p>
    <form onSubmit={submit} noValidate>
      <input value={url} onChange={(e) => { setUrl(e.target.value); if (hasError) setHasError(false); }} placeholder="Paste a Spotify, YouTube, or Tidal playlist link…" aria-invalid={hasError} style={hasError ? { borderColor: "#e5484d" } : undefined} />
      <br/><br/>
      <button type="submit" style={hasError ? { background: "#e5484d", color: "#fff" } : undefined}>{detectedLabel ? `Import from ${detectedLabel}` : "Import playlist"}</button>
    </form>
    {message && <p className={hasError ? "error" : "muted"} role={hasError ? "alert" : "status"}>{message}</p>}
  </div>;
}
