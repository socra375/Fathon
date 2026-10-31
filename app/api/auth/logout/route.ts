import { SESSION_COOKIE } from "@/lib/auth";
import { seeOther } from "@/lib/redirect";

export async function POST(req: Request) {
  const res = seeOther(req, "/");
  res.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return res;
}
