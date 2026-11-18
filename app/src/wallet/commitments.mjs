// Commitments: building one, checking one, completing one, and what a spent one paid.
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

import { NETWORKS, dustFor, fromHex, toBase64, toHex } from "./base.mjs";
import { COSIGNER_PATH, cosignerKeyFromWords, tidyWords, wordsAreValid } from "./keys.mjs";
import { lockDescriptor, lockFor, lockPolicyName, signWith } from "./locks.mjs";
import { coinSource } from "./sending.mjs";

// ---------------------------------------------------------------------------
// Committing a lock to a purchase (spec/commitment-format.md)
// ---------------------------------------------------------------------------

/**
 * The output that names the proposal: OP_RETURN and the proposal's 32-byte
 * hash, carrying no money. It is the last output of every commitment, so the
 * owner's signature covers which proposal the payment is for. Without it a
 * commitment could be relabelled for any other proposal paying the same
 * address (method/lock/commitment.mjs, proposalMarker).
 */
export function proposalMarker(proposalHash) {
  const out = new Uint8Array(34);
  out[0] = 0x6a; out[1] = 0x20; out.set(fromHex(proposalHash), 2);
  return out;
}

// The size of a finished commitment, for its fee. Worked out from its parts,
// because the library's own figure is for the cheaper way out of a lock (the
// owner alone, one signature), and a commitment leaves by the other, with
// two: about a tenth bigger.
const SIGNATURE_BYTES = 72; // the most a low-S signature takes, with its last byte
function commitmentVsize({ destinationScript, scriptLength, withRemainder }) {
  const output = (len) => 8 + 1 + len;
  const base = 4 + 1 + (36 + 1 + 4) + 1 + output(destinationScript.length) + (withRemainder ? output(34) : 0) + output(34) + 4;
  const witness = 2 + 1 + (1 + SIGNATURE_BYTES) + 1 + (1 + SIGNATURE_BYTES) + (1 + scriptLength);
  return Math.ceil((base * 4 + witness) / 4);
}
/** The size the finished payment will have, given the commitment as recorded (the co-signer's signature still to come). */
function completedVsize(tx) {
  return Math.ceil((tx.weight() + SIGNATURE_BYTES) / 4);
}

/**
 * The owner's half of a purchase: one coin of one lock, spent down the
 * purchase branch to the proposal's destination, signed by the owner only.
 * Nothing is broadcast and nothing moves. Without the co-signer's signature
 * this transaction can never be valid, so the record can be published freely.
 *
 * `coin` is one confirmed coin of the lock ({ txid, vout, value }); a
 * commitment spends exactly one. `amount` is what reaches the destination
 * (BigInt sats), or "all": the whole coin less the fee. Committing part of a
 * coin sends the rest straight back to the same lock — same owner, same
 * co-signer, same date — which is the one remainder the spec always accepts.
 *
 * The library's own signers do the signing (backup words here, or the Ledger
 * on the device). The library can't finish this transaction, because it is
 * half of one, so the witness is laid out here in the commitment format's
 * fixed shape — [co-signer's slot (empty), branch selector (empty, the
 * purchase branch), owner's signature, script] — exactly as
 * method/lock/commitment.mjs lays it out and the co-signer later completes.
 *
 * @param {{ account: any, chain: any, lock: any, coin: { txid: string, vout: number, value: number }, proposalHash: string, destination: string, amount: bigint | "all", feeRate: number, maxFee?: number }} args
 * @returns {Promise<{ record: any, fee: bigint, committed: bigint, remainder: bigint }>}
 */
