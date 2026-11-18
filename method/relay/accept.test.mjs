// The relay inbox's check on what a pass may change (accept.mjs), run against
// a throwaway repository: what a pass really writes passes, and anything a bad
// library might try instead is refused.
//
// Run: node method/relay/accept.test.mjs

import { execFileSync, spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pileGrew, onlyRelaysSwapped, txidOfHex } from "./accept.mjs";

let failures = 0;
const check = (what, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(70)} ${detail}`); };
const ACCEPT = fileURLToPath(new URL("./accept.mjs", import.meta.url));
const H = "ab".repeat(32);

const member = (n) => ({ n, address: `tb1q${n}`, signature: `s${n}`, signed: "2026-11-01" });
const lock = (n) => ({ address: `tb1qlock${n}`, owner_pubkey: "02aa", cosigner_pubkey: "03bb", locktime: 1900000000 + n });
// Real test-chain transactions: a commitment as its owner signed it, the same
// payment completed by the co-signer, and another proposal's completed payment.
const T0 = "02000000000101e708d6055b1dd9d507e22486925ca15d0fb6bad11a4a9597094d3ee334c197490000000000fdffffff014eab010000000000160014d4452e16e162417e1f6eab867480077bc4b2c89804000047304402204f7db5f02be6ef31851272e55583caa9ab317221104f70db410776439bb73642022047fa170c1f90592254fb6fec00fe0b62968048ef50f560abccf0cda4fb2e64b3014f2103f6772b0b5bd170a3e87674e9996cb974fedcc9711659c374b0141598a4ebe7cdad63040099fb6ab16721022d292cdd06b930b79f74167f14727645aa06c439323e6e4c00070524b9a80341ac6800000000";
const C0 = { txid: "f75b2fbfc290bb9f6924a2410545adc18c453d6da05f04b942c44423c26a4e0d", tx: "02000000000101e708d6055b1dd9d507e22486925ca15d0fb6bad11a4a9597094d3ee334c197490000000000fdffffff014eab010000000000160014d4452e16e162417e1f6eab867480077bc4b2c8980447304402200427cca98ccd957ad5fa77cb5fad5f081fdbf0685720776d96f6e3c3637b4e590220670b56327756e9033c4a9058e5fc36d99aa27634285623522fcedd6e6cc4d726010047304402204f7db5f02be6ef31851272e55583caa9ab317221104f70db410776439bb73642022047fa170c1f90592254fb6fec00fe0b62968048ef50f560abccf0cda4fb2e64b3014f2103f6772b0b5bd170a3e87674e9996cb974fedcc9711659c374b0141598a4ebe7cdad63040099fb6ab16721022d292cdd06b930b79f74167f14727645aa06c439323e6e4c00070524b9a80341ac6800000000" };
const C1 = { txid: "cafc871c68a54b2a1cf3c6db97542281a80af83fd9a24faf3b5c7cbe1b3e3200", tx: "020000000001017abb11237dcb4163c15a5d6175cf0013350610ab4f5845d2e3603647c0899d7d0000000000fdffffff014eab010000000000160014d4452e16e162417e1f6eab867480077bc4b2c89804483045022100d97a05770e45887719642d68e801bd11969c302ab0e3daaa791aa13f0fdd085d022079fcc2786a32e902542c938fd1cdd5e505a744732a83ecc5d3c2e2e2a447299e0100483045022100ea0045cb97f343d3c04681835fd0a7e68afb8a6d4602d7ebc906841b8651edc5022030d65f0cded9da8c42894747e47df22a0b25f39fd2b781b0538e69bc947edd40014f2103f6772b0b5bd170a3e87674e9996cb974fedcc9711659c374b0141598a4ebe7cdad63048047fa6ab16721022d292cdd06b930b79f74167f14727645aa06c439323e6e4c00070524b9a80341ac6800000000" };
// The stand-in block explorer answers for C0 only.
const explorer = createServer((req, res) => { res.statusCode = req.url === `/tx/${C0.txid}/status` ? 200 : 404; res.end("{}"); });
await new Promise((ok) => explorer.listen(0, "127.0.0.1", ok));
const crowdlock = { name: "Test", relays: ["wss://a", "wss://b"], spare_relays: ["wss://c", "wss://d"], chain_api: `http://127.0.0.1:${explorer.address().port}`, register: { registrations: "registrations.json", proposals: "proposals.json" } };
const pile = { format: "crowdlock-pile/1", proposal: H, commitments: [{ submitted: "2026-11-02T00:00:00Z", record: { tx: T0, proposal: H } }], completed: [] };

