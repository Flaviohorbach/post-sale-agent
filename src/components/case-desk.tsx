"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { CaseEvent, EventActor } from "@/agent/graph";
import sampleRuns from "@/data/sample-runs.json";
import type { CaseRecord } from "@/lib/db";
import { ACTION_LABEL, SCENARIOS } from "@/lib/scenarios";
import type { StreamLine } from "@/lib/stream-run";

const samples = sampleRuns as unknown as (CaseRecord & { label: string })[];

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

const ACTORS: Record<EventActor, { label: string; kind: "agent" | "code" | "person" }> = {
  loja: { label: "Loja (MCP)", kind: "code" },
  triagem: { label: "Agente de triagem", kind: "agent" },
  politica: { label: "Política", kind: "code" },
  resolucao: { label: "Agente de resolução", kind: "agent" },
  revisor: { label: "Agente revisor", kind: "agent" },
  humano: { label: "Pessoa", kind: "person" },
  execucao: { label: "Execução", kind: "code" },
};

const STAGES: { id: EventActor; label: string }[] = [
  { id: "loja", label: "Pedido" },
  { id: "triagem", label: "Triagem" },
  { id: "politica", label: "Política" },
  { id: "resolucao", label: "Resolução" },
  { id: "revisor", label: "Revisão" },
  { id: "humano", label: "Aprovação" },
  { id: "execucao", label: "Execução" },
];

const BADGE: Record<"agent" | "code" | "person", string> = {
  agent: "bg-accent-soft text-ok",
  code: "bg-surface-2 text-muted",
  person: "bg-surface-2 text-warn",
};

