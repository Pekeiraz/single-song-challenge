import crypto from 'node:crypto';
import { getDb } from '../lib/db.ts';

const db = getDb();

const slug = process.argv[2] ?? 'demo';
const name = process.argv[3] ?? 'Demo Challenge';
const id = crypto.randomUUID();

db.prepare(`
  INSERT INTO challenges (id, name, slug, status, starts_at, ends_at)
  VALUES (?, ?, ?, 'open', CURRENT_TIMESTAMP, datetime('now', '+30 days'))
  ON CONFLICT(slug) DO UPDATE SET name=excluded.name, status='open', starts_at=excluded.starts_at, ends_at=excluded.ends_at
`).run(id, name, slug);

console.log(db.prepare('SELECT id, name, slug, status, starts_at, ends_at FROM challenges WHERE slug=?').get(slug));
