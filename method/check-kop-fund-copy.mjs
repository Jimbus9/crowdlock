// The Kop Fund's own repository carries a copy of this repository's reference
// code (the checking code its pages and relay inbox run). Nothing else keeps the
// two in step, so this does: it compares every copied file byte for byte and
// fails, naming the files, when they differ.
//
//   node method/check-kop-fund-copy.mjs ../the-kop-fund
//
// If it fails after you changed method/js/ or method/relay/, carry the change
// across to the fund's repository (same file, same content) and push there.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const other = process.argv[2];
if (!other || !existsSync(other)) { console.error("usage: node method/check-kop-fund-copy.mjs <path to the-kop-fund>"); process.exit(2); }

const PAIRS = [
  ...["append", "crowdlock", "inbox", "lockplan", "lockrecord", "proposals", "relayhealth", "release", "verify"].map((n) => [`js/${n}.mjs`, `js/${n}.mjs`]),
  ["relay/inbox.mjs", "relay/inbox.mjs"], ["relay/nostr.mjs", "relay/nostr.mjs"], ["relay/check.mjs", "relay/check.mjs"], ["relay/signed.mjs", "relay/signed.mjs"],
  ["relay/package.json", "relay/package.json"], ["relay/package-lock.json", "relay/package-lock.json"],
];
const walk = (d, base = "") => readdirSync(join(d, base)).flatMap((n) => {
  const rel = join(base, n);
  return statSync(join(d, rel)).isDirectory() ? walk(d, rel) : [rel];
});
for (const f of walk(join(here, "js/vendor"))) PAIRS.push([`js/vendor/${f}`, `js/vendor/${f}`]);

let bad = 0;
for (const [mine, theirs] of PAIRS) {
  const a = join(here, mine), b = join(other, theirs);
  if (!existsSync(b)) { console.log(`MISSING  ${theirs}`); bad++; continue; }
  if (!readFileSync(a).equals(readFileSync(b))) { console.log(`DIFFERS  ${theirs}   (method/${mine})`); bad++; }
}
console.log(bad === 0 ? `PASS  The Kop Fund's copy matches the reference code (${PAIRS.length} files)` : `\nFAIL  ${bad} file(s) differ. Carry the change across to Jimbus9/the-kop-fund.`);
process.exit(bad === 0 ? 0 : 1);
