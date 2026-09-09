import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { parseSpotifyPlaylistId, spotifyAuthorizeUrl } from "@/lib/spotify";
import { createOAuthState } from "@/lib/oauth-state";
import { clientAddress, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limit = rateLimit(`submission-start:${clientAddress(request)}`, 10, 60_000);
  if (!limit.allowed) return NextResponse.json({ error: "Zu viele Importversuche. Bitte kurz warten." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  try {
    const { challengeId, playlistUrl } = await request.json();
    if (typeof challengeId !== "string") return NextResponse.json({ error: "Ungültige Challenge." }, { status: 400 });
    const playlistId = parseSpotifyPlaylistId(String(playlistUrl ?? ""));
    const iat = Date.now();
    const state = createOAuthState({ provider: "spotify", challengeId, playlistId, nonce: crypto.randomBytes(24).toString("hex"), iat, exp: iat + 10 * 60 * 1000 });
    const response = NextResponse.json({ authorizeUrl: spotifyAuthorizeUrl(state) });
    response.cookies.set("spotify_oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600 });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Ungültige Eingabe" }, { status: 400 });
  }
}
