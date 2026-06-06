import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authenticate } from "./auth.js";
import { initDb } from "./db.js";
import { buildServer } from "./mcpServer.js";

const JSONRPC_UNAUTHORIZED = {
  jsonrpc: "2.0" as const,
  error: { code: -32001, message: "Unauthorized: missing or invalid token." },
  id: null,
};

const JSONRPC_METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0" as const,
  error: { code: -32000, message: "Method not allowed. This server is stateless; use POST." },
  id: null,
};

function startupChecks(): void {
  if (config.validTokens.length === 0) {
    console.warn(
      "[startup] WARNING: VALID_TOKENS is empty — every request will be rejected with 401."
    );
  }
  if (!config.googleBooksApiKey) {
    console.warn(
      "[startup] WARNING: GOOGLE_BOOKS_API_KEY is unset — Google Books lookups may be rate-limited or fail."
    );
  }
}

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const auth = authenticate(req);
  if (!auth) {
    res.status(401).set("WWW-Authenticate", "Bearer").json(JSONRPC_UNAUTHORIZED);
    return;
  }

  // Stateless: a fresh server + transport per request, bound to this user.
  const server = buildServer(auth.userId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request handling failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    }
  }
}

function main(): void {
  startupChecks();
  initDb();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", tokensConfigured: config.validTokens.length });
  });

  app.post("/mcp", handleMcpPost);

  // Stateless transport has no server-initiated streams or sessions to manage.
  app.get("/mcp", (_req, res) => res.status(405).json(JSONRPC_METHOD_NOT_ALLOWED));
  app.delete("/mcp", (_req, res) => res.status(405).json(JSONRPC_METHOD_NOT_ALLOWED));

  app.listen(config.port, () => {
    console.log(`[startup] Reading List MCP server listening on port ${config.port}`);
    console.log(`[startup] MCP endpoint: POST /mcp   Health: GET /health`);
  });
}

main();
