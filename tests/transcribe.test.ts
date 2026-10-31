import { describe, expect, it } from "vitest";
import { filterWhisperSegments, parseDeepgram, toUtterances } from "@/lib/transcribe";

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
    expect(r.segments.map((u) => u.speaker)).toEqual([0, 1]);
  });

  it("drops speakers when diarization is off (microphone track)", () => {
    const r = parseDeepgram({ results: { utterances: [{ start: 0, end: 1, speaker: 0, transcript: "Yo" }] } }, "es", false);
    expect(r.segments[0].speaker).toBeUndefined();
  });

  it("falls back to the channel transcript when there are no utterances", () => {
    const r = parseDeepgram(
      { metadata: { duration: 10 }, results: { channels: [{ alternatives: [{ transcript: "Solo texto" }] }] } },
      "en",
    );
    expect(r.segments).toEqual([{ start: 0, end: 10, text: "Solo texto", speaker: 0 }]);
    expect(r.language).toBe("en");
  });

  it("handles empty audio", () => {
    expect(parseDeepgram({}, null).segments).toEqual([]);
  });
});

describe("filterWhisperSegments", () => {
  it("keeps speech and drops silence hallucinations", () => {
    const out = filterWhisperSegments([
      { start: 0, end: 3, text: " Buenos días a todos. ", avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.3 },
      { start: 3, end: 6, text: "Subtítulos realizados por la comunidad de Amara.org", avg_logprob: -0.4, no_speech_prob: 0.5 },
      { start: 6, end: 9, text: "...", avg_logprob: -1.5, no_speech_prob: 0.9 },
      { start: 9, end: 12, text: "sí sí sí sí sí sí sí sí sí sí sí sí", compression_ratio: 3.1 },
      { start: 12, end: 14, text: "Gracias por ver el video", avg_logprob: -0.3, no_speech_prob: 0.05 },
      { start: 14, end: 15, text: "   " },
    ]);
    expect(out.map((s) => s.text)).toEqual(["Buenos días a todos.", "Gracias por ver el video"]);
  });
});

describe("toUtterances", () => {
  const seg = [{ start: 1, end: 2, text: "hola" }];
  it("labels the microphone as «Tú» and offsets by segment start", () => {
    expect(toUtterances("mic", seg, 1200)).toEqual([{ start: 1201, end: 1202, text: "hola", speaker: 0, label: "Tú" }]);
  });
  it("labels undiarized tab audio as «Otros participantes»", () => {
    expect(toUtterances("tab", seg, 0)[0]).toMatchObject({ speaker: 1, label: "Otros participantes" });
  });
  it("keeps diarized participants apart from you", () => {
    expect(toUtterances("tab", [{ ...seg[0], speaker: 1 }], 0)[0]).toMatchObject({ speaker: 2, label: "Participante 2" });
  });
  it("keeps legacy mixed recordings working", () => {
    expect(toUtterances("mix", [{ ...seg[0], speaker: 0 }], 0)[0]).toMatchObject({ speaker: 0, label: "Hablante 1" });
  });
});