/** A fresh repository holding a small Crowdlock, committed. */
function repo() {
  const d = mkdtempSync(join(tmpdir(), "accept-"));
  const w = (p, v) => { mkdirSync(join(d, p, ".."), { recursive: true }); writeFileSync(join(d, p), typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n"); };
  w("crowdlocks/test.json", crowdlock);
  w("crowdlocks/index.json", { crowdlocks: ["test"] });
  w("registrations.json", { declaration: { statement: "x" }, members: [member(1)], locks: [lock(1)] });
  w(`commitments/${H}.json`, pile);
  w("proposals.json", { proposals: [{ hash: H }, { hash: "cd".repeat(32) }] });
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
  // Run alongside this process, so the stand-in explorer can answer it.
  return new Promise((ok) => {
    const run = spawn("node", [ACCEPT], { cwd: r.d, env: { ...process.env, REPO_ROOT: r.d, RELAY_DIR_ABS: join(r.d, "method/relay") } });
    let out = "";
    run.stdout.on("data", (x) => { out += x; }); run.stderr.on("data", (x) => { out += x; });
    run.on("close", (status) => { rmSync(r.d, { recursive: true, force: true }); ok({ ok: status === 0, out: out.replace(/\s+/g, " ").trim() }); });
  });
}

let v;
v = await judge(({ w }) => w("registrations.json", { declaration: { statement: "x" }, members: [member(1), member(2)], locks: [lock(1), lock(2)] }));
check("A member and a lock added at the end of the register: taken", v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w("registrations.json", { declaration: { statement: "x" }, members: [], locks: [lock(1)] }));
check("A member taken off the register: refused", !v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w("registrations.json", { declaration: { statement: "changed" }, members: [member(1)], locks: [lock(1)] }));
check("The register's statement changed: refused", !v.ok);
v = await judge(({ w }) => w("js/page.mjs", "export const x = 'evil';\n"));
check("The website's code changed: refused", !v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w(".github/workflows/x.yml", "on: push\n"));
check("A workflow added: refused", !v.ok);
v = await judge(({ w }) => w("crowdlocks/test.json", { ...crowdlock, relays: ["wss://a", "wss://c"], spare_relays: ["wss://d"] }));
check("A silent relay replaced by its spare: taken", v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w("crowdlocks/test.json", { ...crowdlock, relays: ["wss://a", "wss://evil"] }));
check("A relay that was neither live nor spare: refused", !v.ok);
v = await judge(({ w }) => w("crowdlocks/test.json", { ...crowdlock, cosigner_keys: ["02ee"] }));
check("A co-signer key slipped into the Crowdlock's file: refused", !v.ok);
v = await judge(({ w }) => w(`commitments/${H}.json`, { ...pile, commitments: [...pile.commitments, { submitted: "2026-11-03T00:00:00Z", record: { tx: "01", proposal: H } }], completed: [{ ...C0, sent: "2026-11-04T00:00:00Z" }] }));
check("A commitment added, and its completed payment marked sent: taken", v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w(`commitments/${H}.json`, { ...pile, completed: [{ ...C0, tx: "01" + C0.tx.slice(2) }] }));
check("A completed payment that isn't the commitment's transaction: refused", !v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w(`commitments/${H}.json`, { ...pile, completed: [C1] }));
check("A completed payment for no commitment in the pile: refused", !v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w(`commitments/${H}.json`, { ...pile, completed: [{ txid: "t1", tx: "00" }] }));
check("A made-up completed payment: refused", !v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w(`commitments/${H}.json`, { ...pile, commitments: [...pile.commitments, { submitted: "2026-11-03T00:00:00Z", record: { tx: C1.tx, proposal: H } }], completed: [{ ...C1, sent: "2026-11-04T00:00:00Z" }] }));
check("A payment marked sent that the explorer doesn't know: refused", !v.ok, v.out.slice(0, 80));
v = await judge(({ w }) => w(`commitments/${H}.json`, { ...pile, commitments: [] }));
check("A commitment taken out of a pile: refused", !v.ok);
v = await judge(({ w }) => w(`commitments/${"cd".repeat(32)}.json`, { format: "crowdlock-pile/1", proposal: "cd".repeat(32), commitments: [] }));
check("A new pile for a published proposal: taken", v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w(`commitments/${"ef".repeat(32)}.json`, { format: "crowdlock-pile/1", proposal: "ef".repeat(32), commitments: [] }));
check("A new pile for a proposal that isn't published: refused", !v.ok, v.out.slice(0, 60));
v = await judge(({ w }) => w("method/relay/health.json", { x: 1 }));
check("Relay health written: taken", v.ok);
v = await judge(({ d }) => { rmSync(join(d, "method/relay/health.json")); });
check("A file removed: refused", !v.ok);
v = await judge(({ d }) => { rmSync(join(d, "registrations.json")); symlinkSync("/etc/passwd", join(d, "registrations.json")); });
check("The register swapped for a link to another file: refused", !v.ok);
v = await judge(({ w }) => w("js/page.mjs", "export const x = 'evil';\n"), { stage: false });
check("A change left outside the patch: refused", !v.ok);

// The pure checks, directly.
check("A pile whose failure notice changes is not growth", pileGrew({ ...pile, notice: { a: 1 } }, { ...pile, notice: { a: 2 } }, H).length > 0);
check("A completed payment that gains anything but `sent` is not growth", pileGrew(pile, { ...pile, completed: [{ ...pile.completed[0], tx: "ff" }] }, H).length > 0);
check("Only relays changed, and only from the spares: nothing else", onlyRelaysSwapped(crowdlock, { ...crowdlock, name: "Other" }).length > 0);
check("Every relay removed is not a swap", onlyRelaysSwapped(crowdlock, { ...crowdlock, relays: [], spare_relays: [] }).length > 0);
check("A relay dropped, the list shorter, is not a swap", onlyRelaysSwapped(crowdlock, { ...crowdlock, relays: ["wss://a"] }).length > 0);
check("The spares turned into a string are not a swap", onlyRelaysSwapped(crowdlock, { ...crowdlock, spare_relays: "wss://c" }).length > 0);
check("A spare promoted out of turn is not a swap", onlyRelaysSwapped(crowdlock, { ...crowdlock, relays: ["wss://a", "wss://d"], spare_relays: ["wss://c"] }).length > 0);
check("A promoted spare also kept as a spare is not a swap", onlyRelaysSwapped(crowdlock, { ...crowdlock, relays: ["wss://a", "wss://c"] }).length > 0);
check("Two relays swapped for the next two spares is a swap", onlyRelaysSwapped(crowdlock, { ...crowdlock, relays: ["wss://c", "wss://d"], spare_relays: [] }).length === 0);
check("A txid is worked out from its transaction, witness left out", txidOfHex(C0.tx) === C0.txid && txidOfHex(T0) === C0.txid && txidOfHex("00") === null);

console.log("-".repeat(80));
console.log(failures === 0 ? "A pass may only add records and swap in spare relays; everything else is refused." : `${failures} check(s) failed.`);
explorer.close();
process.exit(failures === 0 ? 0 : 1);
