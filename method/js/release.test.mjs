// Tests release.mjs against spends built by the lock's own reference code
// (method/lock/lock.mjs), turned into the JSON a block explorer returns. The
// two share no code, so if the detector reads these right it reads the chain
// right.
//
// Run:  node method/js/release.test.mjs      (from the repo root, after npm ci in method/lock)

import { ECPair, lockAddress, buildSpend, networkFor } from "../lock/lock.mjs";
import { isCoSigned, isListedDestination, earlyReleases, staysLocked, readHistory, clocksFor, CLOCK_WINDOW, PAGE, MOST_PAGES } from "./release.mjs";
import { lockAddress as recordAddress } from "./lockrecord.mjs";
import { destinationHash, attestationStatement, stampScript, ZERO_PREV } from "./proposals.mjs";
import { messageHash, memberAddressForOwnerKey } from "./verify.mjs";
import { signAsync } from "./vendor/noble-secp256k1.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failures++;
};

const network = networkFor("mainnet");
const fan = ECPair.makeRandom({ network });
const cos = ECPair.makeRandom({ network });
const locktime = 1893456000; // 1 Jan 2030
const lock = lockAddress({ fanPubkey: Buffer.from(fan.publicKey), cosignerPubkey: Buffer.from(cos.publicKey), locktime, network });
const value = 500000;
const utxo = { txid: "11".repeat(32), vout: 0, value };
const elsewhere = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const shop = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";

// The same coin opened both ways, as an explorer would report each.
const asExplorer = (built, blockTime) => ({
  txid: built.txid,
  status: blockTime ? { confirmed: true, block_time: blockTime, block_hash: `b${blockTime}` } : { confirmed: false },
  vin: [{ prevout: { scriptpubkey_address: lock.address, value }, witness: built.tx.ins[0].witness.map((b) => Buffer.from(b).toString("hex")) }],
  vout: built.tx.outs.map((o) => ({ value: o.value, scriptpubkey_address: o === built.tx.outs[0] ? built.dest : null })),
});
const spend = (route, destination) => {
  const b = buildSpend({ utxo, witnessScript: lock.witnessScript, destination, feeSats: 1000, route, fanKey: fan, cosignerKey: cos, locktime, network });
  return { ...b, dest: destination };
};
const home = spend("home", elsewhere);
const coSignedAway = spend("purchase", elsewhere);
const coSignedToShop = spend("purchase", shop);
// A commitment completed: its payment names its proposal in one marker output.
const MARK = { value: 0, scriptpubkey: "6a20" + "ab".repeat(32), scriptpubkey_address: null };
const marked = (tx) => ({ ...tx, vout: [...tx.vout, MARK] });

check("A spend on its date is not read as co-signed", !isCoSigned(asExplorer(home, locktime + 10).vin[0]));
check("A co-signed spend is read as co-signed", isCoSigned(asExplorer(coSignedAway, 1).vin[0]));

const ownerHex = Buffer.from(fan.publicKey).toString("hex"), cosHex = Buffer.from(cos.publicKey).toString("hex");
const L = { address: lock.address, locktime, owner_pubkey: ownerHex, cosigner_pubkey: cosHex };
const before = locktime - 86400 * 365;

const early = earlyReleases(L, [asExplorer(coSignedAway, before)]);
check("Co-signed before its date, not to a destination: an early release",
  early.length === 1 && early[0].sats === value && early[0].paidTo === elsewhere && early[0].cosigner === L.cosigner_pubkey);
check("…and one still waiting for a block counts too",
  earlyReleases(L, [asExplorer(coSignedAway, null)], null, before).length === 1);
// The network's clock (the median time of the blocks before) for a block stamped just after the date.
const pastClock = { [`b${locktime + 60}`]: locktime + 1 };
check("Co-signed after its date isn't one — the owner could have done that alone",
  earlyReleases(L, [asExplorer(coSignedAway, locktime + 60)], { clocks: pastClock }).length === 0);
check("Opened by its owner on its date isn't one",
  earlyReleases(L, [asExplorer(home, locktime + 60)], { clocks: pastClock }).length === 0);
check("Long after its date, no clock is needed: not one",
  earlyReleases(L, [asExplorer(coSignedAway, locktime + CLOCK_WINDOW + 1)]).length === 0);