export async function buildCommitment({ account, chain, lock, coin, proposalHash, destination, amount, feeRate, maxFee = 0.01 }) {
  const net = account.network;
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) {
    throw new Error("fee rate must be between 1 and 1000 sats per vbyte");
  }
  if (!/^[0-9a-f]{64}$/.test(String(proposalHash ?? ""))) throw new Error("that is not a proposal's hash");
  const check = lockFor({ account, cosignerPubkey: lock.cosignerPubkey, locktime: lock.locktime });
  if (check.address !== lock.address) throw new Error("those lock terms do not make that address — refusing");

  // The library describes the input (script, coin, key path). Given both
  // keys it would still pick the cheaper going-home branch, which needs the
  // date (method/lock/library-check found this on 28 October), so the
  // transaction's date is set to none below, before anything is signed: the
  // owner then signs the purchase spend, which declares no date.
  const descriptor = lockDescriptor(account, check.cosignerPubkey, lock.locktime, lock.cosignerXpub);
  const out = new Output({
    descriptor, network: net,
    signersPubKeys: [fromHex(account.publicKey), fromHex(check.cosignerPubkey)],
  });
  let dest;
  try { dest = new Output({ descriptor: `addr(${String(destination).trim()})`, network: net }); }
  catch { throw new Error("the proposal's destination is not an address on this network"); }
  const back = new Output({ descriptor: lockDescriptor({ ...account, kind: "words" }, check.cosignerPubkey, lock.locktime), network: net });

  const value = BigInt(coin.value);
  const destinationScript = dest.getScriptPubKey();
  const lockScriptLength = out.getWitnessScript()?.length;
  if (!lockScriptLength) throw new Error("the lock's script is missing — refusing");
  const feeFor = (withRemainder) => BigInt(Math.ceil(commitmentVsize({ destinationScript, scriptLength: lockScriptLength, withRemainder }) * feeRate));
  // What each output must hold for the network to pass the payment on.
  const leastCommitted = dustFor(destinationScript), leastBack = dustFor(back.getScriptPubKey());

  let committed, remainder, fee;
  if (amount === "all") {
    fee = feeFor(false); committed = value - fee; remainder = 0n;
  } else {
    committed = BigInt(amount);
    if (committed <= 0n) throw new Error("commit an amount above nothing");
    fee = feeFor(true); remainder = value - committed - fee;
    if (remainder < 0n) throw new Error("that is more than this coin holds, after the fee");
    // A remainder too small to be worth an output goes to the destination too.
    if (remainder < leastBack) { fee = feeFor(false); committed = value - fee; remainder = 0n; }
  }
  if (committed < leastCommitted) throw new Error("too little left to commit after the fee");
  // The spec's own sanity check: verifiers refuse a fee above this share.
  if (Number(fee) > Number(committed) * maxFee) {
    const smallest = BigInt(Math.ceil(Number(fee) / maxFee));
    const btc = (v) => (Number(v) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    throw new Error(`the fee (${fee} sats at ${feeRate} sat/vB) would be more than ${maxFee * 100}% of what is committed. At this fee rate the smallest commitment is about ${btc(smallest)} BTC — commit at least that, or choose a slower fee`);
  }

  const psbt = new Psbt({ network: net });
  out.updatePsbtAsInput({ psbt, txHex: await coinSource(chain, coin), vout: coin.vout });
  dest.updatePsbtAsOutput({ psbt, value: committed });
  if (remainder > 0n) back.updatePsbtAsOutput({ psbt, value: remainder });
  // Last, the proposal itself, so that what is signed says what it is for.
  psbt.addOutput({ script: proposalMarker(proposalHash), value: 0n });
  psbt.setLocktime(0);
  if (psbt.locktime !== 0 || psbt.txInputs.length !== 1) throw new Error("a commitment spends one coin and declares no date — refusing");
  // The signature will cover these two, so nobody could put them right
  // afterwards: a version the network passes on, and no waiting period.
  if (psbt.version !== 1 && psbt.version !== 2) throw new Error("a commitment must be an ordinary version 1 or 2 transaction — refusing");
  if ((psbt.txInputs[0].sequence & 0x80000000) === 0) throw new Error("a commitment's input must set no waiting period — refusing");

  await signWith(account, psbt, [{ descriptor, name: lockPolicyName(lock.locktime) }]);

  const sigs = psbt.data.inputs[0].partialSig ?? [];
  const mine = sigs.find((p) => toHex(p.pubkey) === account.publicKey);
  if (!mine || sigs.length !== 1) throw new Error("the wallet did not sign this commitment as expected — refusing");
  const witnessScript = out.getWitnessScript();
  if (!witnessScript) throw new Error("the lock's script is missing — refusing");

  const tx = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  tx.setWitness(0, [new Uint8Array(0), new Uint8Array(0), mine.signature, witnessScript]);
  // The fee was worked out before anything was built. Check it against the
  // payment as built: never under what the network needs to pass it on.
  if (fee < BigInt(completedVsize(tx))) throw new Error("the fee came out below what the network needs — refusing");

  const record = {
    proposal: proposalHash,
    lock: { address: lock.address, owner_pubkey: account.publicKey, cosigner_pubkey: check.cosignerPubkey, locktime: lock.locktime },
    tx: tx.toHex(),
  };
  if (remainder > 0n) record.remainder = { owner_pubkey: account.publicKey, cosigner_pubkey: check.cosignerPubkey, locktime: lock.locktime };
  return { record, fee, committed, remainder };
}

