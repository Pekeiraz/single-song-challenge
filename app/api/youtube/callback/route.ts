import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getCachedYouTubePlaylist, getChallengeById, replaceSubmission, upsertYouTubePlaylistCache } from "@/lib/db";
import { participantKey } from "@/lib/participant";
import { readOAuthState } from "@/lib/oauth-state";
import { clientAddress, rateLimit } from "@/lib/rate-limit";
import { exchangeYouTubeCode, getYouTubeCurrentChannel, getYouTubePlaylist, getYouTubePlaylistItems, youtubeVideoTitleToArtistTrack } from "@/lib/youtube";

export const runtime = "nodejs";

function redirectToChallengeError(request: NextRequest, slug: string, message: string) {
  const url = new URL("/", request.url);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

function signlessParticipantKey(channelId: string, challengeId: string) {
  return participantKey("youtube", channelId, challengeId);
}

export async function GET(request: NextRequest) {
  const limit = rateLimit(`youtube-callback:${clientAddress(request)}`, 20, 60_000);
  if (!limit.allowed) return new NextResponse("Zu viele OAuth-Anfragen. Bitte kurz warten.", { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const oauthError = request.nextUrl.searchParams.get("error");
  if (oauthError) return new NextResponse(`YouTube OAuth abgebrochen: ${oauthError}`, { status: 400 });
  if (!code || !state) return new NextResponse("Ungültiger OAuth-Status.", { status: 400 });

  let challengeSlug: string | null = null;
  try {
    const decoded = readOAuthState(state, "youtube");
    if (!decoded) return new NextResponse("Ungültiger OAuth-Status.", { status: 400 });
    const challenge = getChallengeById(decoded.challengeId);
    if (!challenge || challenge.status !== "open") return new NextResponse("Challenge ist nicht offen.", { status: 409 });
    challengeSlug = challenge.slug;

    const token = await exchangeYouTubeCode(code);
    const channel = await getYouTubeCurrentChannel(token.access_token);
    if (!channel) return redirectToChallengeError(request, challenge.slug, "Kein YouTube-Kanal für den Google-Account gefunden.");

    const cached = getCachedYouTubePlaylist(decoded.playlistId, config.youtubeCacheTtlSeconds);
    let playlistName: string;
    let playlistUrl: string;
    let items: Awaited<ReturnType<typeof getYouTubePlaylistItems>>;

    if (cached) {
      playlistName = cached.playlist_name;
      playlistUrl = cached.playlist_url;
      items = cached.items as Awaited<ReturnType<typeof getYouTubePlaylistItems>>;
    } else {
      const playlist = await getYouTubePlaylist(token.access_token, decoded.playlistId);
      items = await getYouTubePlaylistItems(token.access_token, decoded.playlistId, config.maxPlaylistItems);
      playlistName = playlist.snippet?.title ?? "YouTube Playlist";
      playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(decoded.playlistId)}`;
      upsertYouTubePlaylistCache({
        playlistId: decoded.playlistId,
        playlistName,
        ownerChannelId: playlist.snippet?.channelId ?? null,
        playlistUrl,
        items,
      });
    }

    if (!items.length) return redirectToChallengeError(request, challenge.slug, "Die Playlist enthält keine importierbaren Videos.");

    const tracks = items.map((item, index) => {
      const snippet = item.snippet!;
      const parsed = youtubeVideoTitleToArtistTrack(snippet.title ?? "", snippet.videoOwnerChannelTitle ?? snippet.channelTitle, snippet.videoOwnerChannelId);
      return {
        position: snippet.position ?? index,
        providerTrackId: `youtube:${snippet.resourceId!.videoId!}`,
        trackName: parsed.track,
        artistName: parsed.artist,
        artistKey: parsed.artistKey,
        providerArtistId: snippet.videoOwnerChannelId ?? null,
        isrc: null,
        parseMethod: parsed.method,
      };
    });

    const seen = new Map<string,string>();
    for (const track of tracks) {
      const key = track.artistKey.toLocaleLowerCase("de-DE").replace(/\s+/g," ").trim();
      if (seen.has(key)) return redirectToChallengeError(request, challenge.slug, `Doppelter Interpret: ${track.artistName}.`);
      seen.set(key, track.trackName);
    }

    const rows = tracks.map((track) => ({
      position: track.position,
      providerTrackId: track.providerTrackId,
      trackName: track.trackName,
      artistName: track.artistName,
      providerArtistId: track.providerArtistId,
      isrc: track.isrc,
      musicbrainzRecordingId: null,
      musicbrainzArtistId: null,
      musicbrainzMatchMethod: `youtube:${track.parseMethod}`,
    }));

    const result = replaceSubmission({
      challengeId: challenge.id,
      participantKey: signlessParticipantKey(channel.id, challenge.id),
      provider: "youtube",
      playlistId: decoded.playlistId,
      playlistName,
      playlistUrl,
      snapshotId: null,
      tracks: rows,
    });
    // Matching is decoupled: a background worker (npm run db:match-once)
    // picks up unmatched tracks. Never block the request on MusicBrainz.

    const notice = result.replaced ? "Deine bisherige Einreichung wurde ersetzt." : "Deine Playlist wurde erfolgreich eingereicht.";
    const response = NextResponse.redirect(new URL(`/?notice=${encodeURIComponent(notice)}`, request.url));
    response.cookies.delete("youtube_oauth_state");
    return response;
  } catch (error) {
    if (challengeSlug) return redirectToChallengeError(request, challengeSlug, error instanceof Error ? error.message : "YouTube-Import fehlgeschlagen.");
    return new NextResponse(error instanceof Error ? error.message : "YouTube-Import fehlgeschlagen.", { status: 500 });
  }
}
