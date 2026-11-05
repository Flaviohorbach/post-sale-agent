import { z } from "zod";

/** The shape `get_order` returns from the MCP server. */
export const OrderSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  statusLabel: z.string(),
  createdAt: z.string(),
  totalBRL: z.number(),
  items: z.array(z.object({ name: z.string(), quantity: z.number(), unitPriceBRL: z.number() })),
  customerFirstName: z.string(),
  shipTo: z.string(),
  estimatedDelivery: z.string().nullable(),
  tracking: z.array(z.object({ courier: z.string(), trackingNumber: z.string(), trackingUrl: z.string() })),
  untrustedCustomerNote: z.string().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const ACTIONS = ["reship", "refund", "escalate", "reply_only"] as const;
export type Action = (typeof ACTIONS)[number];

export const CATEGORIES = ["delay", "status_question", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * The simulated store is a snapshot, so its clock is fixed too. With the real
 * date, every order would eventually be late and the scenarios would stop meaning anything.
 */
export const STORE_DATE = "2026-11-04";

/** Refunds above this wait for a person. The model cannot change it: it never sees a way to. */
export const REFUND_APPROVAL_LIMIT_BRL = 300;

export interface Facts {
  late: boolean;
  daysLate: number;
  shipped: boolean;
  allowed: Action[];
  refundAmountBRL: number;
}

const DAY_MS = 86_400_000;

/**
 * What the store's rules allow for this order. Plain code, so it can be tested
 * and cannot be talked out of a rule by anything written in a complaint.
 */
export function computeFacts(order: Order, category: Category, today = STORE_DATE): Facts {
  const estimate = order.estimatedDelivery ? Date.parse(order.estimatedDelivery) : null;
  const inProgress = order.status !== "canceled" && order.status !== "payment-pending";
  const daysLate = estimate === null ? 0 : Math.floor((Date.parse(`${today}T00:00:00Z`) - estimate) / DAY_MS) + 1;
  const late = inProgress && daysLate > 0;
  const shipped = order.status === "invoiced";

  const allowed: Action[] = ["reply_only", "escalate"];
  // Compensation is an answer to a complaint: nobody gets a refund for asking where a parcel is.
  if (late && category === "delay") {
    allowed.push("refund");
    // Only what already left can be sent again. An order still being prepared has nothing to resend.
    if (shipped) allowed.push("reship");
  }
  return { late, daysLate: Math.max(daysLate, 0), shipped, allowed, refundAmountBRL: order.totalBRL };
}

export interface StockCheck {
  skuId: string;
  available: number;
}

export interface Proposal {
  action: Action;
  reason: string;
  customerMessage: string;
  stockChecks: StockCheck[];
}

const brl = (value: number) => value.toFixed(2).replace(".", ",");
export const formatBRL = (value: number) => `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Every amount in the message must be one this order really has. A model may round, convert or invent. */
function ungroundedAmounts(message: string, order: Order): string[] {
  const known = new Set([order.totalBRL, ...order.items.map((i) => i.unitPriceBRL)].map(brl));
  const found = message.match(/R\$\s*[\d.]+(?:,\d{2})?/g) ?? [];
  return found.filter((text) => {
    const digits = text.replace(/R\$\s*/, "").replaceAll(".", "");
    return !known.has(digits.includes(",") ? digits : `${digits},00`);
  });
}

/** Checks a person would make first, without spending a model call on them. Returns what is wrong. */
export function checkProposal(proposal: Proposal, order: Order, facts: Facts): string[] {
  const problems: string[] = [];
  if (!facts.allowed.includes(proposal.action)) problems.push(`A ação ${proposal.action} não é permitida para este pedido.`);
  if (proposal.action === "reship") {
    const units = Math.max(...order.items.map((i) => i.quantity));
    const enough = proposal.stockChecks.filter((check) => check.available >= units);
    if (enough.length < order.items.length) problems.push("O reenvio exige consultar o estoque de cada item com check_inventory e encontrar unidades suficientes.");
  }
  const amounts = ungroundedAmounts(proposal.customerMessage, order);
  if (amounts.length > 0) problems.push(`A mensagem cita valores que não existem no pedido: ${amounts.join(", ")}.`);
  // The promise that matters: saying money was returned when it was not.
  if (proposal.action !== "refund" && /reembols(ad|ei|amos|arem)/i.test(proposal.customerMessage)) problems.push("A mensagem fala em reembolso, mas a ação escolhida não é reembolso.");
  return problems;
}

export const needsHumanApproval = (action: Action, order: Order) => action === "refund" && order.totalBRL > REFUND_APPROVAL_LIMIT_BRL;

/** Written by code, so a person's "no" or a model that keeps failing review never ends in an unchecked message. */
export function escalationMessage(order: Order) {
  return `Olá, ${order.customerFirstName}. Encaminhamos o seu pedido ${order.orderId} para a nossa equipe de atendimento, que vai analisar o caso e responder em breve.`;
}