// The block's own timestamp is the miner's choice; the network's clock decides
// (OpenAI review C-02, 17 November 2026).
const early2 = earlyReleases(L, [asExplorer(coSignedAway, locktime + 300)], { clocks: { [`b${locktime + 300}`]: locktime - 100 } });
check("A block stamped after the date, while the network's clock was still before it: an early release",
  early2.length === 1 && !early2[0].undecided);
check("…and the network's clock exactly on the date is still before it: an early release",
  earlyReleases(L, [asExplorer(coSignedAway, locktime + 300)], { clocks: { [`b${locktime + 300}`]: locktime } }).length === 1);
const unsure = earlyReleases(L, [asExplorer(coSignedAway, locktime + 300)]);
check("With the clock unread, it is reported as undecided, never as clean", unsure.length === 1 && unsure[0].undecided === true);
{
  const blocks = { [`b${locktime + 300}`]: { previousblockhash: "p1" }, p1: { mediantime: locktime - 100 } };
  const asked = [];
  const clocks = await clocksFor(L, [asExplorer(coSignedAway, locktime + 300), asExplorer(coSignedAway, before), asExplorer(coSignedAway, locktime + CLOCK_WINDOW + 5)],
    async (h) => { asked.push(h); return blocks[h]; });
  check("clocksFor reads the block before's median time, and only for spends that need it",
    clocks[`b${locktime + 300}`] === locktime - 100 && asked.length === 2, asked.join(","));
}

// A destinations list the way a real one is made: each entry attested by the
// attestor the Crowdlock's own file names, and stamped on the chain.
const INSTANCE = "3a".repeat(32);
const attestor = ECPair.makeRandom({ network });
const attHex = Buffer.from(attestor.publicKey).toString("hex");
const attAddress = memberAddressForOwnerKey(attHex, "bc");
const crowdlock = { network: "mainnet", cosigner_keys: [cosHex], attestor_keys: [attHex], attestor_threshold: 1,
  declaration: { sha256: INSTANCE }, destination_wait_days: 7, max_commitment_fee: 0.01 };
const sign = async (text) => {
  const sig = await signAsync(messageHash(text), attestor.privateKey);
  return Buffer.concat([Buffer.from([31 + sig.recovery]), Buffer.from(sig.toCompactRawBytes())]).toString("base64");
};
const stamps = {};
/** specs: [{ op, address, stampedAt? (seconds), attest? (default true) }] */
async function makeList(specs) {
  const entries = [];
  for (const [i, sp] of specs.entries()) {
    const e = { instance: INSTANCE, index: i + 1, op: sp.op, address: sp.address, text: "t", added: "2029-01-01T00:00:00Z",
      prev: entries.length ? destinationHash(entries[entries.length - 1]) : ZERO_PREV };
    if (sp.op === "add" && sp.attest !== false) e.attestations = [{ address: attAddress, signature: await sign(attestationStatement(e)) }];
    if (sp.op === "add" && sp.stampedAt) {
      e.stamp = (i + 1).toString(16).padStart(2, "0").repeat(32);
      stamps[e.stamp] = { txid: e.stamp, status: { confirmed: true, block_time: sp.stampedAt }, vout: [{ scriptpubkey: stampScript(e), value: 0 }] };
    }
    entries.push(e);
  }
  return { instance: INSTANCE, entries };
}
const longAgo = before - 30 * 86400;
const list = await makeList([{ op: "add", address: shop, stampedAt: longAgo }]);
const lctx = { destinations: list, crowdlock, stamps };
check("Co-signed to a listed destination is a purchase, not a release",
  earlyReleases(L, [marked(asExplorer(coSignedToShop, before))], lctx).length === 0);
check("Co-signed to a listed destination naming no proposal: an early release",
  earlyReleases(L, [asExplorer(coSignedToShop, before)], lctx).length === 1);
check("With the list empty, as it is today, every co-signed early spend is a release",
  earlyReleases(L, [marked(asExplorer(coSignedToShop, before))], { ...lctx, destinations: { entries: [] } }).length === 1);
