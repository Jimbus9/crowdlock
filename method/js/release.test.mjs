// Tests release.mjs against spends built by the lock's own reference code
// (method/lock/lock.mjs), turned into the JSON a block explorer returns. The
// two share no code, so if the detector reads these right it reads the chain
// right.
//
// Run:  node method/js/release.test.mjs      (from the repo root, after npm ci in method/lock)

import { ECPair, lockAddress, buildSpend, networkFor } from "../lock/lock.mjs";
import { isCoSigned, isListedDestination, earlyReleases, staysLocked, readHistory, PAGE, MOST_PAGES } from "./release.mjs";
import { lockAddress as recordAddress } from "./lockrecord.mjs";

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
  status: blockTime ? { confirmed: true, block_time: blockTime } : { confirmed: false },
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
check("Co-signed after its date isn't one — the owner could have done that alone",
  earlyReleases(L, [asExplorer(coSignedAway, locktime + 60)]).length === 0);
check("Opened by its owner on its date isn't one",
  earlyReleases(L, [asExplorer(home, locktime + 60)]).length === 0);

const list = { entries: [{ index: 1, op: "add", address: shop }] };
check("Co-signed to a listed destination is a purchase, not a release",
  earlyReleases(L, [asExplorer(coSignedToShop, before)], { destinations: list }).length === 0);
check("With the list empty, as it is today, every co-signed early spend is a release",
  earlyReleases(L, [asExplorer(coSignedToShop, before)], { destinations: { entries: [] } }).length === 1);
const revoked = { entries: [{ index: 1, op: "add", address: shop }, { index: 2, op: "revoke", address: shop }] };
check("A revoked destination doesn't count as listed", !isListedDestination(shop, revoked) && isListedDestination(shop, list));
check("Re-added after a revocation, it does", isListedDestination(shop, { entries: [...revoked.entries, { index: 3, op: "add", address: shop }] }));
check("Other addresses' spends in the same history are ignored",
  earlyReleases({ ...L, address: elsewhere }, [asExplorer(coSignedAway, before)]).length === 0);
check("No history, or a broken one, finds nothing rather than failing",
  earlyReleases(L, undefined).length === 0 && earlyReleases(L, [{}]).length === 0);

// ---- Every output, not just the first (17 November 2026) ----------------
// A co-signed early spend is a purchase only if every output is a listed
// destination, money staying locked, or an OP_RETURN holding nothing.
const crowdlock = { network: "mainnet", cosigner_keys: [cosHex] };
const ctx = { destinations: list, crowdlock, register: { locks: [], members: [] } };
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
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(sameLock, 398000), marker])], ctx).length === 0);
check("The rest into a lock of the same owner with a later date, on the register: a purchase",
  earlyReleases(L, [withOuts([pay(shop, 100000), pay(later, 398000)])],
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

console.log(failures === 0 ? "\nAn early release by the co-signer is caught; a purchase or a spend on its date is not." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
