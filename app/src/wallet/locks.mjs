// Locks: their terms, locking, the date, taking home, locking again, and the record a lock is posted as.
// Part of the wallet's key module: see core.mjs for the rule every part keeps.

import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { BIP32, Output, Psbt, signers, networks, keyExpressionBIP32 } from "@bitcoinerlab/descriptors";
import * as ecc from "@bitcoinerlab/secp256k1";
import bs58check from "bs58check";
import { Transaction, script as bscript, address as baddress, crypto as bcrypto } from "bitcoinjs-lib";
import * as ledgerApi from "@bitcoinerlab/descriptors/ledger";
// The register's own verifier, shared with the website: the message hash a
// signature is made over is computed by exactly the code that later checks it.
import { messageHash, verifyMembership, memberAddressForOwnerKey, canonicalAddress } from "../../../method/js/verify.mjs";
// The lock's script and address, and the destinations list's rules, are the
// register's own browser-safe code (held to the reference code by its tests).
import { lockScript as lockScriptOf, lockAddress as lockAddressOf, lockLine } from "../../../method/js/lockrecord.mjs";
import { destinationIsPermitted, attestorsOf, stampsFor, SETTLE_MARGIN, commitmentEligible } from "../../../method/js/proposals.mjs";
import { isCosignerOf, homeLine, homeSignatureChecks } from "../../../method/js/crowdlock.mjs";

import { DUST_SATS, TOO_SMALL, fromHex, worthSpending } from "./base.mjs";
import { keyFromXpub, signStatement, xpubForNetwork } from "./keys.mjs";
import { buildSend, coinSource } from "./sending.mjs";

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------
//
// A lock is the standard miniscript of spec/lock-format.md, written as a
// descriptor and handed to the library, which makes the script and address:
//
//   wsh(and_v(v:pk(owner),or_i(after(date),pk(cosigner))))
//
// The library check (method/lock/library-check) proved this gives byte-for-byte the
// testnet-proven script, and the app's tests prove it matches the address the
// register rebuilds (method/js/lockrecord.mjs). Locking is an ordinary send to that
// address. Going home is the library's own spend of the owner-alone branch,
// which sets the transaction's date itself; the network refuses it until the
// date has passed, whatever this code says.

const YEAR = 365.25 * 86400;
const DAY = 86400;
const PUBKEY = /^0[23][0-9a-f]{64}$/;

/**
 * The date a lock of `years` made now unlocks, as unix seconds. Rounded up to
 * the next midnight (UTC) so a lock reads as a plain date. Test Crowdlocks may
 * offer lengths under a day; those are not rounded.
 */
export function lockDate(years, nowSeconds = Math.floor(Date.now() / 1000)) {
  const t = Math.ceil(nowSeconds + years * YEAR);
  return years * YEAR < DAY ? t : Math.ceil(t / DAY) * DAY;
}

export function lockDescriptor(account, cosignerPubkey, locktime, cosignerXpub = null) {
  return `wsh(and_v(v:pk(${account.keyExpression}),or_i(after(${locktime}),pk(${cosignerExpression(account, cosignerPubkey, cosignerXpub)}))))`;
}

/**
 * How the lock names its co-signer. The same key either way — a hardware
 * wallet just needs it written as its xpub's first key, so the script and the
 * address are identical. Refuses an xpub that stands for a different key.
 */
function cosignerExpression(account, cosignerPubkey, cosignerXpub) {
  if (account.kind !== "ledger") return cosignerPubkey;
  if (!cosignerXpub) throw new Error("this Crowdlock hasn't published its co-signer's xpub, which a hardware wallet needs before it can lock — ask its founder to add it");
  if (keyFromXpub(cosignerXpub) !== String(cosignerPubkey).toLowerCase()) throw new Error("the co-signer's xpub doesn't stand for its key — refusing");
  return `${xpubForNetwork(cosignerXpub, account.network)}/0/0`;
}

/** What a Ledger shows as the lock's name when asked to approve it once. */
export function lockPolicyName(locktime) {
  const d = new Date(locktime * 1000).toISOString();
  return `Crowdlock until ${d.slice(0, 10)}${locktime % DAY ? " " + d.slice(11, 16) : ""}`;
}

/**
 * Sign every input this account can sign. Backup words sign here; a Ledger
 * signs on the device, after it has approved, once, the rules of each lock it
 * is asked to open (`policies`: { descriptor, name }).
 */
