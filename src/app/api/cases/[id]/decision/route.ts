import { z } from "zod";
import { getShared } from "@/lib/runtime";
import { streamRun } from "@/lib/stream-run";

const BodySchema = z.object({ approved: z.boolean(), note: z.string().trim().max(300).optional() });

/** A person's answer to a paused case. In this demo, whoever has the case link plays the approver. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Resposta inválida." }, { status: 400 });

  const { repo } = await getShared();
  if (!(await repo.claim(id, ["waiting"]))) return Response.json({ error: "Este caso não está aguardando aprovação." }, { status: 409 });
  return streamRun(repo, id, { kind: "resume", decision: body.data });
}
