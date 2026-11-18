// The relay inbox's check on what a pass may change (accept.mjs), run against
// a throwaway repository: what a pass really writes passes, and anything a bad
// library might try instead is refused.
//
// Run: node method/relay/accept.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pileGrew, onlyRelaysSwapped } from "./accept.mjs";

let failures = 0;
const check = (what, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(70)} ${detail}`); };
const ACCEPT = fileURLToPath(new URL("./accept.mjs", import.meta.url));
const H = "ab".repeat(32);

const member = (n) => ({ n, address: `tb1q${n}`, signature: `s${n}`, signed: "2026-11-01" });
const lock = (n) => ({ address: `tb1qlock${n}`, owner_pubkey: "02aa", cosigner_pubkey: "03bb", locktime: 1900000000 + n });
const crowdlock = { name: "Test", relays: ["wss://a", "wss://b"], spare_relays: ["wss://c"], register: { registrations: "registrations.json", proposals: "proposals.json" } };
const pile = { format: "crowdlock-pile/1", proposal: H, commitments: [{ submitted: "2026-11-02T00:00:00Z", record: { tx: "00", proposal: H } }], completed: [{ txid: "t1", tx: "00" }] };

/** A fresh repository holding a small Crowdlock, committed. */
function repo() {
  const d = mkdtempSync(join(tmpdir(), "accept-"));
  const w = (p, v) => { mkdirSync(join(d, p, ".."), { recursive: true }); writeFileSync(join(d, p), typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n"); };
  w("crowdlocks/test.json", crowdlock);
  w("crowdlocks/index.json", { crowdlocks: ["test"] });
  w("registrations.json", { declaration: { statement: "x" }, members: [member(1)], locks: [lock(1)] });
  w(`commitments/${H}.json`, pile);
  w("method/relay/health.json", {});
  w("js/page.mjs", "export const x = 1;\n");
  const git = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
  git("init", "-q"); git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return { d, w, git };
}
/** Make a change, stage it as the workflow's `git apply --index` would, and run the check. */
function judge(change, { stage = true } = {}) {
  const r = repo();
  change(r);
  if (stage) r.git("add", "-A");
  const run = spawnSync("node", [ACCEPT], { cwd: r.d, encoding: "utf8", env: { ...process.env, REPO_ROOT: r.d, RELAY_DIR_ABS: join(r.d, "method/relay") } });
  rmSync(r.d, { recursive: true, force: true });
  return { ok: run.status === 0, out: (run.stdout + run.stderr).replace(/\s+/g, " ").trim() };
}

let v;
v = judge(({ w }) => w("registrations.json", { declaration: { statement: "x" }, members: [member(1), member(2)], locks: [lock(1), lock(2)] }));
check("A member and a lock added at the end of the register: taken", v.ok, v.out.slice(0, 60));
v = judge(({ w }) => w("registrations.json", { declaration: { statement: "x" }, members: [], locks: [lock(1)] }));
check("A member taken off the register: refused", !v.ok, v.out.slice(0, 60));
v = judge(({ w }) => w("registrations.json", { declaration: { statement: "changed" }, members: [member(1)], locks: [lock(1)] }));
check("The register's statement changed: refused", !v.ok);
v = judge(({ w }) => w("js/page.mjs", "export const x = 'evil';\n"));
check("The website's code changed: refused", !v.ok, v.out.slice(0, 60));
v = judge(({ w }) => w(".github/workflows/x.yml", "on: push\n"));
check("A workflow added: refused", !v.ok);
v = judge(({ w }) => w("crowdlocks/test.json", { ...crowdlock, relays: ["wss://a", "wss://c"], spare_relays: [] }));
check("A silent relay replaced by its spare: taken", v.ok, v.out.slice(0, 60));
v = judge(({ w }) => w("crowdlocks/test.json", { ...crowdlock, relays: ["wss://a", "wss://evil"] }));
check("A relay that was neither live nor spare: refused", !v.ok);
v = judge(({ w }) => w("crowdlocks/test.json", { ...crowdlock, cosigner_keys: ["02ee"] }));
check("A co-signer key slipped into the Crowdlock's file: refused", !v.ok);
v = judge(({ w }) => w(`commitments/${H}.json`, { ...pile, commitments: [...pile.commitments, { submitted: "2026-11-03T00:00:00Z", record: { tx: "01", proposal: H } }], completed: [{ ...pile.completed[0], sent: "2026-11-04T00:00:00Z" }] }));
check("A commitment added to a pile, and a payment marked sent: taken", v.ok, v.out.slice(0, 60));
v = judge(({ w }) => w(`commitments/${H}.json`, { ...pile, commitments: [] }));
check("A commitment taken out of a pile: refused", !v.ok);
v = judge(({ w }) => w(`commitments/${"cd".repeat(32)}.json`, { format: "crowdlock-pile/1", proposal: "cd".repeat(32), commitments: [] }));
check("A new pile for a new proposal: taken", v.ok, v.out.slice(0, 60));
v = judge(({ w }) => w("method/relay/health.json", { x: 1 }));
check("Relay health written: taken", v.ok);
v = judge(({ d }) => { rmSync(join(d, "method/relay/health.json")); });
check("A file removed: refused", !v.ok);
v = judge(({ d }) => { rmSync(join(d, "registrations.json")); symlinkSync("/etc/passwd", join(d, "registrations.json")); });
check("The register swapped for a link to another file: refused", !v.ok);
v = judge(({ w }) => w("js/page.mjs", "export const x = 'evil';\n"), { stage: false });
check("A change left outside the patch: refused", !v.ok);

// The pure checks, directly.
check("A pile whose failure notice changes is not growth", pileGrew({ ...pile, notice: { a: 1 } }, { ...pile, notice: { a: 2 } }, H).length > 0);
check("A completed payment that gains anything but `sent` is not growth", pileGrew(pile, { ...pile, completed: [{ ...pile.completed[0], tx: "ff" }] }, H).length > 0);
check("Only relays changed, and only from the spares: nothing else", onlyRelaysSwapped(crowdlock, { ...crowdlock, name: "Other" }).length > 0);

console.log("-".repeat(80));
console.log(failures === 0 ? "A pass may only add records and swap in spare relays; everything else is refused." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