/**
 * Check a commitment, as the co-signer and the proposal page must before
 * counting or completing it. The same checks, in the same order and with the
 * same verdicts, as verifyCommitment in method/lock/commitment.mjs — which runs
 * only in Node — and held to it by the chain tests.
 *
 * `proposal` is a checked proposal from method/js/proposals.mjs; `destinations`
 * the Crowdlock's destinations file. The coin's value, and whether it is still
 * unspent, come from the chain.
 *
 * `coin` in the answer is the coin the commitment spends ("txid:vout"), so a
 * caller adding up a pile can count each coin once: two commitments spending
 * the same coin can never both be paid.
 *
 * @returns {Promise<{ valid: boolean, reason: string, committedSats: number, fee: number, ownerPubkey?: string, coin?: string }>}
 */
export async function checkCommitment({ record, crowdlock, proposal, destinations, chain, network }) {
  const net = typeof network === "string" ? NETWORKS[network].network : (network.network ?? network);
  const hrp = net.bech32;
  const fail = (reason) => ({ valid: false, reason, committedSats: 0, fee: 0 });
  if (record?.proposal !== proposal.hash) return fail("record names a different proposal");
  const L = record.lock ?? {};
  let script, derived;
  try {
    const terms = { ownerPubkey: L.owner_pubkey, cosignerPubkey: L.cosigner_pubkey, locktime: L.locktime };
    script = lockScriptOf(terms); derived = lockAddressOf(terms, hrp);
  } catch (e) { return fail(`lock fields are not a valid lock: ${e.message}`); }
  if (derived !== L.address) return fail("lock address does not re-derive from the stated keys and locktime");
  if (!isCosignerOf(crowdlock, L.cosigner_pubkey)) return fail(`the lock's co-signer is not ${crowdlock.name}'s — this commitment belongs to a different Crowdlock, or to none`);
  // The lock must still be shut when the proposal's settling ends, or its
  // owner could take the money home first (method/lock/commitment.mjs).
  // A lock dated by block height is for a private test chain only: anywhere
  // else it may already be open.
  if (L.locktime < 500000000) {
    if (hrp !== "bcrt") return fail("the lock is dated by block height, which only a private test chain uses — on a real network it may already be open, so its money isn't committed");
  } else {
    const settles = Date.parse(proposal.settles_by ?? proposal.settlesBy ?? "");
    if (Number.isNaN(settles)) return fail("the proposal's settling date can't be read, so whether the lock outlasts it can't be checked");
    if (!(L.locktime > settles / 1000 + (hrp === "bcrt" ? 0 : SETTLE_MARGIN))) return fail("the lock opens before the proposal's settling ends, or within a week of it, so its owner could take the money home before the payment confirms");
  }

  let tx;
  try { tx = Transaction.fromHex(record.tx); } catch (e) { return fail(`transaction will not parse: ${e.message}`); }
  if (tx.ins.length !== 1) return fail(`${tx.ins.length} inputs, must be exactly 1`);
  // The input's own script must be empty: the owner's signature does not
  // cover it, and a lock's spend that has one is never mined (method/lock/commitment.mjs).
  if (tx.ins[0].script.length !== 0) return fail("its input carries a script, which a spend of a lock never does — the network would not take it");
  const w = tx.ins[0].witness;
  if (w.length !== 4) return fail(`witness has ${w.length} items, the purchase branch has 4`);
  if (w[0].length !== 0) return fail("the co-signer's slot is not empty — this is a completed spend, not a commitment");
  if (w[1].length !== 0) return fail("branch selector is not empty, so this takes the going-home branch");
  if (toHex(w[3]) !== toHex(script)) return fail("witness script is not the lock's script");

  // The coin it spends: its value (the signature covers it) and whether it is still there.
  const txid = toHex(Uint8Array.from(tx.ins[0].hash).reverse());
  const coin = (await chain.utxos(L.address)).find((u) => u.txid === txid && u.vout === tx.ins[0].index);
  // The owner's signature is checked whether or not the coin is still there.
  // A spent coin's value is read from the payment that made it. Otherwise
  // copies of a paid commitment with any signature at all would read as
  // "paid" again, and anyone could inflate the paid total.
  let value = coin ? BigInt(coin.value) : null;
  if (value === null) {
    try {
      const src = Transaction.fromHex(String(await chain.txHex(txid)).trim());
      const spent = src.getId() === txid ? src.outs[tx.ins[0].index] : null;
      // The coin must have been a coin OF THIS LOCK. Otherwise a payment from
      // an ordinary wallet, dressed as a spend of a lock, would pass as a
      // commitment whose coin "has already been spent", and count as paid.
      if (spent && toHex(spent.script) !== toHex(lockOutputScript(script))) return fail("the coin it spends was never a coin of the lock it names, so this is not a spend of that lock");
      if (spent) value = BigInt(spent.value);
    } catch { /* below */ }
    if (value === null) return fail("the coin it spends can't be read from the chain just now, so its signature can't be checked");
  }
  {
    let sigOk = false;
    try {
      const decoded = bscript.signature.decode(w[2]);
      const sighash = tx.hashForWitnessV0(0, script, value, Transaction.SIGHASH_ALL);
      // Strict: a signature with a high S value is refused, as the network refuses to pass one on.
      sigOk = decoded.hashType === Transaction.SIGHASH_ALL && ecc.verify(sighash, fromHex(L.owner_pubkey), decoded.signature, true);
    } catch { sigOk = false; }
    if (!sigOk) return fail("the owner's signature does not verify over this transaction");
  }
  if (tx.locktime !== 0) return fail(`declares nLockTime ${tx.locktime}, must be 0`);
  // The owner's signature covers these two, so a commitment that gets them
  // wrong can never be put right by anyone else: it would count and never pay.
  if (tx.version !== 1 && tx.version !== 2) return fail(`is transaction version ${tx.version}, which the network does not pass on — must be 1 or 2`);
  if ((tx.ins[0].sequence & 0x80000000) === 0) return fail("its sequence number sets a waiting period before it could be mined — it must set none");

  // The last output names this proposal, inside what the owner signed.
  if (tx.outs.length < 2 || tx.outs.length > 3) return fail(`${tx.outs.length} outputs, must be 2 or 3`);
  const marker = tx.outs[tx.outs.length - 1];
  if (toHex(marker.script) !== toHex(proposalMarker(proposal.hash)) || BigInt(marker.value) !== 0n) {
    return fail("the payment does not name this proposal inside it — it could have been signed for another");
  }
  let out0;
  try { out0 = baddress.fromOutputScript(tx.outs[0].script, net); } catch { return fail("output 0 is not a recognisable address"); }
  if (canonicalAddress(out0) !== canonicalAddress(proposal.destination)) return fail(`output 0 pays ${out0}, but the proposal names ${proposal.destination}`);
  // The attestors are the ones the Crowdlock's own file names, and the list
  // must be this Crowdlock's: never what a destinations file says of itself.
  // Its age is counted from its stamp's block, read from the chain.
  const rules = attestorsOf(crowdlock, hrp);
  const entries = destinations?.entries ?? [];
  const stamps = await stampsFor(entries, [out0], (id) => chain.tx(id));
  const permitted = destinationIsPermitted({
    address: out0, entries, opensAt: proposal.opens,
    minimumAgeDays: crowdlock.destination_wait_days, attestors: rules.attestors, threshold: rules.threshold, instance: rules.instance, hrp, stamps,
  });
  if (!permitted.permitted) return fail(`destination not permitted: ${permitted.reason}`);

  const committedSats = Number(tx.outs[0].value);
  if (BigInt(committedSats) < dustFor(tx.outs[0].script)) return fail(`commits ${committedSats} sats, too little for the network to pass on`);
  if (tx.outs.length === 3) {
    const r = record.remainder;
    if (!r) return fail("has a second output but no remainder lock declared to check it against");
    let back;
    try { back = lockAddressOf({ ownerPubkey: r.owner_pubkey, cosignerPubkey: r.cosigner_pubkey, locktime: r.locktime }, hrp); }
    catch (e) { return fail(`remainder lock is not a valid lock: ${e.message}`); }
    let out1 = null;
    try { out1 = baddress.fromOutputScript(tx.outs[1].script, net); } catch {}
    if (out1 !== back) return fail("output 1 does not pay the declared remainder lock");
    if (r.owner_pubkey !== L.owner_pubkey) return fail("remainder lock has a different owner — this would move coins out of the owner's hands");
    if (r.locktime < L.locktime) return fail("remainder lock expires earlier than the lock being spent — an early escape");
    if (!isCosignerOf(crowdlock, r.cosigner_pubkey)) return fail("remainder lock is co-signed by a different Crowdlock");
    if (BigInt(tx.outs[1].value) < dustFor(tx.outs[1].script)) return fail(`returns ${Number(tx.outs[1].value)} sats to the lock, too little for the network to pass on`);
  }
  if (!coin) return fail("the coin has already been spent, so this commitment is void");
  // A coin that hasn't confirmed can be replaced by its sender and vanish, so
  // it counts toward nothing.
  if (!coin.confirmed) return fail("the coin it spends hasn't confirmed yet, so it counts toward nothing");
  // A coin a miner paid itself in its own block can't be spent until 100
  // blocks have followed: confirmed, but not yet money.
  if (Number.isInteger(coin.height) && typeof chain.tipHeight === "function" && typeof chain.tx === "function") {
    let maturing = false;
    try {
      const funding = await chain.tx(coin.txid);
      if (funding?.vin?.[0]?.is_coinbase) maturing = (await chain.tipHeight()) - coin.height + 1 < 100;
    } catch (e) { return fail(`whether the coin it spends can be spent yet couldn't be checked (${String(e?.message ?? e)})`); }
    if (maturing) return fail("the coin it spends is a new block's reward, which can't be spent until 100 blocks have followed it");
  }
  const fee = coin.value - tx.outs.reduce((n, o) => n + Number(o.value), 0);
  if (fee < 0) return fail("outputs exceed the input");
  const feeLimit = Math.min(crowdlock.max_commitment_fee, 0.05); // never more than 5%, whatever the file says
  if (fee > committedSats * feeLimit) {
    return fail(`fee of ${fee} sats is more than ${feeLimit * 100}% of the ${committedSats} committed — refusing in case of a client bug`);
  }
  const least = completedVsize(tx);
  if (fee < least) return fail(`fee of ${fee} sats is below the ${least} the network needs to pass this payment on`);
  return { valid: true, reason: "", committedSats, fee, ownerPubkey: L.owner_pubkey, coin: `${txid}:${tx.ins[0].index}` };
}

