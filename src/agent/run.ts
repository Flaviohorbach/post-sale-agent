import { Command } from "@langchain/langgraph";
import { APICallError } from "ai";
import type { CaseRecord, Repository } from "../lib/db";
import { ModelTimeoutError } from "../lib/model";
import type { ApprovalDecision, ApprovalRequest, CaseEvent, CaseGraph, Outcome } from "./graph";

export type RunStart =
  | { kind: "new"; orderId: string; message: string }
  | { kind: "resume"; decision: ApprovalDecision }
  /** Continues from the last saved step, so the model calls that already worked are not spent again. */
  | { kind: "retry" };

export function friendlyError(error: unknown): string {
  if (error instanceof ModelTimeoutError) return "O modelo demorou demais para responder. O caso está salvo: tente continuar em instantes.";
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "O limite gratuito do modelo foi atingido. O caso está salvo: tente continuar mais tarde.";
    if (error.statusCode === 400 || error.statusCode === 403) return "O serviço de IA recusou o pedido. Avise quem mantém este site.";
    return "O modelo está sobrecarregado no momento. O caso está salvo: tente continuar em instantes.";
  }
  return "Algo falhou no meio do caso. Ele está salvo: tente continuar.";
}

/**
 * Runs the graph until it ends, pauses for a person or fails, saving the record
 * after every step. `onEvent` receives each step as it happens, for the live screen.
 */
export async function runCase(graph: CaseGraph, repo: Repository, caseId: string, start: RunStart, onEvent: (event: CaseEvent) => void = () => {}): Promise<CaseRecord> {
  const config = { configurable: { thread_id: caseId }, streamMode: "updates" as const };
  const events: CaseEvent[] = (await repo.get(caseId))?.events ?? [];

  const input =
    start.kind === "new"
      ? { caseId, orderId: start.orderId, message: start.message, attempts: 0, reviewed: false, order: null, triage: null, facts: null, proposal: null, feedback: null, outcome: null }
      : start.kind === "resume"
        ? new Command({ resume: start.decision })
        : null;

  let outcome: Outcome | null = null;
  try {
    for await (const update of await graph.stream(input as never, config)) {
      for (const [node, change] of Object.entries(update as Record<string, { events?: CaseEvent[]; outcome?: Outcome | null } | undefined>)) {
        if (node === "__interrupt__" || !change) continue;
        if (change.outcome) outcome = change.outcome;
        for (const event of change.events ?? []) {
          events.push(event);
          onEvent(event);
        }
        await repo.save(caseId, { status: "running", events });
      }
    }

    const snapshot = await graph.getState({ configurable: { thread_id: caseId } });
    const pending = snapshot.tasks.flatMap((task) => task.interrupts).at(0)?.value as ApprovalRequest | undefined;
    if (pending) await repo.save(caseId, { status: "waiting", events, pending });
    else await repo.save(caseId, { status: "resolved", events, outcome: outcome ?? (snapshot.values as { outcome?: Outcome | null }).outcome ?? null });
  } catch (error) {
    console.error(`case ${caseId} failed:`, (error as Error).message.slice(0, 300));
    await repo.save(caseId, { status: "failed", events, error: friendlyError(error) });
  }
  return (await repo.get(caseId))!;
}
