// The proposals file, and the browser-safe proposal hash held to the
// reference code's bytes. Run: node method/js/proposals.test.mjs
import { readFileSync } from "node:fs";
import {
  proposalLine, proposalHash, documentHash, fieldsOf, checkProposals, phaseOf, pilePath, checkPileShape,
  PROPOSALS_FORMAT, PILE_FORMAT, destinationLine, destinationHash, attestationStatement, attestationsAreValid,
  chainIsIntact, destinationIsPermitted, nextDestination, ZERO_PREV, commitmentEventTemplate, commitmentFromEvent,
  applyCommitments, emptyPile, PER_LOCK_LIMIT,
} from "./proposals.mjs";
import bitcoinMessage from "../lock/node_modules/bitcoinjs-message/index.js";
import { ECPair } from "../lock/lock.mjs";
import * as bitcoin from "../lock/node_modules/bitcoinjs-lib/src/index.js";
import * as ref from "../lock/commitment.mjs";
import { checkCrowdlock } from "./crowdlock.mjs";

let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };
const throws = (fn, part) => { try { fn(); return false; } catch (e) { return e.message.includes(part); } };

const crowdlock = JSON.parse(readFileSync(new URL("../../crowdlocks/kop-fund-testnet4.json", import.meta.url)));
const instance = crowdlock.declaration.sha256;
const text = "Buy the test stake.\nA second line, and an accent: café.";
const p = {
  title: "Test purchase", text, destination: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  requires: 12345, currency: "GBP",
  opens: "2026-11-11T00:00:00Z", closes: "2026-11-25T00:00:00Z", settles_by: "2026-12-02T00:00:00Z",
  target: { sats: 250000, rate: "1 BTC = 66000.00 GBP", at: "2026-11-10T22:00:00Z" },
};
const fields = fieldsOf(p, instance);
const hash = proposalHash(fields);

// The same bytes as the reference code, for several proposals.
const cases = [fields, { ...fields, currency: "EUR", requiresMinor: 1 }, { ...fields, document: documentHash("Ünïcödé, decomposed: é") }];
check("The browser-safe line and hash are the reference code's, byte for byte",
  cases.every((f) => proposalLine(f) === ref.proposalLine(f) && proposalHash(f) === ref.proposalHash(f)));
check("The document is the SHA-256 of the prose, taken after NFC", documentHash("é") === documentHash("é"));
check("A lower-case currency is refused, not upper-cased", throws(() => proposalHash({ ...fields, currency: "gbp" }), "capitals"));

const file = { format: PROPOSALS_FORMAT, instance, proposals: [{ ...p, hash }] };
const ok = checkProposals(file, crowdlock);
check("A well-formed proposals file passes, and each hash is recomputed", ok.ok && ok.proposals[0].hash === hash, ok.problems.join("; "));
check("A proposal whose text was changed after its hash is refused",
  checkProposals({ ...file, proposals: [{ ...p, hash, text: text + " " }] }, crowdlock).problems.some((x) => x.includes("hash")));
check("A proposal whose price was changed after its hash is refused",
  !checkProposals({ ...file, proposals: [{ ...p, hash, requires: 12346 }] }, crowdlock).ok);
check("A proposals file from another Crowdlock is refused", !checkProposals({ ...file, instance: "0".repeat(64) }, crowdlock).ok);
check("A proposal gathering longer than the Crowdlock allows is refused",
  (() => { const q = { ...p, closes: "2027-01-30T00:00:00Z", settles_by: "2027-02-01T00:00:00Z" }; return !checkProposals({ ...file, proposals: [{ ...q, hash: proposalHash(fieldsOf(q, instance)) }] }, crowdlock).ok; })());
check("The same proposal listed twice is refused", !checkProposals({ ...file, proposals: [{ ...p, hash }, { ...p, hash }] }, crowdlock).ok);
check("A target without its rate and moment is refused",
  !checkProposals({ ...file, proposals: [{ ...p, hash, target: { sats: 1 } }] }, crowdlock).ok);

