import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";

/**
 * Derives the per-user partition key from a pre-shared token. We store only this
 * hash in the DB so a database leak never exposes the raw tokens.
 */
export function deriveUserId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time membership check against the configured token set. */
function isKnownToken(token: string): boolean {
  const candidate = Buffer.from(token);
  let matched = false;
  for (const valid of config.validTokens) {
    const known = Buffer.from(valid);
    // timingSafeEqual requires equal lengths; the length check itself leaks only
    // length, not content, which is acceptable here.
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
      matched = true;
    }
  }
  return matched;
}

/**
 * Extracts the bearer token from a request, preferring the standard
 * `Authorization: Bearer <token>` header and falling back to `X-User-Token`.
 */
export function extractToken(req: IncomingMessage): string | null {
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match) return match[1].trim();
  }
  const custom = req.headers["x-user-token"];
  if (typeof custom === "string" && custom.trim() !== "") {
    return custom.trim();
  }
  return null;
}

export interface AuthResult {
  userId: string;
}

/**
 * Authenticates a request. Returns the derived user id on success, or null if
 * the token is missing or not in the valid set (caller should respond 401).
 */
export function authenticate(req: IncomingMessage): AuthResult | null {
  const token = extractToken(req);
  if (!token || !isKnownToken(token)) {
    return null;
  }
  return { userId: deriveUserId(token) };
}