export async function signWith(account, psbt, policies = []) {
  if (account.kind === "ledger") {
    return account.useLedger(async (session) => {
      for (const p of policies) await ledgerApi.registerPolicy({ descriptor: p.descriptor, session, name: p.name });
      await ledgerApi.signers.sign({ psbt, session });
    });
  }
  signers.signBIP32({ psbt, masterNode: account.signer() });
}

/**
 * The lock for this account, co-signer and date: its address and terms.
 * Refuses a co-signer that is the fan's own key (one person could then move
 * the coins any time) and anything that is not a date.
 */
export function lockFor({ account, cosignerPubkey, locktime }) {
  const cosigner = String(cosignerPubkey ?? "").toLowerCase();
  if (!PUBKEY.test(cosigner)) throw new Error("that co-signer key is not a compressed public key");
  if (cosigner.slice(2) === account.publicKey.slice(2)) {
    throw new Error("the co-signer key is your own key — that would not be a lock");
  }
  if (!Number.isInteger(locktime) || locktime < 500000000) throw new Error("a lock's date must be a date");
  // The address, from the plain keys: identical whichever way a wallet names
  // the co-signer, so it is worked out the one way for everybody.
  const output = new Output({ descriptor: lockDescriptor({ ...account, kind: "words" }, cosigner, locktime), network: account.network });
  return { address: output.getAddress(), ownerPubkey: account.publicKey, cosignerPubkey: cosigner, locktime };
}

/**
 * Lock waiting money: one send to the lock's address. `amount` is sats as a
 * BigInt, or "all" (the default) for everything waiting. Whatever is not
 * locked stays waiting, free for another lock or another Crowdlock. Same
 * refusals as any send.
 *
 * @param {{ account: any, chain: any, lock: any, feeRate: number, amount?: bigint | "all" }} args
 */
export async function buildLock({ account, chain, lock, feeRate, amount = "all" }) {
  const check = lockFor({ account, cosignerPubkey: lock.cosignerPubkey, locktime: lock.locktime });
  if (check.address !== lock.address) throw new Error("those lock terms do not make that address — refusing");
  // A Ledger can only take a lock home if it can recognise it, so it never
  // locks money into one it couldn't open: the co-signer's xpub must be there.
  if (account.kind === "ledger") cosignerExpression(account, lock.cosignerPubkey, lock.cosignerXpub);
  // And it is asked to approve the lock's rules now, before any money moves
  // (once; it remembers), so a Ledger that would refuse them says so here and
  // not when the date comes, a year on. Taking it home later finds it approved.
  const policies = account.kind === "ledger"
    ? [{ descriptor: lockDescriptor(account, check.cosignerPubkey, lock.locktime, lock.cosignerXpub), name: lockPolicyName(lock.locktime) }]
    : [];
  return buildSend({ account, chain, to: lock.address, amount, feeRate, policies });
}

/**
 * What state a lock is in, from the chain alone (spec/counting-rule.md):
 *   "empty"      nothing has ever been sent to it
 *   "arriving"   money is on its way, not yet confirmed
 *   "locked"     confirmed money, date still ahead
 *   "lapsed"     confirmed money, date passed — the owner may take it home
 *   "withdrawn"  it held money once and is empty now
 * `medianTime` is the chain's own clock, the one its date is judged by.
 *
 * Two ways to ask less of the block explorer, both the caller's choice:
 *   `quick`     don't ask whether an empty lock ever held money (a screen
 *               that doesn't show empty locks has no use for the answer); an
 *               empty lock is then reported as "withdrawn".
 *   `finished`  a Map the caller keeps. A lock found empty after its date is
 *               over: it is noted there and not asked about again, so a page
 *               doesn't re-ask about every lock a fan ever took home. The
 *               caller empties the Map when the fan asks to check again, which
 *               is when money sent to an old lock's address would be found.
 *
 * @param {{ chain: any, lock: any, medianTime: number, quick?: boolean, finished?: Map<string, string> | null }} args
 */
export async function lockState({ chain, lock, medianTime, quick = false, finished = null }) {
  // Past, not equal: the network takes the owner's spend only once its clock
  // is beyond the date (takeHome asks the same).
  const over = lock.locktime < medianTime;
  const noted = over ? finished?.get(lock.address) : undefined;
  // Already known to be finished, and known how (or this screen doesn't care how).
  if (noted && (noted !== "unasked" || quick)) return { state: noted === "empty" ? "empty" : "withdrawn", confirmed: 0n, arriving: 0n };
  const coins = noted ? [] : await chain.utxos(lock.address);
  const confirmed = coins.filter((c) => c.confirmed).reduce((s, c) => s + BigInt(c.value), 0n);
  const arriving = coins.filter((c) => !c.confirmed).reduce((s, c) => s + BigInt(c.value), 0n);
  let state;
  if (confirmed > 0n) state = over ? "lapsed" : "locked";
  else if (arriving > 0n) state = "arriving";
  else {
    state = quick || (await chain.everFunded(lock.address)) ? "withdrawn" : "empty";
    if (over) finished?.set(lock.address, quick ? "unasked" : state);
  }
  return { state, confirmed, arriving };
}

