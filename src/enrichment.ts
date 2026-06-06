import { lookupGoogleBooks } from "./googleBooks.js";
import { lookupOpenLibrary } from "./openLibrary.js";
import type { BookMetadata, EnrichmentStatus } from "./types.js";

/** Open Library works can carry hundreds of subjects; keep the list useful, not noisy. */
const MAX_SUBJECTS = 25;

export interface EnrichInput {
  title?: string;
  author?: string;
  isbn?: string;
}

/**
 * Combines Google Books (descriptions/categories) and Open Library (subjects).
 * The two lookups run concurrently; a failure or empty result from one source
 * never blocks the other — the gap is reflected in enrichment_status instead.
 */
export async function enrichBook(input: EnrichInput): Promise<BookMetadata> {
  const [googleSettled, openLibSettled] = await Promise.allSettled([
    lookupGoogleBooks(input),
    lookupOpenLibrary(input),
  ]);

  const google = googleSettled.status === "fulfilled" ? googleSettled.value : null;
  const openLib = openLibSettled.status === "fulfilled" ? openLibSettled.value : null;

  const googleHit = google !== null;
  const openLibHit = openLib !== null;

  const description = google?.description ?? openLib?.description ?? null;
  const subjects = dedupe(openLib?.subjects ?? []).slice(0, MAX_SUBJECTS);
  const categories = dedupe(google?.categories ?? []);

  const matched_title = google?.title ?? openLib?.title ?? null;
  const matched_author = google?.authors[0] ?? openLib?.author ?? null;

  // Prefer the ISBN that matches the input; otherwise take whichever source has one.
  const isbn =
    input.isbn ?? google?.isbn ?? openLib?.isbn ?? null;
  const published_date = google?.published_date ?? openLib?.published_date ?? null;

  let enrichment_status: EnrichmentStatus;
  if (!googleHit && !openLibHit) {
    enrichment_status = "not_found";
  } else if (googleHit && openLibHit) {
    enrichment_status = "complete";
  } else {
    enrichment_status = "partial";
  }

  return {
    matched_title,
    matched_author,
    description,
    subjects,
    categories,
    isbn,
    published_date,
    enrichment_status,
  };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(v.trim());
    }
  }
  return out;
}
