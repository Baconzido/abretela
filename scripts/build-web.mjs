// Página de assistir pelo navegador (ROADMAP, seção 5) num arquivo só:
// `dist-web/watch.html`, com o JS, o CSS e as fontes dentro. Assim o servidor
// do túnel (Rust) e o servidor próprio (Worker) servem o mesmo arquivo, sem
// subir nada além do código. Roda antes do build do servidor e do app.
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist-web");

await build({
  root,
  configFile: false,
  logLevel: "warn",
  plugins: [svelte()],
  build: {
    outDir: out,
    emptyOutDir: true,
    // fontes e imagens viram data: dentro do CSS
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(root, "watch.html"),
      output: { codeSplitting: false },
    },
  },
});

let html = await readFile(join(out, "watch.html"), "utf8");
const assetsDir = join(out, "assets");
const read = (href) => readFile(join(out, href.replace(/^\//, "")), "utf8");

// troca <script src> e <link rel=stylesheet> pelo conteúdo
for (const m of [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const code = (await read(m[1])).replace(/<\/script/gi, "<\\/script");
  html = html.replace(m[0], () => `<script type="module">${code}</script>`);
}
for (const m of [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
  const css = await read(m[1]);
  html = html.replace(m[0], () => `<style>${css}</style>`);
}
if (/(src|href)="\/assets\//.test(html)) throw new Error("watch.html ainda aponta para /assets: algo não foi embutido");

await writeFile(join(out, "watch.html"), html);
await rm(assetsDir, { recursive: true, force: true });
console.log(`Página de assistir em dist-web/watch.html (${Math.round(html.length / 1024)} KB)`);
for (const f of await readdir(out)) if (f !== "watch.html") await rm(join(out, f), { recursive: true, force: true });