/**
 * Take a lapsed lock home: the owner alone spends every confirmed coin in it
 * back to their own address (or `to`), through the going-home branch.
 *
 * Refuses before the chain's clock has passed the date — the network would
 * refuse it anyway, but there is no reason to send something that must fail.
 * `ignoreDate` exists only so the tests can prove the network refuses it too.
 *
 * @param {{ account: any, chain: any, lock: any, feeRate: number, medianTime: number, to?: string, ignoreDate?: boolean }} args
 * @returns {Promise<{ hex: string, txid: string, fee: bigint, sent: bigint }>}
 */
export async function takeHome({ account, chain, lock, feeRate, medianTime, to, ignoreDate = false }) {
  const net = account.network;
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) {
    throw new Error("fee rate must be between 1 and 1000 sats per vbyte");
  }
  if (!ignoreDate && !(medianTime > lock.locktime)) {
    throw new Error("this lock's date has not passed yet on the network's clock");
  }
  const check = lockFor({ account, cosignerPubkey: lock.cosignerPubkey, locktime: lock.locktime });
  if (check.address !== lock.address) throw new Error("those lock terms do not make that address — refusing");

  // signersPubKeys tells the library only the owner will sign, so it takes
  // the going-home branch and sets the transaction's date itself.
  const descriptor = lockDescriptor(account, check.cosignerPubkey, lock.locktime, lock.cosignerXpub);
  const out = new Output({ descriptor, network: net, signersPubKeys: [fromHex(account.publicKey)] });
  let dest;
  try { dest = new Output({ descriptor: `addr(${String(to ?? account.address).trim()})`, network: net }); }
  catch { throw new Error("that is not an address on this network"); }

  const everyCoin = (await chain.utxos(lock.address)).filter((c) => c.confirmed);
  if (everyCoin.length === 0) throw new Error("there is no confirmed money in this lock");
  // Coins that cost more to spend than they hold are left where they are.
  const coins = worthSpending(everyCoin, out.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES"), feeRate);
  if (coins.length === 0) throw new Error(TOO_SMALL);
  const total = coins.reduce((s, c) => s + BigInt(c.value), 0n);

  const weight = 44 + coins.length * out.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES") + dest.outputWeight();
  const fee = BigInt(Math.ceil((weight / 4) * feeRate));
  const sent = total - fee;
  if (sent < DUST_SATS) throw new Error("the fee would take almost all of it — too little to bring home");
  // Half, not a tenth: bringing a small lock home is still worth doing.
  if (fee * 2n > total) throw new Error("the fee would be more than half of the lock — refusing");

  const psbt = new Psbt({ network: net });
  const finalizers = [];
  for (const c of coins) {
    finalizers.push(out.updatePsbtAsInput({ psbt, txHex: await coinSource(chain, c), vout: c.vout }));
  }
  dest.updatePsbtAsOutput({ psbt, value: sent });
  await signWith(account, psbt, [{ descriptor, name: lockPolicyName(lock.locktime) }]);
  for (const finalize of finalizers) finalize({ psbt });
  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), fee, sent };
}

/**
 * Lock a lapsed lock again, straight from the old lock into a new one, in one
 * transaction: one fee, and no gap where the money sits uncounted. With
 * `addWaiting`, every confirmed coin waiting goes into the new lock too.
 *
 * The old lock is spent through its going-home branch (the owner alone, after
 * its date), exactly as takeHome does; the only difference is where the money
 * goes. So it is refused before the old date, by this code and by the network.
 *
 * @param {{ account: any, chain: any, lock: any, newLock: any, feeRate: number, medianTime: number, addWaiting?: boolean }} args
 * @returns {Promise<{ hex: string, txid: string, fee: bigint, sent: bigint }>}
 */
