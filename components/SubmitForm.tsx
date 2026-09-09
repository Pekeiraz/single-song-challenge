"use client";

import { useState } from "react";

type Provider = "spotify" | "youtube";

export function SubmitForm({ challengeId, providers }: { challengeId: string; providers: Record<Provider, boolean> }) {
  const defaultProvider: Provider = providers.youtube ? "youtube" : "spotify";
  const [provider, setProvider] = useState<Provider>(defaultProvider);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage("Preparing playlist …");
    const endpoint = provider === "youtube" ? "/api/submissions/youtube/start" : "/api/submissions/start";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeId, playlistUrl: url }) });
      const text = await response.text();
      let data: { error?: string; authorizeUrl?: string } = {};
      try { data = JSON.parse(text) as typeof data; } catch {}
      if (!response.ok) { setMessage(data.error ?? (text.slice(0, 300) || "Import failed.")); return; }
      if (!data.authorizeUrl) { setMessage("The import could not be started."); return; }
      window.location.href = data.authorizeUrl;
    } catch {
      setMessage("The import could not be started.");
    }
  }

  return <div className="card">
    <h2>Submit a playlist</h2>
    <p className="muted">You do not need an account here. Spotify or YouTube will handle authentication.</p>
    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
      {(["youtube", "spotify"] as Provider[]).map((value) => <button key={value} type="button" onClick={() => setProvider(value)} style={{ opacity: provider === value ? 1 : 0.55 }}>{value === "youtube" ? "YouTube" : "Spotify"}</button>)}
    </div>
    <form onSubmit={submit}>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={provider === "youtube" ? "https://www.youtube.com/playlist?list=..." : "https://open.spotify.com/playlist/..."} required />
      <br/><br/>
      <button type="submit">Import with {provider === "youtube" ? "YouTube" : "Spotify"}</button>
    </form>
    {message && <p className="muted">{message}</p>}
  </div>;
}
