import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const db = new DatabaseSync(join(process.cwd(), "data", "playlist-challenge.db"));
const rows = db.prepare("SELECT recording_id, release_id, image_url, fetched_at FROM cover_art_cache WHERE recording_id = ?").all("6fe0f731-6a6a-4985-a9bb-cd032ec3bc3a");
console.log(JSON.stringify(rows, null, 2));