const revoked = await makeList([{ op: "add", address: shop, stampedAt: longAgo }, { op: "revoke", address: shop }]);
const readded = await makeList([{ op: "add", address: shop, stampedAt: longAgo }, { op: "revoke", address: shop }, { op: "add", address: shop, stampedAt: longAgo }]);
const listed = (l, at = before) => isListedDestination(shop, l, { crowdlock, stamps, at });
check("A revoked destination doesn't count as listed", !listed(revoked) && listed(list));
check("Re-added after a revocation, it does", listed(readded));
check("Other addresses' spends in the same history are ignored",
  earlyReleases({ ...L, address: elsewhere }, [asExplorer(coSignedAway, before)]).length === 0);
check("No history, or a broken one, finds nothing rather than failing",
  earlyReleases(L, undefined).length === 0 && earlyReleases(L, [{}]).length === 0);

// ---- Every output, not just the first (17 November 2026) ----------------
// A co-signed early spend is a purchase only if every output is a listed
// destination, money staying locked, or an OP_RETURN holding nothing.
const ctx = { destinations: list, crowdlock, stamps, register: { locks: [], members: [] } };
const pay = (address, sats) => ({ value: sats, scriptpubkey: "0014" + "00".repeat(20), scriptpubkey_address: address });
const marker = { value: 0, scriptpubkey: "6a20" + "ab".repeat(32), scriptpubkey_address: null };
const withOuts = (outs, blockTime = before) => ({ ...asExplorer(coSignedToShop, blockTime), vout: outs });
const sameLock = recordAddress({ ownerPubkey: ownerHex, cosignerPubkey: cosHex, locktime }, "bc");
const later = recordAddress({ ownerPubkey: ownerHex, cosignerPubkey: cosHex, locktime: locktime + 86400 }, "bc");
const earlier = recordAddress({ ownerPubkey: ownerHex, cosignerPubkey: cosHex, locktime: locktime - 86400 }, "bc");
const stranger = ECPair.makeRandom({ network });
const theirs = recordAddress({ ownerPubkey: Buffer.from(stranger.publicKey).toString("hex"), cosignerPubkey: cosHex, locktime }, "bc");

check("Sanity: the lock rebuilt by the register's code is the lock itself", sameLock === lock.address.toLowerCase());
const hidden = earlyReleases(L, [withOuts([pay(shop, 330), pay(elsewhere, 498000)])], ctx);
check("330 sats to a listed destination and the rest to a wallet: an early release",
  hidden.length === 1 && hidden[0].paidTo === elsewhere);
check("To a listed destination, the rest back into the same lock, and the proposal marker: a purchase",
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(sameLock, 399000), marker])], ctx).length === 0);
check("Moved into another of the owner's locks with a proposal marker: an early release",
  earlyReleases(L, [withOuts([pay(sameLock, 499000), MARK])], ctx).length === 1);
check("The rest into a lock of the same owner with a later date, on the register: a purchase",
  // (399,000 back, not 398,000: a purchase leaves at most 1% of what it pays its destination as fee, as a commitment must.)
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(later, 399000), marker])],
    { ...ctx, register: { members: [], locks: [{ address: later, owner_pubkey: ownerHex, cosigner_pubkey: cosHex, locktime: locktime + 86400 }] } }).length === 0);
check("The rest into a lock of the same owner with an EARLIER date: an early release",
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(earlier, 398000)])],
    { ...ctx, register: { members: [], locks: [{ address: earlier, owner_pubkey: ownerHex, cosigner_pubkey: cosHex, locktime: locktime - 86400 }] } })[0]?.paidTo === earlier);
check("The rest into somebody else's lock: an early release",
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(theirs, 398000)])],
    { ...ctx, register: { members: [], locks: [{ address: theirs, owner_pubkey: Buffer.from(stranger.publicKey).toString("hex"), cosigner_pubkey: cosHex, locktime }] } })[0]?.paidTo === theirs);
check("A register record that only claims to be the same owner's later lock is not believed",
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(elsewhere, 398000)])],
    { ...ctx, register: { members: [], locks: [{ address: elsewhere, owner_pubkey: ownerHex, cosigner_pubkey: cosHex, locktime: locktime + 86400 }] } }).length === 1);
check("An OP_RETURN that carries money is not 'holding nothing'",
  earlyReleases(L, [withOuts([pay(shop, 100000), { ...marker, value: 398000 }])], ctx).length === 1);
