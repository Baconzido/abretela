// Empacota o servidor próprio (server/, ROADMAP seção 6) num arquivo só, que o
// app embute (`src-tauri/src/selfhost/`) e sobe para a conta da pessoa pela API
// da Cloudflare. Roda antes do `vite` no dev e no build.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "server/src/index.ts")],
  outfile: resolve(root, "server/dist/worker.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  // o runtime da Cloudflare fornece este módulo
  external: ["cloudflare:workers"],
  legalComments: "none",
  logLevel: "warning",
});
console.log("Servidor empacotado em server/dist/worker.js");
