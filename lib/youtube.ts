import { config } from "@/lib/config";

const API = "https://www.googleapis.com/youtube/v3";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

type TokenResponse = { access_token: string; expires_in: number; scope: string; token_type: string; refresh_token?: string };
export type YouTubePlaylistItem = {
  id: string;
  snippet?: {
    position?: number;
    title?: string;
    channelTitle?: string;
    videoOwnerChannelId?: string;
    videoOwnerChannelTitle?: string;
    resourceId?: { videoId?: string };
  };
};

export function youtubeAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    access_type: "online",
    include_granted_scopes: "true",
    prompt: "select_account",
    state,
  });
  return `${AUTH}?${params}`;
}

export async function exchangeYouTubeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: config.googleRedirectUri, grant_type: "authorization_code" });
  const response = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(`Google OAuth ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

async function ytFetch<T>(token: string, endpoint: string, params: Record<string,string>): Promise<T> {
  const search = new URLSearchParams(params);
  const response = await fetch(`${API}/${endpoint}?${search}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const data = await response.json();
  if (process.env.NODE_ENV !== "production") console.log(`[YouTube API] ${endpoint}`, JSON.stringify(data, null, 2));
  if (!response.ok) throw new Error(`YouTube API ${response.status}: ${JSON.stringify(data).slice(0, 700)}`);
  return data;
}

export function parseYouTubePlaylistId(input: string) {
  const value = input.trim();
  try {
    const url = new URL(value);
    const list = url.searchParams.get("list");
    if (list) return list;
  } catch {}
  if (/^[\w-]{10,}$/.test(value)) return value;
  throw new Error("Keine gültige YouTube-Playlist-URL oder Playlist-ID.");
}

export async function getYouTubeCurrentChannel(token: string) {
  const data = await ytFetch<{items?: Array<{id:string;snippet?:{title?:string}}> }>(token, "channels", { part: "id,snippet", mine: "true" });
  return data.items?.[0] ?? null;
}

export async function getYouTubePlaylist(token: string, playlistId: string) {
  const data = await ytFetch<{items?: Array<{id:string;snippet?:{title?:string;channelId?:string;channelTitle?:string}}>}>(token, "playlists", { part: "snippet", id: playlistId, maxResults: "1" });
  const playlist = data.items?.[0];
  if (!playlist) throw new Error("YouTube-Playlist wurde nicht gefunden oder ist für diesen Account nicht zugänglich.");
  return playlist;
}

export async function getYouTubePlaylistItems(token: string, playlistId: string, maxItems: number) {
  const items: YouTubePlaylistItem[] = [];
  let pageToken = "";
  do {
    const data = await ytFetch<{items?:YouTubePlaylistItem[];nextPageToken?:string}>(token, "playlistItems", {
      part: "snippet",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    items.push(...(data.items ?? []));
    if (items.length >= maxItems) break;
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return items.filter((item) => item.snippet?.resourceId?.videoId).slice(0, maxItems);
}

export function youtubeVideoTitleToArtistTrack(title: string, channelTitle?: string, channelId?: string) {
  const raw = title.trim();
  for (const separator of [" - ", " – ", " — ", " | "]) {
    const index = raw.indexOf(separator);
    if (index > 0) {
      const artist = raw.slice(0, index).trim();
      const track = raw.slice(index + separator.length).trim();
      if (artist && track) return { artist, track, artistKey: artist.toLocaleLowerCase("de-DE"), method: "title-separator" as const };
    }
  }
  const artist = channelTitle?.replace(/\s+-\s+Topic\s*$/i, "").trim() || raw;
  return { artist, track: raw, artistKey: channelId ?? artist.toLocaleLowerCase("de-DE"), method: "channel-fallback" as const };
}
