import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type DB = Database.Database;

/**
 * Opens (and migrates) the Tidings database. Migrations are forward-only and numbered; before
 * applying any, a snapshot is written with VACUUM INTO so an upgrade can always be rolled back.
 * The server refuses to start on a database written by a newer version.
 */
export function openDatabase(dataDir: string, file = 'tidings.db'): DB {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, file);
  const fresh = !existsSync(path);
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not fatal on filesystems without modes */
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  const latest = MIGRATIONS.length;
  if (current > latest) {
    throw new Error(
      `Database schema version ${current} is newer than this Tidings build supports (${latest}). ` +
        'Refusing to start: you probably downgraded. Restore the matching snapshot from data/backups or upgrade.',
    );
  }
  if (current < latest) {
    if (!fresh && current > 0) {
      const backups = join(dataDir, 'backups');
      mkdirSync(backups, { recursive: true, mode: 0o700 });
      const snap = join(backups, `tidings-v${current}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    }
    const apply = db.transaction(() => {
      for (let v = current; v < latest; v++) db.exec(MIGRATIONS[v]);
      db.exec('DELETE FROM schema_version');
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(latest);
    });
    apply();
  }
  return db;
}
