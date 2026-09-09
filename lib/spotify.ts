import crypto from "node:crypto";
import { config } from "@/lib/config";

const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";

type TokenResponse = { access_token: string; token_type: string; expires_in: number; refresh_token?: string; scope: string };

export function spotifyAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: config.spotifyClientId,
    response_type: "code",
    redirect_uri: config.spotifyRedirectUri,
    scope: "playlist-read-private playlist-read-collaborative user-read-private",
    state,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const basic = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.spotifyRedirectUri });
  const response = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Spotify token exchange failed: ${response.status}`);
  return response.json();
}

export async function spotifyFetch<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`Spotify API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

export type SpotifyTrack = {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  external_ids?: { isrc?: string };
};

export type SpotifyPlaylist = { id: string; name: string; snapshot_id?: string; external_urls?: { spotify?: string } };

type ItemsPage = { items: Array<{ item?: SpotifyTrack; track?: SpotifyTrack; is_local?: boolean }>; next: string | null };

export async function getCurrentUser(token: string) { return spotifyFetch<{ account_id?: string; id: string }>(token, "/me"); }
export async function getPlaylist(token: string, id: string) { return spotifyFetch<SpotifyPlaylist>(token, `/playlists/${encodeURIComponent(id)}`); }

export async function getPlaylistItems(token: string, id: string) {
  const tracks: SpotifyTrack[] = [];
  let offset = 0;
  while (true) {
    const page = await spotifyFetch<ItemsPage>(token, `/playlists/${encodeURIComponent(id)}/items?limit=50&offset=${offset}&fields=items(item(id,name,artists(id,name),external_ids(isrc)),track(id,name,artists(id,name),external_ids(isrc)),is_local),next`);
    for (const entry of page.items) {
      const track = entry.item ?? entry.track;
      if (!entry.is_local && track?.id && track.artists?.length) tracks.push(track);
    }
    if (!page.next || page.items.length === 0) break;
    offset += page.items.length;
  }
  return tracks;
}

export function parseSpotifyPlaylistId(input: string) {
  const value = input.trim();
  const match = value.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)(?:\?|$)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{10,}$/.test(value)) return value;
  throw new Error("Keine gültige Spotify-Playlist-URL oder Playlist-ID.");
}

export function makeOAuthState(payload: object) { return Buffer.from(JSON.stringify(payload)).toString("base64url"); }
export function newNonce() { return crypto.randomBytes(24).toString("hex"); }
