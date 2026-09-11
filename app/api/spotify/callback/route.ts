import { NextRequest, NextResponse } from "next/server";
import { getChallengeById, replaceSubmission } from "@/lib/db";
import type { SubmissionTrackInput } from "@/lib/db";
import { participantKey } from "@/lib/participant";
import { readOAuthState } from "@/lib/oauth-state";
import { clientAddress, rateLimit } from "@/lib/rate-limit";
import { exchangeCode, getCurrentUser, getPlaylist, getPlaylistItems } from "@/lib/spotify";

export const runtime = "nodejs";

function redirectToChallengeError(request: NextRequest, slug: string, message: string) {
  const url = new URL("/", request.url);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const limit = rateLimit(`spotify-callback:${clientAddress(request)}`, 20, 60_000);
  if (!limit.allowed) return new NextResponse("Zu viele OAuth-Anfragen. Bitte kurz warten.", { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const oauthError = request.nextUrl.searchParams.get("error");
  if (oauthError) return new NextResponse(`Spotify OAuth abgebrochen: ${oauthError}`, { status: 400 });
  if (!code || !state) return new NextResponse("Ungültiger OAuth-Status.", { status: 400 });

  let challengeSlug: string | null = null;
  try {
    const decoded = readOAuthState(state, "spotify");
    if (!decoded) return new NextResponse("Ungültiger OAuth-Status.", { status: 400 });
    const challenge = getChallengeById(decoded.challengeId);
    if (!challenge || challenge.status !== "open") return new NextResponse("Challenge ist nicht offen.", { status: 409 });
    challengeSlug = challenge.slug;
    const openChallengeSlug = challenge.slug;
    const openChallengeId = challenge.id;

    const token = await exchangeCode(code);
    const user = await getCurrentUser(token.access_token);
    const accountId = user.account_id ?? user.id;
    const playlist = await getPlaylist(token.access_token, decoded.playlistId);
    const tracks = await getPlaylistItems(token.access_token, decoded.playlistId);
    if (!tracks.length) return redirectToChallengeError(request, challenge.slug, "Die Playlist enthält keine importierbaren Titel.");

    const seenArtists = new Map<string, string>();
    for (const track of tracks) for (const artist of track.artists) {
      if (seenArtists.has(artist.id)) return redirectToChallengeError(request, challenge.slug, `Doppelter Interpret: ${artist.name}.`);
      seenArtists.set(artist.id, track.name);
    }

    const rows: SubmissionTrackInput[] = [];
    for (let position = 0; position < tracks.length; position++) {
      const track = tracks[position];
      const artist = track.artists[0];
      rows.push({
        position,
        providerTrackId: track.id,
        trackName: track.name,
        artistName: artist.name,
        providerArtistId: artist.id,
        isrc: track.external_ids?.isrc ?? null,
        musicbrainzRecordingId: null,
        musicbrainzArtistId: null,
        musicbrainzMatchMethod: null,
      });
    }

    try {
      const result = replaceSubmission({
        challengeId: openChallengeId,
        participantKey: participantKey("spotify", accountId, openChallengeId),
        provider: "spotify",
        playlistId: playlist.id,
        playlistName: playlist.name,
        playlistUrl: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
        snapshotId: playlist.snapshot_id ?? null,
        tracks: rows,
      });
      // Matching is decoupled: a background worker (npm run db:match-once)
      // picks up unmatched tracks. Never block the request on MusicBrainz.

      const notice = result.replaced ? "Deine bisherige Einreichung wurde ersetzt." : "Deine Playlist wurde erfolgreich eingereicht.";
      const response = NextResponse.redirect(new URL(`/?notice=${encodeURIComponent(notice)}`, request.url));
      response.cookies.delete("spotify_oauth_state");
      return response;
    } catch (error) {
      return redirectToChallengeError(request, openChallengeSlug, error instanceof Error ? error.message : "Submission konnte nicht gespeichert werden.");
    }

    return NextResponse.redirect(new URL("/", request.url));
  } catch (error) {
    if (challengeSlug) return redirectToChallengeError(request, challengeSlug, error instanceof Error ? error.message : "Spotify-Import fehlgeschlagen.");
    return new NextResponse(error instanceof Error ? error.message : "Spotify-Import fehlgeschlagen.", { status: 500 });
  }
}
