import { getShared } from "@/lib/runtime";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repo } = await getShared();
  const record = await repo.get(id);
  return record ? Response.json(record, { headers: { "cache-control": "no-store" } }) : Response.json({ error: "Caso não encontrado." }, { status: 404 });
}