check("Nothing listed at all: a co-signed early spend into the same lock alone is not a release (the money stayed locked)",
  earlyReleases(L, [withOuts([pay(sameLock, 498000)])], { ...ctx, destinations: { entries: [] } }).length === 0);
check("staysLocked refuses a lock under a co-signer key that isn't this Crowdlock's",
  !staysLocked(sameLock, L, { crowdlock: { cosigner_keys: [Buffer.from(stranger.publicKey).toString("hex")] }, register: null, hrp: "bc" }));

// ---- Ways around the record found by the second review (17 November 2026) ----
const odd = (selector) => { const t = asExplorer(coSignedAway, before); t.vin[0].witness = [...t.vin[0].witness]; t.vin[0].witness[1] = selector; return t; };
check("A co-signed spend whose branch selector is 00 (valid in a block) is an early release",
  earlyReleases(L, [odd("00")], ctx).length === 1 && earlyReleases(L, [odd("80")], ctx).length === 1);
check("All of it paid as fee, with one empty OP_RETURN: an early release",
  earlyReleases(L, [withOuts([{ value: 0, scriptpubkey: "6a", scriptpubkey_address: null }])], ctx).length === 1);
check("All of it paid as fee, with only a proposal marker: an early release",
  earlyReleases(L, [withOuts([marker])], ctx)[0]?.paidTo === null);
check("A fee bigger than a commitment may leave: an early release",
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(sameLock, 300000), marker])], ctx).length === 1);
check("Two markers: an early release (a commitment carries one)",
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(sameLock, 398000), marker, marker])], ctx).length === 1);
const unattested = { instance: INSTANCE, entries: [{ instance: INSTANCE, index: 1, op: "add", address: elsewhere, text: "t", added: "x", prev: ZERO_PREV }] };
check("Paid to an address the file lists but nobody attested: an early release",
  earlyReleases(L, [withOuts([pay(elsewhere, 498000)])], { ...ctx, destinations: unattested }).length === 1);
const lateStamp = await makeList([{ op: "add", address: shop, stampedAt: before + 86400 }]);
check("Paid to a destination stamped only after the payment: an early release",
  earlyReleases(L, [marked(asExplorer(coSignedToShop, before))], { ...ctx, destinations: lateStamp }).length === 1);
const young = await makeList([{ op: "add", address: shop, stampedAt: before - 86400 }]);
check("Paid to a destination still inside its waiting period: an early release",
  earlyReleases(L, [marked(asExplorer(coSignedToShop, before))], { ...ctx, destinations: young }).length === 1);
// One address, two spellings (OpenAI review M-02): a destination listed in capitals is the same destination.
const shouted = await makeList([{ op: "add", address: shop.toUpperCase(), stampedAt: longAgo }]);
check("A destination listed in capital letters is the same destination as the payment's small-letter address",
  earlyReleases(L, [marked(asExplorer(coSignedToShop, before))], { ...ctx, destinations: shouted }).length === 0);
const unstamped = await makeList([{ op: "add", address: shop }]);
check("Paid to an attested destination with no stamp: an early release",
  earlyReleases(L, [marked(asExplorer(coSignedToShop, before))], { ...ctx, destinations: unstamped }).length === 1);
check("Without the Crowdlock's own file, nothing counts as listed",
  earlyReleases(L, [marked(asExplorer(coSignedToShop, before))], { destinations: list, stamps }).length === 1);
const cos2 = ECPair.makeRandom({ network });
const hop = recordAddress({ ownerPubkey: ownerHex, cosignerPubkey: Buffer.from(cos2.publicKey).toString("hex"), locktime }, "bc");
check("Moved to the same owner's lock under a second co-signer key, not on the register: an early release",
  earlyReleases(L, [withOuts([pay(hop, 498000)])], { ...ctx, crowdlock: { ...crowdlock, cosigner_keys: [cosHex, Buffer.from(cos2.publicKey).toString("hex")] } })[0]?.paidTo === hop);

