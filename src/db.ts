import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";

export const DATA_DIR = process.env.BAKERY_DATA_DIR
  ? path.resolve(process.env.BAKERY_DATA_DIR)
  : path.join(__dirname, "..", "data");

export function openDb(dbFile?: string): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = dbFile ?? path.join(DATA_DIR, "bakery.db");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('flour','water','other')),
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mixtures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (name, version)
    );

    CREATE TABLE IF NOT EXISTS mixture_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mixture_id INTEGER NOT NULL REFERENCES mixtures(id),
      ref_type TEXT NOT NULL CHECK (ref_type IN ('ingredient','mixture')),
      ref_id INTEGER NOT NULL,
      mass TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recipe_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      ref_type TEXT NOT NULL CHECK (ref_type IN ('ingredient','mixture')),
      ref_id INTEGER NOT NULL,
      mass TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      kind TEXT NOT NULL CHECK (kind IN ('expand','scale')),
      scale_target TEXT,
      scale_factor TEXT,
      payload TEXT NOT NULL,
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
