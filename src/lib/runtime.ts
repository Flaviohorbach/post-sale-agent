import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createAgents } from "../agent/agents";
import { buildGraph } from "../agent/graph";
import { connectStore } from "../agent/store";
import { createMemorySaver, createPostgresSaver } from "./checkpointer";
import { createLedger, createPglite, createPostgres, createRepository, findDatabaseUrl, type Db, type Repository } from "./db";
import { createShopModel } from "./model";

interface Shared {
  db: Db;
  repo: Repository;
  checkpointer: BaseCheckpointSaver;
}

// On globalThis so a hot reload in development does not lose paused cases.
const holder = globalThis as unknown as { postSaleShared?: Promise<Shared> };

async function connect(): Promise<Shared> {
  const url = findDatabaseUrl(process.env);
  if (url) {
    const db = await createPostgres(url);
    return { db, repo: createRepository(db), checkpointer: await createPostgresSaver(url) };
  }
  if (process.env.VERCEL) throw new Error("DATABASE_URL não configurada. Conecte um banco Neon ao projeto na Vercel e faça o redeploy.");
  const db = await createPglite(".data");
  return { db, repo: createRepository(db), checkpointer: createMemorySaver() };
}

export function getShared(): Promise<Shared> {
  // A failed connection must not stay cached, or every later request would fail too.
  holder.postSaleShared ??= connect().catch((error) => {
    holder.postSaleShared = undefined;
    throw error;
  });
  return holder.postSaleShared;
}

/** One graph for one request, with its own MCP connection, which the caller must close. */
export async function openGraph() {
  const { db, checkpointer } = await getShared();
  const store = await connectStore();
  const graph = buildGraph({ agents: createAgents(createShopModel(), store), store, ledger: createLedger(db), checkpointer });
  return { graph, close: () => store.close() };
}
