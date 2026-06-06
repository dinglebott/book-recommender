import { config } from "./config.js";
import type { SearchHit } from "./types.js";

const BASE = "https://www.googleapis.com/books/v1/volumes";

interface VolumeInfo {
  title?: string;
  authors?: string[];
  description?: string;
  categories?: string[];
  publishedDate?: string;
  industryIdentifiers?: { type?: string; identifier?: string }[];
}

interface Volume {
  volumeInfo?: VolumeInfo;
}

export interface GoogleBooksResult {
  title: string | null;
  authors: string[];
  description: string | null;
  categories: string[];
  isbn: string | null;
  published_date: string | null;
}

function buildQuery(opts: { title?: string; author?: string; isbn?: string }): string {
  if (opts.isbn) return `isbn:${opts.isbn}`;
  const parts: string[] = [];
  if (opts.title) parts.push(`intitle:${opts.title}`);
  if (opts.author) parts.push(`inauthor:${opts.author}`);
  return parts.join("+");
}

/** Prefer ISBN-13, then ISBN-10, then any identifier. */
function pickIsbn(info: VolumeInfo): string | null {
  const ids = info.industryIdentifiers ?? [];
  return (
    ids.find((i) => i.type === "ISBN_13")?.identifier ??
    ids.find((i) => i.type === "ISBN_10")?.identifier ??
    ids[0]?.identifier ??
    null
  );
}

async function fetchVolumes(
  query: string,
  maxResults: number
): Promise<Volume[]> {
  if (!query) return [];
  const url = new URL(BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(maxResults));
  if (config.googleBooksApiKey) {
    url.searchParams.set("key", config.googleBooksApiKey);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(`Google Books HTTP ${res.status}`);
  }
  const data = (await res.json()) as { items?: Volume[] };
  return data.items ?? [];
}

function toResult(volume: Volume): GoogleBooksResult {
  const info = volume.volumeInfo ?? {};
  return {
    title: info.title ?? null,
    authors: info.authors ?? [],
    description: info.description ?? null,
    categories: info.categories ?? [],
    isbn: pickIsbn(info),
    published_date: info.publishedDate ?? null,
  };
}

/** Returns the top relevant volume for enrichment, or null if nothing matched. */
export async function lookupGoogleBooks(opts: {
  title?: string;
  author?: string;
  isbn?: string;
}): Promise<GoogleBooksResult | null> {
  const volumes = await fetchVolumes(buildQuery(opts), 5);
  if (volumes.length === 0) return null;
  return toResult(volumes[0]);
}

/** Returns a list of candidate hits for disambiguation. */
export async function searchGoogleBooks(
  query: string,
  maxResults: number
): Promise<SearchHit[]> {
  const volumes = await fetchVolumes(query, maxResults);
  return volumes.map((v) => {
    const r = toResult(v);
    return {
      title: r.title ?? "(unknown title)",
      author: r.authors[0] ?? null,
      isbn: r.isbn,
      published_date: r.published_date,
    };
  });
}
