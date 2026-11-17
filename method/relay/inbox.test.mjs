// The relay inbox, tested without a network: Nostr events made by nostr-tools,
// a pretend chain, and the real test Crowdlock and register files.
//
// Run: npm install (once), then npm test

import { readFileSync } from "node:fs";
import { join as joinPath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import { signAsync, getPublicKey, utils } from "../js/vendor/noble-secp256k1.js";
import { messageHash, memberAddressForOwnerKey } from "../js/verify.mjs";
import { membershipStatement, checkCrowdlock } from "../js/crowdlock.mjs";
import { lockAddress } from "../js/lockrecord.mjs";
import { applyRecords, recordEventTemplate, recordFromEvent, RECORD_KIND, announcementTemplate, announcementFromEvent, announcementDue, ANNOUNCE_KIND } from "../js/inbox.mjs";
import { recordPass, planSwaps } from "../js/relayhealth.mjs";
import { readBack, readRelay } from "./nostr.mjs";

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), "..", "..");
let failures = 0;
const check = (what, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(70)} ${detail}`); };

const crowdlock = JSON.parse(readFileSync(joinPath(ROOT, "crowdlocks/kop-fund-testnet4.json"), "utf8"));
const register = JSON.parse(readFileSync(joinPath(ROOT, crowdlock.register.registrations), "utf8"));
const statement = membershipStatement(crowdlock);
const fp = crowdlock.declaration.sha256;
const COSIGNER = crowdlock.cosigner_keys[0];
const now = Math.floor(Date.now() / 1000);
const today = new Date().toISOString().slice(0, 10);

check("The test Crowdlock names relays, and its file checks out with them",
  Array.isArray(crowdlock.relays) && checkCrowdlock(crowdlock, { declarationText: readFileSync(joinPath(ROOT, crowdlock.declaration.file), "utf8") }).ok);
check("A Crowdlock naming a relay that is not wss:// is refused",
  !checkCrowdlock({ ...crowdlock, relays: ["https://relay.example"] }).ok);

/** A new member: key, address, and a real signature over the statement. */
async function newMember(over = statement) {
  const priv = utils.randomPrivateKey();
  const pub = Buffer.from(getPublicKey(priv, true)).toString("hex");
  const sig = await signAsync(messageHash(over), priv);
  return {
    pub, address: memberAddressForOwnerKey(pub, "tb"),
    signature: Buffer.concat([Buffer.from([31 + sig.recovery]), Buffer.from(sig.toCompactRawBytes())]).toString("base64"),
  };
}
const post = (record, at = now, fingerprint = fp) => finalizeEvent(recordEventTemplate(record, fingerprint, at), generateSecretKey());

const alice = await newMember();
const join = post({ type: "join", address: alice.address, signature: alice.signature });
check("A posted record is a valid Nostr event, which relays require", verifyEvent(join) && join.kind === RECORD_KIND);
check("…and reads back as the same record", recordFromEvent(join, fp)?.address === alice.address);
check("A record labelled for another Crowdlock is not read as this one's", recordFromEvent(post({ type: "join", address: alice.address, signature: alice.signature }, now, "f".repeat(64)), fp) === null);

const chain = (sats) => async () => sats;
const nextN = Math.max(0, ...register.members.map((m) => m.n)) + 1;
let r = await applyRecords(register, [join, post({ type: "join", address: alice.address, signature: alice.signature })],
  { crowdlock, statement, now, today, confirmedSats: chain(0) });
check("A valid registration from the relays joins, once, even if posted twice",
  r.register.members.length === register.members.length + 1 && r.register.members.at(-1).n === nextN
    && r.outcome.filter((o) => o.added).length === 1, `member ${r.register.members.at(-1).n}`);
check("The register passed in is left untouched", register.members.length === JSON.parse(readFileSync(joinPath(ROOT, crowdlock.register.registrations), "utf8")).members.length);

const mallory = await newMember("I agree to something else entirely.");
r = await applyRecords(register, [post({ type: "join", address: mallory.address, signature: mallory.signature }),
  { ...join, kind: 1 }, { ...post({ type: "join" }), content: "{not json" }],
  { crowdlock, statement, now, today, confirmedSats: chain(0) });
check("A signature over other words, a wrong kind and junk are all left out",
  r.register === register && r.outcome.length === 1 && !r.outcome[0].added, r.outcome[0]?.reason?.slice(0, 40));

// A new member's join and first lock, posted together, before the lock confirms.
const bob = await newMember();
const T = now + 30 * 86400;
const lockRec = { type: "lock", owner_pubkey: bob.pub, cosigner_pubkey: COSIGNER, locktime: T,
  address: lockAddress({ ownerPubkey: bob.pub, cosignerPubkey: COSIGNER, locktime: T }, "tb") };
const events = [post({ type: "join", address: bob.address, signature: bob.signature }, now - 60), post(lockRec, now - 30)];
r = await applyRecords(register, events, { crowdlock, statement, now, today, confirmedSats: chain(0) });
check("Before the lock confirms: the member joins, the lock waits",
  r.register.members.some((m) => m.address === bob.address) && (r.register.locks ?? []).length === (register.locks ?? []).length,
  r.outcome.find((o) => o.type === "lock")?.reason?.slice(0, 40));
r = await applyRecords(register, events, { crowdlock, statement, now, today, confirmedSats: chain(50000) });
check("Once it has confirmed, the same posts add the lock too",
  r.register.locks.at(-1).address === lockRec.address && r.register.locks.at(-1).member === bob.address);
const again = await applyRecords(r.register, events, { crowdlock, statement, now, today, confirmedSats: chain(50000) });
check("Run again over the same posts, nothing is added twice", again.register === r.register);

const wrongCo = { ...lockRec, cosigner_pubkey: "02" + "11".repeat(32) };
wrongCo.address = lockAddress({ ownerPubkey: bob.pub, cosignerPubkey: wrongCo.cosigner_pubkey, locktime: T }, "tb");
r = await applyRecords(register, [events[0], post(wrongCo)], { crowdlock, statement, now, today, confirmedSats: chain(50000) });
check("A lock naming somebody else's co-signer is refused", !r.outcome.find((o) => o.type === "lock").added,
  r.outcome.find((o) => o.type === "lock").reason.slice(0, 40));
const stranger = await newMember();
const strangerLock = { ...lockRec, owner_pubkey: stranger.pub, address: lockAddress({ ownerPubkey: stranger.pub, cosignerPubkey: COSIGNER, locktime: T }, "tb") };
r = await applyRecords(register, [post(strangerLock)], { crowdlock, statement, now, today, confirmedSats: chain(50000) });
check("A lock whose owner never joined is refused", !r.outcome[0].added, r.outcome[0].reason.slice(0, 40));
r = await applyRecords(register, [events[0], post(lockRec)], { crowdlock, statement, now, today, confirmedSats: async () => { throw new Error("down"); } });
check("If the chain can't be read, the lock waits for the next run", !r.outcome.find((o) => o.type === "lock").added);

// ---- Relay health ----
//
// Rewritten 2 November after the old record flapped. It tracked a
// "silentSince" that was set on the first failed pass and cleared on the next
// good one, so an intermittent relay flipped it several times an hour — 117
// of the repository's first 223 commits were that one field — and because any
// good pass reset the clock, seven CONSECUTIVE silent days was nearly
// unreachable. Both of those now have a test.

const A = "wss://a.example", B = "wss://b.example", S1 = "wss://spare1.example", S2 = "wss://spare2.example";
const pass = (h, aOk, bOk, day) => recordPass(h, [{ relay: A, ok: aOk }, { relay: B, ok: bOk }], day);

let h = pass({}, true, true, "2026-11-01");
check("Health records the day each relay last answered",
  h[A].lastAnswered === "2026-11-01" && h[B].lastAnswered === "2026-11-01");
check("…and nothing else that moves", !("silentSince" in h[A]), Object.keys(h[A]).join(", "));
check("The same day again changes nothing, so there is nothing to commit",
  pass(h, true, true, "2026-11-01") === h);
check("A pass where no relay answers says nothing about the relays",
  pass(h, false, false, "2026-11-02") === h);

h = pass(h, true, false, "2026-11-02");
check("A relay that stops answering keeps the day it last answered",
  h[B].lastAnswered === "2026-11-01" && h[A].lastAnswered === "2026-11-02");

// THE FLAPPING. A relay that fails and answers within one day used to rewrite
// the record both times. Now the second pass of the day is a no-op for it.
const answered = pass(h, true, true, "2026-11-02");
const flapped = pass(answered, true, false, "2026-11-02");
check("A relay failing and answering on the same day commits once, not twice",
  flapped === answered, "the second pass of the day changes nothing");

const cl = { ...crowdlock, relays: [A, B], spare_relays: [S1, S2] };
h = pass(h, true, false, "2026-11-05");
check("Six days since it last answered: not swapped yet", planSwaps(cl, h, "2026-11-07").swaps.length === 0);
const sw = planSwaps(cl, h, "2026-11-08");
check("Seven days: swapped for the first spare, in its place",
  sw.swaps.length === 1 && sw.crowdlock.relays[1] === S1
  && sw.crowdlock.spare_relays.length === 1 && sw.crowdlock.spare_relays[0] === S2);
check("…and the swap says when it last answered", sw.swaps[0].lastAnswered === "2026-11-01" && sw.swaps[0].days === 7);
check("…and the swapped Crowdlock file still checks out",
  checkCrowdlock(sw.crowdlock).problems.every((p) => !/relay/.test(p)));

// THE CLOCK THAT NEVER RAN OUT. One good pass in ten used to reset the count
// to zero, so this relay was never swapped however broken it was.
let patchy = pass({}, true, true, "2026-11-01");
for (let d = 2; d <= 20; d++) {
  const day = `2026-11-${String(d).padStart(2, "0")}`;
  patchy = pass(patchy, true, d % 10 === 0, day);   // B answers once in ten days
}
check("A relay answering once in ten days is NOT swapped, because it is working",
  planSwaps(cl, patchy, "2026-11-20").swaps.length === 0, "it answered on the 20th");
// …but once it stops entirely, the clock runs without being reset.
let dying = patchy;
for (let d = 21; d <= 27; d++) dying = pass(dying, true, false, `2026-11-${d}`);
check("…and once it stops answering at all, seven days is reached and it goes",
  planSwaps(cl, dying, "2026-11-27").swaps.length === 1, "no good pass to reset it");

const back = pass(h, true, true, "2026-11-06");
check("A relay that comes back before the seventh day is not swapped",
  back[B].lastAnswered === "2026-11-06" && planSwaps(cl, back, "2026-11-11").swaps.length === 0);
const noSpare = planSwaps({ ...cl, spare_relays: [] }, h, "2026-11-08");
check("With no spare left it is reported, not removed", noSpare.swaps.length === 0 && noSpare.stuck[0] === B);
check("A relay listed as both live and spare is refused", !checkCrowdlock({ ...cl, spare_relays: [A] }).ok);

// If the inbox itself stops running for a week, every relay's record goes
// stale at once. That must not swap the whole set out on the next pass — and
// it does not, because planSwaps runs after recordPass, so a relay that
// answers in that pass is already up to date before the swap is considered.
let outage = pass({}, true, true, "2026-11-01");
outage = pass(outage, true, true, "2026-11-21");   // nothing ran in between
check("A fortnight with the inbox down swaps nothing once it answers again",
  planSwaps(cl, outage, "2026-11-21").swaps.length === 0,
  "both relays answered on the pass that matters");

// A relay added to a Crowdlock that never answers once has no lastAnswered to
// measure from, and used to sit there forever.
let never = recordPass({}, [{ relay: A, ok: true }, { relay: B, ok: false }], "2026-11-01");
check("A relay that has never answered is still watched from the day it appeared",
  never[B].lastAnswered === null && never[B].since === "2026-11-01");
for (let d = 2; d <= 8; d++) never = pass(never, true, false, `2026-11-0${d}`.slice(0, 10));
check("…and is swapped after seven days like any other",
  planSwaps(cl, never, "2026-11-08").swaps.length === 1);

// Records written by the old module carry silentSince. They must not restart.
const legacy = { [A]: { lastAnswered: "2026-10-25", silentSince: null },
                 [B]: { lastAnswered: "2026-10-20", silentSince: "2026-10-21" } };
const migrated = pass(legacy, true, false, "2026-11-02");
check("An old record loses silentSince without losing its history",
  !("silentSince" in migrated[B]) && migrated[B].lastAnswered === "2026-10-20");
check("…so a long-silent relay is swapped at once rather than starting again",
  planSwaps(cl, migrated, "2026-11-02").swaps.length === 1);

// ---- Announcements ----
const ann = finalizeEvent(announcementTemplate({ url: "https://somefan.github.io/pub/crowdlocks/pub.json", name: "The Pub Fund", about: "Buying the Red Lion.", network: "mainnet" }, now), generateSecretKey());
check("An announcement is a valid Nostr event, and reads back", verifyEvent(ann) && ann.kind === ANNOUNCE_KIND && announcementFromEvent(ann)?.name === "The Pub Fund");
check("An announcement pointing anywhere but an https .json file is ignored",
  announcementFromEvent(finalizeEvent(announcementTemplate({ url: "http://x.example/c.json", name: "X" }, now), generateSecretKey())) === null
    && announcementFromEvent(finalizeEvent(announcementTemplate({ url: "https://x.example/page.html", name: "X" }, now), generateSecretKey())) === null);
check("An announcement with no name, or junk, is ignored",
  announcementFromEvent(finalizeEvent(announcementTemplate({ url: "https://x.example/c.json", name: "" }, now), generateSecretKey())) === null
    && announcementFromEvent({ ...ann, content: "{nope" }) === null && announcementFromEvent({ ...ann, kind: 1 }) === null);
check("Announced weekly: not again within six days, again on the seventh",
  announcementDue(undefined, "2026-11-01") && !announcementDue("2026-11-01", "2026-11-07") && announcementDue("2026-11-01", "2026-11-08"));

// ------------------------------------------------------------------ reading back
// A pretend relay: newest first, never more than `cap` at a time, like a real one.
const pretendRelay = (all, cap, log = []) => async ({ since, until, limit }) => {
  log.push(until);
  return all.filter((e) => e.created_at >= since && (until === undefined || e.created_at <= until))
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)).slice(0, Math.min(limit, cap));
};
const ev = (id, created_at) => ({ id, created_at });
{
  // One real record from an hour ago, under 2,000 newer pieces of junk, on a relay that gives 300 at a time.
  const real = ev("real", now - 3600);
  const junk = Array.from({ length: 2000 }, (_, i) => ev("junk" + i, now - 1800 + Math.floor(i / 3)));
  const oneBatch = await pretendRelay([real, ...junk], 300)({ since: now - 86400, limit: 1000 });
  const all = await readBack(pretendRelay([real, ...junk], 300), now - 86400);
  check("A record buried under junk is missed by one batch and found by reading back",
    !oneBatch.some((e) => e.id === "real") && all.complete && all.events.length === 2001 && all.events.some((e) => e.id === "real"));

  const asks = [];
  const few = await readBack(pretendRelay([ev("a", now - 10), ev("b", now - 20)], 300, asks), now - 86400);
  check("A quiet relay is read in full, in three short asks", few.complete && few.events.length === 2 && asks.length === 3, `${asks.length} asks`);

  const sameSecond = Array.from({ length: 250 }, (_, i) => ev("s" + i, now - 50));
  const split = await readBack(pretendRelay([...sameSecond, ev("older", now - 60)], 100), now - 86400);
  check("A second holding more than a batch does not stop it reaching older records",
    split.complete && split.events.some((e) => e.id === "older"));

  const old = await readBack(pretendRelay([ev("in", now - 100), ev("out", now - 200)], 300), now - 150);
  check("Nothing older than the window is read", old.complete && old.events.length === 1 && old.events[0].id === "in");

  const deaf = async () => [ev("x", now - 5), ev("y", now - 6)];   // ignores `until`
  const stuck = await readBack(deaf, now - 86400);
  check("A relay that ignores the question is given up on, keeping what it gave", !stuck.complete && stuck.events.length === 2);

  {
    // A flood bigger than one pass reads (second review, 17 November 2026):
    // each pass carries on from where the last stopped, so an older record is
    // reached in the end, however much junk is newer than it.
    const flood = Array.from({ length: 4000 }, (_, i) => ev(`f${i}`, now + 600 - Math.floor(i / 20)));
    const buried = ev("buried", now - 7200);
    const relay = pretendRelay([...flood, buried], 100);
    let cursor, found = false, passes = 0;
    for (; passes < 20 && !found; passes++) {
      const r = await readRelay(relay, now - 86400, cursor, { maxPages: 8 });
      found = r.events.some((e) => e.id === buried.id);
      cursor = r.cursor;
    }
    check("A record under more junk than one pass reads is reached by carrying on from pass to pass", found, `after ${passes} passes`);
    const once = await readRelay(relay, now - 86400, undefined, { maxPages: 8 });
    check("…where one pass on its own never reaches it", !once.events.some((e) => e.id === buried.id) && once.cursor !== null);
  }
  const capped = await readBack(pretendRelay(junk, 300), now - 86400, { maxPages: 3 });
  check("A pass stops at its limit and says it did not finish", !capped.complete && capped.events.length > 300 && capped.events.length < 2000);

  let n = 0;
  const flaky = async (q) => { if (n++ === 1) throw new Error("reading timed out"); return pretendRelay(junk, 300)(q); };
  const part = await readBack(flaky, now - 86400);
  let threw = false; try { await readBack(async () => { throw new Error("down"); }, now - 86400); } catch { threw = true; }
  check("A later batch failing keeps the earlier ones; the first failing is an error", !part.complete && part.events.length === 300 && threw);
}

// ---------------------------------------------------------------------------
// Signatures on commitments, and sending completed payments (signed.mjs).
// Real keys, real signatures, a pretend block explorer.
// ---------------------------------------------------------------------------
{
  const { Transaction, script: bscript } = await import("bitcoinjs-lib");
  const { lockScript } = await import("../js/lockrecord.mjs");
  const { ownerSigned, completedBy, ownersSigned, completedByBoth, coinsAt, coinValue, coinOf, sendCompleted, readTx } = await import("./signed.mjs");
  const { applyCommitments, applySettlement, emptyPile, commitmentEventTemplate, dueToSend } = await import("../js/proposals.mjs");
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  const ownerPriv = utils.randomPrivateKey(), coPriv = utils.randomPrivateKey();
  const pubOf = (k) => Buffer.from(getPublicKey(k, true)).toString("hex");
  const lock = { owner_pubkey: pubOf(ownerPriv), cosigner_pubkey: pubOf(coPriv), locktime: 1900000000 };
  lock.address = lockAddress({ ownerPubkey: lock.owner_pubkey, cosignerPubkey: lock.cosigner_pubkey, locktime: lock.locktime }, "tb");
  const script = Buffer.from(lockScript({ ownerPubkey: lock.owner_pubkey, cosignerPubkey: lock.cosigner_pubkey, locktime: lock.locktime }));
  const FUNDING = "ab".repeat(32), VALUE = 500000;
  const COIN = `${FUNDING}:0`;

  const PROPOSAL = "5e".repeat(32);
  const unsigned = (proposal = PROPOSAL) => {
    const tx = new Transaction(); tx.version = 2; tx.locktime = 0;
    tx.addInput(Buffer.from(FUNDING, "hex").reverse(), 0, 0xfffffffd);
    tx.addOutput(Buffer.from("0014" + "11".repeat(20), "hex"), 499000n);
    tx.addOutput(Buffer.from("6a20" + proposal, "hex"), 0n); // the output naming the proposal
    return tx;
  };
  const der = (compact, hashType = Transaction.SIGHASH_ALL) => bscript.signature.encode(Buffer.from(compact), hashType);
  const sigBy = async (priv, tx, { value = VALUE, high = false, hashType = Transaction.SIGHASH_ALL } = {}) => {
    const sig = await signAsync(tx.hashForWitnessV0(0, script, BigInt(value), hashType), priv);
    let raw = Buffer.from(sig.toCompactRawBytes());
    if (high) raw = Buffer.concat([raw.subarray(0, 32), Buffer.from((N - BigInt("0x" + raw.subarray(32).toString("hex"))).toString(16).padStart(64, "0"), "hex")]);
    return der(raw, hashType);
  };
  const commitment = async (opts = {}) => {
    const tx = unsigned();
    tx.setWitness(0, [Buffer.alloc(0), Buffer.alloc(0), opts.ownerSig ?? await sigBy(ownerPriv, tx, opts), script]);
    return { proposal: PROPOSAL, lock, tx: tx.toHex() };
  };
  const completion = async (record, coSig) => {
    const tx = Transaction.fromHex(record.tx);
    const w = tx.ins[0].witness;
    tx.setWitness(0, [coSig ?? await sigBy(coPriv, tx), w[1], w[2], w[3]]);
    return tx.toHex();
  };
  const coins = { [COIN]: VALUE };

  const real = await commitment();
  check("A commitment its lock's owner signed is recognised", ownerSigned(real, coins).ok === true && coinOf(real.tx) === COIN);
  const junkSig = await commitment({ ownerSig: der(Buffer.concat([Buffer.alloc(31), Buffer.from([1]), Buffer.alloc(31), Buffer.from([1])])) });
  let asked = 0;
  const counting = new Proxy(coins, { get: (t, k) => { asked++; return t[k]; } });
  check("One relabelled for another proposal is refused, before the explorer is asked anything",
    /does not name this proposal/.test(ownerSigned({ ...real, proposal: "6f".repeat(32) }, counting).reason) && asked === 0);
  check("One with a made-up signature is not", ownerSigned(junkSig, coins).ok === false, ownerSigned(junkSig, coins).reason);
  check("One signed by somebody else is not", ownerSigned(await commitment({ ownerSig: await sigBy(coPriv, unsigned()) }), coins).ok === false);
  check("One signed for a different amount than the coin holds is not", ownerSigned(await commitment({ value: VALUE + 1 }), coins).ok === false);
  check("One spending a coin the lock does not hold is refused without a question",
    /does not spend a coin that lock holds/.test(ownerSigned(real, {}).reason));
  check("One whose signature has a high S value is not taken: the network would not pass its payment on",
    ownerSigned(await commitment({ high: true }), coins).ok === false);
  check("One whose signature does not cover the whole payment is not taken",
    ownerSigned(await commitment({ hashType: Transaction.SIGHASH_NONE }), coins).ok === false);
  check("With the explorer unreachable it is left for the next pass, not refused for good",
    /next/.test(ownerSigned(real, null).reason));
  check("Junk that is not a spend of the lock it names is refused",
    ownerSigned({ lock, tx: "00".repeat(60) }, coins).ok === false && ownerSigned({ lock: { ...lock, locktime: lock.locktime + 1 }, tx: real.tx }, coins).ok === false);

  const done = await completion(real);
  check("A completion signed by owner and co-signer is recognised", completedBy(done, real, VALUE).ok === true);
  check("A copy with a made-up co-signer signature is not", completedBy(await completion(real, der(Buffer.concat([Buffer.alloc(31), Buffer.from([2]), Buffer.alloc(31), Buffer.from([2])]))), real, VALUE).ok === false);
  check("The commitment itself, relabelled as completed, is not", completedBy(real.tx, real, VALUE).ok === false);
  const highCo = await completion(real, await sigBy(coPriv, unsigned(), { high: true }));
  check("A stranger's reworked copy of the real completion (high S) is not",
    Transaction.fromHex(highCo).getId() === Transaction.fromHex(done).getId() && completedBy(highCo, real, VALUE).ok === false);

  // The pretend explorer: counts every question.
  const explorer = (over = {}) => {
    const asked = [];
    const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === "string" ? body : JSON.stringify(body) });
    const fetchImpl = async (url, init = {}) => {
      asked.push(`${init.method ?? "GET"} ${url.replace("https://x", "")}`);
      if (over.down) throw new Error("no answer");
      if (url.endsWith(`/address/${lock.address}/utxo`)) return answer(200, [{ txid: FUNDING, vout: 0, value: VALUE, status: { confirmed: !over.unconfirmed } }]);
      if (url.endsWith(`/tx/${FUNDING}`)) return answer(200, { vout: [{ value: VALUE }] });
      // The real explorers answer this for ANY payment, seen or not.
      if (/\/tx\/[0-9a-f]{64}\/status$/.test(url)) return answer(200, { confirmed: false });
      if (/\/tx\/[0-9a-f]{64}\/hex$/.test(url)) return over.has ? answer(200, "00") : answer(404, "Transaction not found");
      if (url.endsWith("/tx") && init.method === "POST") return over.refuse ? answer(400, over.refuse) : answer(200, "txid");
      return answer(404, "not found");
    };
    return { asked, fetchImpl };
  };

  {
    const x = explorer();
    const coinsFor = coinsAt("https://x", x.fetchImpl);
    const many = [real, junkSig, { ...real, tx: (await commitment({ value: VALUE + 5 })).tx }];
    const v = await ownersSigned(many, { coinsFor });
    check("Three records for one lock cost the explorer one question", v[0].ok && !v[1].ok && !v[2].ok && x.asked.length === 1, x.asked.join(", "));
    const other = { ...lock, address: "tb1qanotherlock" };
    const v2 = await ownersSigned([real, { ...real, lock: other }], { coinsFor, limit: 1, seed: "a" });
    check("More locks than one pass asks about: the rest are left for a later pass, not refused for good",
      v2.filter((a) => /later pass/.test(a.reason ?? "")).length === 1);
    const first = new Set();
    for (let i = 0; i < 40; i++) { const r = await ownersSigned([real, { ...real, lock: other }], { coinsFor: async () => coins, limit: 1, seed: String(i) }); first.add(r[0].ok === true); }
    check("…and which ones are asked about changes from pass to pass", first.size === 2);
  }
  // What the second review found (17 November 2026), through the real checks.
  {
    const junkSlot = (b) => { const t = Transaction.fromHex(real.tx); const w = t.ins[0].witness; t.setWitness(0, [Buffer.from([b]), w[1], w[2], w[3]]); return { ...real, tx: t.toHex() }; };
    check("A copy of a real commitment with junk in the co-signer's place is not taken",
      ownerSigned(junkSlot(1), coins).ok === false && /co-signer's place is not empty/.test(ownerSigned(junkSlot(1), coins).reason));
    const x = explorer({ unconfirmed: true });
    const v = await ownersSigned([real], { coinsFor: coinsAt("https://x", x.fetchImpl) });
    check("A commitment spending a coin that hasn't confirmed is not taken", v[0].ok === false, v[0].reason);

    // The pile, with the inbox's own signature check and transaction reader.
    const FP = "cd".repeat(32), member = memberAddressForOwnerKey(lock.owner_pubkey, "tb");
    const cl = { declaration: { sha256: FP, version: 1 }, cosigner_keys: [lock.cosigner_pubkey], network: "testnet4" };
    const reg = { members: [{ n: 1, address: member }], locks: [{ ...lock, member }] };
    const prop = { hash: PROPOSAL, opens: "2027-01-01T00:00:00Z", closes: "2027-01-29T00:00:00Z", settles_by: "2027-02-12T00:00:00Z" };
    const t0 = Date.parse(prop.opens) / 1000;
    let n = 0;
    const ev = (item, at) => ({ id: String(n++).padStart(64, "0"), ...commitmentEventTemplate({ proposal: PROPOSAL, ...item }, FP, at) });
    const coinsFor = async () => coins;
    const run = (pile, events, register = reg) => applyCommitments(pile, events, { crowdlock: cl, proposal: prop, register, nowIso: "2027-01-02T00:00:00Z", readTx, signed: (rs) => ownersSigned(rs, { coinsFor }) });
    const flood = [1, 2, 3, 4, 5].map((b, i) => ev({ type: "commitment", record: junkSlot(b) }, t0 + 1 + i));
    const r1 = await run(emptyPile(PROPOSAL), [...flood, ev({ type: "commitment", record: real }, t0 + 500)]);
    check("Five junk copies posted first take none of the lock's places, and the real one gets in",
      r1.pile.commitments.length === 1 && r1.pile.commitments[0].record.tx === real.tx, r1.outcome.map((o) => o.reason ?? "added").join("; ").slice(0, 60));
    const long = (h) => { const i = h.indexOf("02", h.indexOf("fdffffff") + 8); return h.slice(0, i) + "fd0200" + h.slice(i + 2); };
    const r2 = await run(r1.pile, [ev({ type: "commitment", record: { ...real, tx: long(real.tx) } }, t0 + 600)]);
    check("The same commitment written another way is the same commitment", r2.pile === r1.pile && readTx(long(real.tx))?.txid === readTx(real.tx).txid);
    const r3 = await run(emptyPile(PROPOSAL), [ev({ type: "commitment", record: { ...real, tx: long(real.tx) } }, t0 + 1)]);
    check("…and what is kept is its standard encoding", r3.pile.commitments[0]?.record.tx === real.tx);
    const shortLock = { ...lock, locktime: Date.parse(prop.settles_by) / 1000 - 86400 };
    const r4 = await run(emptyPile(PROPOSAL), [ev({ type: "commitment", record: { ...real, lock: shortLock } }, t0 + 1)], { ...reg, locks: [{ ...shortLock, member }] });
    check("A commitment from a lock that opens before settling ends is not taken",
      r4.pile.commitments.length === 0 && /opens before this proposal's settling ends/.test(r4.outcome[0]?.reason ?? ""), r4.outcome[0]?.reason);

    // A completion written another way, posted first, does not take the real one's place.
    const pile = { ...emptyPile(PROPOSAL), commitments: [{ submitted: "2027-01-02T00:00:00Z", record: real }] };
    const items = [{ type: "completed", tx: long(done), at: t0 + 10 }, { type: "completed", tx: done, at: t0 + 20 }];
    const canonical = (h) => { try { return Transaction.fromHex(h).toHex(); } catch { return null; } };
    const txidOf = (h) => readTx(h)?.txid ?? null;
    const st = await applySettlement(pile, items, { crowdlock: cl, hash: PROPOSAL, hrp: "tb", addressOf: memberAddressForOwnerKey, txidOf, nowIso: "2027-01-30T00:00:00Z", canonical,
      completedBy: (c) => completedByBoth(c, { valueFor: async () => VALUE }) });
    check("A completion written another way and posted first is kept, and sent, in the standard encoding",
      st.pile.completed?.length === 1 && st.pile.completed[0].tx === done && dueToSend(st.pile, 25, txidOf)[0]?.tx === done);
  }
  {
    const x = explorer();
    const v = await completedByBoth([{ tx: done, record: real }, { tx: highCo, record: real }], { valueFor: coinValue("https://x", x.fetchImpl) });
    check("Two completions of one commitment cost one question, and only the real one passes", v[0].ok && !v[1].ok && x.asked.length === 1);
    const down = explorer({ down: true });
    const v2 = await completedByBoth([{ tx: done, record: real }], { valueFor: coinValue("https://x", down.fetchImpl) });
    check("With the explorer down a completion waits for the next pass", !v2[0].ok && /next/.test(v2[0].reason));
  }

  const payment = { txid: Transaction.fromHex(done).getId(), tx: done };
  {
    const x = explorer();
    const r = await sendCompleted("https://x", payment, x.fetchImpl);
    check("A completed payment the network has never seen is SENT (until 17 November 2026 it was marked sent and never was)",
      r.state === "sent" && x.asked.some((q) => q === "POST /tx") && !x.asked.some((q) => q.endsWith("/status")), x.asked.join(", "));
  }
  {
    const x = explorer({ has: true });
    const r = await sendCompleted("https://x", payment, x.fetchImpl);
    check("One the network already has is not sent again", r.state === "already on the network" && !x.asked.some((q) => q.startsWith("POST")));
  }
  {
    const r = await sendCompleted("https://x", payment, explorer({ refuse: "sendrawtransaction RPC error: bad-txns-inputs-missingorspent" }).fetchImpl);
    check("One the network refuses is not marked sent, and the reason is kept", r.state === null && /missingorspent/.test(r.refused));
    const r2 = await sendCompleted("https://x", payment, explorer({ refuse: "sendrawtransaction RPC error: Transaction already in block chain" }).fetchImpl);
    check("One somebody else sent in the meantime counts as on the network", r2.state === "already on the network");
    const r3 = await sendCompleted("https://x", payment, explorer({ down: true }).fetchImpl);
    check("With the explorer down nothing is marked sent", r3.state === null && !!r3.unreachable);
  }
}

console.log("-".repeat(80));
console.log(failures === 0 ? "The relay inbox takes in valid records and only those." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
