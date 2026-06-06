# Reading List & Recommendation MCP Server — Build Spec

## 1. Overview

Build a **remote MCP server** that acts as a personal reading companion for use inside the Claude apps (web, desktop, mobile) on a Claude Pro plan. The server does **not** generate recommendations itself. It is a **data and grounding layer**: it persists the user's reading list and enriches book records with verified metadata from external APIs. Claude (the connected client) is the reasoning engine that produces recommendations by calling these tools during conversation.

This split is deliberate and is a hard architectural constraint — see §3.

### What it does
- Persists a per-user reading list (books read, plus optional notes on why the user liked each one, and an optional rating).
- Enriches each book with a **summary/description** (from Google Books) and **subject/theme tags** (from Open Library).
- Exposes a metadata-lookup tool so Claude can verify candidate recommendations against real data instead of relying on recall (anti-hallucination grounding).
- Supports multiple users via a pre-shared secret token so reading lists never conflate.

### What it does NOT do
- It does **not** call any LLM API. There is no Anthropic/OpenAI/etc. API key anywhere in this server. All reasoning happens in the Claude client on the user's Pro subscription.
- It does **not** implement collaborative filtering in v1. See §10 for the planned future addition.

---

## 2. Tech Stack

- **Language:** TypeScript (Node.js 20+)
- **MCP SDK:** `@modelcontextprotocol/sdk` (official)
- **Transport:** Streamable HTTP (the current MCP standard; do **not** use the deprecated SSE-only transport). Server must be reachable over HTTPS — Railway provides this automatically.
- **Database:** SQLite via `better-sqlite3` (synchronous, simple, ideal for this scale). The DB file lives on a Railway persistent volume.
- **HTTP client:** native `fetch` (Node 20+) for the external APIs.
- **Hosting:** Railway (already set up). Auto-detects Node; no Dockerfile required.

If any part of the official MCP SDK's HTTP server setup differs from what's described here, follow the SDK's current documented pattern for a Streamable HTTP server — the tool definitions and behavior below are what matter.

---

## 3. Architecture & Core Constraint

```
Claude app (Pro)  ──MCP/Streamable HTTP──▶  This server (Railway)
   (reasoning)                                  │
                                                ├─▶ SQLite (persistent volume)  [reading list]
                                                ├─▶ Google Books API            [descriptions]
                                                └─▶ Open Library API            [subject tags]
```

**Constraint:** The server is purely a tool provider. When the user asks Claude for a recommendation, Claude is expected to:
1. Call `get_reading_profile` to retrieve the enriched reading list + the user's notes.
2. Reason over that data using its own semantic knowledge to propose candidate books.
3. Call `lookup_book` on each candidate it's seriously considering, to ground the candidate's description/subjects in real data before presenting it.
4. Present recommendations in conversation, with reasoning.

Do not add a server-side recommendation endpoint that returns "the answer." The server's job ends at supplying clean, verified data.

---

## 4. MCP Tools

All tools are scoped to the authenticated user (see §7). A user can only ever read or write their own rows.

### 4.1 `add_book`
Adds a book to the user's reading list. On add, the server immediately enriches the record (Google Books + Open Library) and stores the merged metadata so later reads are fast and self-contained.

**Input:**
- `title` (string, required)
- `author` (string, optional — improves match accuracy)
- `isbn` (string, optional — if provided, used as the primary lookup key)
- `notes` (string, optional — free text on why the user liked it / what stood out)
- `rating` (number, optional — 1–10)

**Behavior:**
- Run the enrichment lookup (§5). Store the merged metadata alongside the user's notes/rating.
- Return the stored record **including the matched title/author** so Claude can confirm with the user that the right edition/book was matched (e.g. "Added *Piranesi* by Susanna Clarke — correct?").
- If no confident match is found in either API, still store the user-provided title/author/notes, and flag `enrichment_status: "not_found"` so Claude can tell the user metadata couldn't be retrieved.

### 4.2 `get_reading_profile`
Returns the full enriched reading list, formatted as context optimized for Claude to reason over. This is the primary tool Claude calls before making recommendations.

**Input:** none (user is derived from auth).

**Output:** an array of records, each with: `id`, `title`, `author`, `description`, `subjects` (array), `categories` (array), `notes`, `rating`, `date_added`, `enrichment_status`.

### 4.3 `lookup_book`
Fetches verified metadata for a single book **without** storing it. Used by Claude to ground candidate recommendations before presenting them.

**Input:**
- `title` (string, required unless `isbn` given)
- `author` (string, optional)
- `isbn` (string, optional)

**Output:** merged metadata object: `matched_title`, `matched_author`, `description`, `subjects`, `categories`, `isbn`, `published_date`, `enrichment_status`.

