// Packs the files every founder's Crowdlock repository needs into one JSON
// file the app carries (src/template.mjs): the relay inbox and the exact
// checking code it runs, copied from this repository. The app writes them into
// the founder's own repository when they start a Crowdlock, so a new
// Crowdlock depends on nothing of ours afterwards.
//
//   node scripts/make-template.mjs          write src/template.mjs
//   node scripts/make-template.mjs --check  fail if it is out of date
//
// The tests run --check, so the copy the app carries can never drift from the
// code The Kop Fund itself runs.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(APP, "..");

// The inbox version this app writes, and what each version changed. A
// Crowdlock's site publishes its version in relay/VERSION; the app offers its
// founder and maintainers an update when theirs is older. Add a line here
// whenever the template changes, newest last.
export const TEMPLATE_VERSION = "2026-11-17c";
export const CHANGES = [
  { version: "2026-10-31", change: "Collects registrations and locks from the relays every two minutes, and keeps itself running" },
  { version: "2026-11-01", change: "Announces the Crowdlock weekly so people can find it, and replaces a relay that has been silent for 7 days" },
  { version: "2026-11-02", change: "Removes The Kop Fund's name from the code copied into your Crowdlock. No change to how it works" },
  { version: "2026-11-02b", change: "Moves the inbox code into the repository's new layout. No change to how it works in your Crowdlock" },
  { version: "2026-11-02c", change: "A relay connection that fails after it is finished with no longer stops a pass part-way" },
  { version: "2026-11-02d", change: "Counts a relay's silence from the day it last answered, so a relay that is mostly down is replaced, and records its health at most once a day" },
  { version: "2026-11-03", change: "Accepts co-signer xpubs in the Crowdlock file, so members with a hardware wallet can lock. No change to how anything else works" },
  { version: "2026-11-09", change: "Stops a relay that fails to connect from flooding the job's log with errors, and stops a slow relay being counted as failing after it has been given up on. No change to what is collected" },
  { version: "2026-11-10", change: "Accepts a destination waiting period of 7 days or more on real bitcoin (it was 14), and none on a test copy. Nothing about your Crowdlock changes unless you edit its file" },
  { version: "2026-11-10b", change: "Accepts a Crowdlock file that names a proposals file. No change to how anything works until proposals are published" },
  { version: "2026-11-10c", change: "The destination waiting period is your own choice again, with seven days recommended, rather than a rule of the method" },
  { version: "2026-11-11", change: "Collects commitments to your proposals from the relays into a lasting record in your repository (commitments/), in the order they arrived. Nothing changes until you publish a proposal" },
  { version: "2026-11-11b", change: "Records what your co-signer does: completed payments, published so anyone can send them, and sent a few at a time; and the co-signer's signed notice when a proposal fails" },
  { version: "2026-11-14", change: "Leaves a small sign of life (alive.json on a branch of its own, inbox-alive) about every ten minutes, so anyone can see the inbox is running without signing in to GitHub. No change to what is collected" },
  { version: "2026-11-15", change: "Ready for a new version of your declaration: accepts later versions listed in your Crowdlock file, records members who sign one (keeping their number), and only takes a commitment from a member who signed the version its proposal was published under. Nothing changes until you publish a new version" },
  { version: "2026-11-15b", change: "Turns your repository's Actions red, and emails whoever pushed, when your Crowdlock file or a version of its declaration doesn't check out; and fails the inbox's run instead of quietly skipping your Crowdlock if that ever happens. No change to what is collected" },
  { version: "2026-11-16", change: "Reads each relay further back, a batch at a time, so nobody can push real registrations and locks out of sight by posting junk under your Crowdlock's fingerprint. No change to what is accepted" },
  { version: "2026-11-17", change: "Three fixes to how proposals are handled. Completed payments are now really sent by your repository (it used to mark them sent without sending). A commitment is only taken if its lock's owner signed it, so nobody can use up a member's five places with junk. A completed payment is only recorded if owner and co-signer both signed it, so a fake cannot block the real one" },
  { version: "2026-11-17b", change: "Commitments now name their proposal inside the payment itself, so one can never be counted for a proposal its owner did not choose; your inbox turns away any that do not. Your destinations list is checked against your Crowdlock file: its attestors must be the ones that file names (attestor_keys), and every entry must carry your Crowdlock's fingerprint. Update the app too: commitments made by an older app are no longer accepted" },
  { version: "2026-11-17c", change: "A destination's waiting period now counts from a stamp on the bitcoin chain, made by the app when the destination is added, not from a date written in your destinations list. A destination added before this has no stamp and can't be paid: add it again from the app. No change to how your inbox runs" },
];

const FROM_REPO = [
  "method/js/inbox.mjs", "method/js/append.mjs", "method/js/lockrecord.mjs", "method/js/verify.mjs", "method/js/crowdlock.mjs", "method/js/relayhealth.mjs", "method/js/proposals.mjs",
  "method/js/vendor/noble-secp256k1.js",
  "method/js/vendor/noble-hashes/_assert.js", "method/js/vendor/noble-hashes/_md.js", "method/js/vendor/noble-hashes/crypto.js",
  "method/js/vendor/noble-hashes/ripemd160.js", "method/js/vendor/noble-hashes/sha256.js", "method/js/vendor/noble-hashes/utils.js",
  "method/relay/inbox.mjs", "method/relay/check.mjs", "method/relay/nostr.mjs", "method/relay/signed.mjs", "method/relay/package.json", "method/relay/package-lock.json",
  "LICENSE",
];

// Founders' repositories keep the old layout (js/, relay/ at the top), so the
// source's method/ prefix is dropped when packing. The keys below are what a
// founder's repository receives.
const founderPath = (p) => p.replace(/^method\//, "");
const files = {};
for (const p of FROM_REPO) files[founderPath(p)] = readFileSync(join(REPO, p), "utf8");
files[".github/workflows/relay-inbox.yml"] = readFileSync(join(APP, "template/relay-inbox.yml"), "utf8");
files[".github/workflows/check-crowdlock.yml"] = readFileSync(join(APP, "template/check-crowdlock.yml"), "utf8");
// GitHub Pages would otherwise refuse to publish the vendored files whose
// names begin with an underscore (_md.js, _assert.js) — the bug that broke
// The Kop Fund's site for a week.
files[".nojekyll"] = "";
files[".gitignore"] = "node_modules/\nrelay/.message\nrelay/.broken\n";
files["relay/VERSION"] = TEMPLATE_VERSION + "\n";

const out = "// Generated by scripts/make-template.mjs from the Crowdlock method's reference code. Do not edit.\nexport default " + JSON.stringify({ version: TEMPLATE_VERSION, changes: CHANGES, files }) + ";\n";
const target = join(APP, "src/template.mjs");
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch {}
  if (current !== out) { console.log("src/template.mjs is out of date — run: node scripts/make-template.mjs"); process.exit(1); }
  console.log("The app's Crowdlock template matches the Crowdlock method's reference code.");
} else {
  writeFileSync(target, out);
  console.log(`Wrote src/template.mjs: ${Object.keys(files).length} files, ${out.length} bytes.`);
}
