import { describe, expect, it } from "vitest";
import { renderReportEmail } from "@/lib/email";
import { emptyAnalysis } from "@/lib/analyze";

describe("report email", () => {
  it("escapes model output and includes sections", () => {
    const analysis = {
      ...emptyAnalysis("es"),
      title: "Plan <script>alert(1)</script>",
      summary: "Resumen & más",
      decisions: ["Lanzar el lunes"],
      action_items: [{ owner: "Ana", task: "Preparar demo", due: "viernes" }],
    };
    const r = renderReportEmail({
      meetingId: "x",
      platform: "meet",
      startedAt: new Date("2026-10-31T10:00:00Z"),
      timezone: "America/Mexico_City",
      durationSec: 125,
      analysis,
      talk: [{ speaker: 0, label: "Tú", seconds: 100, pct: 80, turns: 3, words: 50 }],
      transcriptText: "",
      dashboardUrl: "https://example.com/dashboard/meetings/x",
    });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain("Resumen &amp; más");
    expect(r.html).toContain("Preparar demo");
    expect(r.html).toContain("Lanzar el lunes");
    expect(r.html).toContain("Google Meet");
    expect(r.html).toContain("02:05");
    expect(r.html).toContain("4:00"); // 10:00 UTC = 4:00 en Ciudad de México
    expect(r.html).toContain("https://example.com/dashboard/meetings/x");
    expect(r.subject.startsWith("Minuta · Plan")).toBe(true);
    expect(r.text).toContain("Ana: Preparar demo (viernes)");
    expect(r.html).toContain("<strong>Tú</strong>");
  });
});