check("Phases: soon, gathering, settling, over",
  phaseOf(p, Date.parse("2026-11-10T00:00:00Z")) === "soon" && phaseOf(p, Date.parse("2026-11-12T00:00:00Z")) === "gathering"
    && phaseOf(p, Date.parse("2026-11-26T00:00:00Z")) === "settling" && phaseOf(p, Date.parse("2026-12-03T00:00:00Z")) === "over");
check("A pile lives beside the proposals file", pilePath("crowdlocks/test/proposals.json", hash) === `crowdlocks/test/commitments/${hash}.json`
  && pilePath("proposals.json", hash) === `commitments/${hash}.json`);
check("A pile's shape is checked before anything in it is trusted",
  checkPileShape({ format: PILE_FORMAT, proposal: hash, commitments: [] }, hash).ok
    && !checkPileShape({ format: PILE_FORMAT, proposal: "1".repeat(64), commitments: [] }, hash).ok
    && !checkPileShape({ format: PILE_FORMAT, proposal: hash, commitments: [{ submitted: "x", record: {} }] }, hash).ok);

check("A Crowdlock file may name its proposals file",
  checkCrowdlock({ ...crowdlock, register: { ...crowdlock.register, proposals: "crowdlocks/test/proposals.json" } }).ok);
check("…but not as anything other than a .json file",
  !checkCrowdlock({ ...crowdlock, register: { ...crowdlock.register, proposals: 7 } }).ok);

// The destinations list: the same answers as the reference code.
const NET = bitcoin.networks.testnet;
const key = ECPair.makeRandom({ network: NET }), outsider = ECPair.makeRandom({ network: NET });
const addrOf = (k) => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(k.publicKey), network: NET }).address;
const sign = (entry, k) => ({ address: addrOf(k), signature: bitcoinMessage.sign(attestationStatement(entry), Buffer.from(k.privateKey), true, { segwitType: "p2wpkh" }).toString("base64") });
const dfile = { instance, entries: [] };
const { entry: d1, firstSeen: s1 } = nextDestination(dfile, { address: addrOf(outsider), text: "Test seller", now: new Date("2026-11-01T12:00:00.123Z") });
const e1 = { ...d1, attestations: [sign(d1, key)], firstSeen: s1 };
const { entry: d2 } = nextDestination({ instance, entries: [e1] }, { address: addrOf(key), text: "Second", now: new Date("2026-11-20T00:00:00Z") });
const e2 = { ...d2, attestations: [sign(d2, outsider)], firstSeen: "2026-11-20T00:00:00Z" };
const list = [e1, e2];
const rules = { attestors: [addrOf(key)], threshold: 1, hrp: "tb" };
check("A new entry chains to the one before it, with whole-second times", d1.prev === ZERO_PREV && d2.prev === ref.destinationHash(e1) && s1 === "2026-11-01T12:00:00Z");
check("Destination lines, hashes and statements are the reference code's",
  list.every((e) => destinationLine(e) === ref.destinationLine(e) && destinationHash(e) === ref.destinationHash(e) && attestationStatement(e) === ref.attestationStatement(e)));
check("Attestations: the same verdicts as the reference code (a real one, an outsider's)",
  attestationsAreValid(e1, rules).ok === ref.attestationsAreValid(e1, rules).ok && attestationsAreValid(e1, rules).ok
    && attestationsAreValid(e2, rules).ok === ref.attestationsAreValid(e2, rules).ok && !attestationsAreValid(e2, rules).ok);
check("The chain: the same verdicts, intact and tampered",
  chainIsIntact(list).ok && ref.chainIsIntact(list).ok && !chainIsIntact([{ ...e1, text: "x" }, e2]).ok && !ref.chainIsIntact([{ ...e1, text: "x" }, e2]).ok);
