# Playlist Challenge – Local MVP

Ein kleines Next.js-MVP für Playlist-Challenges ohne Supabase und ohne eigene Benutzerkonten.

## Architektur

- Next.js App Router + TypeScript
- **SQLite direkt über `node:sqlite`** – keine native npm-Datenbankabhängigkeit
- Spotify OAuth
- YouTube/Google OAuth
- MusicBrainz als externe Musikdatenbank zum Matching
- lokaler YouTube-Playlist-Cache zur Quota-Schonung

Node.js `node:sqlite` wurde in Node 22.5.0 eingeführt und ist in Node 24 unflagged; dieses Projekt verlangt daher Node >= 22.16.0. Siehe die [Node.js SQLite-Dokumentation](https://nodejs.org/api/sqlite.html).

## Datenbank

Die Datenbank wird automatisch erzeugt:

`data/playlist-challenge.db`

Die Datei ist in `.gitignore` und verlässt den Rechner nicht.

Tabellen:

- `challenges`
- `submissions`
- `submission_tracks`
- `youtube_playlist_cache`

Datenbankregeln:

- Ein Teilnehmer kann je Challenge genau eine Submission haben.
- Eine Playlist kann je Challenge und Provider nur einmal eingereicht werden.
- Eine erneute Abgabe desselben Teilnehmers ersetzt die alte Submission.

## Voraussetzungen

- Node.js >= 22.16
- Spotify Developer App
- Google Cloud Projekt mit YouTube Data API v3 und OAuth Client

## Installation

```powershell
npm install
npm run db:seed
npm run dev
```

Danach:

`http://127.0.0.1:3000/challenge/demo`

## `.env.local`

```env
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000

SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/api/spotify/callback

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/api/youtube/callback

PARTICIPANT_KEY_SECRET=...

MUSICBRAINZ_USER_AGENT=PlaylistChallenge/0.2.0 (https://example.com/contact)
MUSICBRAINZ_CONTACT_EMAIL=...

YOUTUBE_CACHE_TTL_SECONDS=900
MAX_PLAYLIST_ITEMS=500
```

## Spotify

Im Spotify Developer Dashboard muss als Redirect URI exakt folgende lokale Adresse stehen:

`http://127.0.0.1:3000/api/spotify/callback`

Der Spotify-Flow verwendet OAuth. Es wird kein eigener App-Account erzeugt. Aus der Spotify-Account-Kennung wird zusammen mit Challenge-ID und Secret ein HMAC-Teilnehmer-Key erzeugt; die rohe Account-ID wird nicht gespeichert.

## YouTube

In Google Cloud:

1. YouTube Data API v3 aktivieren.
2. OAuth Consent Screen konfigurieren.
3. OAuth Client ID vom Typ Web application erstellen.
4. Redirect URI setzen auf:
   `http://127.0.0.1:3000/api/youtube/callback`

Der YouTube-Flow verwendet `youtube.readonly`.

YouTube-Playlist-Items werden gesammelt und für eine begrenzte Zeit lokal gecacht. Dadurch löst das wiederholte Einreichen derselben Playlist keine unnötigen API-Aufrufe aus. Die Items werden anschließend lokal geparst und gegen MusicBrainz gematcht.

Bei YouTube-Titeln mit einem erkennbaren `Artist - Titel`-Format wird der Interpret aus dem Titel gelesen. Bei Titeln ohne dieses Format wird die stabile YouTube-Kanal-ID zur Erkennung doppelter Interpreten verwendet; der sichtbare Kanalname allein ist nicht eindeutig.

Die Import-Startpunkte und OAuth-Callbacks sind pro Client-Adresse begrenzt, um versehentliche Wiederholungen und einfache Missbrauchsversuche zu bremsen. In einer verteilten Produktion sollte dieser Limiter durch einen gemeinsamen Store wie Redis ersetzt werden.

## Challenge

`npm run db:seed` legt eine Demo-Challenge an. Weitere Challenges können direkt mit einem kleinen Script oder später über ein Admin-UI angelegt werden.

## Produktionshinweise

Der OAuth-State ist providergebunden, HMAC-signiert, zehn Minuten gültig und wird pro Prozess nur einmal akzeptiert. Die HttpOnly-Cookies bleiben als zusätzliche Browser-Unterstützung erhalten, sind aber nicht die alleinige Validierung. OAuth-Codes werden nur serverseitig gegen die jeweiligen Provider ausgetauscht.

Die MusicBrainz-Anreicherung läuft nach dem Redirect über Next.js `after()`, damit der Teilnehmer nicht auf die externen Rate-Limits warten muss. `after()` ist kein dauerhafter Job-Worker: Für eine verteilte Produktion sollte die Anreicherung in eine persistente Queue mit Retry- und Monitoring-Logik ausgelagert werden.