/**
 * The co-signer's failure notice, signed with the co-signer key these words
 * make, for a proposal that did not reach its target. Returns { address,
 * signature } to publish; checked by noticeIsGenuine in method/js/proposals.mjs.
 */
export function signNoticeWith({ words, crowdlock, statement, network }) {
  const tidy = tidyWords(words);
  if (!wordsAreValid(tidy)) throw new Error("those are not valid backup words — check the spelling and the order");
  const node = BIP32.fromSeed(mnemonicToSeedSync(tidy), networks.bitcoin).derivePath(COSIGNER_PATH);
  const pub = toHex(node.publicKey);
  if (!(crowdlock.cosigner_keys ?? []).includes(pub)) throw new Error("these words don't make this Crowdlock's co-signer key");
  const net = typeof network === "string" ? NETWORKS[network].network : (network.network ?? network);
  const address = memberAddressForOwnerKey(pub, net.bech32);
  const { signature, recoveryId } = ecc.signRecoverable(messageHash(statement), node.privateKey);
  const out = new Uint8Array(65);
  out[0] = 39 + recoveryId; // a native segwit address's signature
  out.set(signature, 1);
  const sig = toBase64(out);
  if (!verifyMembership({ address, signature: sig, message: statement, hrp: net.bech32 }).valid) throw new Error("the notice did not verify — refusing");
  return { address, signature: sig };
}

