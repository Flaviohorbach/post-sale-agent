import type { ActionLedger, ApprovalRequest, CaseEvent, Outcome } from "../agent/graph";

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id text PRIMARY KEY,
  order_id text NOT NULL,
  message text NOT NULL,
  status text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]',
  pending jsonb,
  outcome jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS executed_actions (
  case_id text NOT NULL,
  action text NOT NULL,
  amount_brl numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, action)
);
`;

export type CaseStatus = "running" | "waiting" | "resolved" | "failed";

export interface CaseRecord {
  id: string;
  orderId: string;
  message: string;
  status: CaseStatus;
  events: CaseEvent[];
  pending: ApprovalRequest | null;
  outcome: Outcome | null;
  error: string | null;
}

interface CaseRow {
  id: string;
  order_id: string;
  message: string;
  status: CaseStatus;
  events: CaseEvent[];
  pending: ApprovalRequest | null;
  outcome: Outcome | null;
  error: string | null;
}

const toRecord = (row: CaseRow): CaseRecord => ({ id: row.id, orderId: row.order_id, message: row.message, status: row.status, events: row.events, pending: row.pending, outcome: row.outcome, error: row.error });

/** A run killed mid-way (function timeout, crash) stays "running": after this long it may be retried. */
const STALE_RUN_MINUTES = 6;

export function createRepository(db: Db) {
  return {
    async create(id: string, orderId: string, message: string) {
      await db.query("INSERT INTO cases (id, order_id, message, status) VALUES ($1, $2, $3, 'running')", [id, orderId, message]);
    },
    async get(id: string): Promise<CaseRecord | null> {
      const [row] = await db.query<CaseRow>("SELECT * FROM cases WHERE id = $1", [id]);
      return row ? toRecord(row) : null;
    },
    async save(id: string, fields: { status: CaseStatus; events: CaseEvent[]; pending?: ApprovalRequest | null; outcome?: Outcome | null; error?: string | null }) {
      await db.query(
        "UPDATE cases SET status = $2, events = $3::jsonb, pending = $4::jsonb, outcome = $5::jsonb, error = $6, updated_at = now() WHERE id = $1",
        [id, fields.status, JSON.stringify(fields.events), JSON.stringify(fields.pending ?? null), JSON.stringify(fields.outcome ?? null), fields.error ?? null],
      );
    },
    /** Moves a case to running only from the expected state, so two clicks cannot both resume it. */
    async claim(id: string, from: CaseStatus[]): Promise<boolean> {
      const rows = await db.query<{ id: string }>(
        `UPDATE cases SET status = 'running', error = NULL, updated_at = now()
         WHERE id = $1 AND (status = ANY($2::text[]) OR (status = 'running' AND updated_at < now() - interval '${STALE_RUN_MINUTES} minutes'))
         RETURNING id`,
        [id, from],
      );
      return rows.length === 1;
    },
    /** A cap that survives restarts and instances, because the free model quota is shared by every visitor. */
    async countToday(): Promise<number> {
      const [row] = await db.query<{ count: string | number }>("SELECT count(*) AS count FROM cases WHERE created_at > now() - interval '1 day'");
      return Number(row!.count);
    },
    /** Visitors' text is not kept for long. Returns the removed ids so their checkpoints can go too. */
    async purgeOld(days = 7): Promise<string[]> {
      const rows = await db.query<{ id: string }>(`DELETE FROM cases WHERE created_at < now() - interval '${Math.floor(days)} days' RETURNING id`);
      return rows.map((r) => r.id);
    },
  };
}
export type Repository = ReturnType<typeof createRepository>;

export function createLedger(db: Db): ActionLedger {
  return {
    async record(caseId, action, amountBRL) {
      // The primary key is the idempotency: retrying a case cannot refund twice.
      const rows = await db.query<{ case_id: string }>(
        "INSERT INTO executed_actions (case_id, action, amount_brl) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING case_id",
        [caseId, action, amountBRL],
      );
      return rows.length === 1;
    },
  };
}

/** The Vercel integration can add a prefix to the variable's name. */
export function findDatabaseUrl(env: Record<string, string | undefined>): string | undefined {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const key = Object.keys(env).sort().find((name) => name.endsWith("_DATABASE_URL") && env[name]);
  return key ? env[key] : undefined;
}

export async function createPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  await pg.exec(SCHEMA);
  return { query: async <T>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows };
}

export async function createPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  // Neon closes idle connections. Without a listener, that error would crash the process.
  pool.on("error", (error) => console.warn("idle database connection closed:", error.message));
  await pool.query(SCHEMA);
  return { query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as T[] };
}
