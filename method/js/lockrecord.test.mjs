// What the lock endpoint will accept and refuse.
//
// Run:  node method/js/lockrecord.test.mjs      (needs `npm install` in method/lock/ once,
//                                         for the cross-check against bitcoinjs)
//
// Two halves.
//
// First, the address. method/js/lockrecord.mjs rebuilds a lock address with a few
// lines of its own, because the endpoint cannot carry bitcoinjs. That is only
// acceptable if it produces exactly the bytes the proven lock code does — the
// code whose locks Bitcoin itself enforced on testnet4. So every script and
// address here is compared against method/lock/lock.mjs, across networks and across
// locktimes chosen to hit the awkward encodings.
//
// Second, the judgement — mostly refusals, because that is where the value is.
// A lock endpoint that accepted the wrong thing would put money in the headline
// figure that is not really locked, or not really a member's.

import * as proven from "../lock/lock.mjs";
import { lockScript, lockAddress, hrpFor, prepareLock, addLock, lockIsGenuine } from "./lockrecord.mjs";
import { memberAddressForOwnerKey } from "./verify.mjs";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(64)} ${detail}`);
};
const rule = () => console.log("-".repeat(78));
const hex = (b) => Buffer.from(b).toString("hex");

// Fixed keys, so the run is repeatable.
const key = (seed) => hex(proven.ECPair.fromPrivateKey(Buffer.alloc(32, seed)).publicKey);
const OWNER = key(1);
const COSIGNER = key(2);
const STRANGER = key(3);
const mirror = (k) => (k.startsWith("02") ? "03" : "02") + k.slice(2);

// ---------------------------------------------------------------------------
rule();
console.log("THE ADDRESS MATCHES THE PROVEN LOCK CODE, BYTE FOR BYTE");
rule();

const NOW = 1793000000; // late October 2026
const locktimes = [
  ["one year from now", NOW + 31557600],
  ["five years from now", NOW + 5 * 31557600],
  ["a date needing a padding byte (high bit set)", 2200000000],
  ["the largest locktime there is", 4294967295],
  ["a small block height (regtest)", 150],
  ["a height with the high bit set (128)", 128],
];
for (const [label, t] of locktimes) {
  const ours = hex(lockScript({ ownerPubkey: OWNER, cosignerPubkey: COSIGNER, locktime: t }));
  const theirs = hex(proven.lockScript({
    fanPubkey: Buffer.from(OWNER, "hex"), cosignerPubkey: Buffer.from(COSIGNER, "hex"), locktime: t,
  }));
  check(`Script: ${label}`, ours === theirs, ours === theirs ? `${ours.length / 2} bytes` : "DIFFERENT");
}

for (const net of ["mainnet", "testnet4"]) {
  const t = NOW + 3 * 31557600;
  const ours = lockAddress({ ownerPubkey: OWNER, cosignerPubkey: COSIGNER, locktime: t }, hrpFor(net));
  const theirs = proven.lockAddress({
    fanPubkey: Buffer.from(OWNER, "hex"), cosignerPubkey: Buffer.from(COSIGNER, "hex"),
    locktime: t, network: proven.networkFor(net),
  }).address;
  check(`Address on ${net}`, ours === theirs, ours.slice(0, 18) + "…");
}

const typical = lockScript({ ownerPubkey: OWNER, cosignerPubkey: COSIGNER, locktime: NOW + 31557600 });
check("A dated lock's script is the 79 bytes the spec gives", typical.length === 79, `${typical.length}`);

// ---------------------------------------------------------------------------
rule();
console.log("WHAT THE ENDPOINT ACCEPTS");
rule();

const kop = JSON.parse(readFileSync(new URL("../fixtures/the-kop-fund/crowdlocks/kop-fund.json", import.meta.url), "utf8"));
const crowdlock = { ...kop, cosigner_keys: [COSIGNER] };
const member = memberAddressForOwnerKey(OWNER, "bc");
const register = {
  declaration: { sha256: kop.declaration.sha256 },
  members: [{ n: 1, address: member, signature: "x", signed: "2026-10-27" }],
  locks: [],
};
const frozen = JSON.stringify(register);
const good = { owner_pubkey: OWNER, cosigner_pubkey: COSIGNER, locktime: NOW + 31557600 };
const ctx = { crowdlock, register, now: NOW };

const p = prepareLock(good, ctx);
check("A genuine, member-owned lock is prepared", p.ok, p.ok ? p.lock.address.slice(0, 18) + "…" : p.reason);
check("…its member is the address the owner key hashes to", p.ok && p.lock.member === member);
check("…its unlock date is shown as a calendar date", p.ok && /^\d{4}-\d{2}-\d{2}$/.test(p.lock.unlocks), p.lock?.unlocks);

const added = p.ok && addLock(register, p.lock, { confirmedSats: 250000, today: "2026-10-27" });
check("With confirmed coins at the address, it joins the register", added.ok);
check("…as a record carrying the terms anyone can rebuild it from",
  added.ok && ["address", "member", "owner_pubkey", "cosigner_pubkey", "locktime", "unlocks", "submitted"]
    .every((k) => k in added.register.locks[0]));
check("…and the register passed in is untouched", JSON.stringify(register) === frozen);

const small = p.ok && addLock(register, p.lock, { confirmedSats: 1000, today: "2026-10-27" });
check("A lock below the minimum is still published (the counting rule decides)", small.ok);

const withAddr = prepareLock({ ...good, address: p.lock.address.toUpperCase() }, ctx);
check("Sending the address too is fine, in either case", withAddr.ok);

// ---------------------------------------------------------------------------
rule();
console.log("WHAT THE ENDPOINT REFUSES");
rule();

const refuses = (what, result, expect) => {
  const ok = !result.ok && String(result.reason).includes(expect);
  check(what, ok, result.ok ? "ACCEPTED IT" : result.reason.slice(0, 44));
};

// A Crowdlock refuses every lock until it publishes a co-signer key, because
// a lock names one and there is nothing yet to name. This used to read The
// Kop Fund's own file, which had an empty list — so the day James published
// his key, 2 November, a correct change turned the suite red. A test of a
// behaviour should not depend on live data that is expected to change.
refuses("A Crowdlock that has published no co-signer key yet",
  prepareLock(good, { ...ctx, crowdlock: { ...kop, cosigner_keys: [] } }), "not published a co-signer key");
refuses("A co-signer key that is not this Crowdlock's",
  prepareLock({ ...good, cosigner_pubkey: STRANGER }, ctx), "not this Crowdlock's");
refuses("Owner and co-signer the same key",
  prepareLock({ ...good, owner_pubkey: COSIGNER }, ctx), "same key");
refuses("…or a key and its mirror",
  prepareLock({ ...good, owner_pubkey: mirror(COSIGNER) }, ctx), "same key");
refuses("A block height on a real network",
  prepareLock({ ...good, locktime: 900000 }, ctx), "must be a date");
refuses("A date already passed",
  prepareLock({ ...good, locktime: NOW - 1 }, ctx), "already passed");
refuses("A lock longer than the longest offered",
  prepareLock({ ...good, locktime: NOW + 6 * 31557600 }, ctx), "longer than this Crowdlock offers");
refuses("An owner who has not signed the declaration",
  prepareLock({ ...good, owner_pubkey: STRANGER }, { ...ctx, crowdlock: { ...crowdlock, cosigner_keys: [COSIGNER] } }),
  "not on the register");
refuses("An address that does not rebuild from the terms",
  prepareLock({ ...good, address: "bc1qwqdg6squsna38e46795at95yu9atm8azzmyvckulcc7kytlcckxswvvzej" }, ctx),
  "those terms make the address");
refuses("A lock already on the register",
  prepareLock(good, { ...ctx, register: added.register }), "already on the register");
refuses("No confirmed coins at the address yet",
  addLock(register, p.lock, { confirmedSats: 0, today: "2026-10-27" }), "no confirmed coins");
refuses("An uncompressed or malformed owner key",
  prepareLock({ ...good, owner_pubkey: "04" + "ab".repeat(64) }, ctx), "owner_pubkey must be");
refuses("A megabyte where a key should be",
  prepareLock({ ...good, cosigner_pubkey: "a".repeat(1e6) }, ctx), "cosigner_pubkey must be");
refuses("A locktime that is not a whole number",
  prepareLock({ ...good, locktime: "soon" }, ctx), "whole number");
refuses("A register file of the wrong shape",
  prepareLock(good, { ...ctx, register: { locks: [] } }), "not in the expected shape");

// ---------------------------------------------------------------------------
rule();
console.log("WHAT A READER BELIEVES OF A REGISTER (found by review, 17 November 2026)");
rule();
{
  // The lock the endpoint itself would publish is believed…
  const onRegister = added.register;
  const record = onRegister.locks[0];
  const read = { crowdlock, register: onRegister };
  check("A lock the endpoint published is a genuine one to a reader", lockIsGenuine(record, read).ok, lockIsGenuine(record, read).reason);
  // …and nothing else is, whatever the file says.
  const not = (what, lock, ctx2 = read, expect = "") => {
    const r = lockIsGenuine(lock, ctx2);
    check(`Not counted: ${what}`, !r.ok && r.reason.includes(expect), r.ok ? "WAS BELIEVED" : r.reason);
  };
  not("an ordinary address a register calls a lock", { ...record, address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kwmyzaz" }, read, "not the lock its terms make");
  not("a lock whose date was edited after the fact", { ...record, locktime: record.locktime + 1 }, read, "not the lock its terms make");
  not("a lock co-signed by a key that is not this Crowdlock's", (() => {
    const other = "03" + "5a".repeat(32);
    return { ...record, cosigner_pubkey: other, address: lockAddress({ ownerPubkey: OWNER, cosignerPubkey: other, locktime: record.locktime }, "bc") };
  })(), read, "co-signer is not this Crowdlock's");
  // A real lock stays a real lock whoever the record says owns it: the
  // counting rule counts its money. Its owner is worked out from its key.
  const relabelled = lockIsGenuine({ ...record, member: "bc1qsomebodyelse" }, read);
  check("A real lock credited to somebody else is still a lock, and its owner is still the key's own address",
    relabelled.ok && relabelled.owner === member && relabelled.member === true);
  const stranger = lockIsGenuine(record, { crowdlock, register: { ...onRegister, members: [] } });
  check("A real lock whose owner never joined is a lock, and its owner is not counted as a member", stranger.ok && stranger.member === false);
  not("a record with no keys", { address: record.address, member: record.member, locktime: record.locktime }, read, "not public keys");
  not("a lock whose owner and co-signer are one key", { ...record, cosigner_pubkey: "03" + OWNER.slice(2) }, read, "same key");
  not("anything at all, for a network the checker does not know", record, { crowdlock: { ...crowdlock, network: "nowhere" }, register: onRegister }, "network");
  // The real registers, as they stand: every lock on them is genuine.
  const root = new URL("../../", import.meta.url);
  const test = JSON.parse(readFileSync(new URL("crowdlocks/kop-fund-testnet4.json", root), "utf8"));
  const testReg = JSON.parse(readFileSync(new URL(test.register.registrations, root), "utf8"));
  check(`Every lock on the test Crowdlock's own register is genuine (${testReg.locks.length})`,
    testReg.locks.length > 0 && testReg.locks.every((l) => lockIsGenuine(l, { crowdlock: test, register: testReg }).ok));
  const fundReg = JSON.parse(readFileSync(new URL("../fixtures/the-kop-fund/registrations.json", import.meta.url), "utf8"));
  check(`…and so is every lock on The Kop Fund's register, as frozen for these tests (${(fundReg.locks ?? []).length})`,
    (fundReg.locks ?? []).every((l) => lockIsGenuine(l, { crowdlock: kop, register: fundReg }).ok));
}

console.log();
rule();
console.log(failures === 0
  ? "The lock endpoint builds the same addresses as the proven code and refuses what it should."
  : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
