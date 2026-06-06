# ClaudeReads
A remote MCP server that acts as a personal reading companion inside the Claude apps.\
It doesn't generate recommendations itself — it acts as a grounding layer for Claude to reason over. It remembers what you've read (with your notes and ratings) and enriches each book with real metadata: **descriptions** from Google Books and **subject/theme tags** from Open Library. Claude then reasons over that real data to recommend new books.\
<br/>

## How it works
```
Claude app  ──▶  this server (Railway)  ──▶  your reading list (SQLite)
                                         ──▶  Google Books   (descriptions)
                                         ──▶  Open Library   (subject tags)
```
You connect it to Claude as a custom connector. Each person uses their own secret token, so reading lists never mix.\
<br/>

## What Claude can do with it
- **Add** a book you've read, with notes and a rating (1–10).
- **Recommend** new books grounded in what you've actually enjoyed.
- **Look up** or **search** real book metadata.
- **Update** or **remove** entries.
<br/>

## Running it
```bash
npm install
cp .env.example .env    # fill in the values
npm run build
npm start
```
It's built to deploy on Railway over HTTPS with a persistent volume for the database. See `.env.example` for the required settings, and `CLAUDE.md` / `design_spec.md` for the full technical detail.\
<br/>
