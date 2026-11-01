import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import Sqlite from 'better-sqlite3';
import { applicationId, migrations, migrationForeignKeyRebuilds } from './schema.ts';
export type Database = Sqlite.Database;

export function transaction<T>(db: Database, action: () => T): T {
  if (Object.prototype.toString.call(action) === '[object AsyncFunction]') throw new Error('Database transaction callbacks must be synchronous');
  return db.transaction(() => {
    const value = action();
    if (value && typeof (value as any).then === 'function') {
      throw new Error('Database transaction callbacks must be synchronous');
    }
    return value;
  }).immediate();
}

export function openDatabase(path: string): Database {
  const existed = path !== ':memory:' && existsSync(path);
  const db = new Sqlite(path);
  try {
    if (!existed && path !== ':memory:') chmodSync(path, 0o600);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all();
    const marker = db.pragma('application_id', { simple: true });
    if ((tables.length || marker !== 0 || db.pragma('user_version', { simple: true }) !== 0) && marker !== applicationId) {
      throw new Error('Refusing to modify a foreign or legacy database');
    }
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (tables.length) {
      const applied = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
      if (applied.some(row => row.version > migrations.length)) throw new Error('Database schema is newer than this runtime');
      for (let index = 0; index < applied.length; index++) {
        const row = applied[index];
        const sql = migrations[row.version - 1];
        if (row.version !== index + 1 || !sql || row.checksum !== digest(sql)) throw new Error('Migration checksum mismatch');
      }
    }
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    const rebuild = migrationForeignKeyRebuilds.some(version => !tables.length || !db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version));
    if (rebuild) db.pragma('foreign_keys = OFF');
    try { transaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, checksum TEXT NOT NULL
      )`);
      for (const [index, sql] of migrations.entries()) {
        const version = index + 1;
        if (!db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version)) {
          db.exec(sql);
          db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)').run(version, digest(sql));
        }
      }
      if (rebuild && (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Migration foreign key validation failed');
      db.pragma(`application_id = ${applicationId}`);
    }); } finally { if (rebuild) db.pragma('foreign_keys = ON'); }
    if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Foreign key enforcement unavailable');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function digest(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}
