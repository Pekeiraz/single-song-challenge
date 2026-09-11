import { NextRequest, NextResponse } from "next/server";
import { getChallengeById, replaceSubmission } from "@/lib/db";
import type { SubmissionTrackInput } from "@/lib/db";
import { participantKey } from "@/lib/participant";
import { readOAuthState } from "@/lib/oauth-state";
import { clientAddress, rateLimit } from "@/lib/rate-limit";
import { exchangeTidalCode, getTidalCurrentUser, getTidalPlaylist, getTidalPlaylistTracks, tidalTrackDetails } from "@/lib/tidal";

export const runtime = "nodejs";

function redirectToChallengeError(request: NextRequest, slug: string, message: string) {
  const url = new URL("/", request.url);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const limit = rateLimit(`tidal-callback:${clientAddress(request)}`, 20, 60_000);
  if (!limit.allowed) return new NextResponse("Zu viele OAuth-Anfragen. Bitte kurz warten.", { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const oauthError = request.nextUrl.searchParams.get("error");
  if (oauthError) return new NextResponse(`Tidal OAuth abgebrochen: ${oauthError}`, { status: 400 });
  if (!code || !state) return new NextResponse("Ungültiger OAuth-Status.", { status: 400 });

  let challengeSlug: string | null = null;
  try {
    const decoded = readOAuthState(state, "tidal");
    if (!decoded) return new NextResponse("Ungültiger OAuth-Status.", { status: 400 });
    const challenge = getChallengeById(decoded.challengeId);
    if (!challenge || challenge.status !== "open") return new NextResponse("Challenge ist nicht offen.", { status: 409 });
    challengeSlug = challenge.slug;
    if (!decoded.codeVerifier) return new NextResponse("Ungültiger Tidal OAuth-Status.", { status: 400 });
    const token = await exchangeTidalCode(code, decoded.codeVerifier);
    const user = await getTidalCurrentUser(token.access_token);
    const playlist = await getTidalPlaylist(token.access_token, decoded.playlistId);
    const tracks = (await getTidalPlaylistTracks(token.access_token, decoded.playlistId)).map(tidalTrackDetails);
    if (!tracks.length) return redirectToChallengeError(request, challenge.slug, "Die Playlist enthält keine importierbaren Titel.");
    const seenArtists = new Set<string>();
    for (const track of tracks) {
      const key = (track.artistId ?? track.artistName).toLocaleLowerCase("de-DE").trim();
      if (seenArtists.has(key)) return redirectToChallengeError(request, challenge.slug, `Doppelter Interpret: ${track.artistName}.`);
      seenArtists.add(key);
    }
    const rows: SubmissionTrackInput[] = tracks.map((track, position) => ({
      position,
      providerTrackId: track.id,
      trackName: track.name,
      artistName: track.artistName,
      providerArtistId: track.artistId,
      isrc: track.isrc,
      musicbrainzRecordingId: null,
      musicbrainzArtistId: null,
      musicbrainzMatchMethod: null,
    }));
    const result = replaceSubmission({ challengeId: challenge.id, participantKey: participantKey("tidal", user.id, challenge.id), provider: "tidal", playlistId: playlist.id, playlistName: playlist.name, playlistUrl: playlist.url, snapshotId: null, tracks: rows });
    // Matching is decoupled: a background worker (npm run db:match-once)
    // picks up unmatched tracks. Never block the request on MusicBrainz.
    const notice = result.replaced ? "Deine bisherige Einreichung wurde ersetzt." : "Deine Playlist wurde erfolgreich eingereicht.";
    const response = NextResponse.redirect(new URL(`/?notice=${encodeURIComponent(notice)}`, request.url));
    response.cookies.delete("tidal_oauth_state");
    return response;
  } catch (error) {
    if (challengeSlug) return redirectToChallengeError(request, challengeSlug, error instanceof Error ? error.message : "Tidal-Import fehlgeschlagen.");
    return new NextResponse(error instanceof Error ? error.message : "Tidal-Import fehlgeschlagen.", { status: 500 });
  }
}