/** Saca el JSON aunque el modelo lo envuelva en ```json … ``` o añada texto alrededor. */
export function extractJson(text: string): string {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1].trim() : t;
  if (body.startsWith("{")) return body;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  return a >= 0 && b > a ? body.slice(a, b + 1) : body;
}
