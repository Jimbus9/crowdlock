// The app's Crowdlock loader, tested against the real files in this repository.
//
// Run: node crowdlocks.test.mjs   (needs no chain)
//
// Milestone 2 is done when a tampered Crowdlock is refused and a test
// registration reaches a test register. This is the first half: the loader
// the phone runs, given the real Kop Fund and test Crowdlock files, and then
// given doctored copies of them — which it must turn away, with the reason.

import { readFileSync } from "node:fs";
import { esploraChain } from "../src/wallet/esplora.mjs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadCrowdlock, baseFor, membershipOf, committedTotal, submitJoin, STARTING_LIST, shortBtc, poundsPerBtc, COUNTING_RULE_URL, submitLock, locksOnRegister, openLinkFor, fileUrlFromOpenLink, shareLinkFor, rankFound, matchesSearch } from "../src/crowdlocks.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = "https://crowdlock.org/";
// The Kop Fund has its own site; the tests serve its frozen copy (method/fixtures/the-kop-fund).
const KOP_SITE = "https://thekopfund.org/";
const KOP_FIX = join(REPO, "method/fixtures/the-kop-fund");

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(66)} ${detail}`);
};

/** A fetch that serves this repository as if it were the live site, with optional tampering. */
const siteFetch = (tamper = {}) => async (url, init = {}) => {
  const u = String(url);
  const kopSite = u.startsWith(KOP_SITE);
  if (!kopSite && !u.startsWith(SITE)) return new Response("not found", { status: 404 });
  const path = u.slice((kopSite ? KOP_SITE : SITE).length).split("?")[0];
  if (tamper[(kopSite ? "kop:" : "") + path] !== undefined) return new Response(tamper[(kopSite ? "kop:" : "") + path], { status: 200 });
  try { return new Response(readFileSync(join(kopSite ? KOP_FIX : REPO, path)), { status: 200 }); }
  catch { return new Response("not found", { status: 404 }); }
};

console.log("-".repeat(80));
console.log("LOADING THE REAL CROWDLOCKS");
console.log("-".repeat(80));

check("A file in crowdlocks/ reads its paths from the site root",
  baseFor(`${SITE}crowdlocks/kop-fund-testnet4.json`) === SITE, baseFor(`${SITE}crowdlocks/kop-fund-testnet4.json`));
check("A file anywhere else reads them from its own folder",
  baseFor("https://example.org/club/my-crowdlock.json") === "https://example.org/club/");

const kop = await loadCrowdlock(`${KOP_SITE}crowdlocks/kop-fund.json`, siteFetch());
check("The Kop Fund loads and passes every check", kop.ok, kop.ok ? kop.crowdlock.network : kop.problems.join("; "));
check("…its statement is byte-for-byte the one member 1 signed",
  kop.ok && kop.statement === JSON.parse(readFileSync(join(KOP_FIX, "registrations.json"), "utf8")).declaration.statement);
check("…and it knows member 1", kop.ok && membershipOf(kop.register, "BC1QX22LEJ8SLM4G6F5L85TTE0PERAHA7KM30LQXW7")?.n === 1);

const test = await loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, siteFetch());
check("The test Crowdlock loads and passes every check", test.ok, test.ok ? test.crowdlock.network : test.problems.join("; "));
check("…it is on testnet4, and takes registrations through its relays, not an endpoint",
  test.ok && test.crowdlock.network === "testnet4" && test.crowdlock.relays.length > 0 && !test.crowdlock.join_endpoint);
check("…and a different declaration from The Kop Fund", test.ok && kop.ok && test.statement !== kop.statement);
check("Both are on the app's starting list, The Kop Fund at its own domain",
  STARTING_LIST.length === 2 && STARTING_LIST[0] === `${KOP_SITE}crowdlocks/kop-fund.json` && STARTING_LIST[1] === `${SITE}crowdlocks/kop-fund-testnet4.json`);

console.log("-".repeat(80));
console.log("REFUSING WHAT IT SHOULD");
console.log("-".repeat(80));

const refuses = async (what, result, expect) => {
  const r = await result;
  const ok = !r.ok && r.problems.some((p) => p.includes(expect));
  check(what, ok, r.ok ? "ACCEPTED IT" : r.problems[0].slice(0, 46));
};

const realDecl = readFileSync(join(KOP_FIX, "spec/declaration-v1.txt"), "utf8");
await refuses("A declaration altered by one word",
  loadCrowdlock(`${KOP_SITE}crowdlocks/kop-fund.json`, siteFetch({ "kop:spec/declaration-v1.txt": realDecl.replace("glory", "money") })),
  "hashes to");
const doctored = JSON.parse(readFileSync(join(REPO, "crowdlocks/kop-fund-testnet4.json"), "utf8"));
doctored.declaration.sha256 = JSON.parse(readFileSync(join(KOP_FIX, "crowdlocks/kop-fund.json"), "utf8")).declaration.sha256;
await refuses("A Crowdlock file claiming somebody else's fingerprint",
  loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, siteFetch({ "crowdlocks/kop-fund-testnet4.json": JSON.stringify(doctored) })),
  "hashes to");
const swappedReg = JSON.parse(readFileSync(join(REPO, "crowdlocks/test/registrations.json"), "utf8"));
swappedReg.declaration.sha256 = "0".repeat(64);
await refuses("A register that names a different declaration",
  loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, siteFetch({ "crowdlocks/test/registrations.json": JSON.stringify(swappedReg) })),
  "");
await refuses("A link that is not https", loadCrowdlock("http://crowdlock.org/crowdlocks/kop-fund.json", siteFetch()), "https");
await refuses("Something that is not a link", loadCrowdlock("the kop fund please", siteFetch()), "not a link");
await refuses("A link to nothing, said plainly", loadCrowdlock(`${SITE}crowdlocks/nonesuch.json`, siteFetch()), "no Crowdlock file at that link");

console.log("-".repeat(80));
console.log("TOTALS AND JOINING");
console.log("-".repeat(80));

// Locks for these tests' registers: real ones, whose address is the lock
// their terms make and whose owner is the member named. A register is only
// believed about a record that checks out (see "A register cannot count…").
const { lockAddress: lockAddressFor } = await import("../../method/js/lockrecord.mjs");
const { memberAddressForOwnerKey: memberFor } = await import("../../method/js/verify.mjs");
const TEST_COSIGNER = "03" + "c0".repeat(32);
// Owners with real keys, so a member's signature over the declaration really
// verifies: only then is a lock's owner a committed member (OpenAI review H-03).
const noble = await import("../../method/js/vendor/noble-secp256k1.js");
const { messageHash: msgHash } = await import("../../method/js/verify.mjs");
const { membershipStatement: statementOf } = await import("../../method/js/crowdlock.mjs");
const DECL = { title: "Test Declaration", version: 1, sha256: "ab".repeat(32) };
const privOf = new Map();
const realLock = (hrp, n, locktime) => {
  const priv = Buffer.alloc(32, n);
  const owner_pubkey = Buffer.from(noble.getPublicKey(priv, true)).toString("hex");
  const member = memberFor(owner_pubkey, hrp);
  privOf.set(member, priv);
  return { owner_pubkey, cosigner_pubkey: TEST_COSIGNER, locktime, member,
    address: lockAddressFor({ ownerPubkey: owner_pubkey, cosignerPubkey: TEST_COSIGNER, locktime }, hrp) };
};
const signFor = async (address) => {
  const sig = await noble.signAsync(msgHash(statementOf({ declaration: DECL }, 1)), privOf.get(address));
  return Buffer.concat([Buffer.from([31 + sig.recovery]), Buffer.from(sig.toCompactRawBytes())]).toString("base64");
};
const membersOf = async (locks, extra = []) => Promise.all([...new Set(locks.map((l) => l.member)), ...extra]
  .map(async (address, i) => ({ n: i + 1, address, ...(privOf.has(address) ? { signature: await signFor(address) } : {}) })));

// A pretend chain with one lock in date and above the minimum, one below it,
// and one whose date has passed — only the first may count.
const now = 1800000000;
const counts = realLock("tb", 1, now + 1000), tooSmall = realLock("tb", 2, now + 1000), lapsed = realLock("tb", 2, now - 1);
const fakeLoaded = {
  crowdlock: { network: "testnet4", chain_api: "https://chain.example", minimum_counted_lock_sats: 10000, cosigner_keys: [TEST_COSIGNER], declaration: DECL },
  // Three signed; only member one holds a lock that counts.
  register: { members: await membersOf([counts, tooSmall], ["tb1qthree"]), locks: [counts, tooSmall, lapsed, { ...counts, address: counts.address.toUpperCase() }] },
};
const chainFetch = async (url) => {
  const coins = { [counts.address]: [{ txid: "a", vout: 0, value: 50000, status: { confirmed: true } }, { txid: "b", vout: 0, value: 999, status: { confirmed: false } }],
    [tooSmall.address]: [{ txid: "c", vout: 0, value: 5000, status: { confirmed: true } }],
    [lapsed.address]: [{ txid: "d", vout: 0, value: 90000, status: { confirmed: true } }] };
  const addr = String(url).split("/address/")[1].split("/")[0];
  return Response.json(coins[addr] ?? coins[addr.toLowerCase()] ?? []);
};
const totals = await committedTotal(fakeLoaded, chainFetch, now);
check("The committed total counts only confirmed, in-date, above-minimum locks, once each",
  totals.sats === 50000n && totals.locks === 1, `${totals.sats} sats in ${totals.locks} lock(s)`);
check("…and the only people it counts are committed members, never signatures",
  totals.members === 1, `${totals.members} committed of 3 signed`);

// A register cannot count what is not a lock. Found by review on 17 November
// 2026: the total believed whatever address a register listed, so a changed
// register (or a founder's own) could name any well-funded address a "lock".
{
  const asked = [];
  const rich = async (url) => { asked.push(String(url)); return Response.json([{ txid: "f", vout: 0, value: 5000000000, status: { confirmed: true } }]); };
  const good = realLock("tb", 7, now + 1000);
  const base = { network: "testnet4", chain_api: "https://chain.example", minimum_counted_lock_sats: 10000, cosigner_keys: [TEST_COSIGNER], declaration: DECL };
  const notALock = [
    ["an ordinary address called a lock", { ...good, address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx" }],
    ["a lock with another Crowdlock's co-signer", realLockWith("03" + "dd".repeat(32))],
    ["a record with no keys at all", { address: good.address, member: good.member, locktime: good.locktime }],
  ];
  function realLockWith(cosigner) {
    const owner_pubkey = "02" + "07".repeat(32);
    return { owner_pubkey, cosigner_pubkey: cosigner, locktime: now + 1000, member: memberFor(owner_pubkey, "tb"),
      address: lockAddressFor({ ownerPubkey: owner_pubkey, cosignerPubkey: cosigner, locktime: now + 1000 }, "tb") };
  }
  const results = [];
  for (const [what, lock] of notALock) {
    asked.length = 0;
    const t = await committedTotal({ crowdlock: base, register: { members: await membersOf([good]), locks: [lock] } }, rich, now);
    results.push(t.sats === 0n && t.members === 0 && t.notLocks === 1 && asked.length === 0 ? null : `${what}: ${t.sats} sats, ${asked.length} asked`);
  }
  check("A register cannot count what is not a lock: an ordinary address, another Crowdlock's lock, or a record with no keys",
    results.every((r) => r === null), results.filter(Boolean).join(" | "));
  // A real lock's money counts whoever the record says owns it (the counting
  // rule); its owner is counted as a committed member only if they are one,
  // and who that is comes from the lock's own key, not the record's label.
  const someoneElse = "tb1qsomebodyelse";
  const mislabelled = await committedTotal({ crowdlock: base, register: { members: [{ n: 1, address: someoneElse }], locks: [{ ...good, member: someoneElse }] } }, rich, now);
  check("A real lock credited to a member who does not own it: the money counts, the member does not",
    mislabelled.sats === 5000000000n && mislabelled.members === 0, `${mislabelled.sats} sats, ${mislabelled.members} members`);
  const honest = await committedTotal({ crowdlock: base, register: { members: await membersOf([good]), locks: [good] } }, rich, now);
  check("…and the chain is not even asked about one, while a real lock still counts, with its owner", honest.sats === 5000000000n && honest.notLocks === 0 && honest.members === 1);
  const forged = await committedTotal({ crowdlock: base, register: { members: [{ n: 1, address: good.member, signature: "INVALID" }], locks: [good] } }, rich, now);
  check("A member listed with a signature that doesn't verify: the money counts, the member does not (OpenAI review H-03)", forged.sats === 5000000000n && forged.members === 0, `${forged.members} members`);
}

let posted = null;
const endpointFetch = async (url, init) => { posted = { url, body: JSON.parse(init.body) }; return Response.json({ ok: true, n: 7 }); };
const joined = await submitJoin({ join_endpoint: "https://example.com/join/submit?c=x" }, { address: "tb1qme", signature: "sig" }, endpointFetch);
check("Joining posts the address and signature to the Crowdlock's own endpoint",
  joined.ok && joined.n === 7 && posted.url.endsWith("?c=x") && posted.body.address === "tb1qme");
const noEndpoint = await submitJoin({}, { address: "tb1qme", signature: "sig" }, endpointFetch);
check("With no endpoint, it says to use a pull request instead", !noEndpoint.ok && noEndpoint.error.includes("pull request"));
const down = await submitJoin({ join_endpoint: "https://x" }, { address: "a", signature: "s" }, async () => { throw new Error("offline"); });
check("If the register can't be reached, it says the signature is fine", !down.ok && down.error.includes("signature is fine"));

check("The minimum is written plainly", shortBtc(200000) === "0.002 BTC" && shortBtc(10000) === "0.0001 BTC" && shortBtc(100000000) === "1 BTC");
const priceFetch = async (url) => (url === "https://mempool.space/api/v1/prices" ? Response.json({ USD: 60000, GBP: 46000 }) : new Response("", { status: 404 }));
check("Real bitcoin gets a rough pound figure", (await poundsPerBtc({ network: "mainnet", chain_api: "https://mempool.space/api" }, priceFetch)) === 46000);
check("Test bitcoin gets none, because it has no value", (await poundsPerBtc({ network: "testnet4", chain_api: "x" }, priceFetch)) === null);
check("No price source means no pound figure, not a wrong one", (await poundsPerBtc({ network: "mainnet", chain_api: "https://down" }, async () => { throw new Error("offline"); })) === null);
check("The link points at the counting rule's section on the minimum", COUNTING_RULE_URL.endsWith("counting-rule.md#the-minimum"));

{
  // Only genuine locks of the member's own key count as theirs (second review,
  // 17 November 2026): the record's `member` label is never believed.
  const { lockAddress } = await import("../../method/js/lockrecord.mjs");
  const { memberAddressForOwnerKey } = await import("../../method/js/verify.mjs");
  const OWN = "02" + "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", CO = "03" + "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5".slice(0, 64);
  const OTHER = "02" + "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
  const cl = { network: "testnet4", cosigner_keys: [CO] };
  const me = memberAddressForOwnerKey(OWN, "tb");
  const T = 1900000000;
  const real = { address: lockAddress({ ownerPubkey: OWN, cosignerPubkey: CO, locktime: T }, "tb"), member: me.toUpperCase(), owner_pubkey: OWN, cosigner_pubkey: CO, locktime: T };
  const reg = { members: [{ n: 1, address: me }], locks: [
    real,
    { address: "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m", member: me, owner_pubkey: OTHER, cosigner_pubkey: CO, locktime: T },  // someone's funded address, labelled as mine
    { ...real, locktime: T + 5 * 31557600 },                                                                   // my real lock, with another date
    { ...real, address: lockAddress({ ownerPubkey: OTHER, cosignerPubkey: CO, locktime: T }, "tb"), owner_pubkey: OTHER }, // somebody else's lock, labelled as mine
  ] };
  const mine = locksOnRegister(reg, me, cl);
  check("A member's own locks are found on the register, whatever the case", mine.length === 1 && mine[0].address === real.address && mine[0].cosignerPubkey === CO && mine[0].locktime === T);
  check("…and a record that only says it is theirs, or gives their lock another date, is not", mine.length === 1, `${mine.length} found`);
}

{
  // A lock is ready to take home once the network's clock is past its date,
  // not on it: the network refuses the owner's spend until then.
  const { lockState } = await import("../src/wallet/core.mjs");
  const one = { utxos: async () => [{ txid: "a".repeat(64), vout: 0, value: 1000, confirmed: true }] };
  check("On its date exactly, a lock is still locked", (await lockState({ chain: one, lock: { address: "x", locktime: 1900000000 }, medianTime: 1900000000 })).state === "locked");
  check("…and a second later it is ready to take home", (await lockState({ chain: one, lock: { address: "x", locktime: 1900000000 }, medianTime: 1900000001 })).state === "lapsed");
}

{
  // A Crowdlock's destination rules, remembered (second review, 17 November 2026).
  const { rulesOf, rulesChanges } = await import("../src/crowdlocks.mjs");
  const ZERO = "0".repeat(64), I = "3a".repeat(32);
  const e1 = { instance: I, index: 1, op: "add", address: "tb1qshop", text: "t", added: "x", prev: ZERO };
  const P = await import("../../method/js/proposals.mjs");
  const e2 = { instance: I, index: 2, op: "revoke", address: "tb1qshop", text: "t", added: "x", prev: P.destinationHash(e1) };
  const base = { crowdlock: { attestor_keys: ["02aa"], attestor_threshold: 1, destination_wait_days: 7 }, destinations: { entries: [e1, e2] } };
  const seen = rulesOf(base);
  check("Nothing seen before: nothing to warn about", !rulesChanges(null, seen).changed);
  check("The same rules: no warning", !rulesChanges(seen, rulesOf(structuredClone(base))).changed);
  const grown = { ...base, destinations: { entries: [e1, e2, { ...e1, index: 3, prev: P.destinationHash(e2) }] } };
  check("The list growing at its end is not a change", !rulesChanges(seen, rulesOf(grown)).changed);
  check("An attestor added is", rulesChanges(seen, rulesOf({ ...base, crowdlock: { ...base.crowdlock, attestor_keys: ["02aa", "02bb"] } })).changed);
  check("The waiting period shortened is", rulesChanges(seen, rulesOf({ ...base, crowdlock: { ...base.crowdlock, destination_wait_days: 0 } })).changed);
  check("A revocation cut off the end of the list is", /shorter/.test(rulesChanges(seen, rulesOf({ ...base, destinations: { entries: [e1] } })).notes.join(" ")));
  check("An earlier entry rewritten is", /rewritten/.test(rulesChanges(seen, rulesOf({ ...base, destinations: { entries: [{ ...e1, address: "tb1qmine" }, e2] } })).notes.join(" ")));
}
let lockPosted = null;
const lockOk = await submitLock({ lock_endpoint: "https://example.com/lock/submit?c=x" },
  { ownerPubkey: "02aa", cosignerPubkey: "02cc", locktime: 9, address: "tb1qa" },
  async (url, init) => { lockPosted = { url, body: JSON.parse(init.body) }; return Response.json({ ok: true }); });
check("A lock is posted to the Crowdlock's own lock endpoint, in the register's field names",
  lockOk.ok && lockPosted.url.endsWith("?c=x") && lockPosted.body.owner_pubkey === "02aa" && lockPosted.body.cosigner_pubkey === "02cc" && lockPosted.body.locktime === 9);
const again = await submitLock({ lock_endpoint: "https://x" }, { ownerPubkey: "a", cosignerPubkey: "b", locktime: 1, address: "c" },
  async () => Response.json({ error: "that lock is already on the register" }, { status: 409 }));
check("A lock already on the register counts as done", again.ok);
const early = await submitLock({ lock_endpoint: "https://x" }, { ownerPubkey: "a", cosignerPubkey: "b", locktime: 1, address: "c" },
  async () => Response.json({ error: "there are no confirmed coins at that lock address yet" }, { status: 409 }));
check("Any other refusal is passed on as it was given", !early.ok && early.error.includes("no confirmed coins"));

// An explorer that never answers: the app must give up and say so, not spin forever.
const silent = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
let gaveUp = null;
try { await esploraChain("https://x", silent, 50).utxos("tb1qme"); } catch (e) { gaveUp = e.message; }
check("An explorer that never answers is given up on, with a plain reason", /didn't answer/.test(gaveUp ?? ""), gaveUp ?? "IT WAITED FOREVER");
let unreachable = null;
try { await esploraChain("https://x", async () => { throw new TypeError("Network request failed"); }, 50).utxos("tb1qme"); } catch (e) { unreachable = e.message; }
check("One that can't be reached says so too", /couldn't reach/.test(unreachable ?? ""));

// An explorer that says "too many requests": wait, try again, and if it never
// relents, say so plainly. And don't ask the same thing twice in quick succession.
const noWait = { wait: async () => {} };
let calls = 0;
const busyOnce = async () => (++calls === 1 ? new Response("slow down", { status: 429 }) : Response.json([]));
const after = await esploraChain("https://x", busyOnce, 50, noWait).utxos("tb1qme");
check("A 'too many requests' is waited out and asked again", Array.isArray(after) && calls === 2, `${calls} calls`);
let waitedFor = null;
const busyAlways = async () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
let busyMsg = null;
try { await esploraChain("https://x", busyAlways, 50, { wait: async (ms) => { waitedFor = ms; } }).utxos("tb1qme"); } catch (e) { busyMsg = e.message; }
check("If it never relents, the fan is told it's busy, in plain words", /busy — wait a minute and try again/.test(busyMsg ?? ""), busyMsg ?? "NO ERROR");
check("The explorer's own 'try again in' is honoured", waitedFor === 3000, String(waitedFor));
calls = 0;
const counting = async () => { calls++; return Response.json([]); };
const c1 = esploraChain("https://x", counting, 50), c2 = esploraChain("https://x", counting, 50);
await Promise.all([c1.utxos("tb1qa"), c1.utxos("tb1qa"), c2.utxos("tb1qa")]);
check("The same question asked several times at once goes to the explorer once", calls === 1, `${calls} calls`);
await c1.utxos("tb1qb");
check("A different question is still asked", calls === 2, `${calls} calls`);
await c1.broadcast("00");
calls = 0;
await c2.utxos("tb1qa");
check("After sending, answers already in hand are forgotten", calls === 1, `${calls} calls`);
calls = 0;
const flaky = async () => (++calls === 1 ? new Response("no", { status: 500 }) : Response.json([]));
const fc = esploraChain("https://x", flaky, 50);
try { await fc.utxos("tb1qa"); } catch {}
await fc.utxos("tb1qa");
check("A failed answer isn't remembered", calls === 2, `${calls} calls`);

// The explorer going quiet. One unanswered question is usually a hiccup, so a
// question is asked twice before giving up; once it has given up, the
// questions queued behind it fail at once rather than each waiting in turn.
{
  const { askAfresh } = await import("../src/wallet/esplora.mjs");
  const { lockState } = await import("../src/wallet/core.mjs");
  const never = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  let n = 0;
  const hiccup = async (url, init) => (++n === 1 ? never(init) : Response.json([]));
  const got = await esploraChain("https://h", hiccup, 50).utxos("tb1qa");
  check("A question that goes unanswered once is asked again, and answered", Array.isArray(got) && n === 2, `${n} calls`);

  n = 0;
  const dead = async (url, init) => { n++; return never(init); };
  const d = esploraChain("https://d", dead, 50, { downMs: 80 });
  let why = null;
  const t0 = Date.now();
  try { await d.utxos("tb1qa"); } catch (e) { why = e.message; }
  const took = Date.now() - t0;
  check("One that stays quiet is given up on after two tries, inside the time it names", /didn't answer within 0.05 seconds/.test(why ?? "") && n === 2 && took < 200, `${n} calls, ${took} ms, ${why}`);
  let next = null;
  const t1 = Date.now();
  try { await d.utxos("tb1qb"); } catch (e) { next = e.message; }
  check("The questions queued behind it fail at once, without asking", next === why && n === 2 && Date.now() - t1 < 20, `${n} calls`);
  await new Promise((r) => setTimeout(r, 100));
  try { await d.utxos("tb1qb"); } catch {}
  check("…and a moment later the explorer is asked again", n === 4, `${n} calls`);
  try { await d.utxos("tb1qc"); } catch {}
  askAfresh(dead);
  try { await d.utxos("tb1qc"); } catch {}
  check("Checking again by hand asks straight away", n === 6, `${n} calls`);

  n = 0;
  let sendErr = null;
  try { await esploraChain("https://s", dead, 50).broadcast("00"); } catch (e) { sendErr = e.message; }
  check("A payment is only ever sent once, answered or not", n === 1 && /didn't answer/.test(sendErr ?? ""), `${n} calls`);

  // Asking less. A block never changes, so the clock's second question is asked once.
  const asked = [];
  const tip = async (url) => { asked.push(String(url)); return String(url).endsWith("/blocks/tip/hash") ? new Response("abc") : Response.json({ mediantime: 1000 }); };
  const tc = esploraChain("https://t", tip, 50);
  await tc.medianTime(); askAfresh(tip); const mt = await tc.medianTime();
  check("Checking again re-reads the chain's tip but not a block it already has",
    mt === 1000 && asked.filter((u) => u.endsWith("/blocks/tip/hash")).length === 2 && asked.filter((u) => u.includes("/block/abc")).length === 1, asked.join(" "));

  // A lock found empty after its date is finished: it isn't asked about again
  // until the fan checks by hand (the caller empties the note then).
  const q = [];
  const coinsAt = { tb1qlive: [{ txid: "aa", vout: 0, value: 5000, confirmed: true }] };
  const fakeChain = {
    utxos: async (a) => { q.push(`utxos ${a}`); return coinsAt[a] ?? []; },
    everFunded: async (a) => { q.push(`ever ${a}`); return a !== "tb1qnever"; },
  };
  const finished = new Map();
  const past = { address: "tb1qhome", locktime: 500 }, never2 = { address: "tb1qnever", locktime: 500 };
  const ahead = { address: "tb1qahead", locktime: 5000 }, live = { address: "tb1qlive", locktime: 500 };
  const st = (lock, quick = false) => lockState({ chain: fakeChain, lock, medianTime: 1000, quick, finished });
  const first = await st(past);
  const again2 = await st(past);
  check("A lock taken home is asked about once, then remembered as taken home",
    first.state === "withdrawn" && again2.state === "withdrawn" && q.length === 2, q.join(", "));
  q.length = 0;
  const e1 = await st(never2), e2 = await st(never2);
  check("…and one that never held money is remembered as empty", e1.state === "empty" && e2.state === "empty" && q.length === 2, q.join(", "));
  q.length = 0;
  await st(ahead); await st(ahead); await st(live); await st(live);
  check("A lock whose date is ahead, or that still holds money, is asked about every time",
    q.filter((x) => x === "utxos tb1qahead").length === 2 && q.filter((x) => x === "utxos tb1qlive").length === 2, q.join(", "));
  finished.clear(); q.length = 0;
  const quick1 = await st(past, true), quick2 = await st(past, true);
  check("Home's quick look asks one question the first time and none after", quick1.state === "withdrawn" && quick2.state === "withdrawn" && q.join() === "utxos tb1qhome", q.join(", "));
  q.length = 0;
  const full = await st(never2, true).then(() => st(never2));
  check("A page that needs the whole answer asks only for the part Home skipped", full.state === "empty" && q.join() === "utxos tb1qnever,ever tb1qnever", q.join(", "));
  finished.clear(); q.length = 0;
  coinsAt.tb1qhome = [{ txid: "bb", vout: 0, value: 7000, confirmed: true }];
  const found = await st(past);
  check("Checking by hand finds money sent to an old lock", found.state === "lapsed" && found.confirmed === 7000n);
  const plain = await lockState({ chain: fakeChain, lock: never2, medianTime: 1000 });
  check("Without a note to keep, a lock is read as it always was", plain.state === "empty");

  // The co-signer's record: a lock well past its date has a closed record.
  const { coSignerRecord } = await import("../src/crowdlocks.mjs");
  const now = 2000000000;
  const old = realLock("tb", 9, now - 4 * 3600), recent = realLock("tb", 9, now - 3600), open = realLock("tb", 9, now + 3600);
  const early = { txid: "e9", status: { confirmed: true, block_time: now - 5 * 3600 }, vin: [{ prevout: { scriptpubkey_address: old.address, value: 5000 }, witness: ["aa", "", "bb", "cc"] }], vout: [{ scriptpubkey_address: "tb1qelsewhere" }] };
  const seenUrls = [];
  const recFetch = async (url) => { seenUrls.push(String(url)); return Response.json(String(url).includes(old.address) ? [early] : []); };
  const reg = { crowdlock: { network: "testnet4", chain_api: "https://closed", cosigner_keys: [TEST_COSIGNER] }, register: { members: await membersOf([old]), locks: [old, recent, open] }, destinations: { entries: [] } };
  const r1 = await coSignerRecord(reg, recFetch, now);
  askAfresh(recFetch);
  const r2 = await coSignerRecord(reg, recFetch, now);
  const times = (a) => seenUrls.filter((u) => u.includes(a)).length;
  check("A lock well past its date has its record read once; it still shows what was found",
    times(old.address) === 1 && r1.releases.length === 1 && r2.releases.length === 1 && r2.releases[0].txid === "e9", seenUrls.join(" "));
  check("…one just past its date, or still ahead of it, is read every time", times(recent.address) === 2 && times(open.address) === 2);

  // Security loop, round 1. The record must not depend on the register
  // staying as it was: a lock taken off it, or with its date bent so it no
  // longer reads as a lock, is still checked by a phone that saw it before.
  {
    const { locksToWatch, locksSeen } = await import("../src/crowdlocks.mjs");
    const remembered = locksSeen(reg);
    check("The phone remembers the terms of every lock it has seen on the register",
      remembered.length === 3 && remembered.every((l) => l.owner_pubkey && l.cosigner_pubkey && Number.isInteger(l.locktime) && !("address" in l)));
    const without = { ...reg, register: { ...reg.register, locks: [recent, open] } };
    askAfresh(recFetch);
    const hidden = await coSignerRecord(without, recFetch, now);
    const kept = await coSignerRecord(without, recFetch, now, { remembered });
    check("An early release whose lock was taken off the register is still on the record of a phone that saw the lock",
      hidden.releases.length === 0 && kept.releases.length === 1 && kept.releases[0].txid === "e9" && kept.gone === 1, `${kept.releases.length} release(s), ${kept.gone} gone`);
    const bent = { ...reg, register: { ...reg.register, locks: [{ ...old, locktime: old.locktime + 1 }, recent, open] } };
    const kept2 = await coSignerRecord(bent, recFetch, now, { remembered });
    check("…and so is one whose date was changed by a digit, so that it no longer reads as a lock",
      kept2.releases.length === 1 && kept2.gone === 1);
    check("With nothing gone, nothing is reported gone", (await coSignerRecord(reg, recFetch, now, { remembered })).gone === 0);
    check("What is remembered next keeps the lock that has gone", locksSeen(without, remembered).length === 3 && locksToWatch(without, locksSeen(without, remembered)).gone.length === 1);
    check("Junk in the phone's memory is not a lock", locksToWatch(reg, [{ owner_pubkey: "zz", cosigner_pubkey: "02aa", locktime: 5 }, null, 7]).gone.length === 0);
  }

  // Commitments only on the relays: a reader looks at those the repository's
  // inbox could take, and no others.
  {
    const { relayOnlyCommitments, RELAY_ONLY_PER_LOCK } = await import("../src/crowdlocks.mjs");
    const rec = (lock, tx, extra = {}) => ({ type: "commitment", at: 5, record: { proposal: "p", lock: { address: lock.address, owner_pubkey: lock.owner_pubkey, cosigner_pubkey: lock.cosigner_pubkey, locktime: lock.locktime }, tx, ...extra } });
    const stranger = realLock("tb", 7, now + 7200);
    const found = [
      rec(stranger, "aa"),                                   // a real lock shape, but not on this register
      rec({ ...open, locktime: open.locktime + 1 }, "bb"),   // a register lock with its terms changed
      rec(open, "cc", { junk: "x" }),                        // good, with something added
      rec(open, "cc", { junk: "y" }),                        // the same again
      rec(open, "dd"),                                       // already in the repository's pile
      { type: "completed", tx: "ee", at: 6 },
      { type: "commitment", at: 7, record: { tx: "ff" } },   // not a record at all
    ];
    const kept = relayOnlyCommitments(found, { crowdlock: reg.crowdlock, register: reg.register, inPile: new Set(["dd"]) });
    check("A commitment on the relays is looked at only if its lock is a real lock on the register",
      kept.filter((x) => x.type === "commitment").length === 1 && kept.find((x) => x.type === "commitment").record.tx === "cc", kept.map((x) => x.record?.tx ?? x.type).join(","));
    check("…only the parts a commitment has are kept, and completions pass through",
      !("junk" in kept.find((x) => x.type === "commitment").record) && kept.some((x) => x.type === "completed"));
    const flood = Array.from({ length: 300 }, (_, i) => rec(open, `c${i}`));
    check("A flood of copies for one lock is cut to a handful, so it costs the explorer little",
      relayOnlyCommitments(flood, { crowdlock: reg.crowdlock, register: reg.register }).length === RELAY_ONLY_PER_LOCK);
  }

  // A Crowdlock that names another's co-signer key or declaration shows that
  // Crowdlock's locks as its own.
  {
    const { markCopies } = await import("../src/crowdlocks.mjs");
    const K1 = "02" + "11".repeat(32), K2 = "03" + "22".repeat(32), K3 = "02" + "33".repeat(32);
    const real = { url: "https://real/kop.json", name: "The Kop Fund", sats: 250863n, members: 1, declaration: "d1", cosigners: [K1] };
    const copy = { url: "https://evil/kop.json", name: "The Kop Fund - official", sats: 250863n, members: 1, declaration: "d9", cosigners: ["03" + K1.slice(2), K3] };
    const sameWords = { url: "https://evil/words.json", name: "Same words", sats: 0n, members: 0, declaration: "d1", cosigners: [K3] };
    const honest = { url: "https://small/x.json", name: "A small honest Crowdlock", sats: 100000n, members: 1, declaration: "d2", cosigners: [K2] };
    const m = markCopies([real, copy, sameWords, honest], [real.url]);
    const by = (u) => m.find((x) => x.url === u);
    check("A Crowdlock naming a trusted one's co-signer key is marked as its copy and shows none of its money",
      by(copy.url).copyOf === "The Kop Fund" && by(copy.url).sats === 0n && by(copy.url).members === 0);
    check("…the same for one sharing its declaration", by(sameWords.url).copyOf === "The Kop Fund");
    check("…and the real one and an unrelated one are left as they are",
      by(real.url).sats === 250863n && !by(real.url).copyOf && by(honest.url).sats === 100000n && !by(honest.url).copyOf && !by(honest.url).sharesWith);
    const m2 = markCopies([copy, { ...real, name: "Somebody's fund" }], []);
    check("Where neither is one the app or the person already has, both carry a warning and keep their figures",
      m2.every((x) => x.sharesWith && !x.copyOf && x.sats === 250863n), m2.map((x) => x.sharesWith).join(" / "));
    const ranked = rankFound(m);
    check("A copy no longer ranks level with the real one", ranked[0].url === real.url && ranked.findIndex((x) => x.url === copy.url) > ranked.findIndex((x) => x.url === honest.url));
  }
}

// A slow connection. The first try is never cut short: the second runs
// alongside it, so an answer that takes most of the time still counts. (An
// earlier version dropped the first try after 8 seconds and gave the second
// only 12, which made a slow-but-working phone connection fail.)
{
  const later = (ms, init, make) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(make()), ms);
    init.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
  });
  let n = 0;
  // Every try takes 70 of the 100 ms allowed: longer than either share of it.
  const slow = async (url, init) => { n++; return later(70, init, () => Response.json([{ txid: "aa", vout: 0, value: 1, status: { confirmed: true } }])); };
  const t0 = Date.now();
  const got = await esploraChain("https://slow", slow, 100).utxos("tb1qa");
  const took = Date.now() - t0;
  check("A slow answer that arrives inside the time is used, not thrown away", got.length === 1 && took >= 60 && took < 100, `${took} ms, ${n} tries`);
  check("…with a second try started alongside it meanwhile", n === 2, `${n} tries`);

  // A phone that has only just woken says "no connection" at once. Asking
  // again in the same instant gets the same answer, so the second try waits.
  const at = [];
  const waking = async () => { at.push(Date.now()); if (at.length === 1) throw new TypeError("Network request failed"); return Response.json([]); };
  const w = await esploraChain("https://wake", waking, 400).utxos("tb1qa");
  check("A try that fails outright is repeated after a pause, and then answers", Array.isArray(w) && at.length === 2 && at[1] - at[0] >= 25, `${at[1] - at[0]} ms apart`);

  // With a backup the wait isn't needed: the second try goes somewhere else.
  const seen = [];
  const mainGone = async (url) => { seen.push([String(url), Date.now()]); if (String(url).startsWith("https://gone")) throw new TypeError("Network request failed"); return Response.json([]); };
  await esploraChain("https://gone", mainGone, 400, { backup: "https://b" }).utxos("tb1qa");
  check("…but a backup explorer is asked straight away", seen.length === 2 && seen[1][0].startsWith("https://b") && seen[1][1] - seen[0][1] < 20, `${seen[1][1] - seen[0][1]} ms apart`);

  // The main explorer answers late, the backup never: the late answer wins.
  let calls = 0;
  const lateMain = async (url, init) => { calls++; return String(url).startsWith("https://late") ? later(70, init, () => Response.json([])) : new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))); };
  const lm = await esploraChain("https://late", lateMain, 100, { backup: "https://b" }).utxos("tb1qa");
  check("A main explorer that answers late still counts while the backup is silent", Array.isArray(lm) && calls === 2);
}

// "Check the connection": one timed question to each place the app depends
// on, so a page that won't load can be told apart from a phone that is offline.
{
  const { checkConnection, describeResult, sumUp } = await import("../src/connection.mjs");
  const targets = [
    { name: "explorer.example", url: "https://explorer.example/blocks/tip/height", explorer: true },
    { name: "site.example", url: "https://site.example/crowdlocks/x.json" },
  ];
  const world = (explorer, site) => async (url, init) => {
    const how = String(url).includes("explorer.example") ? explorer : site;
    if (how === "silent") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    if (how === "gone") throw new TypeError("Network request failed");
    if (how === "busy") return new Response("slow down", { status: 429 });
    return new Response("161293");
  };
  const run = (explorer, site) => checkConnection(targets, { fetchImpl: world(explorer, site), timeoutMs: 40 });

  const fine = await run("ok", "ok");
  check("When everything answers it says so, with the time each took",
    fine.every((r) => r.ok) && /^answered in \d/.test(describeResult(fine[0])) && sumUp(fine) === "Everything the app needs is answering.", describeResult(fine[0]));
  const t0 = Date.now();
  const quiet = await run("silent", "ok");
  check("A silent explorer is named as silent, and the phone as online",
    quiet[0].silent && quiet[1].ok && /^no answer in/.test(describeResult(quiet[0], 40)) && /online, but the block explorer isn't answering/.test(sumUp(quiet)), sumUp(quiet));
  check("…and the places are asked at the same moment, not one after another", Date.now() - t0 < 80);
  const off = await run("gone", "gone");
  check("When nothing answers it points at the phone's connection",
    off.every((r) => r.unreachable) && describeResult(off[0]) === "couldn't be reached at all" && /phone's own connection/.test(sumUp(off)), sumUp(off));
  const busyOne = await run("busy", "ok");
  check("An explorer that is too busy is reported as that", /too busy \(429\)/.test(describeResult(busyOne[0])) && /isn't answering/.test(sumUp(busyOne)), describeResult(busyOne[0]));
  const slowOne = [{ ...fine[0], ms: 9000 }, fine[1]];
  check("A slow answer is called slow", describeResult(slowOne[0]) === "answered in 9 seconds" && /but slowly/.test(sumUp(slowOne)), sumUp(slowOne));
  const half = [{ ...quiet[0] }, { name: "backup.example", url: "u", explorer: true, ok: true, ms: 300, status: 200 }, fine[1]];
  check("With a backup, one explorer down is reported without alarm", sumUp(half) === "One block explorer isn't answering, and the app is using the other.");
}

// A backup explorer, for real bitcoin: when the main one is silent, busy or
// broken, the other is asked. Neither can move money; nothing gets a backup
// unless it is given one.
{
  const { BACKUP_EXPLORERS, EXPLORERS } = await import("../src/wallet/esplora.mjs");
  const { committedTotal } = await import("../src/crowdlocks.mjs");
  const never = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const two = (main, fetchImpl, more = {}) => esploraChain(main, fetchImpl, 50, { backup: "https://b", preferMs: 80, downMs: 80, ...more });
  const coin = [{ txid: "aa", vout: 0, value: 5000, status: { confirmed: true } }];

  let log = [];
  let mainMode = "silent";
  const net = async (url, init) => {
    url = String(url); log.push(url);
    if (url.startsWith("https://b")) {
      if (url.endsWith("/fee-estimates")) return Response.json({ "1": 12.3, "2": 12.3, "3": 6.1, "6": 2.2, "144": 1.01 });
      return Response.json(coin);
    }
    if (mainMode === "silent") return never(init);
    if (mainMode === "busy") return new Response("slow down", { status: 429 });
    if (mainMode === "broken") return new Response("bad gateway", { status: 502 });
    if (mainMode === "no") return new Response("Transaction not found", { status: 404 });
    return Response.json([]);
  };
  const toMain = () => log.filter((u) => u.startsWith("https://m")).length;
  const toBackup = () => log.filter((u) => u.startsWith("https://b")).length;

  const c = two("https://m1", net);
  const t0 = Date.now();
  const got = await c.utxos("tb1qa");
  check("When the main explorer is silent the backup is asked, and answers", got.length === 1 && got[0].value === 5000 && toBackup() === 1 && Date.now() - t0 < 100, log.join(" "));
  log = [];
  await c.utxos("tb1qb");
  check("…and the next question goes straight to the backup", toMain() === 0 && toBackup() === 1, log.join(" "));
  await new Promise((r) => setTimeout(r, 100));
  mainMode = "fine"; log = [];
  const back = await c.utxos("tb1qc");
  check("…until a while has passed, when the main one is asked first again", back.length === 0 && log[0].startsWith("https://m1") && toBackup() === 0, log.join(" "));

  mainMode = "busy"; log = [];
  let waited = false;
  const viaBusy = await two("https://m2", net, { wait: async () => { waited = true; } }).utxos("tb1qa");
  check("A busy main explorer is passed over at once, without waiting it out", viaBusy.length === 1 && !waited && toMain() === 1 && toBackup() === 1);
  mainMode = "broken"; log = [];
  check("…and so is a broken one", (await two("https://m3", net).utxos("tb1qa")).length === 1 && toBackup() === 1);
  mainMode = "no"; log = [];
  let said = null;
  try { await two("https://m4", net).txHex("ff"); } catch (e) { said = e.message; }
  check("A plain 'no' is an answer: the backup isn't asked to contradict it", /answered 404/.test(said ?? "") && toBackup() === 0, said ?? "NO ERROR");

  mainMode = "silent"; log = [];
  const fees = await two("https://m5", net).feeRates();
  check("The backup's fee rates are read in its own wording", fees.fast === 13 && fees.normal === 7 && fees.slow === 3 && log.some((u) => u === "https://b/fee-estimates"), JSON.stringify(fees));

  // Both silent: one error, in the time it names, then fail fast as before.
  const dead = async (url, init) => never(init);
  const d = two("https://m6", dead);
  let why = null; const t1 = Date.now();
  try { await d.utxos("tb1qa"); } catch (e) { why = e.message; }
  const t2 = Date.now();
  let next = null;
  try { await d.utxos("tb1qb"); } catch (e) { next = e.message; }
  check("With both silent the fan is told once, in the time named, and the rest fail at once",
    /didn't answer/.test(why ?? "") && t2 - t1 < 200 && next === why && Date.now() - t2 < 20, why ?? "NO ERROR");

  // Sending. The same signed payment is offered to the backup only when the
  // main explorer didn't take it; a refusal is a refusal.
  let sends = [];
  const sender = (mainSays, backupSays) => async (url, init) => {
    url = String(url);
    if (init?.method !== "POST") return Response.json([]);
    sends.push(url);
    const says = url.startsWith("https://b") ? backupSays : mainSays;
    if (says === "silent") return never(init);
    if (says === "ok") return new Response("txid123");
    if (says === "has it") return new Response('sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}', { status: 400 });
    if (says === "has it unconfirmed") return new Response('sendrawtransaction RPC error: {"code":-25,"message":"txn-already-in-mempool"}', { status: 400 });
    return new Response('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}', { status: 400 });
  };
  const sent = await two("https://s1", sender("silent", "ok")).broadcast("00");
  check("A payment the main explorer didn't take is sent through the backup", sent === "txid123" && sends.length === 2 && sends[1] === "https://b/tx", sends.join(" "));
  sends = [];
  let threw = null;
  try { await two("https://s2", sender("silent", "has it")).broadcast("00"); } catch (e) { threw = e.message; }
  let threw2 = null;
  try { await two("https://s3", sender("silent", "has it unconfirmed")).broadcast("00"); } catch (e) { threw2 = e.message; }
  check("If the backup already has it, the main one did pass it on: that is sent, not an error", threw === null && threw2 === null, threw ?? threw2 ?? "");
  sends = [];
  let refused = null;
  try { await two("https://s4", sender("refuse", "ok")).broadcast("00"); } catch (e) { refused = e.message; }
  check("A payment the network refuses is not offered to the backup", /the network refused it: .*min relay fee/.test(refused ?? "") && sends.length === 1, `${refused} | ${sends.join(" ")}`);
  sends = [];
  let bothRefuse = null;
  try { await two("https://s5", sender("silent", "refuse")).broadcast("00"); } catch (e) { bothRefuse = e.message; }
  check("…and a refusal from the backup is passed on as a refusal", /the network refused it/.test(bothRefuse ?? ""), bothRefuse ?? "NO ERROR");

  // Who gets one.
  log = [];
  const unreachable = async (url) => { log.push(String(url)); throw new TypeError("Network request failed"); };
  try { await esploraChain("https://mempool.space/api", unreachable, 50).utxos("bc1qa"); } catch {}
  check("Nothing gets a backup unless it is given one", log.length === 2 && log.every((u) => u.startsWith("https://mempool.space/api")), log.join(" "));
  check("Real bitcoin and the test network each have a backup explorer",
    BACKUP_EXPLORERS[EXPLORERS.mainnet] === "https://blockstream.info/api" && BACKUP_EXPLORERS[EXPLORERS.testnet4] === "https://blockstream.info/testnet4/api");
  // A quiet network: the backup has no estimate for short waits at all.
  const sparse = async (url, init) => {
    url = String(url);
    if (url.startsWith("https://q")) throw new TypeError("Network request failed");
    return Response.json(url.endsWith("/fee-estimates") ? { "1008": 0.495, "144": 0.495, "504": 30.009 } : []);
  };
  const quietFees = await esploraChain("https://q", sparse, 50, { backup: "https://b", minFee: 5 }).feeRates();
  check("Fee rates still come out when the backup only has estimates for long waits",
    quietFees.fast === 5 && quietFees.normal === 5 && quietFees.slow === 5, JSON.stringify(quietFees));
  const some = async (url) => (String(url).startsWith("https://r") ? Promise.reject(new TypeError("x")) : Response.json(String(url).endsWith("/fee-estimates") ? { "2": 40.2, "4": 21, "25": 3 } : []));
  const someFees = await esploraChain("https://r", some, 50, { backup: "https://b" }).feeRates();
  check("…and a wait it has no figure for takes the next longer one", someFees.fast === 41 && someFees.normal === 21 && someFees.slow === 3, JSON.stringify(someFees));
  const mainLock = realLock("bc", 5, 4000000000);
  const mainDown = async (url) => {
    url = String(url);
    if (url.startsWith("https://mempool.space")) throw new TypeError("Network request failed");
    return Response.json(url.startsWith(`https://blockstream.info/api/address/${mainLock.address}/utxo`) ? [{ txid: "aa", vout: 0, value: 250000, status: { confirmed: true } }] : []);
  };
  const total = await committedTotal({
    crowdlock: { network: "mainnet", chain_api: "https://mempool.space/api", minimum_counted_lock_sats: 200000, cosigner_keys: [TEST_COSIGNER], declaration: DECL },
    register: { members: await membersOf([mainLock]), locks: [mainLock] },
  }, mainDown);
  check("A Crowdlock's total is still counted when its explorer is down, from the backup", total.sats === 250000n && total.members === 1, String(total.sats));
}

