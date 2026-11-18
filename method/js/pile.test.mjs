// The shared pile reader (pile.mjs), with everything it asks for faked: the
// app and the website both add a pile up through it, so this is what both do.
//
// Run: node method/js/pile.test.mjs

import { readFileSync } from "node:fs";
import { readPile, settleOrder, planFor } from "./pile.mjs";
import { lockAddress } from "./lockrecord.mjs";
import { PILE_FORMAT } from "./proposals.mjs";
import { membershipStatement } from "./crowdlock.mjs";
import { messageHash, memberAddressForOwnerKey } from "./verify.mjs";
import { signAsync, getPublicKey, utils } from "./vendor/noble-secp256k1.js";

let failures = 0;
const check = (what, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(72)} ${detail}`); };

const crowdlock = JSON.parse(readFileSync(new URL("../../crowdlocks/kop-fund-testnet4.json", import.meta.url)));
const HASH = "ef".repeat(32);
const proposal = { hash: HASH, opens: "2027-01-01T00:00:00Z", closes: "2027-01-29T00:00:00Z", settles_by: "2027-02-12T00:00:00Z", target: { sats: 100000 } };
const NOW = Date.parse("2027-02-01T00:00:00Z"); // settling

const priv = utils.randomSecretKey ? utils.randomSecretKey() : utils.randomPrivateKey();
const pub = Buffer.from(getPublicKey(priv, true)).toString("hex");
const member = memberAddressForOwnerKey(pub, "tb");
const g = await signAsync(messageHash(membershipStatement(crowdlock, crowdlock.declaration.version)), priv);
const signature = Buffer.concat([Buffer.from([39 + g.recovery]), Buffer.from(g.toCompactRawBytes())]).toString("base64");
const lockOf = (n) => { const l = { owner_pubkey: pub, cosigner_pubkey: crowdlock.cosigner_keys.at(-1), locktime: 1900000000 + n }; return { ...l, address: lockAddress({ ownerPubkey: l.owner_pubkey, cosignerPubkey: l.cosigner_pubkey, locktime: l.locktime }, "tb") }; };
const locks = [lockOf(1), lockOf(2), lockOf(3)];
const register = { members: [{ n: 1, address: member, signature, signed: "2026-12-01" }], locks: locks.map((l) => ({ ...l, member })) };
const rec = (i, tx) => ({ proposal: HASH, lock: locks[i], tx });
const file = (records) => ({ ok: true, status: 200, json: async () => ({ format: PILE_FORMAT, proposal: HASH, commitments: records.map((r) => ({ submitted: "2027-01-02T00:00:00Z", record: r })) }) });

/** Read a pile with fakes: `results` says what each commitment's check, and payment, come to. */
const read = (records, { results = {}, payments = {}, relay = [], fetchPile = null, now = NOW } = {}) => readPile({
  crowdlock, register, destinations: null, proposal,
  fetchPile: fetchPile ?? (async () => file(records)),
  relayItems: async () => relay,
  check: async (r) => results[r.tx] ?? { valid: true, committedSats: 40000, coin: `${r.tx}:0`, ownerPubkey: pub },
  payment: async (r) => payments[r.tx] ?? null,
  txidOf: (r) => `id-${r.tx}`,
  ownerPubkey: pub, now,
});

let p = await read([rec(0, "aa"), rec(1, "bb"), rec(2, "cc")]);
check("Every waiting commitment is counted, in the repository's order", p.count === 3 && p.sats === 120000 && p.good.map((x) => x.record.tx).join() === "aa,bb,cc");
check("…and the plan takes the oldest up to the target, the rest held in reserve", planFor(p, 100000).take.map((x) => x.record.tx).join() === "aa,bb,cc" && planFor(p, 80000).take.length === 2);

p = await read([rec(0, "aa"), rec(1, "bb")], { results: { aa: { valid: false, reason: "the coin has already been spent" } }, payments: { aa: { sats: 40000, confirmed: true } } });
check("A spent commitment that was paid counts as paid, not refused", p.paid === 40000 && p.paidCount === 1 && p.count === 1);
p = await read([rec(0, "aa")], { results: { aa: { valid: false, reason: "the coin has already been spent" } }, payments: { aa: { unknown: true, reason: "timed out" } } });
check("One whose payment couldn't be looked up is uncertain, not unpaid", p.uncertain === 1 && p.paid === 0);

p = await read([rec(0, "aa"), rec(1, "aa2")], { results: { aa2: { valid: true, committedSats: 40000, coin: "aa:0", ownerPubkey: pub } } });
check("Two commitments spending one coin count once", p.count === 1);

p = await read([], { fetchPile: async () => ({ ok: false, status: 404 }) });
check("No pile yet is an empty pile, not an unreadable one", p.count === 0 && p.unreadable === null);
p = await read([], { fetchPile: async () => ({ ok: false, status: 500 }) });
check("A pile that can't be read is said", /couldn't be read/.test(p.unreadable ?? ""));

const forged = { ...register, members: [{ ...register.members[0], signature: "x" }] };
p = await readPile({ crowdlock, register: forged, destinations: null, proposal, fetchPile: async () => file([rec(0, "aa")]), relayItems: async () => [], check: async () => ({ valid: true, committedSats: 40000, coin: "aa:0" }), payment: async () => null, txidOf: () => null, now: NOW });
check("A commitment from someone who may not back the proposal isn't counted", p.count === 0 && /has not signed version/.test(p.refused[0] ?? ""));

const relayOnly = { type: "commitment", record: rec(1, "dd"), at: Date.parse("2027-01-05T00:00:00Z") / 1000 };
p = await read([rec(0, "aa")], { relay: [relayOnly], now: Date.parse("2027-01-10T00:00:00Z") });
check("A relay-only commitment is counted while gathering, after the repository's", p.count === 2 && settleOrder(p.good)[1].record.tx === "dd");
p = await read([rec(0, "aa")], { relay: [relayOnly] });
check("…and not once relay-only commitments have stopped counting", p.count === 1);
// Posted ten minutes after closing: the inbox never takes it, so neither does
// anyone counting, even in the hour relay-only commitments still count.
const late = { type: "commitment", record: rec(1, "ee"), at: Date.parse("2027-01-29T00:10:00Z") / 1000 };
p = await read([rec(0, "aa")], { relay: [late], now: Date.parse("2027-01-29T00:30:00Z") });
check("A commitment posted after closing doesn't count, even within the hour", p.count === 1);
const lastMinute = { ...late, record: rec(1, "ef"), at: Date.parse("2027-01-28T23:59:00Z") / 1000 };
p = await read([rec(0, "aa")], { relay: [lastMinute], now: Date.parse("2027-01-29T00:30:00Z") });
check("…one posted a minute before closing does, until the inbox has it", p.count === 2);
// A destination taken off the list after a payment was made to it.
p = await read([rec(0, "aa")], { results: { aa: { valid: false, reason: "destination not permitted: it was revoked" } }, payments: { aa: { sats: 40000, confirmed: true } } });
check("A payment made before its destination was revoked still counts as paid", p.paid === 40000 && p.paidCount === 1 && p.refused.length === 0);
p = await read([rec(0, "aa")], { results: { aa: { valid: false, reason: "destination not permitted: it was revoked" } } });
check("…and a commitment to it never paid is refused, not counted", p.paid === 0 && p.count === 0 && p.refused.length === 1);

console.log("-".repeat(80));
console.log(failures === 0 ? "A pile is added up the same way for the app and the website." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
