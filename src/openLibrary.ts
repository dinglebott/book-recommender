import { config } from "./config.js";
import type { SearchHit } from "./types.js";

const BASE = "https://openlibrary.org";

export interface OpenLibraryResult {
  title: string | null;
  author: string | null;
  description: string | null;
  subjects: string[];
  isbn: string | null;
  published_date: string | null;
}

function headers(): HeadersInit {
  return { "User-Agent": config.openLibraryUserAgent, Accept: "application/json" };
}

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

interface SearchDoc {
  key?: string; // work key, e.g. /works/OL123W
  title?: string;
  author_name?: string[];
  subject?: string[];
  first_publish_year?: number;
  isbn?: string[];
}

interface WorkDoc {
  title?: string;
  // subjects is normally string[]; description can be a string or { value }.
  subjects?: string[];
  description?: string | { value?: string };
}

interface EditionDoc {
  works?: { key?: string }[];
  title?: string;
  publish_date?: string;
  isbn_13?: string[];
  isbn_10?: string[];
}

function normalizeDescription(d: WorkDoc["description"]): string | null {
  if (!d) return null;
  if (typeof d === "string") return d;
  return d.value ?? null;
}

async function fetchWorkSubjects(
  workKey: string
): Promise<{ subjects: string[]; description: string | null; title: string | null }> {
  // workKey looks like "/works/OL123W"
  const work = await getJson<WorkDoc>(`${workKey}.json`);
  if (!work) return { subjects: [], description: null, title: null };
  return {
    subjects: work.subjects ?? [],
    description: normalizeDescription(work.description),
    title: work.title ?? null,
  };
}

/**
 * Looks up subject tags (and a fallback description) from Open Library.
 * Resolves the work via ISBN edition when possible, otherwise via search.
 */
export async function lookupOpenLibrary(opts: {
  title?: string;
  author?: string;
  isbn?: string;
}): Promise<OpenLibraryResult | null> {
  if (opts.isbn) {
    const edition = await getJson<EditionDoc>(`/isbn/${opts.isbn}.json`);
    const workKey = edition?.works?.[0]?.key;
    if (workKey) {
      const work = await fetchWorkSubjects(workKey);
      return {
        title: work.title ?? edition?.title ?? null,
        author: null,
        description: work.description,
        subjects: work.subjects,
        isbn: opts.isbn,
        published_date: edition?.publish_date ?? null,
      };
    }
    // ISBN edition existed but no work link; fall through to search if we have a title.
  }

  const params = new URLSearchParams();
  if (opts.title) params.set("title", opts.title);
  if (opts.author) params.set("author", opts.author);
  if (!opts.title && !opts.author) return null;
  params.set("limit", "1");
  params.set(
    "fields",
    "key,title,author_name,subject,first_publish_year,isbn"
  );

  const search = await getJson<{ docs?: SearchDoc[] }>(
    `/search.json?${params.toString()}`
  );
  const doc = search?.docs?.[0];
  if (!doc) return null;

  // Prefer subjects from the work record; fall back to the search doc's subject array.
  let subjects = doc.subject ?? [];
  let description: string | null = null;
  if (doc.key) {
    const work = await fetchWorkSubjects(doc.key);
    if (work.subjects.length > 0) subjects = work.subjects;
    description = work.description;
  }

  return {
    title: doc.title ?? null,
    author: doc.author_name?.[0] ?? null,
    description,
    subjects,
    isbn: opts.isbn ?? doc.isbn?.[0] ?? null,
    published_date: doc.first_publish_year ? String(doc.first_publish_year) : null,
  };
}

/** Free-text catalog search; used as a fallback for search_books. */
export async function searchOpenLibrary(
  query: string,
  maxResults: number
): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(maxResults),
    fields: "title,author_name,first_publish_year,isbn",
  });
  const search = await getJson<{ docs?: SearchDoc[] }>(
    `/search.json?${params.toString()}`
  );
  return (search?.docs ?? []).map((doc) => ({
    title: doc.title ?? "(unknown title)",
    author: doc.author_name?.[0] ?? null,
    isbn: doc.isbn?.[0] ?? null,
    published_date: doc.first_publish_year ? String(doc.first_publish_year) : null,
  }));
}
