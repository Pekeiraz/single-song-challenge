export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function configured(...names: string[]) {
  return names.every((name) => Boolean(process.env[name]));
}

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const config = {
  get spotifyConfigured() { return configured("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI"); },
  get youtubeConfigured() { return configured("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"); },
  get tidalConfigured() { return configured("TIDAL_CLIENT_ID", "TIDAL_CLIENT_SECRET", "TIDAL_REDIRECT_URI"); },
  get appUrl() { return required("NEXT_PUBLIC_APP_URL"); },
  get spotifyClientId() { return required("SPOTIFY_CLIENT_ID"); },
  get spotifyClientSecret() { return required("SPOTIFY_CLIENT_SECRET"); },
  get spotifyRedirectUri() { return required("SPOTIFY_REDIRECT_URI"); },
  get googleClientId() { return required("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return required("GOOGLE_CLIENT_SECRET"); },
  get googleRedirectUri() { return required("GOOGLE_REDIRECT_URI"); },
  get tidalClientId() { return required("TIDAL_CLIENT_ID"); },
  get tidalClientSecret() { return required("TIDAL_CLIENT_SECRET"); },
  get tidalRedirectUri() { return required("TIDAL_REDIRECT_URI"); },
  get participantKeySecret() { return required("PARTICIPANT_KEY_SECRET"); },
  get musicBrainzUserAgent() { return required("MUSICBRAINZ_USER_AGENT"); },
  get musicBrainzContactEmail() { return process.env.MUSICBRAINZ_CONTACT_EMAIL ?? ""; },
  get youtubeCacheTtlSeconds() { return positiveInteger("YOUTUBE_CACHE_TTL_SECONDS", 900); },
  get maxPlaylistItems() { return positiveInteger("MAX_PLAYLIST_ITEMS", 500); },
};