/**
 * One co-signer key's signature saying where this Crowdlock lives: the key
 * these words make, over homeLine. Returns { key, signature }; the file's
 * `home.signatures` needs one from every co-signer key (method/js/crowdlock.mjs,
 * checkHome). `url` is the link to the Crowdlock's file, exactly as people open it.
 */
export function signHomeWith({ words, crowdlock, url }) {
  const tidy = tidyWords(words);
  if (!wordsAreValid(tidy)) throw new Error("those are not valid backup words — check the spelling and the order");
  if (!/^https:\/\/[^\s]+$/.test(String(url))) throw new Error("the Crowdlock's link must start with https://");
  const node = BIP32.fromSeed(mnemonicToSeedSync(tidy), networks.bitcoin).derivePath(COSIGNER_PATH);
  const key = toHex(node.publicKey);
  const line = homeLine(crowdlock.network, url, crowdlock.declaration.sha256);
  const { signature, recoveryId } = ecc.signRecoverable(messageHash(line), node.privateKey);
  const out = new Uint8Array(65);
  out[0] = 39 + recoveryId; // a native segwit address's signature
  out.set(signature, 1);
  const sig = toBase64(out);
  if (!homeSignatureChecks(crowdlock, url, key, sig)) throw new Error("the signature did not check — refusing");
  return { key, signature: sig };
}

