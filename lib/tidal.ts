import crypto from "node:crypto";
import { config } from "@/lib/config";

const AUTH = "https://auth.tidal.com/v1/oauth2";
const LOGIN = "https://login.tidal.com";
const API = "https://openapi.tidal.com/v2";

type TokenResponse = { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
type TidalResource = { id: string; type?: string; attributes?: Record<string, unknown> };
type TidalResponse = { data?: TidalResource | TidalResource[]; included?: TidalResource[]; links?: { next?: string | null } };

export function createTidalCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

export function tidalAuthorizeUrl(state: string, codeChallenge: string) {
  const params = new URLSearchParams({
    client_id: config.tidalClientId,
    response_type: "code",
    redirect_uri: config.tidalRedirectUri,
    scope: "user.read playlists.read",
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    state,
  });
  return `${LOGIN}/authorize?${params}`;
}

export async function exchangeTidalCode(code: string, codeVerifier: string): Promise<{ access_token: string }> {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: config.tidalClientId, code, redirect_uri: config.tidalRedirectUri, code_verifier: codeVerifier });
  const response = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const payload = await response.json() as TokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(`Tidal token exchange failed: ${response.status} ${payload.error_description ?? payload.error ?? "access token missing"}`);
  }
  return { access_token: payload.access_token };
}

async function tidalFetch<T extends TidalResponse>(token: string, path: string): Promise<T> {
  if (!token) throw new Error("Tidal access token is missing.");
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.tidal.v1+json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Tidal API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

export function parseTidalPlaylistId(input: string) {
  const value = input.trim();
  const match = value.match(/(?:listen\.)?tidal\.com\/(?:browse\/)?playlist\/([A-Za-z0-9-]+)(?:\?|$)/i) ?? value.match(/^tidal:playlist:([A-Za-z0-9-]+)$/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9-]{8,}$/.test(value)) return value;
  throw new Error("Keine gültige Tidal-Playlist-URL oder Playlist-ID.");
}

function attributes(resource: TidalResource | undefined) { return resource?.attributes ?? {}; }

export async function getTidalCurrentUser(token: string) {
  const response = await tidalFetch<TidalResponse>(token, "/users/me");
  const user = Array.isArray(response.data) ? response.data[0] : response.data;
  return { id: user?.id ?? "unknown" };
}

export async function getTidalPlaylist(token: string, playlistId: string) {
  const response = await tidalFetch<TidalResponse>(token, `/playlists/${encodeURIComponent(playlistId)}?countryCode=US`);
  const playlist = Array.isArray(response.data) ? response.data[0] : response.data;
  return { id: playlist?.id ?? playlistId, name: String(attributes(playlist).title ?? "Tidal Playlist"), url: `https://tidal.com/browse/playlist/${playlistId}` };
}

export async function getTidalPlaylistTracks(token: string, playlistId: string) {
  const tracks: TidalResource[] = [];
  let path = `/playlists/${encodeURIComponent(playlistId)}/relationships/items?countryCode=US&include=items`;
  while (path) {
    const response = await tidalFetch<TidalResponse>(token, path);
    const included = response.included?.filter((resource) => resource.type === "tracks") ?? [];
    const data = Array.isArray(response.data) ? response.data : [];
    tracks.push(...(included.length ? included : data));
    const next = response.links?.next;
    path = next ? (next.startsWith(API) ? next.slice(API.length) : next) : "";
  }
  return tracks;
}

export function tidalTrackDetails(track: TidalResource) {
  const data = attributes(track);
  const artists = Array.isArray(data.artists) ? data.artists : [];
  const firstArtist = artists[0] as { id?: string; name?: string } | undefined;
  return { id: track.id, name: String(data.title ?? "Untitled"), artistName: String(firstArtist?.name ?? data.artistName ?? "Unknown artist"), artistId: firstArtist?.id ?? (typeof data.artistId === "string" ? data.artistId : null), isrc: typeof data.isrc === "string" ? data.isrc : null };
}