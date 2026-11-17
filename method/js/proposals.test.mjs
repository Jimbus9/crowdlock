// The proposals file, and the browser-safe proposal hash held to the
// reference code's bytes. Run: node method/js/proposals.test.mjs
import { readFileSync } from "node:fs";
import {
  proposalLine, proposalHash, documentHash, fieldsOf, checkProposals, phaseOf, pilePath, checkPileShape,
  PROPOSALS_FORMAT, PILE_FORMAT, destinationLine, destinationHash, attestationStatement, attestationsAreValid,
  chainIsIntact, destinationIsPermitted, nextDestination, ZERO_PREV, commitmentEventTemplate, commitmentFromEvent,
  applyCommitments, emptyPile, PER_LOCK_LIMIT, applySettlement, dueToSend, noticeStatement, noticeIsGenuine,
} from "./proposals.mjs";
import { memberAddressForOwnerKey } from "./verify.mjs";
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
  const register = { members: [{ n: 1, address: "tb1qmember", signature: "x", signed: "2026-11-01" }], locks: [{ ...lock, member: "tb1qmember" }] };
  const prop = { ...p, hash };
  const inWindow = Math.floor(Date.parse(p.opens) / 1000) + 60;
  const ev = (tx, at = inWindow, l = lock) => ({ id: tx, ...commitmentEventTemplate({ type: "commitment", proposal: hash, record: { proposal: hash, lock: l, tx } }, instance, at) });
  // The owner's signature is the caller's to check (the relay inbox asks the
  // chain); here every commitment is taken as signed unless a check says not.
  const allSigned = async (records) => records.map(() => ({ ok: true }));
  const run = (pile, events, signed = allSigned) => applyCommitments(pile, events, { crowdlock, proposal: prop, register, nowIso: "2026-11-12T09:00:00Z", signed });
  const r1 = await run(emptyPile(hash), [ev("aa"), ev("aa"), ev("bb", inWindow + 5)]);
  check("The inbox adds each commitment once, in the order it first saw them, with its own time",
    r1.pile.commitments.length === 2 && r1.pile.commitments[0].record.tx === "aa" && r1.pile.commitments.every((c) => c.submitted === "2026-11-12T09:00:00Z"));
  const r2 = await run(r1.pile, [ev("aa"), ev("bb")]);
  check("…and nothing again on the next run", r2.pile === r1.pile);
  const r3 = await run(emptyPile(hash), [ev("cc", inWindow, { ...lock, address: "tb1qnotregistered" }), ev("dd", Math.floor(Date.parse(p.opens) / 1000) - 10), ev("zz-not-hex")]);
  check("It refuses a lock not on the register, one posted before the proposal opened, and a malformed one",
    r3.pile.commitments.length === 0 && r3.outcome.length === 3 && r3.outcome.every((o) => !o.added), r3.outcome.map((o) => o.reason).join("; "));
  const many = Array.from({ length: PER_LOCK_LIMIT + 2 }, (_, i) => ev(`e${i}`.replace(/[^0-9a-f]/g, "e"), inWindow + i));
  const r4 = await run(emptyPile(hash), many);
  check(`It keeps at most ${PER_LOCK_LIMIT} per lock, so nobody can flood the file`, r4.pile.commitments.length === PER_LOCK_LIMIT);
  check("A completed transaction posted to the relays is not put in the pile",
    (await run(emptyPile(hash), [{ id: "x", ...commitmentEventTemplate({ type: "completed", proposal: hash, tx: "ab" }, instance, inWindow) }])).pile.commitments.length === 0);

  // Unsigned junk must not take a lock's places. Before 17 November 2026 five
  // junk records naming a lock were enough to shut its owner out.
  const asked = [];
  const onlyReal = async (records) => { asked.push(...records.map((r) => r.tx)); return records.map((r) => r.tx === "ee" ? { ok: true } : { ok: false, reason: "the lock's owner has not signed it" }); };
  const junk = Array.from({ length: PER_LOCK_LIMIT + 3 }, (_, i) => ev(`0${i}`, inWindow + i));
  const r5 = await run(emptyPile(hash), [...junk, ev("ee", inWindow + 50)], onlyReal);
  check("Junk the owner never signed takes none of a lock's places, and the owner's own commitment still gets in",
    r5.pile.commitments.length === 1 && r5.pile.commitments[0].record.tx === "ee" && r5.outcome.filter((o) => !o.added).every((o) => /has not signed/.test(o.reason)));
  const r6 = await run(emptyPile(hash), [ev("cc", inWindow, { ...lock, address: "tb1qnotregistered" }), ev("dd", Math.floor(Date.parse(p.opens) / 1000) - 10)], onlyReal);
  check("The signature is only asked about for records that passed every other check", !asked.includes("cc") && !asked.includes("dd") && r6.pile.commitments.length === 0);
  let threw = false;
  try { await applyCommitments(emptyPile(hash), [ev("aa")], { crowdlock, proposal: prop, register, nowIso: "x" }); } catch { threw = true; }
  check("A caller that leaves the signature check out is refused, not trusted", threw);
}

