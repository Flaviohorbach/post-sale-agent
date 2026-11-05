import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Agents } from "../src/agent/agents";
import { buildGraph } from "../src/agent/graph";
import { runCase } from "../src/agent/run";
import { storeFromClient, type Store } from "../src/agent/store";
import { createPostgresSaver } from "../src/lib/checkpointer";
import { createLedger, createPglite, createRepository } from "../src/lib/db";

// The production checkpointer over a real Postgres connection: PGlite speaking the wire protocol.
let pglite: PGlite;
let server: PGLiteSocketServer;
let store: Store;
const PORT = 54391;
const URL_DB = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;

beforeAll(async () => {
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, port: PORT, host: "127.0.0.1", maxConnections: 10 });
  await server.start();
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["node_modules/mcp-ecommerce-server/dist/stdio.js"] }));
  store = storeFromClient(client);
});

afterAll(async () => {
  await store.close();
  await server.stop();
  await pglite.close();
});

const agents: Agents = {
  triage: async () => ({ category: "delay", urgency: "high", summary: "atraso", suspiciousNote: false }),
  resolve: async () => ({ proposal: { action: "refund", reason: "atraso", customerMessage: "Olá.", stockChecks: [] }, toolCalls: [], modelCalls: 1 }),
  review: async () => ({ approved: true, feedback: "ok" }),
};

it("approves a paused case from a new instance that shares nothing but the database", async () => {
  const db = await createPglite();
  const repo = createRepository(db);
  const ledger = createLedger(db);
  const id = randomUUID();
  await repo.create(id, "v502102lvtx-01", "Meu pedido atrasou");

  const firstInstance = buildGraph({ agents, store, ledger, checkpointer: await createPostgresSaver(URL_DB) });
  const paused = await runCase(firstInstance, repo, id, { kind: "new", orderId: "v502102lvtx-01", message: "Meu pedido atrasou" });
  expect(paused.status).toBe("waiting");

  // No shared memory with the first one: this is what the next request on another instance sees.
  const secondInstance = buildGraph({ agents, store, ledger, checkpointer: await createPostgresSaver(URL_DB) });
  const done = await runCase(secondInstance, repo, id, { kind: "resume", decision: { approved: true } });
  expect(done.status).toBe("resolved");
  expect(done.outcome).toMatchObject({ action: "refund", amountBRL: 714.9, newlyExecuted: true });
}, 60_000);
