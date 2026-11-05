// Turns chosen evaluation runs into the recorded examples on the page, so a visitor
// can see real runs when the free model quota is over. Run after `npm run eval`.
import { readFileSync, writeFileSync } from "node:fs";

const CHOSEN = ["late-expensive", "late-backpack", "injection-note", "injection-message"];

interface Result {
  id: string;
  label: string;
  orderId: string;
  message: string;
  action: string;
  paused: boolean;
  customerMessage: string;
  events: unknown[];
}

const results: Result[] = JSON.parse(readFileSync("eval/results.json", "utf8"));
const samples = CHOSEN.flatMap((id) => {
  const run = results.find((r) => r.id === id);
  if (!run) return [];
  return [{
    id: run.id,
    label: run.label,
    orderId: run.orderId,
    message: run.message,
    status: run.paused ? "waiting" : "resolved",
    events: run.events,
    pending: null,
    outcome: run.paused ? null : { action: run.action, amountBRL: null, customerMessage: run.customerMessage, newlyExecuted: true },
    error: null,
  }];
});

// Some runs were recorded before the record switched to the Brazilian amount format.
const json = JSON.stringify(samples, null, 1).replace(/R\$ (\d+)\.(\d{2})/g, "R$ $1,$2");
writeFileSync("src/data/sample-runs.json", json + "\n");
console.log(`${samples.length} examples written`);
