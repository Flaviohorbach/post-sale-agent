import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Agents, Resolution } from "../src/agent/agents";
import { buildGraph } from "../src/agent/graph";
import type { Action, Proposal } from "../src/agent/policy";
import { runCase } from "../src/agent/run";
import { storeFromClient, type Store } from "../src/agent/store";
import { createLedger, createPglite, createRepository, type Db, type Repository } from "../src/lib/db";

const LATE_CHEAP = "v502101lvtx-01"; // R$ 202,80, shipped
const LATE_EXPENSIVE = "v502102lvtx-01"; // R$ 714,90, being prepared
const NOT_LATE = "v502108lvtx-01";

// The published package from project 7, over stdio: real MCP, no network.
let store: Store;
let db: Db;
let repo: Repository;

beforeAll(async () => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["node_modules/mcp-ecommerce-server/dist/stdio.js"] }));
  store = storeFromClient(client);
  db = await createPglite();
  repo = createRepository(db);
});
afterAll(() => store.close());

interface Calls {
  triage: number;
  resolve: number;
  review: number;
  seenFeedback: (string | null)[];
}
let calls: Calls;
beforeEach(() => {
  calls = { triage: 0, resolve: 0, review: 0, seenFeedback: [] };
});

function fakeAgents(options: { action?: Action; proposals?: Partial<Proposal>[]; reviews?: boolean[]; category?: "delay" | "status_question"; failResolveOnce?: boolean } = {}): Agents {
  let failed = false;
  return {
    triage: async () => {
      calls.triage++;
      return { category: options.category ?? "delay", urgency: "normal", summary: "resumo", suspiciousNote: false };
    },
    resolve: async ({ feedback }) => {
      if (options.failResolveOnce && !failed) {
        failed = true;
        throw new Error("model overloaded");
      }
      calls.seenFeedback.push(feedback);
      const custom = options.proposals?.[calls.resolve] ?? {};
      calls.resolve++;
      const proposal: Proposal = { action: options.action ?? "refund", reason: "motivo", customerMessage: "Olá.", stockChecks: [], ...custom };
      return { proposal, toolCalls: [], modelCalls: 1 } satisfies Resolution;
    },
    review: async () => {
      const approved = options.reviews?.[calls.review] ?? true;
      calls.review++;
      return { approved, feedback: approved ? "ok" : "corrija" };
    },
  };
}

async function start(agents: Agents, orderId: string, checkpointer = new MemorySaver()) {
  const graph = buildGraph({ agents, store, ledger: createLedger(db), checkpointer });
  const id = randomUUID();
  await repo.create(id, orderId, "Meu pedido atrasou");
  const record = await runCase(graph, repo, id, { kind: "new", orderId, message: "Meu pedido atrasou" });
  return { graph, id, record, checkpointer };
}

const amountsOf = (id: string) => db.query<{ action: string; amount_brl: string }>("SELECT action, amount_brl FROM executed_actions WHERE case_id = $1", [id]);

describe("a refund under the limit", () => {
  it("runs straight through and records the order's amount", async () => {
    const { id, record } = await start(fakeAgents(), LATE_CHEAP);
    expect(record.status).toBe("resolved");
    expect(record.outcome).toMatchObject({ action: "refund", amountBRL: 202.8, newlyExecuted: true });
    expect(await amountsOf(id)).toHaveLength(1);
    expect(record.events.map((e) => e.actor)).toEqual(["loja", "triagem", "politica", "resolucao", "revisor", "execucao"]);
  });
});