const ask = (address, opensAt, minimumAgeDays) => [destinationIsPermitted({ address, entries: list, opensAt, minimumAgeDays, ...rules }), ref.destinationIsPermitted({ address, entries: list, opensAt, minimumAgeDays, ...rules })];
const agree = (pair) => pair[0].permitted === pair[1].permitted && pair[0].reason === pair[1].reason;
check("Permitted or not: the same answer and reason as the reference code, in every case",
  agree(ask(addrOf(outsider), "2026-11-10T00:00:00Z", 7)) && ask(addrOf(outsider), "2026-11-10T00:00:00Z", 7)[0].permitted
    && agree(ask(addrOf(outsider), "2026-11-05T00:00:00Z", 7)) && !ask(addrOf(outsider), "2026-11-05T00:00:00Z", 7)[0].permitted
    && agree(ask(addrOf(outsider), "2026-11-01T12:00:00Z", 0)) && ask(addrOf(outsider), "2026-11-01T12:00:00Z", 0)[0].permitted
    && agree(ask(addrOf(key), "2026-12-30T00:00:00Z", 7)) && !ask(addrOf(key), "2026-12-30T00:00:00Z", 7)[0].permitted
    && agree(ask("tb1qnotonthelist", "2026-12-30T00:00:00Z", 7)));
check("A destination text with a | is refused", throws(() => nextDestination(dfile, { address: addrOf(key), text: "a|b" }), "may not contain"));

// Commitments on the relays.
const rec = { proposal: hash, lock: { address: "x" }, tx: "00ff" };
const ev = { ...commitmentEventTemplate({ type: "commitment", proposal: hash, record: rec }, instance, 1800000000) };
check("A commitment event reads back as the same record", commitmentFromEvent(ev, instance, hash)?.record?.tx === "00ff");
check("…and not for another proposal or Crowdlock", commitmentFromEvent(ev, instance, "1".repeat(64)) === null && commitmentFromEvent(ev, "2".repeat(64), hash) === null);
const done = commitmentEventTemplate({ type: "completed", proposal: hash, tx: "abcd" }, instance, 1800000000);
check("A completed transaction event reads back", commitmentFromEvent(done, instance, hash)?.tx === "abcd");

// The pile the inbox keeps.
{
  const lock = { address: "tb1qlockaddress", owner_pubkey: "02" + "a".repeat(64), cosigner_pubkey: "03" + "b".repeat(64), locktime: 1800000000 };
  const register = { locks: [{ ...lock, member: "tb1qmember" }] };
  const prop = { ...p, hash };
  const inWindow = Math.floor(Date.parse(p.opens) / 1000) + 60;
  const ev = (tx, at = inWindow, l = lock) => ({ id: tx, ...commitmentEventTemplate({ type: "commitment", proposal: hash, record: { proposal: hash, lock: l, tx } }, instance, at) });
  const run = (pile, events) => applyCommitments(pile, events, { crowdlock, proposal: prop, register, nowIso: "2026-11-12T09:00:00Z" });
  const r1 = run(emptyPile(hash), [ev("aa"), ev("aa"), ev("bb", inWindow + 5)]);
  check("The inbox adds each commitment once, in the order it first saw them, with its own time",
    r1.pile.commitments.length === 2 && r1.pile.commitments[0].record.tx === "aa" && r1.pile.commitments.every((c) => c.submitted === "2026-11-12T09:00:00Z"));
  const r2 = run(r1.pile, [ev("aa"), ev("bb")]);
  check("…and nothing again on the next run", r2.pile === r1.pile);
  const r3 = run(emptyPile(hash), [ev("cc", inWindow, { ...lock, address: "tb1qnotregistered" }), ev("dd", Math.floor(Date.parse(p.opens) / 1000) - 10), ev("zz-not-hex")]);
  check("It refuses a lock not on the register, one posted before the proposal opened, and a malformed one",
    r3.pile.commitments.length === 0 && r3.outcome.length === 3 && r3.outcome.every((o) => !o.added), r3.outcome.map((o) => o.reason).join("; "));
  const many = Array.from({ length: PER_LOCK_LIMIT + 2 }, (_, i) => ev(`e${i}`.replace(/[^0-9a-f]/g, "e"), inWindow + i));
  const r4 = run(emptyPile(hash), many);
  check(`It keeps at most ${PER_LOCK_LIMIT} per lock, so nobody can flood the file`, r4.pile.commitments.length === PER_LOCK_LIMIT);
  check("A completed transaction posted to the relays is not put in the pile",
    run(emptyPile(hash), [{ id: "x", ...commitmentEventTemplate({ type: "completed", proposal: hash, tx: "ab" }, instance, inWindow) }]).pile.commitments.length === 0);
}

console.log(failures === 0 ? "Proposals behave as spec/proposal-and-settlement.md describes." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
