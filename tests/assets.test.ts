import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXTENSION_FILES, SCHEMA_SQL } from "@/lib/generated/assets";

describe("embedded assets", () => {
  it("schema matches db/schema.sql", () => {
    expect(SCHEMA_SQL).toBe(readFileSync("db/schema.sql", "utf8"));
  });
  it("extension bundle has the required files", () => {
    for (const f of ["manifest.json", "background.js", "content.js", "config.js", "popup.html", "popup.js", "icons/icon128.png"]) {
      expect(EXTENSION_FILES[f], f).toBeTruthy();
    }
    const manifest = JSON.parse(Buffer.from(EXTENSION_FILES["manifest.json"], "base64").toString());
    expect(manifest.manifest_version).toBe(3);
  });
});
