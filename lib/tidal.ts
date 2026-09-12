import crypto from "node:crypto";
import { config } from "@/lib/config";

const AUTH = "https://auth.tidal.com/v1/oauth2";
const LOGIN = "https://login.tidal.com";
const API = "https://openapi.tidal.com/v2";

type TokenResponse = { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
type TidalRelationshipData = { id: string; type?: string };
type TidalResource = { id: string; type?: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: TidalRelationshipData | TidalRelationshipData[] | null }> };
type TidalResponse = { data?: TidalResource | TidalResource[]; included?: TidalResource[]; links?: { next?: string | null }; errors?: Array<{ code?: string; detail?: string; title?: string }> };

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
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.api+json" }, cache: "no-store" });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    // TIDAL returns JSON:API { errors: [...] } or RFC7807 { title, detail, status }.
    try {
      const parsed = JSON.parse(body) as TidalResponse & { title?: string; detail?: string; status?: number };
      const first = parsed.errors?.[0];
      if (first) throw new Error(`Tidal API ${response.status} [${first.code ?? first.title ?? "error"}]: ${first.detail ?? first.title ?? body}`);
      if (parsed.title ?? parsed.detail) throw new Error(`Tidal API ${response.status} [${parsed.title ?? "error"}]: ${parsed.detail ?? body}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Tidal API")) throw e;
    }
    throw new Error(`Tidal API ${response.status}: ${body}`);
  }
  return response.json();
}

export function parseTidalPlaylistId(input: string) {
  const value = input.trim();
  const match = value.match(/(?:listen\.)?tidal\.com\/(?:browse\/)?playlist\/([A-Za-z0-9-]+)(?:[?/#]|$)/i) ?? value.match(/^tidal:playlist:([A-Za-z0-9-]+)$/i);
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
  const attrs = attributes(playlist);
  // NOTE: the OpenAPI spec names this field `name`, not `title`.
  const name = attrs.name ?? attrs.title;
  return { id: playlist?.id ?? playlistId, name: String(name ?? "Tidal Playlist"), url: `https://tidal.com/browse/playlist/${playlistId}` };
}

function includedById(included: TidalResource[] | undefined) {
  const map = new Map<string, TidalResource>();
  for (const resource of included ?? []) map.set(`${resource.type}:${resource.id}`, resource);
  return map;
}

function relationshipIds(resource: TidalResource | undefined, name: string): string[] {
  const data = resource?.relationships?.[name]?.data;
  if (!data) return [];
  const list = Array.isArray(data) ? data : [data];
  return list.map((entry) => entry.id).filter(Boolean);
}

export async function getTidalPlaylistTracks(token: string, playlistId: string) {
  const tracks: TidalResource[] = [];
  const artistsById = new Map<string, TidalResource>();
  // `items.artists` embeds tracks AND their artists (nested includes auto-embed
  // intermediates). Fall back to `items` if the server rejects the nested path.
  let path = `/playlists/${encodeURIComponent(playlistId)}/relationships/items?countryCode=US&include=items.artists`;
  let fellBack = false;
  while (path) {
    let response: TidalResponse;
    try {
      response = await tidalFetch<TidalResponse>(token, path);
    } catch (error) {
      if (!fellBack && path.includes("items.artists") && error instanceof Error && error.message.includes("400")) {
        fellBack = true;
        path = `/playlists/${encodeURIComponent(playlistId)}/relationships/items?countryCode=US&include=items`;
        continue;
      }
      throw error;
    }
    const byId = includedById(response.included);
    for (const [key, resource] of byId) if (key.startsWith("artists:")) artistsById.set(resource.id, resource);
    // `data` holds identifiers; full objects live in `included` when requested.
    const data = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
    for (const entry of data) {
      if (entry.type && entry.type !== "tracks" && entry.type !== "videos") continue;
      const full = (entry.type ? byId.get(`${entry.type}:${entry.id}`) : undefined) ?? entry;
      if (full.type === "videos") continue; // skip videos for the challenge
      // Attach resolved artist name/id so tidalTrackDetails stays sync.
      const artistId = relationshipIds(full, "artists")[0];
      const artist = artistId ? (artistsById.get(artistId) ?? byId.get(`artists:${artistId}`)) : undefined;
      if (artist) {
        (full as TidalResource).attributes = { ...attributes(full), _resolvedArtistName: attributes(artist).name, _resolvedArtistId: artist.id };
        if (!artistsById.has(artist.id)) artistsById.set(artist.id, artist);
      }
      tracks.push(full);
    }
    // Also accept already-expanded track objects in `included` (older behaviour).
    for (const resource of response.included ?? []) {
      if (resource.type !== "tracks" || tracks.some((t) => t.id === resource.id)) continue;
      const artistId = relationshipIds(resource, "artists")[0];
      const artist = artistId ? artistsById.get(artistId) : undefined;
      if (artist) resource.attributes = { ...attributes(resource), _resolvedArtistName: attributes(artist).name, _resolvedArtistId: artist.id };
      tracks.push(resource);
    }
    const next = response.links?.next;
    path = next ? (next.startsWith(API) ? next.slice(API.length) : next) : "";
  }
  return tracks;
}

export function tidalTrackDetails(track: TidalResource) {
  const data = attributes(track);
  const artists = Array.isArray(data.artists) ? data.artists : [];
  const firstArtist = artists[0] as { id?: string; name?: string } | undefined;
  const relArtistId = relationshipIds(track, "artists")[0];
  const version = typeof data.version === "string" && data.version ? ` (${data.version})` : "";
  return {
    id: track.id,
    name: String(data.title ?? "Untitled") + (data.title ? version : ""),
    artistName: String(firstArtist?.name ?? data._resolvedArtistName ?? data.artistName ?? "Unknown artist"),
    artistId: firstArtist?.id ?? (typeof data._resolvedArtistId === "string" ? data._resolvedArtistId : null) ?? relArtistId ?? (typeof data.artistId === "string" ? data.artistId : null),
    isrc: typeof data.isrc === "string" ? data.isrc : null,
  };
}