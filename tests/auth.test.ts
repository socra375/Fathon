import { beforeEach, describe, expect, it } from "vitest";
import { checkApiKey, checkPassword, createSessionToken, verifySessionToken } from "@/lib/auth";

describe("auth", () => {
  beforeEach(() => {
    process.env.MINUTA_API_KEY = "k".repeat(40);
    process.env.DASHBOARD_PASSWORD = "secreta";
  });

  it("validates bearer key", () => {
    const ok = new Request("http://x", { headers: { Authorization: `Bearer ${"k".repeat(40)}` } });
    const bad = new Request("http://x", { headers: { Authorization: "Bearer nope" } });
    expect(checkApiKey(ok)).toBe(true);
    expect(checkApiKey(bad)).toBe(false);
    expect(checkApiKey(new Request("http://x"))).toBe(false);
  });

  it("session tokens sign, expire and break when the key rotates", () => {
    const now = Date.now();
    const t = createSessionToken(now);
    expect(verifySessionToken(t, now)).toBe(true);
    expect(verifySessionToken(t, now + 31 * 86_400_000)).toBe(false);
    expect(verifySessionToken(t.replace(/.$/, "x"), now)).toBe(false);
    process.env.MINUTA_API_KEY = "otra-clave-diferente-0000000000000000000";
    expect(verifySessionToken(t, now)).toBe(false);
  });

  it("checks the dashboard password", () => {
    expect(checkPassword("secreta")).toBe(true);
    expect(checkPassword("Secreta")).toBe(false);
  });
});
