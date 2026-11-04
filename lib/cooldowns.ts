import { q } from "./db";
import type { Cooldown, CooldownStore } from "./rotator";

/** Pausas de proveedores guardadas en Postgres: valen para todas las reuniones y todas las invocaciones. */
export const dbCooldowns: CooldownStore = {
  async all() {
    const rows = await q<{ provider: string; blocked_until: Date; reason: string }>(
      "SELECT provider, blocked_until, reason FROM provider_state WHERE blocked_until > now()",
    );
    return new Map<string, Cooldown>(rows.map((r) => [r.provider, { until: new Date(r.blocked_until).getTime(), reason: r.reason }]));
  },
  async set(key, until, reason) {
    await q(
      `INSERT INTO provider_state (provider, blocked_until, reason, updated_at)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, now())
       ON CONFLICT (provider) DO UPDATE
         SET blocked_until = EXCLUDED.blocked_until, reason = EXCLUDED.reason, updated_at = now()`,
      [key, until, reason],
    );
  },
  async clear(key) {
    await q("DELETE FROM provider_state WHERE provider = $1", [key]);
  },
};
