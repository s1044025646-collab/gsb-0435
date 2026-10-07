import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");
export const MAX_DEPTH = 8;
export const MAX_LEAVES = 10000;

export function openDb(dataDir: string = DEFAULT_DATA_DIR): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "bakery.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL CHECK (category IN ('flour','water','other')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mixtures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (name, version)
    );

    CREATE TABLE IF NOT EXISTS mixture_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mixture_id INTEGER NOT NULL REFERENCES mixtures(id),
      item_type TEXT NOT NULL CHECK (item_type IN ('ingredient','mixture')),
      ingredient_id INTEGER REFERENCES ingredients(id),
      child_mixture_id INTEGER REFERENCES mixtures(id),
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
      item_type TEXT NOT NULL CHECK (item_type IN ('ingredient','mixture')),
      ingredient_id INTEGER REFERENCES ingredients(id),
      mixture_id INTEGER REFERENCES mixtures(id),
      mass TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      request_id TEXT UNIQUE,
      target_total_mass TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
