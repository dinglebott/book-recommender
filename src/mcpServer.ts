import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { enrichBook } from "./enrichment.js";
import { searchGoogleBooks } from "./googleBooks.js";
import { searchOpenLibrary } from "./openLibrary.js";
import {
  deleteBook,
  findDuplicates,
  insertBook,
  listBooks,
  updateBook,
} from "./db.js";

/** Serialise any payload into the text content block clients read. */
function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/** Clamp a rating to the supported 1–10 integer range; null passes through. */
function normalizeRating(rating: number | undefined): number | null {
  if (rating === undefined || rating === null) return null;
  const rounded = Math.round(rating);
  return Math.min(10, Math.max(1, rounded));
}

/**
 * Builds an McpServer whose tools are bound to a single authenticated user.
 * A fresh server is created per request in the stateless transport, so the
 * userId closure is the only thing that varies between callers.
 */
export function buildServer(userId: string): McpServer {
  const server = new McpServer({
    name: "reading-list",
    version: "1.0.0",
  });

  server.registerTool(
    "add_book",
    {
      title: "Add a book to the reading list",
      description:
        "Add a book the user has read to their persistent reading list. The server " +
        "immediately enriches it with a description (Google Books) and subject/theme " +
        "tags (Open Library) and stores everything. Returns the matched title/author so " +
        "you can confirm the right book was matched (e.g. 'Added Piranesi by Susanna " +
        "Clarke — correct?'). Pass author and/or isbn to improve match accuracy.",
      inputSchema: {
        title: z.string().min(1).describe("Book title (required)."),
        author: z.string().optional().describe("Author name; improves match accuracy."),
        isbn: z.string().optional().describe("ISBN; used as the primary lookup key if given."),
        notes: z
          .string()
          .optional()
          .describe("Free text on why the user liked it / what stood out."),
        rating: z.number().optional().describe("Optional rating from 1 to 10."),
      },
    },
    async ({ title, author, isbn, notes, rating }) => {
      const metadata = await enrichBook({ title, author, isbn });
      const duplicates = findDuplicates(userId, metadata.matched_title ?? title, metadata.matched_author ?? author ?? null);
      const record = insertBook({
        userId,
        title,
        author: author ?? null,
        notes: notes ?? null,
        rating: normalizeRating(rating),
        metadata,
      });
      return json({
        record,
        duplicate_warning:
          duplicates.length > 0
            ? `You already logged "${record.title}" (id ${duplicates.map((d) => d.id).join(", ")}). Added anyway.`
            : null,
        confirm:
          metadata.enrichment_status === "not_found"
            ? `Stored "${title}", but no metadata could be retrieved from Google Books or Open Library.`
            : `Added "${record.title}"${record.author ? ` by ${record.author}` : ""} — confirm this is the right book.`,
      });
    }
  );

  server.registerTool(
    "get_reading_profile",
    {
      title: "Get the user's enriched reading list",
      description:
        "Return the user's full reading list with enriched metadata (descriptions, " +
        "subjects, categories) plus their own notes and ratings. Call this FIRST when " +
        "asked for a recommendation: reason over these descriptions, subjects, and the " +
        "user's stated preferences to form candidate books, then verify each serious " +
        "candidate with lookup_book before presenting it.",
      inputSchema: {},
    },
    async () => {
      const books = listBooks(userId);
      return json({ count: books.length, books });
    }
  );

  server.registerTool(
    "lookup_book",
    {
      title: "Look up verified metadata for a single book (no storage)",
      description:
        "Fetch verified metadata (description, subjects, categories, ISBN, published " +
        "date) for ONE book without storing it. Use this to ground candidate " +
        "recommendations in real data before presenting them to the user — it prevents " +
        "recommending hallucinated titles or misremembered plots. Provide title (and " +
        "author) or an isbn.",
      inputSchema: {
        title: z.string().optional().describe("Book title (required unless isbn given)."),
        author: z.string().optional().describe("Author name; improves match accuracy."),
        isbn: z.string().optional().describe("ISBN; used as the primary lookup key if given."),
      },
    },
    async ({ title, author, isbn }) => {
      if (!title && !isbn) {
        return errorResult("Provide either a title or an isbn.");
      }
      const metadata = await enrichBook({ title, author, isbn });
      return json(metadata);
    }
  );

  server.registerTool(
    "search_books",
    {
      title: "Search the book catalog for candidate matches",
      description:
        "Search the external catalog and return a short list of candidate matches " +
        "(title, author, isbn, published date). Use this for disambiguation when a title " +
        "is ambiguous or the user isn't sure of the exact title, then confirm with them " +
        "before adding.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text search query."),
        max_results: z
          .number()
          .optional()
          .describe("How many results to return (default 5, max 10)."),
      },
    },
    async ({ query, max_results }) => {
      const cap = Math.min(10, Math.max(1, Math.round(max_results ?? 5)));
      // Prefer Google Books; fall back to Open Library if it fails or is empty.
      let results = await searchGoogleBooks(query, cap).catch(() => []);
      let source = "google_books";
      if (results.length === 0) {
        results = await searchOpenLibrary(query, cap).catch(() => []);
        source = "open_library";
      }
      return json({ count: results.length, source, results });
    }
  );

  server.registerTool(
    "update_book",
    {
      title: "Update notes or rating on a stored book",
      description:
        "Update the notes and/or rating on an existing reading-list record, identified " +
        "by its id (from get_reading_profile). Does not re-fetch metadata.",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("The record id to update."),
        notes: z.string().optional().describe("New free-text notes."),
        rating: z.number().optional().describe("New rating from 1 to 10."),
      },
    },
    async ({ id, notes, rating }) => {
      const numericId = Number(id);
      if (!Number.isInteger(numericId)) {
        return errorResult(`Invalid id: ${id}`);
      }
      if (notes === undefined && rating === undefined) {
        return errorResult("Provide notes and/or rating to update.");
      }
      const updated = updateBook({
        userId,
        id: numericId,
        notes,
        rating: rating === undefined ? undefined : normalizeRating(rating),
      });
      if (!updated) {
        return errorResult(`No book with id ${numericId} in your list.`);
      }
      return json({ record: updated });
    }
  );

  server.registerTool(
    "remove_book",
    {
      title: "Remove a single book from the reading list",
      description:
        "Remove ONE book from the user's reading list by its id (from " +
        "get_reading_profile). Deletes a single record only.",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("The record id to remove."),
      },
    },
    async ({ id }) => {
      const numericId = Number(id);
      if (!Number.isInteger(numericId)) {
        return errorResult(`Invalid id: ${id}`);
      }
      const removed = deleteBook(userId, numericId);
      if (!removed) {
        return errorResult(`No book with id ${numericId} in your list.`);
      }
      return json({ removed: true, id: numericId });
    }
  );

  return server;
}
