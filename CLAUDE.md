# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A **remote MCP server** ("ClaudeReads") that acts as a personal reading companion inside the Claude apps. It is a **data and grounding layer only** — it does **not** generate recommendations and contains **no LLM API key or LLM call** anywhere. Claude (the connected client) is the reasoning engine; this server persists the user's reading list and enriches books with verified metadata from public APIs so Claude grounds its recommendations in real data instead of recall.

The authoritative design is `design_spec.md`. This file is the working summary; when they disagree, the spec wins unless the code already diverged intentionally (see "Deviations").

## Running things

```bash
npm install
cp .env.example .env       # fill in values
npm run build              # tsc -> dist/
npm start                  # POST /mcp + GET /health on $PORT (default 8000)
npm run dev                # tsc --watch
npm run typecheck          # tsc --noEmit
```

There are no automated tests or linters. Verification is done by smoke-testing the running server with `curl` against `POST /mcp` (JSON-RPC). Each MCP request needs three things: an `Authorization: Bearer <token>` header (token must be in `VALID_TOKENS`), `Content-Type: application/json`, and `Accept: application/json, text/event-stream`.

## Architecture

```
Claude app  ──MCP / Streamable HTTP──▶  this server (Railway)
  (reasoning)                              ├─▶ SQLite (persistent volume)  [reading list]
                                           ├─▶ Google Books API            [descriptions]
                                           └─▶ Open Library API            [subject tags]
```

**Transport:** stateless Streamable HTTP via the official `@modelcontextprotocol/sdk` (v1.29). `sessionIdGenerator: undefined`, `enableJsonResponse: true`. A **fresh `McpServer` + transport is created per request** ([src/index.ts](src/index.ts) `handleMcpPost`), each bound to the authenticated `user_id` via closure ([src/mcpServer.ts](src/mcpServer.ts) `buildServer`). There is no session state, which is deliberate — it survives Railway restarts and matches the per-request token model. The SDK's stateless transport does not require a per-request `initialize` handshake before `tools/list` / `tools/call`.

**ESM + NodeNext:** the project is `"type": "module"`; intra-repo imports must use `.js` extensions (e.g. `import { config } from "./config.js"`).

### Module map (`src/`)
- `index.ts` — Express app, stateless transport wiring, `/health`, 401 / 405 handling.
- `config.ts` — single point of `process.env` access; everything else imports `config`.
- `auth.ts` — extracts bearer token (`Authorization`, fallback `X-User-Token`), constant-time check against `VALID_TOKENS`, derives `user_id = sha256(token)`.
- `db.ts` — `better-sqlite3`, schema init (WAL), and **all queries filter by `user_id`**. JSON-array columns (`subjects`, `categories`) are stored as JSON strings and parsed on read.
- `googleBooks.ts` — Google Books client: descriptions, categories, ISBN, published date. `lookupGoogleBooks` (top hit) + `searchGoogleBooks` (list).
- `openLibrary.ts` — Open Library client: subjects (the primary field) + description fallback, plus `searchOpenLibrary`. Always sends the `User-Agent` header.
- `enrichment.ts` — `enrichBook()` runs both lookups concurrently with `Promise.allSettled` and merges into one `BookMetadata`. **Description ← Google (Open Library fallback); subjects ← Open Library; categories ← Google.** Subjects deduped + capped at 25.
- `mcpServer.ts` — registers the 6 tools; tool descriptions are written to nudge the recommendation flow (call `get_reading_profile` first, `lookup_book` to ground candidates).
- `types.ts` — shared `BookMetadata`, `BookRecord`, `SearchHit`, `EnrichmentStatus`.

### Data flow
1. `add_book` → `enrichBook()` → merged metadata + user notes/rating persisted via `insertBook` (stores canonical matched title/author, falling back to user input).
2. `get_reading_profile` → `listBooks(userId)` → the enriched list Claude reasons over.
3. `lookup_book` → `enrichBook()` only, **no storage** — used to verify a candidate before presenting it.
4. `search_books` → Google Books, **falling back to Open Library** when Google fails or is empty; response carries a `source` field.

## The 6 MCP tools
`add_book`, `get_reading_profile`, `lookup_book`, `search_books`, `update_book`, `remove_book`. All are user-scoped — a token can only ever read/write its own rows. There is intentionally **no bulk-delete / wipe tool**; deletion is one record at a time.

## Auth & multi-user
Pre-shared tokens, no OAuth. `VALID_TOKENS` is a comma-separated allowlist; add to grant, remove to revoke. `user_id` is the SHA-256 of the token — **only the hash is ever stored or logged, never the raw token.**

The token reaches the server three ways ([src/auth.ts](src/auth.ts) `extractToken`, in priority order): `Authorization: Bearer <token>` header, `X-User-Token` header, or **`?token=<token>` query param**. The query param matters because **Claude's custom-connector UI only supports OAuth or no-auth — it cannot set custom headers**, so in practice each user embeds their token in the connector URL: `https://<app>.up.railway.app/mcp?token=<their-token>`. This diverges from `design_spec.md` §7, which assumed header support. Never log the full request URL (it carries the token); current code logs neither URLs nor tokens.

## Deployment (Railway)
- `railway.json` pins NIXPACKS, `npm run build` → `npm start`, healthcheck `/health`.
- Mount a **persistent volume at `/data`** and set `DATABASE_PATH=/data/reading_list.db` so the list survives redeploys.
- Bind to `process.env.PORT` (Railway injects it). Railway provides the public HTTPS URL; the MCP endpoint is `<url>/mcp`.
- Env vars: `GOOGLE_BOOKS_API_KEY`, `VALID_TOKENS`, `DATABASE_PATH`, `OPEN_LIBRARY_USER_AGENT`, `PORT`. See `.env.example`.
- Watch point: the Nixpacks build must compile `better-sqlite3`'s native binding.

## Conventions & invariants (don't break these)
- **No LLM key/call** ever enters this server.
- **Graceful degradation:** one external source failing or returning nothing must never fail the whole operation — store what's available and set `enrichment_status` (`complete` / `partial` / `not_found`). Never let one source's failure block the other.
- **Ratings clamp to 1–10** (`normalizeRating`). Note: `design_spec.md` §11 says "1–5" but §4.1/§6 say 1–10; 1–10 was confirmed as correct, so §11 is the stale one.
- **`search_books.max_results`** caps at 10 (default 5).
- Tool handlers return JSON in a text content block; recoverable problems return `{ isError: true }` results, not thrown exceptions, where practical.
- Only the SHA-256 hash of a token is persisted/logged.
- Same book may be added twice (rereads); `add_book` surfaces a soft `duplicate_warning` but does not block.

## Deviations from spec / future work
- **`search_books` Open Library fallback** is an addition beyond the spec (which named only Google for search) — justified by §4.4's "catalogs" wording and the graceful-degradation requirement. Without a `GOOGLE_BOOKS_API_KEY`, Google returns 429 and search relies on this fallback.
- **Collaborative filtering is NOT in v1** (spec §10). The recommendation flow leaves a clean injection point (Claude weighing external signal alongside its own reasoning) so a `get_similar_by_behavior` tool can be added later without reworking existing tools.

## Code style
Comment only genuinely non-obvious logic (e.g. why stateless, constant-time comparison, JSON-column parsing). Don't comment what the code already says. Never remove existing comments when editing.
