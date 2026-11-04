import { beforeEach, describe, expect, it } from "vitest";
import { classifySmtpError, deliverReport, describeFailures, parseRecipients, validateRecipients, type SmtpLike } from "@/lib/mailer";
import { memoryStore, ProviderLimit } from "@/lib/rotator";

const msg = { subject: "Informe", html: "<p>hola</p>", text: "hola", attachments: [{ filename: "t.txt", content: "texto" }] };

const RESTRICTION = JSON.stringify({
  message: "You can only send testing emails to your own email address (propio@gmail.com). To send emails to other recipients, please verify a domain at resend.com/domains",
  name: "validation_error",
  statusCode: 403,
});

/** fetch falso de Resend: solo deja enviar a la cuenta propia, como hace sin dominio verificado. */
function resendFetch(sent: string[], own = "propio@gmail.com"): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const to = body.to[0] as string;
    if (to.toLowerCase() !== own) return new Response(RESTRICTION, { status: 403 });
    sent.push(to);
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  }) as typeof fetch;
}

function smtpStub(sent: string[], failFor: string[] = []): SmtpLike {
  return {
    async sendMail(o) {
      if (failFor.includes(o.to)) throw Object.assign(new Error("550 5.1.1 The email account does not exist"), { responseCode: 550 });
      sent.push(o.to);
      return { messageId: `<smtp-${sent.length}@x>` };
    },
  };
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "Minuta <onboarding@resend.dev>";
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.EMAIL_PROVIDERS;
});

describe("destinatarios", () => {
  it("separa por comas, saltos de línea, punto y coma y espacios, sin repetidos", () => {
    expect(parseRecipients("a@x.com, b@y.com\nA@X.COM;c@z.org  d@w.net")).toEqual(["a@x.com", "b@y.com", "c@z.org", "d@w.net"]);
    expect(parseRecipients("")).toEqual([]);
    expect(parseRecipients(null)).toEqual([]);
  });

  it("valida cantidad y formato", () => {
    expect(validateRecipients("a@x.com\nb@y.com")).toBeNull();
    expect(validateRecipients("")).toMatch(/al menos un correo/);
    expect(validateRecipients("a@x.com, no-es-correo")).toMatch(/no-es-correo/);
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(",");
    expect(validateRecipients(many)).toMatch(/Máximo 10/);
  });
});

describe("deliverReport", () => {
  it("envía a cada destinatario por separado con Resend", async () => {
    const sent: string[] = [];
    const r = await deliverReport(["propio@gmail.com"], msg, { fetchImpl: resendFetch(sent), store: memoryStore() });
    expect(r.failed).toEqual([]);
    expect(r.delivered).toEqual([{ to: "propio@gmail.com", via: "resend", id: "re_1" }]);
  });

  it("con Resend sin dominio, los demás destinatarios pasan a SMTP y todos reciben el informe", async () => {
    process.env.SMTP_USER = "yo@gmail.com";
    process.env.SMTP_PASS = "abcd efgh ijkl mnop";
    const viaResend: string[] = [];
    const viaSmtp: string[] = [];
    const r = await deliverReport(["propio@gmail.com", "otra@persona.com", "mas@gente.org"], msg, {
      fetchImpl: resendFetch(viaResend),
      smtp: smtpStub(viaSmtp),
      store: memoryStore(),
    });
    expect(r.failed).toEqual([]);
    expect(viaResend).toEqual(["propio@gmail.com"]);
    expect(viaSmtp).toEqual(["otra@persona.com", "mas@gente.org"]);
    expect(r.delivered.map((d) => d.via)).toEqual(["resend", "smtp", "smtp"]);
  });

  it("sin SMTP, indica quién no pudo recibirlo y por qué, y el resto sí llega", async () => {
    const sent: string[] = [];
    const r = await deliverReport(["propio@gmail.com", "otra@persona.com"], msg, { fetchImpl: resendFetch(sent), store: memoryStore() });
    expect(r.delivered.map((d) => d.to)).toEqual(["propio@gmail.com"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].to).toBe("otra@persona.com");
    expect(r.failed[0].error).toContain("propio@gmail.com");
    expect(describeFailures(r.failed)).toContain("otra@persona.com");
  });

  it("un rechazo de una dirección no impide enviar a las demás", async () => {
    process.env.SMTP_USER = "yo@gmail.com";
    process.env.SMTP_PASS = "x";
    process.env.EMAIL_PROVIDERS = "smtp";
    const sent: string[] = [];
    const r = await deliverReport(["mala@x.com", "buena@x.com"], msg, { smtp: smtpStub(sent, ["mala@x.com"]), store: memoryStore() });
    expect(r.delivered.map((d) => d.to)).toEqual(["buena@x.com"]);
    expect(r.failed.map((f) => f.to)).toEqual(["mala@x.com"]);
  });

  it("si Resend alcanza su límite diario, usa SMTP y recuerda la pausa", async () => {
    process.env.SMTP_USER = "yo@gmail.com";
    process.env.SMTP_PASS = "x";
    const store = memoryStore();
    const limited = (async () => new Response("daily limit exceeded", { status: 429 })) as unknown as typeof fetch;
    const sent: string[] = [];
    const r = await deliverReport(["a@x.com", "b@x.com"], msg, { fetchImpl: limited, smtp: smtpStub(sent), store });
    expect(r.delivered.map((d) => d.via)).toEqual(["smtp", "smtp"]);
    expect((await store.all()).has("email:resend")).toBe(true);
  });

  it("avisa claramente cuando no hay ningún servicio de correo", async () => {
    delete process.env.RESEND_API_KEY;
    const r = await deliverReport(["a@x.com"], msg, { store: memoryStore() });
    expect(r.delivered).toEqual([]);
    expect(r.failed[0].error).toMatch(/RESEND_API_KEY o SMTP_USER/);
  });
});

describe("classifySmtpError", () => {
  it("pausa el SMTP si la contraseña es incorrecta y orienta sobre Gmail", () => {
    const e = classifySmtpError(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }));
    expect(e).toBeInstanceOf(ProviderLimit);
    expect(e.message).toMatch(/contraseña de aplicación/);
  });
  it("pausa por el límite diario de Gmail y por caídas de red, pero no por una dirección inexistente", () => {
    expect(classifySmtpError(new Error("550 5.4.5 Daily user sending limit exceeded"))).toBeInstanceOf(ProviderLimit);
    expect(classifySmtpError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBeInstanceOf(ProviderLimit);
    expect(classifySmtpError(Object.assign(new Error("550 5.1.1 no such user"), { responseCode: 550 }))).not.toBeInstanceOf(ProviderLimit);
  });
});