// Every co-signer key this repository publishes must be a real point on the
// curve: one that only looks right would make every lock naming it impossible
// to spend by the purchase route, and nothing would say so until it was tried.
{
  const { readdirSync, readFileSync } = await import("node:fs");
  const { isPublicKey } = await import("../src/wallet/core.mjs");
  const dir = new URL("../../crowdlocks/", import.meta.url);
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "index.json")) {
    for (const k of JSON.parse(readFileSync(new URL(f, dir), "utf8")).cosigner_keys ?? []) if (!isPublicKey(k)) bad.push(`${f}: ${k.slice(0, 12)}…`);
  }
  check("Every co-signer key this repository publishes is a real public key", bad.length === 0, bad.join(", "));
  const { checkCosignerXpubs } = await import("../src/wallet/core.mjs");
  const badX = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "index.json")) {
    const r = checkCosignerXpubs(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    if (!r.ok) badX.push(`${f}: ${r.problems.join("; ")}`);
  }
  check("Every co-signer xpub this repository publishes stands for one of its keys", badX.length === 0, badX.join(", "));
}

// The app's lock must be the very script the method's reference code reads,
// or the early-release detector would be reading the wrong shape of witness.
{
  const { accountFromWords, lockFor } = await import("../src/wallet/core.mjs");
  const { lockAddress } = await import("../../method/js/lockrecord.mjs");
  const acct = accountFromWords("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "testnet4");
  const cosignerPubkey = "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c";
  const l = lockFor({ account: acct, cosignerPubkey, locktime: 1893456000 });
  check("The app's lock is byte-for-byte the method's lock script",
    l.address === lockAddress({ ownerPubkey: acct.publicKey, cosignerPubkey, locktime: 1893456000 }, "tb"), l.address);
}

// The co-signer's record, as the Crowdlock screen reads it.
{
  const { coSignerRecord } = await import("../src/crowdlocks.mjs");
  const L = realLock("tb", 11, 2000000000), L2 = realLock("tb", 11, 2000000001);
  const early = { txid: "e1", status: { confirmed: true, block_time: 1900000000 }, vin: [{ prevout: { scriptpubkey_address: L.address, value: 5000 }, witness: ["aa", "", "bb", "cc"] }], vout: [{ scriptpubkey_address: "tb1qelsewhere" }] };
  const onDate = { txid: "h1", status: { confirmed: true, block_time: 2000000100, block_hash: "bh" }, vin: [{ prevout: { scriptpubkey_address: L2.address, value: 5000 }, witness: ["01", "bb", "cc"] }], vout: [{ scriptpubkey_address: L.member }] };
  const loaded = { crowdlock: { network: "testnet4", chain_api: "https://rec", cosigner_keys: [TEST_COSIGNER] }, register: { members: await membersOf([L]), locks: [L, L2, L] }, destinations: { entries: [] } };
  // The network's clock for the take-home's block: the median time of the blocks before it, past the date.
  const fake = async (url) => Response.json(String(url).endsWith("/block/bh") ? { previousblockhash: "bp" } : String(url).endsWith("/block/bp") ? { mediantime: 2000000050 }
    : String(url).includes(L2.address) ? [onDate] : [early]);
  const rec = await coSignerRecord(loaded, fake);
  check("The Crowdlock screen finds a co-signer's early release, once, and nothing else",
    rec.releases.length === 1 && rec.releases[0].txid === "e1" && rec.releases[0].member === L.member && rec.unreadable === 0);
}

// A hardware wallet's view of the lock. Given the co-signer as an xpub, the
// same lock must come out at exactly the same address, and turn into the
// wallet policy a Ledger (BIP 388) accepts. If either fails, no hardware
// wallet member could ever take a lock home.
{
  const { Output, networks: nets } = await import("@bitcoinerlab/descriptors");
  const { createRequire } = await import("node:module");
  const { accountFromWords, lockFor, xpubForNetwork, keyFromXpub } = await import("../src/wallet/core.mjs");
  const req = createRequire(import.meta.url);
  const { derivePolicyFromOutput } = req(join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@bitcoinerlab/descriptors-core/dist/hww/policies.js"));
  const acct = accountFromWords("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "testnet4");
  const XP = xpubForNetwork("xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V", "testnet4");
  const t = 1893456000;
  const plain = lockFor({ account: acct, cosignerPubkey: keyFromXpub(XP), locktime: t });
  const out = new Output({ descriptor: `wsh(and_v(v:pk(${acct.keyExpression}),or_i(after(${t}),pk(${XP}/0/0))))`, network: nets.testnet });
  check("Written with xpubs, the way a hardware wallet sees it, the lock is the same address", out.getAddress() === plain.address, plain.address);
  const pol = await derivePolicyFromOutput({ output: out, getMasterFingerprint: async () => Buffer.from(acct.keyExpression.slice(1, 9), "hex") });
  check("…and becomes the wallet policy a Ledger accepts",
    pol.descriptorTemplate === `wsh(and_v(v:pk(@0/**),or_i(after(${t}),pk(@1/**))))` && pol.keyRoots[1] === XP && pol.change === 0 && pol.index === 0,
    pol.descriptorTemplate);
}

// Warning members when a Crowdlock's co-signer keys change.
{
  const { keyChanges, historyLinkFor } = await import("../src/crowdlocks.mjs");
  const A = "02" + "a".repeat(64), B = "03" + "b".repeat(64);
  check("The first look sets the baseline, with nothing to warn about", !keyChanges(null, [A]).changed);
  check("The same keys: no warning", !keyChanges([A], [A]).changed);
  const ch = keyChanges([A], [A, B]);
  check("An added key is caught", ch.changed && ch.added[0] === B && ch.removed.length === 0);
  const gone = keyChanges([A, B], [B]);
  check("A removed key is caught", gone.changed && gone.removed[0] === A && gone.added.length === 0);
  check("A key swapped for its mirror (02 to 03) isn't a change", !keyChanges([A], ["03" + "a".repeat(64)]).changed);
  check("A key this phone added doesn't warn when it appears", !keyChanges([A], [A, B], [B]).changed);
  check("…nor while the website still shows the old list (the false 'removed' James saw)", !keyChanges([A], [A], [B]).changed);
  check("A key someone else added still warns, alongside one this phone added", keyChanges([A], [A, B, "02" + "c".repeat(64)], [B]).added.length === 1);
  check("The warning links to the file's public history",
    historyLinkFor("https://somefan.github.io/the-pub-fund/crowdlocks/the-pub-fund.json") === "https://github.com/somefan/the-pub-fund/commits/main/crowdlocks/the-pub-fund.json");
}

// Sharing
const kopUrl = `${KOP_SITE}crowdlocks/kop-fund.json`;
const app = openLinkFor(kopUrl);
check("An app link carries the Crowdlock's file link, and gives it back", app.startsWith("crowdlock://add?url=") && fileUrlFromOpenLink(app) === kopUrl);
check("An app link to anything but an https file link is ignored",
  fileUrlFromOpenLink("crowdlock://add?url=" + encodeURIComponent("http://x.example/c.json")) === null
    && fileUrlFromOpenLink("https://example.com") === null && fileUrlFromOpenLink("crowdlock://add?url=%E0%A4%A") === null);
check("Sharing The Kop Fund sends people to its join page", kop.ok && shareLinkFor(kop) === "https://jimbus9.github.io/the-kop-fund/join/");
check("A Crowdlock naming no page is shared as its site", test.ok && shareLinkFor(test) === SITE);

// Finding
const found = rankFound([
  { name: "Spam 1", sats: 0n, members: 0 }, { name: "Small", sats: 50000n, members: 3 },
  { name: "Big", sats: 900000n, members: 2 }, { name: "Also small", sats: 50000n, members: 5 },
]);
check("Found Crowdlocks rank by committed bitcoin, then committed members", found.map((x) => x.name).join(",") === "Big,Also small,Small,Spam 1");
check("Search matches the name or what it's for", matchesSearch({ name: "The Pub Fund", about: "Buying the Red Lion" }, "red lion") && !matchesSearch({ name: "X", about: "Y" }, "pub"));

console.log("-".repeat(80));
console.log(failures === 0 ? "The app's Crowdlock loader accepts the real files and refuses doctored ones." : `${failures} check(s) failed.`);

{
  const quiet = async () => ({ ok: true, status: 200, json: async () => ({ halfHourFee: 1 }), text: async () => "" });
  const busy = async () => ({ ok: true, status: 200, json: async () => ({ halfHourFee: 40 }), text: async () => "" });
  const down = async () => { throw new TypeError("Network request failed"); };
  const low = await esploraChain("https://fee-a", quiet, 50).feeRate();
  const raised = await esploraChain("https://fee-b", quiet, 50, { minFee: 5 }).feeRate();
  const high = await esploraChain("https://fee-c", busy, 50, { minFee: 5 }).feeRate();
  const fallback = await esploraChain("https://fee-d", down, 50, { minFee: 5, retries: 0 }).feeRate();
  console.log(low === 1 && raised === 5 && high === 40 && fallback === 5 ? "PASS  The fee floor lifts a too-low estimate, never lowers a high one" : `FAIL  fee floor ${low} ${raised} ${high} ${fallback}`);
  if (!(low === 1 && raised === 5 && high === 40 && fallback === 5)) process.exitCode = 1;

  // Slow / normal / fast: the explorer's three rates, in order, never below the floor.
  const three = async () => ({ ok: true, status: 200, json: async () => ({ fastestFee: 12, halfHourFee: 6, hourFee: 3, economyFee: 1 }), text: async () => "" });
  const r3 = await esploraChain("https://fee-e", three, 50).feeRates();
  const r3f = await esploraChain("https://fee-f", three, 50, { minFee: 5 }).feeRates();
  const slow = await esploraChain("https://fee-g", three, 50).feeRate("slow");
  const fast = await esploraChain("https://fee-h", three, 50).feeRate("fast");
  const dflt = await esploraChain("https://fee-i", three, 50).feeRate();
  const ok3 = r3.slow === 3 && r3.normal === 6 && r3.fast === 12 && r3f.slow === 5 && r3f.normal === 6 && r3f.fast === 12 && slow === 3 && fast === 12 && dflt === 6;
  console.log(ok3 ? "PASS  Slow, normal and fast fee rates come from the explorer, in order, above the floor" : `FAIL  three rates ${JSON.stringify([r3, r3f, slow, fast, dflt])}`);
  if (!ok3) process.exitCode = 1;
}

console.log("-".repeat(80));
console.log("A CROWDLOCK THAT MOVES KEEPS THE PHONE'S RECORDS");
console.log("-".repeat(80));
{
  const { movedUrl, moveRecords } = await import("../src/moves.mjs");
  const { MOVED_ADDRESSES } = await import("../src/build.mjs");
  const { repoFromFileUrl, pathInRepo, historyLinkFor } = await import("../src/crowdlocks.mjs");
  const OLD_KOP = "https://jimbus9.github.io/the-kop-fund/crowdlocks/kop-fund.json";
  const OLD_TEST = "https://jimbus9.github.io/fanfund/crowdlocks/kop-fund-testnet4.json";
  const NEW_KOP = STARTING_LIST[0], NEW_TEST = STARTING_LIST[1];
  const OTHER = "https://somefan.github.io/the-pub-fund/crowdlocks/the-pub-fund.json";
  check("Both old addresses move to the ones on the starting list",
    movedUrl(OLD_KOP, MOVED_ADDRESSES) === NEW_KOP && movedUrl(OLD_TEST, MOVED_ADDRESSES) === NEW_TEST);
  check("…and nothing else moves", movedUrl(OTHER, MOVED_ADDRESSES) === OTHER && movedUrl(NEW_KOP, MOVED_ADDRESSES) === NEW_KOP);
  check("The github.io test address moves to crowdlock.org too (and fanfund follows both moves)",
    movedUrl("https://jimbus9.github.io/crowdlock/crowdlocks/kop-fund-testnet4.json", MOVED_ADDRESSES) === NEW_TEST
    && NEW_TEST === "https://crowdlock.org/crowdlocks/kop-fund-testnet4.json");
  check("A loop in the list of moves can't hang the app",
    typeof movedUrl("https://a.example/x", [["https://a.example/", "https://b.example/"], ["https://b.example/", "https://a.example/"]]) === "string");

  const realLock = { crowdlock: OLD_KOP, address: "bc1qreal", locktime: 1826000000, cosignerPubkey: "02aa" };
  const testLock = { crowdlock: OLD_TEST, address: "tb1qtest", locktime: 1763100000, cosignerPubkey: "02bb" };
  const otherLock = { crowdlock: OTHER, address: "tb1qother", locktime: 1, cosignerPubkey: "02cc" };
  const phone = {
    locks: [realLock, testLock, otherLock],
    seen: { [OLD_KOP]: ["02k1"], [OLD_TEST]: ["02t1"], [OTHER]: ["02o1"] },
    expected: { [OLD_TEST]: ["02t2"] },
    added: [OTHER, OLD_TEST],
  };
  const moved = moveRecords(phone, MOVED_ADDRESSES, STARTING_LIST);
  check("The real lock is refiled under The Kop Fund's new address, terms untouched",
    moved.changed && JSON.stringify(moved.locks[0]) === JSON.stringify({ ...realLock, crowdlock: NEW_KOP }));
  check("…the test lock under the test Crowdlock's new address",
    JSON.stringify(moved.locks[1]) === JSON.stringify({ ...testLock, crowdlock: NEW_TEST }));
  check("…and a lock in another Crowdlock is left alone", JSON.stringify(moved.locks[2]) === JSON.stringify(otherLock));
  check("No lock is lost or added", moved.locks.length === 3);
  check("The co-signer keys seen move too, so a key change still warns",
    JSON.stringify(moved.seen) === JSON.stringify({ [OTHER]: ["02o1"], [NEW_KOP]: ["02k1"], [NEW_TEST]: ["02t1"] }));
  check("…and so do the keys this phone is waiting to see", JSON.stringify(moved.expected) === JSON.stringify({ [NEW_TEST]: ["02t2"] }));
  check("An added Crowdlock that moved onto the starting list isn't listed twice", JSON.stringify(moved.added) === JSON.stringify([OTHER]));

  const again = moveRecords(moved, MOVED_ADDRESSES, STARTING_LIST);
  check("Running it again changes nothing, so it can run at every start",
    !again.changed && JSON.stringify(again.locks) === JSON.stringify(moved.locks) && JSON.stringify(again.seen) === JSON.stringify(moved.seen));
  check("A phone with nothing saved is fine", !moveRecords({}, MOVED_ADDRESSES, STARTING_LIST).changed);

  const both = moveRecords({ seen: { [OLD_KOP]: ["02old"], [NEW_KOP]: ["02new"] }, expected: { [OLD_KOP]: ["02a"], [NEW_KOP]: ["02b"] } }, MOVED_ADDRESSES, STARTING_LIST);
  check("If both addresses have keys, the newer list wins for 'seen'", JSON.stringify(both.seen) === JSON.stringify({ [NEW_KOP]: ["02new"] }));
  check("…and a key waiting under either still waits", JSON.stringify(both.expected[NEW_KOP]?.slice().sort()) === JSON.stringify(["02a", "02b"]));

  const shared = fileUrlFromOpenLink(openLinkFor(OLD_KOP));
  check("An app link shared before the move opens the new address", shared === NEW_KOP);

  check("The Kop Fund's own domain still knows its repository",
    JSON.stringify(repoFromFileUrl(NEW_KOP)) === JSON.stringify({ owner: "Jimbus9", repo: "the-kop-fund" }) && pathInRepo(NEW_KOP) === "crowdlocks/kop-fund.json");
  check("…so a co-signer key change there links to its history",
    historyLinkFor(NEW_KOP) === "https://github.com/Jimbus9/the-kop-fund/commits/main/crowdlocks/kop-fund.json");
  check("A domain the build doesn't know names no repository", repoFromFileUrl("https://example.org/crowdlocks/x.json") === null && pathInRepo("https://example.org/crowdlocks/x.json") === null);
}

console.log("-".repeat(80));
console.log("A CROWDLOCK CAN'T CHOOSE WHO COUNTS ITS MONEY");
console.log("-".repeat(80));
{
  const { coSignerRecord, explorerFor } = await import("../src/crowdlocks.mjs");
  // A Crowdlock whose file names an explorer of its founder's own, which
  // reports a fortune at a lock that holds nothing, and no early releases.
  const asked = [];
  const liar = async (url) => {
    url = String(url); asked.push(url);
    if (url.startsWith("https://founders-own.example")) return Response.json(url.endsWith("/utxo") ? [{ txid: "ff", vout: 0, value: 5000000000, status: { confirmed: true } }] : []);
    return Response.json([]);   // the app's own explorer: nothing there
  };
  const empty = realLock("bc", 12, 4000000000);
  const faked = {
    crowdlock: { network: "mainnet", chain_api: "https://founders-own.example/api", minimum_counted_lock_sats: 10000, cosigner_keys: [TEST_COSIGNER] },
    register: { members: await membersOf([empty]), locks: [empty] }, destinations: { entries: [] },
  };
  const t = await committedTotal(faked, liar);
  await coSignerRecord(faked, liar);
  await poundsPerBtc(faked.crowdlock, liar);
  check("A total is counted from the app's own explorer, whatever explorer the Crowdlock's file names", t.sats === 0n && t.members === 0, String(t.sats));
  check("…and the explorer it names is never asked: not for its total, its co-signer's record or a price",
    asked.length > 0 && !asked.some((u) => u.includes("founders-own")) && asked.every((u) => u.startsWith("https://mempool.space/api/") || u.startsWith("https://blockstream.info/api/")), asked.join(" "));
  let refused = false;
  try { explorerFor({ network: "somewhere-else" }); } catch { refused = true; }
  check("A network this app has no explorer for is refused, not guessed at", refused);
}

console.log("-".repeat(80));
console.log("A HOSTILE LINK: SILENT, ENDLESS OR OVERSIZED");
console.log("-".repeat(80));
{
  const file = `${SITE}crowdlocks/kop-fund-testnet4.json`;
  // A server that takes the request and never answers.
  const silent = (path) => async (url, init) => (String(url).endsWith(path) ? new Promise(() => {}) : siteFetch()(url, init));
  let t0 = Date.now();
  const s1 = await loadCrowdlock(file, silent("kop-fund-testnet4.json"), { limitMs: 60 });
  check("A Crowdlock file that never answers is given up on, in the time allowed", !s1.ok && /didn't answer within/.test(s1.problems.join()) && Date.now() - t0 < 2000, s1.ok ? "" : s1.problems[0]);
  t0 = Date.now();
  const s2 = await loadCrowdlock(file, silent("registrations.json"), { limitMs: 60 });
  check("…and so is a register that never answers", !s2.ok && /could not load its register/.test(s2.problems.join()) && Date.now() - t0 < 2000, s2.ok ? "" : s2.problems[0]);
  const real = JSON.parse(readFileSync(join(REPO, "crowdlocks/kop-fund-testnet4.json"), "utf8"));
  const big = await loadCrowdlock(file, siteFetch({ [real.declaration.file]: "x".repeat(400000) }));
  check("A declaration far too large to be one is refused", !big.ok && /too large/.test(big.problems.join()), big.ok ? "" : big.problems[0]);
  const many = { ...real, declaration_versions: Array.from({ length: 51 }, (_, i) => ({ version: i + 2, file: `v${i + 2}.txt`, sha256: "0".repeat(64), published: "2027-01-01", reason: "x" })) };
  let asked = 0;
  const counting = async (url, init) => { asked++; return siteFetch({ "crowdlocks/kop-fund-testnet4.json": JSON.stringify(many) })(url, init); };
  const m = await loadCrowdlock(file, counting);
  check("A file listing more versions than any Crowdlock would have is refused before they are fetched", !m.ok && /more than 50 versions/.test(m.problems.join()) && asked <= 2, m.ok ? "" : `${m.problems[0]} (${asked} requests)`);
}

console.log("-".repeat(80));
console.log("A NEW VERSION OF THE DECLARATION");
console.log("-".repeat(80));
{
  const { newVersionToSign, mayCommitTo, versionSignedBy, lineChanges } = await import("../src/crowdlocks.mjs");
  const { declarationHash, canonicalise } = await import("../../method/js/crowdlock.mjs");
  const tFile = JSON.parse(readFileSync(join(REPO, "crowdlocks/kop-fund-testnet4.json"), "utf8"));
  const v1Text = readFileSync(join(REPO, tFile.declaration.file), "utf8");
  const v2Text = canonicalise(v1Text.replace(/\n$/, "") + "\nA sentence added in version 2.\n");
  const withV2 = { ...tFile, declaration_versions: [{ version: 2, file: "crowdlocks/test/declaration-test-v2.txt", sha256: declarationHash(v2Text), published: "2027-01-31", reason: "Clearer wording." }] };
  const reg = JSON.parse(readFileSync(join(REPO, "crowdlocks/test/registrations.json"), "utf8"));
  // The live test register changes as people test: members sign whatever
  // versions the real test Crowdlock has published. This section invents its
  // own version 2, so it starts from members who have signed only version 1.
  reg.members = reg.members.map(({ also_signed, version, ...m }) => m);
  const someone = reg.members[0];
  const serve = (r) => siteFetch({ "crowdlocks/kop-fund-testnet4.json": JSON.stringify(withV2), "crowdlocks/test/declaration-test-v2.txt": v2Text, "crowdlocks/test/registrations.json": JSON.stringify(r) });
  const v = await loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, serve(reg));
  check("A Crowdlock with a version 2 loads, and checks version 2's text", v.ok && v.versions.length === 2 && v.versions[1].text === v2Text, v.ok ? "" : v.problems.join("; "));
  check("…a newcomer is shown version 2 and signs it", v.ok && v.declarationText === v2Text && v.statement.includes(" v2 (sha256:"));
  const ask = v.ok ? newVersionToSign(v, someone.address) : null;
  check("A member who signed version 1 is asked about version 2, with the reason and the changed line",
    !!ask && ask.current.version === 2 && ask.previous.version === 1 && ask.current.reason === "Clearer wording."
    && ask.changes.filter((x) => x.kind === "new").map((x) => x.text).join() === "A sentence added in version 2." && !ask.changes.some((x) => x.kind === "gone"));
  check("A newcomer isn't asked (they aren't a member)", v.ok && newVersionToSign(v, "tb1qnobodyhere0000000000000000000000000000") === null);
  const signed = { ...reg, members: reg.members.map((m, i) => (i === 0 ? { ...m, also_signed: [{ version: 2, signature: "x", signed: "2027-02-01" }] } : m)) };
  const v2 = await loadCrowdlock(`${SITE}crowdlocks/kop-fund-testnet4.json`, serve(signed));
  check("Once they've signed it they aren't asked again, and their page shows version 2's words",
    v2.ok && newVersionToSign(v2, someone.address) === null && versionSignedBy(v2, v2.register.members[0]).version === 2);
  const me1 = v.ok ? membershipOf(v.register, someone.address) : null;
  const me2 = v2.ok ? membershipOf(v2.register, someone.address) : null;
  check("Committing to a version-2 proposal needs version 2; a version-1 proposal needs only version 1",
    v.ok && v2.ok && !mayCommitTo(v, me1, { declaration_version: 2 }) && mayCommitTo(v2, me2, { declaration_version: 2 }) && mayCommitTo(v, me1, {}));
  check("Old against new: a changed line shows as one out and one in",
    JSON.stringify(lineChanges("a\nb\nc\n", "a\nB\nc\n").map((x) => x.kind)) === JSON.stringify(["same", "gone", "new", "same"]));
}

console.log("-".repeat(80));
process.exit(failures === 0 ? 0 : 1);
