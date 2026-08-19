/** Persistent per-craft tune-iteration history.
 *
 * Ported from backend/app/tuning/store.py, adapted from "one JSON file per
 * craft" (fine for a single-user kiosk Pi) to a local SQLite database via
 * expo-sqlite, since a mobile app doesn't have the Python version's
 * filesystem-as-database convenience but does get a real embedded SQL
 * engine for free. The product's whole philosophy is iterative tuning
 * across multiple flights, so this history must survive app restarts.
 */
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { AnalysisSummary } from './analysisSummary';

export interface AppliedChange {
  parameter: string;
  from: number | null;
  to: number | null;
}

export interface Iteration {
  number: number; // 1-based, sequential per craft
  timestamp: number; // seconds since epoch
  label: string; // "Baseline" | "Applied" | "Current" -- display only
  appliedChanges: AppliedChange[];
  analysisSummary: AnalysisSummary;
}

let dbPromise: Promise<SQLiteDatabase> | null = null;

function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabaseAsync('tuning_history.db').then(async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS iterations (
          craft_id TEXT NOT NULL,
          number INTEGER NOT NULL,
          timestamp REAL NOT NULL,
          label TEXT NOT NULL,
          applied_changes TEXT NOT NULL,
          analysis_summary TEXT NOT NULL,
          PRIMARY KEY (craft_id, number)
        );
      `);
      return db;
    });
  }
  return dbPromise;
}

/** Sanitize a craft name into a storage-safe id. Unnamed/unknown craft
 * still needs a stable id to accumulate history against, rather than
 * silently dropping iteration tracking -- "unnamed" is a deliberate,
 * stable fallback bucket, not a random/per-session id, so history still
 * accumulates across sessions for a craft that never got a name set. */
export function craftIdFromName(craftName: string | null | undefined): string {
  if (!craftName || !craftName.trim()) return 'unnamed';
  const slug = craftName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_');
  return slug || 'unnamed';
}

interface IterationRow {
  number: number;
  timestamp: number;
  label: string;
  applied_changes: string;
  analysis_summary: string;
}

function rowToIteration(row: IterationRow): Iteration {
  return {
    number: row.number,
    timestamp: row.timestamp,
    label: row.label,
    appliedChanges: JSON.parse(row.applied_changes),
    analysisSummary: JSON.parse(row.analysis_summary),
  };
}

export async function loadIterations(craftId: string): Promise<Iteration[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<IterationRow>(
    'SELECT number, timestamp, label, applied_changes, analysis_summary FROM iterations WHERE craft_id = ? ORDER BY number ASC',
    [craftId]
  );
  return rows.map(rowToIteration);
}

/** Append a new iteration for this craft and persist it. Returns the saved
 * Iteration (with its assigned sequential number). */
export async function saveIteration(
  craftId: string,
  label: string,
  appliedChanges: AppliedChange[],
  analysisSummary: AnalysisSummary
): Promise<Iteration> {
  const existing = await loadIterations(craftId);
  const number = existing.length > 0 ? existing[existing.length - 1].number + 1 : 1;
  const timestamp = Date.now() / 1000;

  const db = await getDb();
  await db.runAsync(
    'INSERT INTO iterations (craft_id, number, timestamp, label, applied_changes, analysis_summary) VALUES (?, ?, ?, ?, ?, ?)',
    [craftId, number, timestamp, label, JSON.stringify(appliedChanges), JSON.stringify(analysisSummary)]
  );

  return { number, timestamp, label, appliedChanges, analysisSummary };
}

export async function getLatestIteration(craftId: string): Promise<Iteration | null> {
  const iterations = await loadIterations(craftId);
  return iterations.length > 0 ? iterations[iterations.length - 1] : null;
}
