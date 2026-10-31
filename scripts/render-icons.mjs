// Genera los iconos PNG de la extensión a partir de public/logo.svg (usa el Chromium preinstalado).
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { readFileSync } from "node:fs";
const svg = readFileSync(new URL("../public/logo.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`../extension/icons/icon${size}.png`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
console.log("icons ok");