// What the co-signer does: completions published in the pile, paced, and the notice.
{
  const mk = (n, witness) => { const t = new bitcoin.Transaction(); t.addInput(Buffer.alloc(32, n), 0, 0xfffffffe); t.addOutput(Buffer.from("0014" + "11".repeat(20), "hex"), 1000 + n); t.setWitness(0, witness); return t.toHex(); };
  const half = (n) => mk(n, [Buffer.alloc(0), Buffer.alloc(0), Buffer.from("aa", "hex"), Buffer.from("bb", "hex")]);
  const full = (n) => mk(n, [Buffer.from("cc", "hex"), Buffer.alloc(0), Buffer.from("aa", "hex"), Buffer.from("bb", "hex")]);
  const txidOf = (h) => { try { return bitcoin.Transaction.fromHex(h).getId(); } catch { return null; } };
  const cosignerKey = ECPair.makeRandom({ network: NET });
  const cl = { ...crowdlock, cosigner_keys: [Buffer.from(cosignerKey.publicKey).toString("hex")] };
  const pile = { ...emptyPile(hash), commitments: [1, 2, 3].map((n) => ({ submitted: "2026-11-12T09:00:00Z", record: { proposal: hash, lock: {}, tx: half(n) } })) };
  const allGood = async (candidates) => candidates.map(() => ({ ok: true }));
  const args = { crowdlock: cl, hash, hrp: "tb", addressOf: memberAddressForOwnerKey, txidOf, nowIso: "2026-11-12T10:00:00Z", completedBy: allGood };
  const done = await applySettlement(pile, [{ type: "completed", tx: full(2), at: 5 }, { type: "completed", tx: full(1), at: 6 }, { type: "completed", tx: full(9), at: 7 }, { type: "completed", tx: full(2), at: 8 }], args);
  check("Completed payments are recorded in the pile, once each, and only if they complete a commitment in it",
    done.pile.completed.length === 2 && done.outcome.some((o) => !o.added && /completes no commitment/.test(o.reason)));
  check("They go out oldest commitment first, a few per pass", dueToSend(done.pile, 1, txidOf)[0].txid === txidOf(half(1)) && dueToSend(done.pile, 5, txidOf).length === 2);
  const sentOne = { ...done.pile, completed: done.pile.completed.map((c, i) => i === 0 ? { ...c, sent: "x" } : c) };
  check("…and one already sent is not sent again", dueToSend(sentOne, 5, txidOf).length === 1);

  const signNotice = (k) => ({ address: addrOf(k), signature: bitcoinMessage.sign(noticeStatement(hash), Buffer.from(k.privateKey), true, { segwitType: "p2wpkh" }).toString("base64") });
  check("The notice is a fixed sentence naming the proposal", noticeStatement(hash) === `I declare proposal ${hash} dead: it did not reach its target, and I will complete none of its commitments.`);
  check("A notice signed by the co-signer is genuine; one signed by anyone else is not",
    noticeIsGenuine(signNotice(cosignerKey), args).ok && !noticeIsGenuine(signNotice(key), args).ok);
  // A copy with a made-up co-signer signature has the real completion's id.
  // Posted first, it used to be recorded and the real one then ignored.
  const fake = (n) => mk(n, [Buffer.from("dead", "hex"), Buffer.alloc(0), Buffer.from("aa", "hex"), Buffer.from("bb", "hex")]);
  const realOnly = async (candidates) => candidates.map((c) => c.tx === full(1) ? { ok: true } : { ok: false, reason: "the co-signer has not signed it" });
  const mixed = await applySettlement(pile, [{ type: "completed", tx: fake(1), at: 1 }, { type: "completed", tx: full(1), at: 2 }], { ...args, completedBy: realOnly });
  check("A completion the co-signer never signed is not recorded, and the real one posted after it is",
    mixed.pile.completed.length === 1 && mixed.pile.completed[0].tx === full(1) && mixed.outcome.some((o) => !o.added && /co-signer has not signed/.test(o.reason)));
  const onlyFake = await applySettlement(pile, [{ type: "completed", tx: fake(1), at: 1 }], { ...args, completedBy: realOnly });
  check("…and with only the fake posted, the commitment stays open for the real one", !onlyFake.pile.completed && dueToSend(onlyFake.pile, 5, txidOf).length === 0);

  const dead = await applySettlement(pile, [{ type: "notice", notice: signNotice(cosignerKey), at: 1 }, { type: "completed", tx: full(1), at: 2 }], args);
  check("Once declared dead, no completion is recorded after it", !!dead.pile.notice && !dead.pile.completed && dead.outcome.some((o) => /declared this proposal dead/.test(o.reason ?? "")));
}

console.log(failures === 0 ? "Proposals behave as spec/proposal-and-settlement.md describes." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
