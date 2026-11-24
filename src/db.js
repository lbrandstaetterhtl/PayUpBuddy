import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  flash      TEXT
);

CREATE TABLE IF NOT EXISTS bills (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  payer_id    INTEGER NOT NULL REFERENCES users(id),
  image       TEXT,
  due_date    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shares (
  id           INTEGER PRIMARY KEY,
  bill_id      INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  label        TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  paid_at      TEXT
);

CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id);
CREATE INDEX IF NOT EXISTS shares_bill ON shares(bill_id);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'payupbuddy.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
