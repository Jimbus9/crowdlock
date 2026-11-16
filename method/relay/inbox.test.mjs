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
import { readBack } from "./nostr.mjs";

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

  const capped = await readBack(pretendRelay(junk, 300), now - 86400, { maxPages: 3 });
  check("A pass stops at its limit and says it did not finish", !capped.complete && capped.events.length > 300 && capped.events.length < 2000);

  let n = 0;
  const flaky = async (q) => { if (n++ === 1) throw new Error("reading timed out"); return pretendRelay(junk, 300)(q); };
  const part = await readBack(flaky, now - 86400);
  let threw = false; try { await readBack(async () => { throw new Error("down"); }, now - 86400); } catch { threw = true; }
  check("A later batch failing keeps the earlier ones; the first failing is an error", !part.complete && part.events.length === 300 && threw);
}

console.log("-".repeat(80));
console.log(failures === 0 ? "The relay inbox takes in valid records and only those." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
