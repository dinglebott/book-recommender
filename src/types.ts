export type EnrichmentStatus = "complete" | "partial" | "not_found";

/** Merged metadata produced by the enrichment layer (Google Books + Open Library). */
export interface BookMetadata {
  matched_title: string | null;
  matched_author: string | null;
  description: string | null;
  subjects: string[];
  categories: string[];
  isbn: string | null;
  published_date: string | null;
  enrichment_status: EnrichmentStatus;
}

/** A stored reading-list record as returned to the client. */
export interface BookRecord {
  id: number;
  title: string;
  author: string | null;
  isbn: string | null;
  description: string | null;
  subjects: string[];
  categories: string[];
  notes: string | null;
  rating: number | null;
  enrichment_status: EnrichmentStatus;
  date_added: string;
}

/** A lightweight catalog hit used by search_books. */
export interface SearchHit {
  title: string;
  author: string | null;
  isbn: string | null;
  published_date: string | null;
}
