/**
 * Centralised environment configuration. Reading env once here keeps the rest of
 * the codebase free of process.env access and makes missing-config failures loud.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export const config = {
  googleBooksApiKey: optional("GOOGLE_BOOKS_API_KEY", ""),
  databasePath: optional("DATABASE_PATH", "./data/reading_list.db"),
  openLibraryUserAgent: optional(
    "OPEN_LIBRARY_USER_AGENT",
    "ReadingListMCP/1.0 (contact: unset@example.com)"
  ),
  port: Number(optional("PORT", "8000")),
  /** Raw pre-shared tokens accepted by the server. */
  validTokens: optional("VALID_TOKENS", "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0),
};

export { required };