/** The coin a commitment spends, as "txid:vout", or null if it won't read. */
export function commitmentCoin(record) {
  try {
    const tx = Transaction.fromHex(record.tx);
    return tx.ins.length === 1 ? `${toHex(Uint8Array.from(tx.ins[0].hash).reverse())}:${tx.ins[0].index}` : null;
  } catch { return null; }
}

/**
 * Which of these commitments the co-signer key these words make can
 * complete, and what they add up to. A Crowdlock may list more than one
 * co-signer key, and a commitment can only be completed with the key its own
 * lock names. Those the typed words cannot complete are left out of the sum
 * BEFORE anything is signed: counted, then skipped, they would leave honest
 * members' money paid towards a purchase that stays short.
 *
 * Returns { ok, still, total, problems }: `ok` only if `total` (what is
 * already paid plus what `still` commits) reaches the proposal's target.
 */
export async function commitmentsToComplete({ words, records, crowdlock, register = null, proposal, destinations, chain, network, alreadyPaid = 0 }) {
  const key = cosignerKeyFromWords(words).publicKey;
  // `records` come in the order they were submitted. They are taken in that
  // order until the target is met, and no further: anything past it is held
  // in reserve, and a reserve one is used only if one ahead of it no longer
  // passes its check.
  const still = [], problems = [];
  let total = alreadyPaid;
  for (const record of records) {
    if (total >= proposal.target.sats) break;
    if (String(record?.lock?.cosigner_pubkey ?? "").toLowerCase() !== key) {
      problems.push("A commitment's lock names a co-signer key these words don't make, so they can't complete it and it isn't counted.");
      continue;
    }
    // Given the register, only a commitment that may back this proposal counts.
    if (register) {
      const e = commitmentEligible(record, { crowdlock, register, proposal });
      if (!e.ok) { problems.push(`A commitment can't back this proposal: ${e.reason}`); continue; }
    }
    try {
      const v = await checkCommitment({ record, crowdlock, proposal, destinations, chain, network });
      if (v.valid) { still.push(record); total += v.committedSats; } else problems.push(`A commitment no longer passes its check: ${v.reason}`);
    } catch (e) { problems.push(String(e?.message ?? e)); }
  }
  return { ok: total >= proposal.target.sats, still, total, problems };
}

/** The output script of a lock: segwit v0, the SHA-256 of its witness script. */
function lockOutputScript(witnessScript) {
  return Uint8Array.from([0x00, 0x20, ...bcrypto.sha256(Uint8Array.from(witnessScript))]);
}

/** The id of a commitment's payment, which a completed one shares (the id leaves out the signatures). Null if it won't read. */
export function commitmentTxid(record) {
  try { return Transaction.fromHex(record.tx).getId(); } catch { return null; }
}

/**
 * Has this commitment been paid? A completed commitment has the same txid as
 * the commitment itself (the txid leaves out the signatures), so if that txid
 * is in a block, the co-signer completed it and it was sent. Returns the sats
 * it paid the destination, or 0. One the network has seen but no block holds
 * yet is not paid.
 *
 * The id says which coin was spent and where the money went, and nothing
 * about who signed. So this asks the chain what that coin was: it counts as
 * paid only if the coin was a coin of the lock the record names. Without
 * that, an ordinary payment from anybody's wallet to the seller, carrying
 * the proposal's marker, would read as a paid commitment.
 * Such a coin can only have been spent this way with the co-signer's
 * signature: the payment declares no date, so the lock's going-home exit
 * refuses it.
 */
