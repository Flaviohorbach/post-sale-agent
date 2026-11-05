import { getShared } from "@/lib/runtime";
import { streamRun } from "@/lib/stream-run";

/** Continues a failed case from its last saved step, without repeating the model calls that worked. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repo } = await getShared();
  if (!(await repo.claim(id, ["failed"]))) return Response.json({ error: "Este caso não pode ser retomado agora." }, { status: 409 });
  return streamRun(repo, id, { kind: "retry" });
}
