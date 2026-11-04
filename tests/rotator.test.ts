import { describe, expect, it } from "vitest";
import { Budget, RetryLater } from "@/lib/budget";
import {
  AllProvidersFailed,
  classifyHttpError,
  memoryStore,
  parseDuration,
  ProviderLimit,
  ProviderSkip,
  retryAfterMs,
  rotate,
} from "@/lib/rotator";

describe("parseDuration / retryAfterMs", () => {
  it("parses Groq-style durations", () => {
    expect(parseDuration("7.66s")).toBe(7660);
    expect(parseDuration("1m2.5s")).toBe(62500);
    expect(parseDuration("350ms")).toBe(350);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration(null)).toBe(0);
  });

  it("reads retry-after, reset headers, Gemini retryDelay and OpenRouter reset epochs", () => {
    expect(retryAfterMs({ "retry-after": "360" }, "")).toBe(360_000);
    expect(retryAfterMs({ "x-ratelimit-reset-tokens": "2m59.5s" }, "")).toBe(179_500);
    expect(retryAfterMs({}, '{"error":{"details":[{"retryDelay":"37s"}]}}')).toBe(37_000);
    expect(retryAfterMs({}, "Please retry in 12.5s.")).toBe(12_500);
    const now = 1_700_000_000_000;
    expect(retryAfterMs({}, `{"metadata":{"headers":{"X-RateLimit-Reset":"${now + 45_000}"}}}`, now)).toBe(45_000);
    expect(retryAfterMs({}, "nada")).toBe(0);
  });
});

describe("classifyHttpError", () => {
  it("pauses on 429 using the wait the provider asks for", () => {
    const e = classifyHttpError("groq", 429, { "retry-after": "360" }, "rate limit");
    expect(e).toBeInstanceOf(ProviderLimit);
    expect((e as ProviderLimit).retryAfterMs).toBe(360_000);
    expect((e as ProviderLimit).kind).toBe("rate");
  });

  it("treats a daily quota as a long pause", () => {
    const e = classifyHttpError("gemini", 429, {}, "You exceeded your current quota (per day)") as ProviderLimit;
    expect(e.kind).toBe("quota");
    expect(e.retryAfterMs).toBeGreaterThanOrEqual(3_600_000);
  });

  it("pauses on bad keys, no credit and server errors, skips on 413, and fails normally on 400", () => {
    expect((classifyHttpError("x", 401, {}, "") as ProviderLimit).kind).toBe("auth");
    expect((classifyHttpError("x", 402, {}, "") as ProviderLimit).kind).toBe("quota");
    expect((classifyHttpError("x", 503, {}, "") as ProviderLimit).kind).toBe("overload");
    expect(classifyHttpError("x", 413, {}, "")).toBeInstanceOf(ProviderSkip);
    const e = classifyHttpError("x", 400, {}, "mala petición");
    expect(e).not.toBeInstanceOf(ProviderLimit);
    expect(e.message).toContain("mala petición");
  });
});

describe("rotate", () => {
  const ok = (id: string, calls: string[]) => ({
    id,
    run: async () => {
      calls.push(id);
      return `resultado de ${id}`;
    },
  });
  const limited = (id: string, calls: string[], ms = 60_000) => ({
    id,
    run: async () => {
      calls.push(id);
      throw new ProviderLimit(`${id} sin cuota`, id, ms, "rate");
    },
  });

  it("uses the first provider when it works", async () => {
    const calls: string[] = [];
    const r = await rotate([ok("a", calls), ok("b", calls)], { namespace: "analysis", store: memoryStore() });
    expect(r.provider).toBe("a");
    expect(calls).toEqual(["a"]);
  });

  it("moves to the next provider when one hits its limit and remembers the pause", async () => {
    const calls: string[] = [];
    const store = memoryStore();
    let t = 1_000_000;
    const now = () => t;
    const r1 = await rotate([limited("a", calls, 600_000), ok("b", calls)], { namespace: "analysis", store, now });
    expect(r1.provider).toBe("b");
    expect((await store.all()).get("analysis:a")?.until).toBe(t + 600_000);

    // La siguiente reunión ni siquiera intenta «a».
    calls.length = 0;
    t += 1000;
    const r2 = await rotate([ok("a", calls), ok("b", calls)], { namespace: "analysis", store, now });
    expect(r2.provider).toBe("b");
    expect(calls).toEqual(["b"]);

    // Pasada la pausa, vuelve a usarse «a».
    calls.length = 0;
    t += 700_000;
    const r3 = await rotate([ok("a", calls), ok("b", calls)], { namespace: "analysis", store, now });
    expect(r3.provider).toBe("a");
  });

  it("keeps namespaces apart", async () => {
    const store = memoryStore({ "stt:groq": { until: Date.now() + 60_000, reason: "x" } });
    const calls: string[] = [];
    const r = await rotate([ok("groq", calls)], { namespace: "analysis", store });
    expect(r.provider).toBe("groq");
  });

  it("tries the next provider after a normal failure without pausing the first", async () => {
    const calls: string[] = [];
    const store = memoryStore();
    const bad = { id: "a", run: async () => Promise.reject(new Error("JSON no válido")) };
    const r = await rotate([bad, ok("b", calls)], { namespace: "analysis", store });
    expect(r.provider).toBe("b");
    expect((await store.all()).size).toBe(0);
  });

  it("throws RetryLater with the earliest end of pause when all are paused and it is too long to wait", async () => {
    const t = 5_000_000;
    const err = await rotate([limited("a", [], 3_600_000), limited("b", [], 900_000)], {
      namespace: "analysis",
      store: memoryStore(),
      now: () => t,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryLater);
    expect((err as RetryLater).at.getTime()).toBe(t + 900_000);
  });

  it("waits inside the invocation when the shortest pause fits the budget", async () => {
    let attempts = 0;
    const flaky = {
      id: "a",
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new ProviderLimit("rpm", "a", 50, "rate");
        return "ya";
      },
    };
    const r = await rotate([flaky], { namespace: "stt", store: memoryStore(), budget: Budget.fromNow(60_000) });
    expect(r.value).toBe("ya");
    expect(attempts).toBe(2);
  });

  it("fails clearly when nothing is configured or every provider fails for real", async () => {
    await expect(rotate([], { namespace: "x", store: memoryStore() })).rejects.toBeInstanceOf(AllProvidersFailed);
    const bad = (id: string) => ({ id, run: async () => Promise.reject(new Error(`${id} roto`)) });
    const err = await rotate([bad("a"), bad("b")], { namespace: "x", store: memoryStore() }).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailed);
    expect(err.message).toContain("a roto");
    expect(err.message).toContain("b roto");
  });
});
