import Database from 'better-sqlite3';
import { createTables } from './schema.js';

/**
 * Open (or create) the SQLite database and initialize all tables.
 * Uses WAL mode for better concurrency.
 */
export function getDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables(db);
  return db;
}
