import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

let db: DB | null = null;

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  migrate(d);
  db = d;
  return d;
}

export function getDb(): DB {
  if (!db) throw new Error('db not initialized');
  return db;
}

/** In-memory DB for tests. */
export function openTestDb(): DB {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  migrate(d);
  db = d;
  return d;
}

function migrate(d: DB) {
  d.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    d.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name as string),
  );
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const tx = d.transaction(() => {
      d.exec(sql);
      d.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
    });
    tx();
  }
}
