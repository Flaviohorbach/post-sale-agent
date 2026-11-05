import { describe, expect, it } from "vitest";
import { checkProposal, computeFacts, needsHumanApproval, type Order, type Proposal } from "../src/agent/policy";

const order = (overrides: Partial<Order> = {}): Order => ({
  orderId: "v1lvtx-01",
  status: "invoiced",
  statusLabel: "Faturado",
  createdAt: "2026-10-01T00:00:00Z",
  totalBRL: 714.9,
  items: [{ name: "Perfume", quantity: 1, unitPriceBRL: 714.9 }],
  customerFirstName: "Ana",
  shipTo: "São Paulo/SP",
  estimatedDelivery: "2026-10-27T23:59:00Z",
  tracking: [],
  untrustedCustomerNote: null,
  ...overrides,
});

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({ action: "refund", reason: "r", customerMessage: "Olá, Ana.", stockChecks: [], ...overrides });

describe("computeFacts", () => {
  it("offers refund and reship for a shipped order that is late, when the customer complains", () => {
    const facts = computeFacts(order(), "delay");
    expect(facts.late).toBe(true);
    expect(facts.daysLate).toBe(8);
    expect(facts.allowed).toEqual(expect.arrayContaining(["refund", "reship", "escalate", "reply_only"]));
  });

  it("does not offer reship for an order still being prepared", () => {
    const facts = computeFacts(order({ status: "handling" }), "delay");
    expect(facts.allowed).toContain("refund");
    expect(facts.allowed).not.toContain("reship");
  });

  it("offers no compensation when the customer only asks where it is", () => {
    expect(computeFacts(order(), "status_question").allowed).toEqual(["reply_only", "escalate"]);
  });

  it("offers no compensation when the order is not late", () => {
    const facts = computeFacts(order({ estimatedDelivery: "2026-11-12T23:59:00Z" }), "delay");
    expect(facts.late).toBe(false);
    expect(facts.allowed).toEqual(["reply_only", "escalate"]);
  });

  it("does not treat a canceled or unpaid order as late", () => {
    expect(computeFacts(order({ status: "canceled" }), "delay").allowed).toEqual(["reply_only", "escalate"]);
    expect(computeFacts(order({ status: "payment-pending" }), "delay").allowed).toEqual(["reply_only", "escalate"]);
  });

  it("does not count the promised day itself as late", () => {
    expect(computeFacts(order({ estimatedDelivery: "2026-11-04T23:59:00Z" }), "delay").late).toBe(false);
    expect(computeFacts(order({ estimatedDelivery: "2026-11-03T23:59:00Z" }), "delay").late).toBe(true);
  });
});

describe("needsHumanApproval", () => {
  it("applies only to refunds above the limit", () => {
    expect(needsHumanApproval("refund", order({ totalBRL: 300.01 }))).toBe(true);
    expect(needsHumanApproval("refund", order({ totalBRL: 300 }))).toBe(false);
    expect(needsHumanApproval("reship", order({ totalBRL: 9000 }))).toBe(false);
  });
});

describe("checkProposal", () => {
  const facts = computeFacts(order(), "delay");

  it("accepts a valid refund", () => {
    expect(checkProposal(proposal({ customerMessage: "Reembolsamos R$ 714,90." }), order(), facts)).toEqual([]);
  });

  it("rejects an action the policy does not allow", () => {
    const limited = computeFacts(order(), "status_question");
    expect(checkProposal(proposal(), order(), limited)).toHaveLength(1);
  });

  it("rejects a reship without stock evidence for every item", () => {
    const twoItems = order({ items: [{ name: "A", quantity: 1, unitPriceBRL: 1 }, { name: "B", quantity: 1, unitPriceBRL: 2 }] });
    const oneCheck = proposal({ action: "reship", stockChecks: [{ skuId: "1", available: 5 }] });
    expect(checkProposal(oneCheck, twoItems, facts).join()).toContain("estoque");
    const both = proposal({ action: "reship", stockChecks: [{ skuId: "1", available: 5 }, { skuId: "2", available: 5 }] });
    expect(checkProposal(both, twoItems, facts)).toEqual([]);
  });

  it("rejects a reship when there is not enough stock", () => {
    const empty = proposal({ action: "reship", stockChecks: [{ skuId: "1", available: 0 }] });
    expect(checkProposal(empty, order(), facts).join()).toContain("estoque");
  });

  it("rejects an amount that is not in the order, in any format", () => {
    expect(checkProposal(proposal({ customerMessage: "Devolvemos R$ 10,00." }), order(), facts).join()).toContain("R$ 10,00");
    expect(checkProposal(proposal({ customerMessage: "Devolvemos R$ 1.000,00." }), order(), facts).join()).toContain("R$ 1.000,00");
    expect(checkProposal(proposal({ customerMessage: "O total é R$ 714,90." }), order(), facts)).toEqual([]);
  });

  it("rejects a message that claims a refund when the action is something else", () => {
    const wrong = proposal({ action: "escalate", customerMessage: "Já reembolsamos você." });
    expect(checkProposal(wrong, order(), facts).join()).toContain("reembolso");
  });
});
