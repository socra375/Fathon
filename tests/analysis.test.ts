import { describe, expect, it } from "vitest";
import { ANALYSIS_JSON_SCHEMA, AnalysisSchema, buildPrompt, emptyAnalysis } from "@/lib/analyze";

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; required?: string[]; additionalProperties?: boolean };

function checkStrict(s: JsonSchema, path = "$") {
  if (s.type === "object") {
    expect(s.additionalProperties, path).toBe(false);
    expect([...(s.required ?? [])].sort(), path).toEqual(Object.keys(s.properties ?? {}).sort());
    for (const [k, v] of Object.entries(s.properties ?? {})) checkStrict(v, `${path}.${k}`);
  }
  if (s.type === "array" && s.items) checkStrict(s.items, `${path}[]`);
}

describe("analysis schema", () => {
  it("JSON schema is strict (structured outputs requirement)", () => {
    checkStrict(ANALYSIS_JSON_SCHEMA as JsonSchema);
  });

  it("JSON schema keys match the zod schema", () => {
    expect(Object.keys(ANALYSIS_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(AnalysisSchema.shape).sort());
  });

  it("empty analysis validates", () => {
    expect(AnalysisSchema.safeParse(emptyAnalysis("es")).success).toBe(true);
  });

  it("prompt contains transcript and talk time", () => {
    const p = buildPrompt({
      transcriptText: "[00:01] Hablante 1: Hola",
      platform: "Google Meet",
      title: "Demo",
      startedAt: new Date("2026-10-31T10:00:00Z"),
      durationSec: 90,
      talk: [{ speaker: 0, label: "Tú", seconds: 90, pct: 100, turns: 1, words: 1 }],
      reportLanguage: "es",
    });
    expect(p).toContain("<transcripcion>\n[00:01] Hablante 1: Hola\n</transcripcion>");
    expect(p).toContain("- Tú: 100%");
    expect(p).toContain("Duración: 01:30");
  });
});