function Timeline({ events }: { events: CaseEvent[] }) {
  return (
    <ol className="space-y-2" aria-label="Registro de decisões">
      {events.map((event, i) => {
        const actor = ACTORS[event.actor];
        return (
          <li key={i} className="rounded-xl border border-line bg-surface p-3">
            <p className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded-full px-2 py-0.5 font-medium ${BADGE[actor.kind]}`}>{actor.label}</span>
              <span className="text-muted">{event.modelCalls > 0 ? `${event.modelCalls} ${event.modelCalls === 1 ? "chamada" : "chamadas"} de modelo` : actor.kind === "code" ? "código, sem modelo" : ""}</span>
            </p>
            <p className="mt-1.5 text-sm font-medium">{event.title}</p>
            {event.detail && <p className="mt-0.5 text-sm text-muted">{event.detail}</p>}
            {event.data !== undefined && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-muted">Ver dados</summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-xs">{JSON.stringify(event.data, null, 1)}</pre>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Stages({ events, status }: { events: CaseEvent[]; status: CaseRecord["status"] | null }) {
  const seen = new Set(events.map((e) => e.actor));
  return (
    <ol aria-label="Etapas do caso" className="flex flex-wrap gap-x-1 gap-y-2 text-xs">
      {STAGES.map((stage, i) => {
        const done = seen.has(stage.id);
        const waiting = stage.id === "humano" && status === "waiting";
        return (
          <li key={stage.id} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className="text-muted">→</span>}
            <span className={`rounded-full border px-2 py-0.5 ${waiting ? "border-warn font-medium text-warn" : done ? "border-accent bg-accent-soft font-medium" : "border-line text-muted"}`}>
              {stage.label}
              {waiting && " (aguardando)"}
              {done && <span className="sr-only"> (concluída)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Reads one JSON line at a time, as the server finishes each step. */
async function readStream(response: Response, onLine: (line: StreamLine) => void) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line.trim()) onLine(JSON.parse(line) as StreamLine);
  }
}

export function CaseDesk() {
  const router = useRouter();
  const params = useSearchParams();
  const caseId = params.get("caso");

  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const [orderId, setOrderId] = useState(SCENARIOS[0]!.orderId);
  const [message, setMessage] = useState(SCENARIOS[0]!.message);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [record, setRecord] = useState<CaseRecord | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const liveCase = useRef<string | null>(null);

  const sample = samples.find((s) => s.id === sampleId);
  const shown = sample ?? record;
  const shownEvents = sample ? sample.events : events;

  // The case lives in the URL, so a paused one can be reopened later and approved.
  useEffect(() => {
    if (!caseId || liveCase.current === caseId) return;
    const controller = new AbortController();
    fetch(`/api/cases/${encodeURIComponent(caseId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Caso não encontrado. Casos ficam guardados por 7 dias.");
        const loaded = (await response.json()) as CaseRecord;
        setRecord(loaded);
        setEvents(loaded.events);
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setProblem(error.message);
      });
    return () => controller.abort();
  }, [caseId]);

  const follow = async (response: Response) => {
    await readStream(response, (line) => {
      if (line.type === "event") setEvents((current) => [...current, line.event]);
      else {
        setRecord(line.case);
        setEvents(line.case.events);
      }
    });
  };

  const run = async (request: () => Promise<Response>, reset: boolean) => {
    setBusy(true);
    setProblem(null);
    setSampleId(null);
    if (reset) {
      setEvents([]);
      setRecord(null);
    } else {
      setRecord((current) => current && { ...current, status: "running", pending: null, error: null });
    }
    try {
      const response = await request();
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setProblem(body?.error ?? "Não foi possível continuar. Tente de novo.");
        return;
      }
      const id = response.headers.get("x-case-id");
      if (id) {
        liveCase.current = id;
        router.replace(`/?caso=${id}`, { scroll: false });
      }
      await follow(response);
    } catch {
      setProblem("A conexão caiu. O caso continua salvo no servidor: recarregue a página para ver o estado atual.");
    } finally {
      setBusy(false);
    }
  };

  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const totalCalls = shownEvents.reduce((sum, e) => sum + e.modelCalls, 0);

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <section aria-label="Novo caso" className="min-w-0">
        <fieldset>
          <legend className="text-sm font-medium">Escolha uma situação</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {SCENARIOS.map((s) => (
              <label key={s.id} className={`cursor-pointer rounded-xl border p-3 ${s.id === scenarioId ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}>
                <input
                  type="radio"
                  name="scenario"
                  className="sr-only"
                  checked={s.id === scenarioId}
                  onChange={() => {
                    setScenarioId(s.id);
                    setOrderId(s.orderId);
                    setMessage(s.message);
                  }}
                />
                <span className="block text-sm font-medium">{s.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{s.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => post("/api/cases", { orderId, message }), true);
          }}
        >
          <div>
            <label htmlFor="order" className="text-sm font-medium">Número do pedido</label>
            <input id="order" value={orderId} maxLength={40} onChange={(e) => setOrderId(e.currentTarget.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 font-mono text-sm outline-accent" />
          </div>
          <div>
            <label htmlFor="message" className="text-sm font-medium">Mensagem do cliente</label>
            <textarea id="message" value={message} rows={3} maxLength={500} onChange={(e) => setMessage(e.currentTarget.value)} className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-accent" />
          </div>
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-accent px-5 py-3 text-sm font-medium text-accent-ink disabled:opacity-50">{busy ? "Trabalhando no caso…" : "Abrir caso"}</button>
          {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
        </form>

        {samples.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-medium">Exemplos gravados</h2>
            <p className="mt-0.5 text-xs text-muted">Execuções reais salvas, para ver sem gastar a cota gratuita.</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {samples.map((s) => (
                <li key={s.id}>
                  <button type="button" disabled={busy} aria-pressed={s.id === sampleId} onClick={() => setSampleId(s.id)} className={`rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${s.id === sampleId ? "border-accent bg-accent-soft" : "border-line text-muted hover:border-accent hover:text-ink"}`}>
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-label="Andamento do caso" className="min-w-0">
        <Stages events={shownEvents} status={shown?.status ?? null} />

        <div aria-live="polite" className="mt-3 space-y-3">
          {shownEvents.length === 0 && !busy && <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">Abra um caso para ver cada decisão aqui, com quem decidiu e por quê.</p>}

          {shown && (
            <p className="text-xs text-muted">
              {sample ? "Exemplo gravado. " : ""}Pedido <span className="font-mono">{shown.orderId}</span>: “{shown.message}”
            </p>
          )}

          {shownEvents.length > 0 && <Timeline events={shownEvents} />}
          {busy && <p className="text-sm text-muted">Próxima etapa em andamento…</p>}

          {!sample && record?.status === "waiting" && record.pending && (
            <div className="rounded-xl border-2 border-warn bg-surface p-4">
              <h2 className="font-display font-semibold">Sua aprovação é necessária</h2>
              <p className="mt-1 text-sm">
                Reembolso de <strong>{brl.format(record.pending.amountBRL)}</strong> para {record.pending.customerFirstName}. Acima de {brl.format(record.pending.limitBRL)}, uma pessoa precisa decidir.
              </p>
              <p className="mt-2 text-sm text-muted"><span className="font-medium">Motivo do agente:</span> {record.pending.reason}</p>
              <p className="mt-2 text-sm text-muted"><span className="font-medium">Mensagem que será enviada:</span> {record.pending.customerMessage}</p>
              <label htmlFor="note" className="mt-3 block text-sm font-medium">Observação (opcional)</label>
              <input id="note" value={note} maxLength={300} onChange={(e) => setNote(e.currentTarget.value)} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-accent" />
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void run(() => post(`/api/cases/${record.id}/decision`, { approved: true, note }), false)} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50">Aprovar reembolso</button>
                <button type="button" disabled={busy} onClick={() => void run(() => post(`/api/cases/${record.id}/decision`, { approved: false, note }), false)} className="rounded-xl border border-line px-4 py-2 text-sm font-medium disabled:opacity-50">Recusar e encaminhar</button>
              </div>
            </div>
          )}

          {!sample && record?.status === "failed" && (
            <div className="rounded-xl border border-danger bg-surface p-4">
              <p role="alert" className="text-sm text-danger">{record.error}</p>
              <button type="button" disabled={busy} onClick={() => void run(() => post(`/api/cases/${record.id}/retry`), false)} className="mt-3 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-50">Continuar de onde parou</button>
            </div>
          )}

          {shown?.status === "resolved" && shown.outcome && (
            <div className="rounded-xl border-2 border-accent bg-surface p-4">
              <h2 className="font-display font-semibold">Resultado: {ACTION_LABEL[shown.outcome.action]}</h2>
              {shown.outcome.amountBRL !== null && <p className="mt-1 text-sm font-medium text-price">{brl.format(shown.outcome.amountBRL)}</p>}
              <p className="mt-2 text-sm"><span className="font-medium">Mensagem ao cliente:</span> {shown.outcome.customerMessage}</p>
              <p className="mt-2 text-xs text-muted">{totalCalls} {totalCalls === 1 ? "chamada" : "chamadas"} de modelo neste caso. A ação foi só registrada: nenhum dinheiro ou produto real se move nesta demo.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
