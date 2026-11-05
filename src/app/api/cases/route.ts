import { randomUUID } from "node:crypto";
import { z } from "zod";
import { clientIp } from "@/lib/client-ip";
import { createRateLimiter } from "@/lib/rate-limit";
import { getShared } from "@/lib/runtime";
import { streamRun } from "@/lib/stream-run";

// Each case spends several requests of a small free model quota shared by every visitor.
const limiter = createRateLimiter({ limit: 4, windowMs: 10 * 60_000 });
const DAILY_LIMIT = Number(process.env.DAILY_CASE_LIMIT ?? 12);

const BodySchema = z.object({
  orderId: z.string().trim().min(3).max(40),
  message: z.string().trim().min(3).max(500),
});

export async function POST(request: Request) {
  const { allowed, retryAfterMs } = limiter(clientIp(request));
  if (!allowed) return Response.json({ error: "Muitos casos em pouco tempo. Tente de novo em alguns minutos, ou veja os exemplos gravados." }, { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } });

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Informe o pedido e a mensagem do cliente." }, { status: 400 });

  const { repo, checkpointer } = await getShared();
  if ((await repo.countToday()) >= DAILY_LIMIT) return Response.json({ error: "O limite de casos de hoje acabou, porque a demo usa uma cota gratuita. Veja os exemplos gravados, ou volte amanhã." }, { status: 429 });

  for (const old of await repo.purgeOld()) await checkpointer.deleteThread(old);

  const id = randomUUID();
  await repo.create(id, body.data.orderId, body.data.message);
  const response = streamRun(repo, id, { kind: "new", ...body.data });
  response.headers.set("x-case-id", id);
  return response;
}