describe("a refund above the limit", () => {
  it("stops and does nothing until a person answers", async () => {
    const { id, record } = await start(fakeAgents(), LATE_EXPENSIVE);
    expect(record.status).toBe("waiting");
    expect(record.pending).toMatchObject({ amountBRL: 714.9, limitBRL: 300 });
    expect(await amountsOf(id)).toHaveLength(0);
  });

  it("executes after approval, without calling the models again", async () => {
    const { graph, id } = await start(fakeAgents(), LATE_EXPENSIVE);
    const before = { ...calls };
    const record = await runCase(graph, repo, id, { kind: "resume", decision: { approved: true, note: "ok" } });
    expect(record.status).toBe("resolved");
    expect(record.outcome).toMatchObject({ action: "refund", amountBRL: 714.9 });
    expect(calls.resolve).toBe(before.resolve);
    expect(calls.review).toBe(before.review);
    expect(await amountsOf(id)).toHaveLength(1);
  });

  it("escalates with a message from code when the person refuses", async () => {
    const { graph, id } = await start(fakeAgents({ proposals: [{ customerMessage: "Olá, Ana. Seu dinheiro volta logo." }] }), LATE_EXPENSIVE);
    const record = await runCase(graph, repo, id, { kind: "resume", decision: { approved: false, note: "cliente frequente de fraude" } });
    expect(record.outcome?.action).toBe("escalate");
    expect(record.outcome?.customerMessage).toContain("equipe de atendimento");
    expect(record.outcome?.customerMessage).not.toContain("dinheiro");
    const executed = await amountsOf(id);
    expect(executed.map((e) => e.action)).toEqual(["escalate"]);
  });
});

describe("rules hold whatever a model does", () => {
  it("stops an action the policy forbids, before the reviewer is asked", async () => {
    const { record } = await start(fakeAgents({ action: "refund" }), NOT_LATE);
    expect(calls.review).toBe(0);
    expect(record.outcome?.action).toBe("escalate");
    expect(record.events.map((e) => e.title)).toContain("Proposta barrada pelas regras");
  });

  it("gives the resolver the reason, and it can fix the proposal", async () => {
    const { record } = await start(fakeAgents({ proposals: [{ customerMessage: "Devolvemos R$ 99,00." }, { customerMessage: "Devolvemos o valor total." }] }), LATE_CHEAP);
    expect(calls.seenFeedback[0]).toBeNull();
    expect(calls.seenFeedback[1]).toContain("R$ 99,00");
    expect(record.outcome).toMatchObject({ action: "refund", newlyExecuted: true });
  });

  it("does not let a reship through without stock evidence", async () => {
    const { record } = await start(fakeAgents({ action: "reship" }), LATE_CHEAP);
    expect(record.outcome?.action).toBe("escalate");
  });

  it("stops after two attempts instead of looping", async () => {
    const { record } = await start(fakeAgents({ reviews: [false, false, false] }), LATE_CHEAP);
    expect(calls.resolve).toBe(2);
    expect(record.outcome?.action).toBe("escalate");
    expect(record.outcome?.customerMessage).toContain("equipe de atendimento");
  });

  it("offers no compensation to someone who only asked for the status", async () => {
    const { record } = await start(fakeAgents({ category: "status_question", action: "refund" }), LATE_CHEAP);
    expect(record.outcome?.action).toBe("escalate");
  });
});

describe("failure and retry", () => {
  it("continues from the last step, without repeating what worked", async () => {
    const { graph, id, record } = await start(fakeAgents({ failResolveOnce: true }), LATE_CHEAP);
    expect(record.status).toBe("failed");
    expect(record.error).toContain("salvo");
    expect(calls.triage).toBe(1);

    const retried = await runCase(graph, repo, id, { kind: "retry" });
    expect(retried.status).toBe("resolved");
    expect(calls.triage).toBe(1);
    expect(retried.outcome).toMatchObject({ action: "refund", newlyExecuted: true });
  });

  it("answers plainly when the order does not exist, without calling a model", async () => {
    const { record } = await start(fakeAgents(), "v999999lvtx-01");
    expect(record.status).toBe("resolved");
    expect(calls.triage).toBe(0);
    expect(record.outcome?.customerMessage).toContain("Não encontramos");
  });
});

describe("idempotency", () => {
  it("records an action once per case", async () => {
    const ledger = createLedger(db);
    const id = randomUUID();
    expect(await ledger.record(id, "refund", 10)).toBe(true);
    expect(await ledger.record(id, "refund", 10)).toBe(false);
  });

  it("lets only one of two clicks resume a waiting case", async () => {
    const { id } = await start(fakeAgents(), LATE_EXPENSIVE);
    const results = await Promise.all([repo.claim(id, ["waiting"]), repo.claim(id, ["waiting"])]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