export async function relock({ account, chain, lock, newLock, feeRate, medianTime, addWaiting = false }) {
  const net = account.network;
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) {
    throw new Error("fee rate must be between 1 and 1000 sats per vbyte");
  }
  if (!(medianTime > lock.locktime)) throw new Error("this lock's date has not passed yet on the network's clock");
  const old = lockFor({ account, cosignerPubkey: lock.cosignerPubkey, locktime: lock.locktime });
  if (old.address !== lock.address) throw new Error("those lock terms do not make that address — refusing");
  const next = lockFor({ account, cosignerPubkey: newLock.cosignerPubkey, locktime: newLock.locktime });
  if (next.address !== newLock.address) throw new Error("the new lock's terms do not make its address — refusing");
  if (next.address === old.address) throw new Error("the new lock must have a new date");

  const oldDescriptor = lockDescriptor(account, old.cosignerPubkey, lock.locktime, lock.cosignerXpub);
  const oldOut = new Output({ descriptor: oldDescriptor, network: net, signersPubKeys: [fromHex(account.publicKey)] });
  const dest = new Output({ descriptor: `addr(${next.address})`, network: net });

  const everyLockCoin = (await chain.utxos(lock.address)).filter((c) => c.confirmed);
  if (everyLockCoin.length === 0) throw new Error("there is no confirmed money in this lock");
  // Coins that cost more to spend than they hold are left where they are.
  const lockCoins = worthSpending(everyLockCoin, oldOut.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES"), feeRate);
  if (lockCoins.length === 0) throw new Error(TOO_SMALL);
  const waitCoins = addWaiting ? worthSpending((await chain.utxos(account.address)).filter((c) => c.confirmed), account.output.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES"), feeRate) : [];
  const total = [...lockCoins, ...waitCoins].reduce((s, c) => s + BigInt(c.value), 0n);

  const weight = 44
    + lockCoins.length * oldOut.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES")
    + waitCoins.length * account.output.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES")
    + dest.outputWeight();
  const fee = BigInt(Math.ceil((weight / 4) * feeRate));
  const sent = total - fee;
  if (sent < DUST_SATS) throw new Error("the fee would take almost all of it — too little to lock");
  if (fee * 10n > sent) throw new Error("the fee would be more than a tenth of the amount — refusing");

  const psbt = new Psbt({ network: net });
  const finalizers = [];
  for (const c of lockCoins) finalizers.push(oldOut.updatePsbtAsInput({ psbt, txHex: await coinSource(chain, c), vout: c.vout }));
  // Waiting coins are added by the library as usual. They are finished by
  // bitcoinjs's own standard finaliser rather than the descriptor's, which
  // refuses them: it checks every input against the transaction's date, and
  // here the date belongs to the old lock's input, not to these.
  const waitIndexes = [];
  for (const c of waitCoins) {
    account.output.updatePsbtAsInput({ psbt, txHex: await coinSource(chain, c), vout: c.vout });
    waitIndexes.push(psbt.inputCount - 1);
  }
  dest.updatePsbtAsOutput({ psbt, value: sent });
  // The new lock's rules are approved now too, so the device has read them
  // long before it has to take that lock home.
  const policies = [{ descriptor: oldDescriptor, name: lockPolicyName(lock.locktime) }];
  if (account.kind === "ledger") {
    policies.push({ descriptor: lockDescriptor(account, next.cosignerPubkey, newLock.locktime, newLock.cosignerXpub), name: lockPolicyName(newLock.locktime) });
  }
  await signWith(account, psbt, policies);
  for (const finalize of finalizers) finalize({ psbt });
  for (const i of waitIndexes) psbt.finalizeInput(i);
  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), fee, sent };
}


/**
 * The record a lock is posted to the relays as. Signed by the owner when the
 * key is on this phone, so a flood of records naming this member's key can't
 * hold it up (method/js/lockrecord.mjs, lockLine). A Ledger's lock goes
 * unsigned rather than ask for a second approval; it is still taken, only
 * not ahead of others.
 */
export function lockRecordFor(account, crowdlock, { address, cosigner_pubkey, locktime }) {
  const record = { type: "lock", owner_pubkey: account.publicKey, cosigner_pubkey, locktime, address };
  if (account.kind === "ledger") return record;
  // Never throws. Given the wallet as the screens hold it, which can't sign
  // until it is unlocked, the record simply goes unsigned: it is still taken,
  // only not ahead of others. (Throwing here, after the money is locked,
  // would leave the lock off the register.) Pass the unlocked account to have
  // it signed.
  try { return { ...record, owner_signature: signStatement(account, lockLine(crowdlock.declaration.sha256, record)) }; }
  catch { return record; }
}
