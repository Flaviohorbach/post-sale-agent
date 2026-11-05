import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";

/**
 * Where a paused case lives. On serverless hosting the approval may reach
 * another instance, so production keeps it in Postgres.
 */
export async function createPostgresSaver(url: string): Promise<BaseCheckpointSaver> {
  const [{ PostgresSaver }, { default: pg }] = await Promise.all([import("@langchain/langgraph-checkpoint-postgres"), import("pg")]);
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  // Neon closes idle connections. Without a listener, that error would crash the process.
  pool.on("error", (error) => console.warn("idle database connection closed:", error.message));
  const saver = new PostgresSaver(pool);
  await saver.setup();
  return saver;
}

export const createMemorySaver = (): BaseCheckpointSaver => new MemorySaver();
