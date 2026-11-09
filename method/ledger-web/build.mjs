// Builds the Lock page's Ledger bundle into the Kop Fund's repository.
//
//   cd method/ledger-web && npm ci && node build.mjs <path to the-kop-fund>
//
// Output: <the-kop-fund>/js/vendor/crowdlock-ledger-web.bundle.js (+ a sha256 line).
// The source of record is this folder plus app/src/wallet/core.mjs and
// app/src/ledgerLink.mjs; the bundle is a build product, like the vendored
// nostr-tools one, and is committed so the site needs no build step.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] ?? resolve(here, "../../../the-kop-fund"));
const out = resolve(target, "js/vendor/crowdlock-ledger-web.bundle.js");
mkdirSync(dirname(out), { recursive: true });

// The Device Management Kit is pinned here to the app's version (1.11.0), so
// the transport and the kit are the ones proved on the phone. Everything else
// (the Bitcoin library, the key module's own dependencies) comes from the app.
const app = resolve(here, "../../app/node_modules");

await build({
  entryPoints: [resolve(here, "entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "CrowdlockLedger",
  platform: "browser",
  target: "es2022",
  minify: false,
  legalComments: "inline",
  outfile: out,
  nodePaths: [app, resolve(here, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  inject: [resolve(here, "shim.mjs")],
  logLevel: "info",
});

const sum = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync(out.replace(/\.js$/, ".sha256"), `${sum}  crowdlock-ledger-web.bundle.js\n`);
console.log("sha256", sum);
