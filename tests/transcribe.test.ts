import { describe, expect, it } from "vitest";
import { parseDeepgram } from "@/lib/transcribe";

describe("parseDeepgram", () => {
  it("reads utterances with speakers", () => {
    const r = parseDeepgram(
      {
        metadata: { duration: 42.6 },
        results: {
          channels: [{ detected_language: "es", alternatives: [{ transcript: "x" }] }],
          utterances: [
            { start: 0, end: 1, speaker: 0, transcript: "Hola" },
            { start: 1, end: 2, speaker: 1, transcript: "Qué tal" },
          ],
        },
      },
      null,
    );
    expect(r.durationSec).toBe(43);
    expect(r.language).toBe("es");
    expect(r.utterances.map((u) => u.speaker)).toEqual([0, 1]);
  });

  it("falls back to the channel transcript when there are no utterances", () => {
    const r = parseDeepgram(
      { metadata: { duration: 10 }, results: { channels: [{ alternatives: [{ transcript: "Solo texto" }] }] } },
      "en",
    );
    expect(r.utterances).toEqual([{ start: 0, end: 10, speaker: 0, text: "Solo texto" }]);
    expect(r.language).toBe("en");
  });

  it("handles empty audio", () => {
    expect(parseDeepgram({}, null).utterances).toEqual([]);
  });
});