### 4.4 `search_books`
Searches the external catalogs and returns a short list of candidate matches. Useful for disambiguation when a title is ambiguous or the user isn't sure of the exact title.

**Input:**
- `query` (string, required)
- `max_results` (number, optional, default 5, cap 10)

**Output:** array of `{ title, author, isbn, published_date }`.

### 4.5 `update_book`
Updates the notes and/or rating on an existing record.

**Input:** `id` (string/int, required), `notes` (optional), `rating` (optional).

### 4.6 `remove_book`
Removes a book from the user's list.

**Input:** `id` (string/int, required).

> Note: per the action-safety posture, removing a single book is fine to perform on request, but the server should never expose a "delete all" / "wipe list" tool. Deletion is one record at a time.

---

## 5. External API Integration

The enrichment lookup combines two sources. **Each is used for a specific field — do not substitute one for the other.**

### 5.1 Google Books — used for DESCRIPTIONS / SUMMARIES
Publisher-sourced descriptions, generally well-populated and substantive. This is the primary content Claude reasons about.

- **By ISBN:** `GET https://www.googleapis.com/books/v1/volumes?q=isbn:{isbn}&key={GOOGLE_BOOKS_API_KEY}`
- **By title + author:** `GET https://www.googleapis.com/books/v1/volumes?q=intitle:{title}+inauthor:{author}&key={GOOGLE_BOOKS_API_KEY}`
- Take the top relevant volume. Extract from `volumeInfo`:
  - `description` → **the summary** (primary field we want)
  - `title`, `authors` → canonical title/author for confirmation
  - `categories` → coarse genre buckets (store, but treat as secondary to Open Library subjects)
  - `industryIdentifiers` → ISBN(s)
  - `publishedDate`
- Requires a free API key from Google Cloud Console (one-time setup). Stays within fair-use limits at personal scale.

### 5.2 Open Library — used for SUBJECT / THEME TAGS
Community-sourced subject tags that are more granular and thematically useful than Google's categories (e.g. "unreliable narrator", "psychological fiction", "coming of age" rather than just "Fiction / Literary").

- **By ISBN:** `GET https://openlibrary.org/isbn/{isbn}.json` → gives a work reference.
- **By search:** `GET https://openlibrary.org/search.json?title={title}&author={author}` → take top doc.
- **Subjects** live on the *work*: `GET https://openlibrary.org/works/{work_id}.json` and read the `subjects` array. The `search.json` doc may also carry a `subject` array — use it as a fallback.
- Extract `subjects` → **the theme tags** (primary field we want from this source).
- **Required:** send a descriptive `User-Agent` header on every Open Library request (e.g. `ReadingListMCP/1.0 (contact: <your-email>)`). Open Library asks for this and may throttle requests without it.

### 5.3 Merge logic
Produce one metadata object per book:
- `description` ← Google Books (fall back to Open Library description only if Google has none)
- `subjects` ← Open Library `subjects`
- `categories` ← Google Books `categories`
- `matched_title` / `matched_author` ← prefer Google Books canonical values; fall back to Open Library
- `isbn`, `published_date` ← whichever source has it (prefer the one matching the input ISBN)
- `enrichment_status` ← `"complete"`, `"partial"` (one source missing), or `"not_found"` (neither matched)

Both lookups run concurrently. A failure or empty result from one source must not block the other — degrade gracefully and reflect it in `enrichment_status`.

---

## 6. Data Model (SQLite)

```sql
CREATE TABLE IF NOT EXISTS books (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,          -- derived from the pre-shared token (see §7)
  title         TEXT NOT NULL,
  author        TEXT,
  isbn          TEXT,
  description   TEXT,                    -- from Google Books
  subjects      TEXT,                    -- JSON array, from Open Library
  categories    TEXT,                    -- JSON array, from Google Books
  notes         TEXT,                    -- user's free-text notes
  rating        INTEGER,                 -- 1-10, nullable
  enrichment_status TEXT,                -- complete | partial | not_found
  date_added    TEXT NOT NULL            -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);
```

The DB file must live on the mounted volume (see §8), e.g. `/data/reading_list.db`, so it survives redeploys.

---

## 7. Authentication & User Partitioning

Use the **pre-shared secret token** approach (no OAuth in v1).

- Each user configures a secret token as a custom header when adding the connector in Claude's settings. Expect it on the `Authorization` header as `Bearer <token>` (fall back to a custom `X-User-Token` header if present).
- Maintain a set of **valid tokens** via the `VALID_TOKENS` env var (comma-separated). Requests whose token is not in this set get a `401`.
- Derive `user_id` as a SHA-256 hash of the token. **Store only the hash**, never the raw token, in the DB. All queries filter by `user_id`, so each token sees only its own list.
- To grant someone access later: add a new token to `VALID_TOKENS`. To revoke: remove it.

