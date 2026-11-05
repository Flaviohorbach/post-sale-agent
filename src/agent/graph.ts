import { Annotation, END, interrupt, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { Agents, Triage } from "./agents";
import { checkProposal, computeFacts, escalationMessage, formatBRL, needsHumanApproval, REFUND_APPROVAL_LIMIT_BRL, type Action, type Facts, type Order, type Proposal } from "./policy";
import type { Store } from "./store";

export type EventActor = "loja" | "triagem" | "politica" | "resolucao" | "revisor" | "humano" | "execucao";

/** One line of the record shown on screen. It is the audit trail: what was decided, by whom and why. */
export interface CaseEvent {
  actor: EventActor;
  title: string;
  detail?: string;
  data?: unknown;
  /** Model requests this step spent. Zero means plain code. */
  modelCalls: number;
}

export interface Outcome {
  action: Action;
  amountBRL: number | null;
  customerMessage: string;
  /** False when the action was already recorded: a retry must not refund twice. */
  newlyExecuted: boolean;
}

export interface ApprovalRequest {
  orderId: string;
  customerFirstName: string;
  amountBRL: number;
  limitBRL: number;
  reason: string;
  customerMessage: string;
}

export interface ApprovalDecision {
  approved: boolean;
  note?: string;
}

const MAX_ATTEMPTS = 2;

const CaseState = Annotation.Root({
  caseId: Annotation<string>,
  orderId: Annotation<string>,
  message: Annotation<string>,
  order: Annotation<Order | null>,
  triage: Annotation<Triage | null>,
  facts: Annotation<Facts | null>,
  proposal: Annotation<Proposal | null>,
  feedback: Annotation<string | null>,
  attempts: Annotation<number>,
  reviewed: Annotation<boolean>,
  outcome: Annotation<Outcome | null>,
  events: Annotation<CaseEvent[]>({ reducer: (current, added) => [...current, ...added], default: () => [] }),
});
type State = typeof CaseState.State;

/** The side effect: a real store would call its refund and shipping APIs here. */
export interface ActionLedger {
  /** Records an action once per case. Returns false if it was already recorded. */
  record(caseId: string, action: Action, amountBRL: number | null): Promise<boolean>;
}

export interface GraphDeps {
  agents: Agents;
  store: Store;
  ledger: ActionLedger;
  checkpointer: BaseCheckpointSaver;
}

export function buildGraph({ agents, store, ledger, checkpointer }: GraphDeps) {
  const loadOrder = async (state: State): Promise<Partial<State>> => {
    const order = await store.getOrder(state.orderId);
    const event: CaseEvent = order
      ? { actor: "loja", title: `Pedido consultado pelo MCP: ${order.statusLabel}`, detail: `${order.items.map((i) => i.name).join(", ")}. Total de ${formatBRL(order.totalBRL)}.`, data: order, modelCalls: 0 }
      : { actor: "loja", title: "Pedido não encontrado", detail: state.orderId, modelCalls: 0 };
    return { order, events: [event] };
  };

  const notFound = async (state: State): Promise<Partial<State>> => ({
    outcome: { action: "reply_only", amountBRL: null, customerMessage: `Não encontramos o pedido ${state.orderId}. Confira o número e tente de novo, por favor.`, newlyExecuted: false },
    events: [],
  });

  const triage = async (state: State): Promise<Partial<State>> => {
    const result = await agents.triage({ order: state.order!, message: state.message });
    return { triage: result, events: [{ actor: "triagem", title: `Classificado como ${result.category}, urgência ${result.urgency}`, detail: result.summary + (result.suspiciousNote ? " Texto suspeito tratado como dado." : ""), data: result, modelCalls: 1 }] };
  };

  const policy = async (state: State): Promise<Partial<State>> => {
    const facts = computeFacts(state.order!, state.triage!.category);
    const lateness = facts.late ? `${facts.daysLate} dias de atraso` : "Sem atraso";
    return { facts, events: [{ actor: "politica", title: `${lateness}. Ações permitidas: ${facts.allowed.join(", ")}`, data: facts, modelCalls: 0 }] };
  };

  const resolve = async (state: State): Promise<Partial<State>> => {
    const { proposal, toolCalls, modelCalls } = await agents.resolve({ order: state.order!, message: state.message, triage: state.triage!, facts: state.facts!, feedback: state.feedback });
    return {
      proposal,
      attempts: (state.attempts ?? 0) + 1,
      reviewed: false,
      events: [{ actor: "resolucao", title: `Propôs ${proposal.action}`, detail: proposal.reason, data: { toolCalls, customerMessage: proposal.customerMessage }, modelCalls }],
    };
  };

  const review = async (state: State): Promise<Partial<State>> => {
    const { order, facts, proposal, message } = state;
    // Rules first: a broken rule needs no opinion, and saves a model call.
    const problems = checkProposal(proposal!, order!, facts!);
    if (problems.length > 0) {
      return { feedback: problems.join(" "), reviewed: false, events: [{ actor: "politica", title: "Proposta barrada pelas regras", detail: problems.join(" "), modelCalls: 0 }] };
    }
    const result = await agents.review({ order: order!, message, facts: facts!, proposal: proposal! });
    return {
      feedback: result.approved ? null : result.feedback,
      reviewed: result.approved,
      events: [{ actor: "revisor", title: result.approved ? "Aprovou a proposta" : "Pediu correção", detail: result.feedback, modelCalls: 1 }],
    };
  };

  /** Two tries and then a person: neither agent can keep the case going forever or force an answer through. */
  const giveUp = async (state: State): Promise<Partial<State>> => ({
    proposal: { action: "escalate", reason: "A proposta não passou na revisão depois de duas tentativas.", customerMessage: escalationMessage(state.order!), stockChecks: [] },
    events: [{ actor: "politica", title: "Encaminhado a um atendente", detail: "Duas tentativas sem aprovação.", modelCalls: 0 }],
  });

  /**
   * Stops here until a person answers. Everything before `interrupt` runs again
   * on resume, so this node must have no side effects.
   */
  const humanGate = async (state: State): Promise<Partial<State>> => {
    const { order, proposal } = state;
    if (!needsHumanApproval(proposal!.action, order!)) return { events: [] };

    const request: ApprovalRequest = {
      orderId: order!.orderId,
      customerFirstName: order!.customerFirstName,
      amountBRL: order!.totalBRL,
      limitBRL: REFUND_APPROVAL_LIMIT_BRL,
      reason: proposal!.reason,
      customerMessage: proposal!.customerMessage,
    };
    const decision = interrupt<ApprovalRequest, ApprovalDecision>(request);

    const note = decision.note?.trim() ? decision.note.trim() : undefined;
    if (decision.approved) {
      return { events: [{ actor: "humano", title: `Reembolso de ${formatBRL(order!.totalBRL)} aprovado`, detail: note, modelCalls: 0 }] };
    }
    return {
      proposal: { action: "escalate", reason: note ?? "Reembolso recusado na aprovação humana.", customerMessage: escalationMessage(order!), stockChecks: [] },
      events: [{ actor: "humano", title: "Reembolso recusado; caso vai para um atendente", detail: note, modelCalls: 0 }],
    };
  };

  const execute = async (state: State): Promise<Partial<State>> => {
    const { action, customerMessage } = state.proposal!;
    // The amount comes from the order, never from a model's text.
    const amountBRL = action === "refund" ? state.order!.totalBRL : null;
    const newlyExecuted = await ledger.record(state.caseId, action, amountBRL);
    return {
      outcome: { action, amountBRL, customerMessage, newlyExecuted },
      events: [{ actor: "execucao", title: newlyExecuted ? `Ação registrada: ${action}` : `Ação ${action} já estava registrada; nada foi repetido`, detail: amountBRL === null ? undefined : formatBRL(amountBRL), modelCalls: 0 }],
    };
  };

  return new StateGraph(CaseState)
    .addNode("load_order", loadOrder)
    .addNode("not_found", notFound)
    .addNode("classify", triage)
    .addNode("policy", policy)
    .addNode("resolve", resolve)
    .addNode("review", review)
    .addNode("give_up", giveUp)
    .addNode("human_gate", humanGate)
    .addNode("execute", execute)
    .addEdge(START, "load_order")
    .addConditionalEdges("load_order", (state) => (state.order ? "classify" : "not_found"), ["classify", "not_found"])
    .addEdge("not_found", END)
    .addEdge("classify", "policy")
    .addEdge("policy", "resolve")
    .addEdge("resolve", "review")
    .addConditionalEdges(
      "review",
      (state) => {
        if (state.reviewed) return "human_gate";
        return state.attempts >= MAX_ATTEMPTS ? "give_up" : "resolve";
      },
      ["human_gate", "give_up", "resolve"],
    )
    .addEdge("give_up", "human_gate")
    .addEdge("human_gate", "execute")
    .addEdge("execute", END)
    .compile({ checkpointer });
}

export type CaseGraph = ReturnType<typeof buildGraph>;