// ---- The whole history (17 November 2026) --------------------------------
// A release on the third page of a lock's history is still found.
const filler = (n, page) => Array.from({ length: n }, (_, i) => ({ txid: `p${page}t${i}`, status: { confirmed: true, block_time: before }, vin: [], vout: [] }));
const release = withOuts([pay(shop, 330), pay(elsewhere, 498000)]);
const pages = [filler(PAGE, 1), filler(PAGE, 2), [...filler(10, 3), release]];
const asked = [];
const h = await readHistory(async () => pages[0], async (last) => { asked.push(last); return pages[asked.length]; });
check("The whole history is read, page after page",
  h.complete && h.txs.length === 2 * PAGE + 11 && asked[0] === `p1t${PAGE - 1}` && asked[1] === `p2t${PAGE - 1}`);
check("…and a release buried under 50 small payments is found",
  earlyReleases(L, h.txs, ctx).length === 1);
const one = await readHistory(async () => filler(3, 1), async () => { throw new Error("asked for more"); });
check("A short history is one question", one.complete && one.txs.length === 3);
let n = 0;
const endless = await readHistory(async () => filler(PAGE, 0), async () => filler(PAGE, ++n));
check(`A history longer than ${MOST_PAGES} pages is read that far and called incomplete`,
  !endless.complete && n === MOST_PAGES - 1);
const waiting = Array.from({ length: 50 }, (_, i) => ({ txid: `w${i}`, status: { confirmed: false }, vin: [], vout: [] }));
check("Fifty waiting payments: called incomplete (an explorer shows no more than fifty)",
  !(await readHistory(async () => waiting, async () => [])).complete);