export async function commitmentPaid({ record, chain }) {
  const p = await commitmentPayment({ record, chain });
  return p?.confirmed ? p.sats : 0;
}

/**
 * The payment a commitment became, if the co-signer completed it and it was
 * sent: { sats, confirmed }, or null. `confirmed` is false while the network
 * has it and no block holds it yet.
 *
 * A payment waiting for a block is not "paid", and must not be forgotten
 * either: read as void, the total would fall once the co-signer had sent the
 * first commitments, the reserve would seem to reach the target by itself,
 * and pressing the button again would pay the seller twice.
 */
export async function commitmentPayment({ record, chain, crowdlock = null }) {
  let tx;
  try { tx = Transaction.fromHex(record.tx); } catch { return null; }
  if (tx.ins.length !== 1) return null;
  // A lookup that fails is not an answer: read as "never paid", a payment on
  // its way could be overlooked and a reserve completed in its place, paying
  // twice. It comes back { unknown: true }, and the co-signer's screen won't
  // go on.
  const unknown = (e) => ({ unknown: true, reason: String(e?.message ?? e) });
  let spent;
  try {
    const L = record.lock ?? {};
    const script = lockScriptOf({ ownerPubkey: L.owner_pubkey, cosignerPubkey: L.cosigner_pubkey, locktime: L.locktime });
    const from = toHex(Uint8Array.from(tx.ins[0].hash).reverse());
    let src;
    try { src = Transaction.fromHex(String(await chain.txHex(from)).trim()); } catch (e) { return unknown(e); }
    spent = src.getId() === from ? src.outs[tx.ins[0].index] : null;
    if (!spent || toHex(spent.script) !== toHex(lockOutputScript(script))) return null;
  } catch { return null; }
  // A payment counts only if it kept to the fee limit its commitment had to
  // keep to while it waited: otherwise its value is not a lawful payment.
  if (crowdlock) {
    const fee = Number(spent.value) - tx.outs.reduce((a, o) => a + Number(o.value), 0);
    if (fee > Number(tx.outs[0].value) * Math.min(crowdlock.max_commitment_fee, 0.05)) return null;
  }
  let seen;
  try { seen = await chain.tx(tx.getId()); } catch (e) { return unknown(e); }
  if (!seen) return null;
  return { sats: Number(tx.outs[0].value), confirmed: !!seen.status?.confirmed };
}

/**
 * The co-signer's half, at settlement: complete a checked commitment with the
 * co-signer key these words make (m/84'/0'/0'/0/0, as everywhere). The
 * signature is the library's, over the library's sighash; the witness is laid
 * out in the commitment format's fixed shape. Returns the finished
 * transaction's hex, ready to broadcast. The words are not kept.
 */
export async function completeCommitmentWith({ words, record, chain }) {
  const tidy = tidyWords(words);
  if (!wordsAreValid(tidy)) throw new Error("those are not valid backup words — check the spelling and the order");
  const node = BIP32.fromSeed(mnemonicToSeedSync(tidy), networks.bitcoin).derivePath(COSIGNER_PATH);
  if (toHex(node.publicKey) !== String(record.lock.cosigner_pubkey).toLowerCase()) {
    throw new Error("these words don't make this lock's co-signer key");
  }
  const L = record.lock;
  const script = lockScriptOf({ ownerPubkey: L.owner_pubkey, cosignerPubkey: L.cosigner_pubkey, locktime: L.locktime });
  const tx = Transaction.fromHex(record.tx);
  if (tx.ins.length !== 1 || tx.ins[0].script.length !== 0) throw new Error("its input carries a script, which a spend of a lock never does — the network would not take it");
  const txid = toHex(Uint8Array.from(tx.ins[0].hash).reverse());
  const coin = (await chain.utxos(L.address)).find((u) => u.txid === txid && u.vout === tx.ins[0].index);
  if (!coin) throw new Error("the coin has already been spent, so this commitment is void");
  if (!coin.confirmed) throw new Error("the coin this commitment spends hasn't confirmed yet — refusing");
  const sighash = tx.hashForWitnessV0(0, script, BigInt(coin.value), Transaction.SIGHASH_ALL);
  const sig = bscript.signature.encode(node.sign(sighash), Transaction.SIGHASH_ALL);
  const w = tx.ins[0].witness;
  tx.setWitness(0, [sig, w[1], w[2], w[3]]);
  return tx.toHex();
}
