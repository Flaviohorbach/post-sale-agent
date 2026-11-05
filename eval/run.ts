// Runs each complaint through the real graph, models and MCP server, then checks
// with fixed rules what happened. Resumable, because every case spends free quota.
// A case that stops halfway keeps its checkpoints in memory only for this process,
// so it starts over on the next run: the score counts complete runs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAgents } from "../src/agent/agents";
import { buildGraph, type CaseEvent } from "../src/agent/graph";
import { runCase } from "../src/agent/run";
import { connectStore } from "../src/agent/store";
import { createMemorySaver } from "../src/lib/checkpointer";
import { createLedger, createPglite, createRepository } from "../src/lib/db";
import { createShopModel } from "../src/lib/model";

interface Case {
  id: string;
  label: string;
  orderId: string;
  message: string;
  acceptActions: string[];
  expectPause?: boolean;
  expectSuspicious?: boolean;
  mustNotContain?: string[];
}
interface Result {
  id: string;
  label: string;
  orderId: string;
  message: string;
  action: string;
  paused: boolean;
  modelCalls: number;
  attempts: number;
  customerMessage: string;
  events: CaseEvent[];
  pass: boolean;
  problems: string[];
}

const OUTPUT = "eval/results.json";
const cases: Case[] = JSON.parse(readFileSync("eval/cases.json", "utf8"));
const results: Result[] = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : [];

const db = await createPglite();
const repo = createRepository(db);
const store = await connectStore();
const graph = buildGraph({ agents: createAgents(createShopModel(), store), store, ledger: createLedger(db), checkpointer: createMemorySaver() });

for (const item of cases) {
  if (results.some((r) => r.id === item.id)) continue;
  const caseId = randomUUID();
  await repo.create(caseId, item.orderId, item.message);
  const record = await runCase(graph, repo, caseId, { kind: "new", orderId: item.orderId, message: item.message });
  if (record.status === "failed") {
    console.log(`STOP ${item.id}: ${record.error}`);
    process.exitCode = 1;
    break;
  }

  const paused = record.status === "waiting";
  const action = paused ? "refund" : (record.outcome?.action ?? "none");
  const customerMessage = paused ? record.pending!.customerMessage : (record.outcome?.customerMessage ?? "");
  const text = customerMessage.toLowerCase();
  const suspicious = record.events.some((e) => e.actor === "triagem" && (e.data as { suspiciousNote?: boolean } | undefined)?.suspiciousNote === true);

  const problems = [
    ...(item.acceptActions.includes(action) ? [] : [`action was ${action}`]),
    ...(item.expectPause === undefined || item.expectPause === paused ? [] : [paused ? "paused when it should not" : "did not pause"]),
    ...(item.expectSuspicious && !suspicious ? ["did not flag the suspicious text"] : []),
    ...(item.mustNotContain ?? []).filter((part) => text.includes(part.toLowerCase())).map((part) => `message has "${part}"`),
  ];

  results.push({
    id: item.id,
    label: item.label,
    orderId: item.orderId,
    message: item.message,
    action,
    paused,
    modelCalls: record.events.reduce((sum, e) => sum + e.modelCalls, 0),
    attempts: record.events.filter((e) => e.actor === "resolucao").length,
    customerMessage,
    events: record.events,
    pass: problems.length === 0,
    problems,
  });
  writeFileSync(OUTPUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${item.id} [${action}${paused ? ", paused" : ""}] ${record.events.reduce((s, e) => s + e.modelCalls, 0)} calls ${problems.join("; ")}`);
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}

await store.close();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
