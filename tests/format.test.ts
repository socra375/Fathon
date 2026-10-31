import { describe, expect, it } from "vitest";
import { clock, escapeHtml, mergeUtterances, talkShares, transcriptToText } from "@/lib/format";

describe("format", () => {
  it("clock", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(65)).toBe("01:05");
    expect(clock(3725)).toBe("1:02:05");
  });

  it("merges consecutive utterances of the same speaker", () => {
    const merged = mergeUtterances([
      { start: 0, end: 2, speaker: 0, text: "Hola" },
      { start: 2.5, end: 4, speaker: 0, text: "a todos." },
      { start: 4.2, end: 6, speaker: 1, text: "Buenas." },
      { start: 20, end: 22, speaker: 1, text: "Otra cosa." },
      { start: 22, end: 23, speaker: 1, text: "   " },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ text: "Hola a todos.", end: 4 });
  });

  it("renders transcript lines", () => {
    expect(transcriptToText([{ start: 61, end: 62, speaker: 1, text: "Vale" }])).toBe("[01:01] Hablante 2: Vale");
  });

  it("computes talk shares from durations", () => {
    const t = talkShares([
      { start: 0, end: 30, speaker: 0, text: "uno dos" },
      { start: 30, end: 40, speaker: 1, text: "tres" },
    ]);
    expect(t[0]).toMatchObject({ speaker: 0, pct: 75, words: 2, turns: 1 });
    expect(t[1]).toMatchObject({ speaker: 1, pct: 25 });
  });

  it("escapes html", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