// ---- Security loop, round 3 ------------------------------------------------
{
  // Emptied as fees, a slice at a time. Each spend sent 99% back to the same
  // lock and left 1% as fee: every output "stayed locked" and each fee was
  // within a commitment's limit of what was SPENT, so 300 of them took 95% of
  // a lock before its date and none showed. A purchase pays a destination,
  // and its fee is limited by what it pays the destination, as a
  // commitment's is.
  // A list made afresh here: the stamps above are shared, and later lists in this file re-made them.
  const ctx3 = { ...ctx, destinations: await makeList([{ op: "add", address: shop, stampedAt: longAgo }]) };
  const move = (id, from, to, blockTime) => ({ txid: id, status: { confirmed: true, block_time: blockTime, block_hash: `b${blockTime}` },
    vin: [{ prevout: { scriptpubkey_address: lock.address, value: from }, witness: ["aa", "", "bb", "cc"] }], vout: [pay(sameLock, to)] });
  const slices = [];
  let left = 500000;
  for (let i = 0; i < 300; i++) { const next = Math.ceil(left * 0.99); slices.push(move(`s${i}`, left, next, before + i)); left = next; }
  const seen = earlyReleases(L, slices.slice().reverse(), ctx3);   // newest first, as an explorer lists them
  check("300 co-signed moves back into the same lock, each leaving 1% as fee: all but the first are on the record",
    left < 500000 * 0.06 && seen.length === 299 && seen.every((r) => r.paidTo === null), `${seen.length} reported; ${left} of 500000 sats left`);
  check("…while one such move with an ordinary fee is still not a release: the money stayed locked",
    earlyReleases(L, [move("m1", 500000, 499000, before)], ctx3).length === 0);
  const token = earlyReleases(L, [withOuts([pay(shop, 330), pay(sameLock, 494670)])], ctx3);
  check("…and 330 sats to a listed destination does not excuse a fee of 5,000", token.length === 1);
  check("A real commitment's shape still reads as a purchase: fee within 1% of what the destination is paid",
    earlyReleases(L, [withOuts([pay(shop, 100000), pay(sameLock, 399000), marker])], ctx3).length === 0
      && earlyReleases(L, [withOuts([pay(shop, 100000), pay(sameLock, 398999), marker])], ctx3).length === 1);
}
{
  // The locks a reader remembers. Remembering the newest 500 was not enough:
  // 500 newer records pushed an older lock out of memory while it was still
  // on the register, and it could then be removed unseen. The reader now also
  // keeps a running fingerprint of every lock it has seen, in order, so any
  // earlier record removed or changed shows, however long the register is.
  const { locksToWatch, locksSeen, LOCKS_REMEMBERED } = await import("./release.mjs");
  const co = "02" + "c5".repeat(32);
  const cl = { network: "mainnet", cosigner_keys: [co] };
  const mk = (i) => {
    const owner = Buffer.from(ECPair.makeRandom({ network }).publicKey).toString("hex");
    const t = 1900000000 + i;
    return { owner_pubkey: owner, cosigner_pubkey: co, locktime: t, address: recordAddress({ ownerPubkey: owner, cosignerPubkey: co, locktime: t }, "bc") };
  };
  const X = mk(0);
  const small = { members: [], locks: [X] };
  const m1 = locksSeen({ crowdlock: cl, register: small });
  check("What is remembered: the locks' terms, how many there were, and a fingerprint of them in order",
    m1.locks.length === 1 && m1.count === 1 && /^[0-9a-f]{64}$/.test(m1.chain) && !m1.rewritten);
  const many = { members: [], locks: [X, ...Array.from({ length: LOCKS_REMEMBERED + 1 }, (_, i) => mk(i + 1))] };
  const m2 = locksSeen({ crowdlock: cl, register: many, remembered: m1 });
  check("A register that only grows is not a rewritten one", !m2.rewritten && m2.count === LOCKS_REMEMBERED + 2 && !locksToWatch({ crowdlock: cl, register: many, remembered: m1 }).rewritten);
  check("…though by now the oldest lock's terms have dropped out of memory", !m2.locks.some((l) => l.owner_pubkey === X.owner_pubkey));
  const without = { members: [], locks: many.locks.slice(1) };
  const w = locksToWatch({ crowdlock: cl, register: without, remembered: m2 });
  check("That oldest lock taken off the register is still noticed: the register was rewritten", w.rewritten === true, `gone ${w.gone.length}, rewritten ${w.rewritten}`);
  const bent = { members: [], locks: [{ ...X, locktime: X.locktime + 1 }, ...many.locks.slice(1)] };
  check("…and so is one digit of its date changed", locksToWatch({ crowdlock: cl, register: bent, remembered: m2 }).rewritten === true);
  const m3 = locksSeen({ crowdlock: cl, register: without, remembered: m2 });
  check("Once seen, a rewrite is not forgotten when the register settles down",
    m3.rewritten === true && locksToWatch({ crowdlock: cl, register: without, remembered: m3 }).rewritten === true);
  check("Memory kept the old way (a plain list of terms) still works", locksToWatch({ crowdlock: cl, register: { members: [], locks: [] }, remembered: [X] }).gone.length === 1);
}
{
  // The coins at an address, worked out from its history. Public explorers
  // refuse to list the coins at an address holding more than 500, so 501
  // tiny coins sent to a lock's address made the lock unreadable everywhere.
  const { coinsFromHistory } = await import("./release.mjs");
  const A = "bc1qaaa", B = "bc1qbbb";
  const funding = { txid: "f1", status: { confirmed: true }, vin: [{ txid: "00", vout: 0, prevout: { scriptpubkey_address: B } }], vout: [{ scriptpubkey_address: A, value: 500000 }, { scriptpubkey_address: B, value: 7 }] };
  const dust = { txid: "d1", status: { confirmed: true }, vin: [{ txid: "01", vout: 0, prevout: { scriptpubkey_address: B } }], vout: Array.from({ length: 501 }, () => ({ scriptpubkey_address: A.toUpperCase(), value: 330 })) };
  const pending = { txid: "p1", status: { confirmed: false }, vin: [{ txid: "02", vout: 1, prevout: { scriptpubkey_address: B } }], vout: [{ scriptpubkey_address: A, value: 9000 }] };
  const spendOne = { txid: "s1", status: { confirmed: true }, vin: [{ txid: "d1", vout: 3, prevout: { scriptpubkey_address: A } }], vout: [{ scriptpubkey_address: B, value: 100 }] };
  const coins = coinsFromHistory(A, [pending, spendOne, dust, funding]);
  check("An address's coins are worked out from its history: every output paying it that nothing has spent",
    coins.length === 1 + 500 + 1 && coins.filter((c) => c.confirmed).length === 501 && !coins.some((c) => c.txid === "d1" && c.vout === 3)
      && coins.some((c) => c.txid === "f1" && c.vout === 0 && c.value === 500000 && c.confirmed) && coins.some((c) => c.txid === "p1" && !c.confirmed));
}

console.log(failures === 0 ? "\nAn early release by the co-signer is caught; a purchase or a spend on its date is not." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
