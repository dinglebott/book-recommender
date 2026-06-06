import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { BookMetadata, BookRecord, EnrichmentStatus } from "./types.js";

/** Raw row shape as stored in SQLite (JSON-array columns are still strings here). */
interface BookRow {
  id: number;
  user_id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  description: string | null;
  subjects: string | null;
  categories: string | null;
  notes: string | null;
  rating: number | null;
  enrichment_status: string | null;
  date_added: string;
}

let db: Database.Database;

export function initDb(): void {
  mkdirSync(dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      title         TEXT NOT NULL,
      author        TEXT,
      isbn          TEXT,
      description   TEXT,
      subjects      TEXT,
      categories    TEXT,
      notes         TEXT,
      rating        INTEGER,
      enrichment_status TEXT,
      date_added    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
  `);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    isbn: row.isbn,
    description: row.description,
    subjects: parseJsonArray(row.subjects),
    categories: parseJsonArray(row.categories),
    notes: row.notes,
    rating: row.rating,
    enrichment_status: (row.enrichment_status as EnrichmentStatus) ?? "not_found",
    date_added: row.date_added,
  };
}

export interface AddBookInput {
  userId: string;
  title: string;
  author: string | null;
  notes: string | null;
  rating: number | null;
  metadata: BookMetadata;
}

export function insertBook(input: AddBookInput): BookRecord {
  const { metadata } = input;
  const dateAdded = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO books (user_id, title, author, isbn, description, subjects, categories, notes, rating, enrichment_status, date_added)
    VALUES (@user_id, @title, @author, @isbn, @description, @subjects, @categories, @notes, @rating, @enrichment_status, @date_added)
  `);
  const info = stmt.run({
    user_id: input.userId,
    // Prefer the canonical matched title/author, but never lose the user's input.
    title: metadata.matched_title ?? input.title,
    author: metadata.matched_author ?? input.author,
    isbn: metadata.isbn,
    description: metadata.description,
    subjects: JSON.stringify(metadata.subjects),
    categories: JSON.stringify(metadata.categories),
    notes: input.notes,
    rating: input.rating,
    enrichment_status: metadata.enrichment_status,
    date_added: dateAdded,
  });
  return getBook(input.userId, Number(info.lastInsertRowid))!;
}

export function getBook(userId: string, id: number): BookRecord | null {
  const row = db
    .prepare("SELECT * FROM books WHERE user_id = ? AND id = ?")
    .get(userId, id) as BookRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function listBooks(userId: string): BookRecord[] {
  const rows = db
    .prepare("SELECT * FROM books WHERE user_id = ? ORDER BY date_added ASC, id ASC")
    .all(userId) as BookRow[];
  return rows.map(rowToRecord);
}

/** Soft duplicate check: same title+author (case-insensitive) for this user. */
export function findDuplicates(
  userId: string,
  title: string,
  author: string | null
): BookRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM books
       WHERE user_id = ?
         AND LOWER(title) = LOWER(?)
         AND (
           (author IS NULL AND ? IS NULL)
           OR LOWER(IFNULL(author, '')) = LOWER(IFNULL(?, ''))
         )`
    )
    .all(userId, title, author, author) as BookRow[];
  return rows.map(rowToRecord);
}

export interface UpdateBookInput {
  userId: string;
  id: number;
  notes?: string | null;
  rating?: number | null;
  description?: string | null;
  subjects?: string[];
}

/** complete = description + subjects both present; partial = one; not_found = neither. */
function deriveStatus(description: string | null, subjects: string[]): EnrichmentStatus {
  const hasDesc = !!description && description.trim() !== "";
  const hasSubjects = subjects.length > 0;
  if (hasDesc && hasSubjects) return "complete";
  if (hasDesc || hasSubjects) return "partial";
  return "not_found";
}

/**
 * Updates notes, rating, description, and/or subjects. Returns the updated record,
 * or null if not found. When description or subjects is manually edited, the
 * enrichment_status is recomputed from the resulting fields so books filled in by
 * hand stop reading as "not_found".
 */
export function updateBook(input: UpdateBookInput): BookRecord | null {
  const existing = getBook(input.userId, input.id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: Record<string, unknown> = { user_id: input.userId, id: input.id };
  if (input.notes !== undefined) {
    sets.push("notes = @notes");
    params.notes = input.notes;
  }
  if (input.rating !== undefined) {
    sets.push("rating = @rating");
    params.rating = input.rating;
  }
  if (input.description !== undefined) {
    sets.push("description = @description");
    params.description = input.description;
  }
  if (input.subjects !== undefined) {
    sets.push("subjects = @subjects");
    params.subjects = JSON.stringify(input.subjects);
  }

  if (input.description !== undefined || input.subjects !== undefined) {
    const finalDescription =
      input.description !== undefined ? input.description : existing.description;
    const finalSubjects =
      input.subjects !== undefined ? input.subjects : existing.subjects;
    sets.push("enrichment_status = @enrichment_status");
    params.enrichment_status = deriveStatus(finalDescription, finalSubjects);
  }

  if (sets.length === 0) return existing;

  db.prepare(
    `UPDATE books SET ${sets.join(", ")} WHERE user_id = @user_id AND id = @id`
  ).run(params);
  return getBook(input.userId, input.id);
}

/** Removes a single record. Returns true if a row was deleted. */
export function deleteBook(userId: string, id: number): boolean {
  const info = db
    .prepare("DELETE FROM books WHERE user_id = ? AND id = ?")
    .run(userId, id);
  return info.changes > 0;
}
