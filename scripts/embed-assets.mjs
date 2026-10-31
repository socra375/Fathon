// Incrusta el esquema SQL y los archivos de la extensión en un módulo TS para que estén
// disponibles en las funciones serverless sin depender del sistema de archivos.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const extDir = path.join(root, "extension");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = Object.fromEntries(
  walk(extDir)
    .sort()
    .map((f) => [path.relative(extDir, f).split(path.sep).join("/"), readFileSync(f).toString("base64")]),
);
const schemaSql = readFileSync(path.join(root, "db", "schema.sql"), "utf8");

mkdirSync(path.join(root, "lib", "generated"), { recursive: true });
writeFileSync(
  path.join(root, "lib", "generated", "assets.ts"),
  `// Archivo generado por scripts/embed-assets.mjs. No editar a mano.\n` +
    `export const SCHEMA_SQL: string = ${JSON.stringify(schemaSql)};\n` +
    `export const EXTENSION_FILES: Record<string, string> = ${JSON.stringify(files, null, 0)};\n`,
);
console.log(`embed-assets: ${Object.keys(files).length} archivos de la extensión + esquema SQL`);