This gives both access control (only known tokens work) and clean per-user partitioning (each token = an isolated reading list), which resolves the conflation problem.

---

## 8. Deployment (Railway)

- **Persistent volume:** mount a volume (e.g. at `/data`). Set `DATABASE_PATH=/data/reading_list.db`. Volume storage at this scale (a few hundred KB) is effectively free and absorbed by existing plan credits.
- **HTTPS:** Railway provides a public HTTPS URL out of the box — this is the URL the user pastes into Claude → Settings → Connectors → Add custom connector.
- **Port:** bind to `process.env.PORT` (Railway injects it).

### Environment variables
| Var | Purpose |
|-----|---------|
| `GOOGLE_BOOKS_API_KEY` | Google Books API key (free, from Google Cloud Console) |
| `VALID_TOKENS` | Comma-separated list of accepted pre-shared tokens |
| `DATABASE_PATH` | Path to SQLite file on the volume, e.g. `/data/reading_list.db` |
| `OPEN_LIBRARY_USER_AGENT` | Descriptive UA string for Open Library requests |
| `PORT` | Provided by Railway |

---

## 9. Recommendation Flow (how Claude is expected to use this)

This is documentation of intended client behavior, not server code — but build the tools so this flow works smoothly:

1. User: "Recommend me something based on what I've read."
2. Claude calls `get_reading_profile` → receives enriched list + notes.
3. Claude reasons over descriptions, subjects, and the user's stated preferences to form candidates.
4. For each serious candidate, Claude calls `lookup_book` → grounds the candidate's real summary and subjects (prevents hallucinated titles/plots).
5. Claude presents recommendations with reasoning tied to what the user actually liked.

Tool descriptions (the MCP `description` field on each tool) should be written to nudge this behavior — e.g. `lookup_book`'s description should mention it's for verifying candidate recommendations before presenting them.

---

## 10. Future Enhancement — Collaborative Filtering (NOT in v1)

A known gap: this system uses content/semantic signal (descriptions + subjects + Claude's reasoning) but not **behavioral collaborative-filtering signal** ("readers who liked X also liked Y"). There is no confirmed free public API for this.

Planned approach for a future iteration:
- Add a `get_similar_by_behavior` tool that calls **API League's "Find Similar Books" API** (collaborative + content-based; commercial/freemium). Its results would be returned to Claude as *additional context* to weigh alongside its own reasoning — not as a replacement for it.
- Self-hosting an open SASRec-style model trained on the Book-Crossing / Goodreads-style data is an alternative, but it's a substantially larger build (hosting + serving a trained model) and should only be pursued if the API League option proves insufficient.
- **Decision deferred on purpose:** build and use v1 first. Only add this if recommendations feel too surface-level / too obvious in practice.

Design v1 so this slots in cleanly: the recommendation flow already has a step (§9.4) where external signal could be injected, so adding a behavioral-similarity tool later requires no rework of the existing tools.

---

## 11. Implementation Notes & Edge Cases

- **Concurrency:** run the two enrichment lookups in parallel; never let one source's failure block the other.
- **Ambiguous matches:** `add_book` takes the top match but must return what it matched so the user can confirm. `search_books` exists for explicit disambiguation.
- **Missing metadata:** never fail the whole operation because a description or subject list is missing — store what's available and set `enrichment_status` accordingly.
- **Open Library UA:** always send the `User-Agent` header (§5.2) or requests may be throttled.
- **No destructive bulk ops:** deletion is one record at a time; do not expose any wipe-all tool.
- **Secrets:** never log raw tokens or write them to the DB — store only the SHA-256 hash.
- **Input validation:** clamp `rating` to 1–10; cap `search_books.max_results` at 10.
- **Idempotency-ish:** it's fine to allow the same book twice (e.g. a reread); don't hard-block duplicates, but Claude may want to surface "you already logged this" — optionally include a soft duplicate check that flags matching title+author for the same user without blocking.

---

## 12. Acceptance Criteria

- [ ] Server runs on Railway over HTTPS, connectable as a custom MCP connector from the Claude apps.
- [ ] Requests without a valid token are rejected with 401; valid tokens see only their own list.
- [ ] `add_book` enriches via Google Books (description) + Open Library (subjects) and persists to the SQLite file on the volume.
- [ ] Reading list survives a redeploy (volume persistence verified).
- [ ] `get_reading_profile`, `lookup_book`, `search_books`, `update_book`, `remove_book` all function and are user-scoped.
- [ ] No LLM API key or LLM call exists anywhere in the server.
- [ ] Graceful degradation when one or both external APIs return nothing.
