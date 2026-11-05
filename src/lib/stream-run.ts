import { runCase, type RunStart } from "../agent/run";
import type { CaseEvent } from "../agent/graph";
import type { CaseRecord, Repository } from "./db";
import { openGraph } from "./runtime";

export type StreamLine = { type: "event"; event: CaseEvent } | { type: "done"; case: CaseRecord };

/**
 * Sends each step to the screen as one JSON line while the graph runs. The run
 * is saved on the server, so a closed tab loses the live view, not the case.
 */
export function streamRun(repo: Repository, caseId: string, start: RunStart): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: StreamLine) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        } catch {
          // The visitor left. The case keeps running and saving.
        }
      };
      let close = async () => {};
      try {
        const opened = await openGraph();
        close = opened.close;
        send({ type: "done", case: await runCase(opened.graph, repo, caseId, start, (event) => send({ type: "event", event })) });
      } catch (error) {
        console.error(`case ${caseId} could not run:`, (error as Error).message.slice(0, 300));
        const current = await repo.get(caseId);
        await repo.save(caseId, { status: "failed", events: current?.events ?? [], error: "Não foi possível conectar à loja agora. O caso está salvo: tente continuar." });
        send({ type: "done", case: (await repo.get(caseId))! });
      } finally {
        await close().catch(() => {});
        try {
          controller.close();
        } catch {
          // Already closed by the visitor leaving.
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
