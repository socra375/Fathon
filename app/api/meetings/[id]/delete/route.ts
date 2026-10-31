import { isAuthed } from "@/lib/auth";
import { q } from "@/lib/db";
import { isUuid, unauthorized } from "@/lib/http";
import { seeOther } from "@/lib/redirect";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed(req))) return unauthorized();
  const { id } = await ctx.params;
  if (isUuid(id)) await q("DELETE FROM meetings WHERE id = $1", [id]);
  return seeOther(req, "/dashboard?deleted=1");
}
