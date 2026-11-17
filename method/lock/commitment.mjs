// Commitments: how a supporter backs one specific purchase with locked money.
//
// A commitment is the owner's half of a transaction nobody has broadcast. The
// coins do not move. The owner's signature alone cannot move them, because the
// lock's purchase exit needs the co-signer too. So a commitment can be
// published, copied and mirrored freely and nobody can spend with it.
//
// Three operations:
//
//   buildCommitment     the supporter signs their half
//   verifyCommitment    anybody checks it, against the proposal and the list
//   completeCommitment  the co-signer adds the second signature, at settlement
//
// Everything except the "is the coin still unspent" check works offline.
//
// See spec/commitment-format.md and spec/destinations-format.md.

import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { createHash } from "node:crypto";
import { lockScript, lockAddress } from "./lock.mjs";
import { isCosignerOf } from "../js/crowdlock.mjs";
import { verifyMembership, memberAddressForOwnerKey } from "../js/verify.mjs";

const { Transaction, script: bscript } = bitcoin;

// Defaults only. A Crowdlock sets its own in crowdlocks/<name>.json, and
// verifyCommitment uses those whenever it is handed the Crowdlock's file.

/** Fee may not exceed this share of the committed amount. */
export const MAX_FEE_FRACTION = 0.01;

/** A destination must be publicly visible this long before a proposal opens. */
export const MINIMUM_AGE_DAYS = 7; // used only when no Crowdlock is given; each Crowdlock sets its own (destination_wait_days)

const sha256 = (buf) => createHash("sha256").update(buf).digest();

// ---------------------------------------------------------------------------
// The destinations list
// ---------------------------------------------------------------------------

/**
 * The canonical line that gets hashed and signed. One per entry.
 *
 * `instance` is the SHA-256 of this instance's declaration. It is in the line
 * so that an attestation signed for one instance cannot verify against another
 * — anybody may copy these documents, and several instances may run at once.
 */
export function destinationLine({ instance, index, op, address, text, added, prev }) {
  if (!/^[0-9a-f]{64}$/.test(instance ?? "")) throw new Error("instance must be a 64-character hex declaration hash");
  for (const [name, v] of [["text", text], ["address", address]]) {
    if (/[|\n\r]/.test(v)) throw new Error(`${name} may not contain | or a newline`);
  }
  return `${instance}|${index}|${op}|${address}|${text}|${added}|${prev}`;
}

export const ZERO_PREV = "0".repeat(64);

export function destinationHash(entry) {
  return sha256(Buffer.from(destinationLine(entry).normalize("NFC"), "utf8")).toString("hex");
}

export function attestationStatement(entry) {
  // The instance needs no mention: the line this hashes already carries it.
  return `I attest destination entry ${entry.index} (sha256:${destinationHash(entry)}).`;
}

/**
 * Are an entry's attestations real, and are there enough of them?
 *
 * The destinations list is the only thing standing between a supporter and
 * sending money to an address somebody inserted. Its protection is entirely
 * the signatures on each entry — so for a long time this project had the
 * weakest possible version of that protection: entries carried attestations,
 * the specification described how they were signed, and no code ever checked
 * one. A list could have been edited freely and still read as attested.
 *
 * Each attestation is a Bitcoin Signed Message over attestationStatement(),
 * which carries the entry's hash, which carries the instance. So a signature
 * cannot be moved to another entry, another list, or another instance.
 *
 * Three things are required, and the second is the one that is easy to miss:
 * every signature must verify; every signer must be a listed attestor; and
 * two signatures from the SAME attestor count once, or a single attestor
 * could meet any threshold alone.
 *
 * Returns { ok, reason, signers } — `signers` being the distinct attestors
 * whose signatures verified.
 */
/**
 * A destination's stamp on the chain (spec/destinations-format.md, "The
 * waiting period"): a payment whose OP_RETURN output carries the hash of the
 * entry and its attestations. The block it is in dates the entry, and nobody
 * can backdate a block. Covering the attestations means nobody without an
 * attestor's key can stamp an entry ahead of time.
 */
export function stampLine(entry) {
  return [destinationHash(entry), ...(entry.attestations ?? []).map((a) => `${a.address}:${a.signature}`)].join("|");
}

export function stampHash(entry) {
  return sha256(Buffer.from(stampLine(entry), "utf8")).toString("hex");
}

export function stampScript(entry) {
  return `6a20${stampHash(entry)}`;
}

/**
 * When an entry was stamped: the block time of its stamp payment, `tx` being
 * an Esplora explorer's /tx/<txid> answer. Returns { ok, at, reason }.
 */
export function stampedAt(entry, tx) {
  if (!/^[0-9a-f]{64}$/.test(String(entry?.stamp ?? ""))) {
    return { ok: false, at: null, reason: `entry ${entry?.index} has no stamp on the chain, so when it was published cannot be established` };
  }
  if (!tx || tx.txid !== entry.stamp) return { ok: false, at: null, reason: `entry ${entry.index}'s stamp could not be read from the chain` };
  const want = stampScript(entry);
  if (!(tx.vout ?? []).some((o) => o?.scriptpubkey === want && Number(o?.value) === 0)) {
    return { ok: false, at: null, reason: `entry ${entry.index}'s stamp is a payment that does not carry this entry and its attestations` };
  }
  if (!tx.status?.confirmed || !Number.isInteger(tx.status.block_time)) {
    return { ok: false, at: null, reason: `entry ${entry.index}'s stamp is not in a block yet` };
  }
  return { ok: true, at: tx.status.block_time, reason: "" };
}

export function attestationsAreValid(entry, { attestors = [], threshold = 1, hrp = "bc" } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    return { ok: false, reason: "the threshold must be a positive whole number", signers: [] };
  }
  if (attestors.length < threshold) {
    return { ok: false, reason: `the list names ${attestors.length} attestor(s) but requires ${threshold}`, signers: [] };
  }

  const statement = attestationStatement(entry);
  const permitted = new Set(attestors);
  const signers = new Set();

  for (const a of entry.attestations ?? []) {
    const address = String(a?.address ?? "").trim();
    if (!permitted.has(address)) {
      return { ok: false, reason: `entry ${entry.index} is attested by ${address || "nobody"}, who is not a listed attestor`, signers: [...signers] };
    }
    const r = verifyMembership({ address, signature: String(a?.signature ?? ""), message: statement, hrp });
    if (!r.valid) {
      return { ok: false, reason: `entry ${entry.index}: ${address}'s attestation does not verify — ${r.reason}`, signers: [...signers] };
    }
    signers.add(address);
  }

  if (signers.size < threshold) {
    return {
      ok: false,
      reason: `entry ${entry.index} has ${signers.size} valid attestation(s) from distinct attestors, needs ${threshold}`,
      signers: [...signers],
    };
  }
  return { ok: true, reason: "", signers: [...signers] };
}

/**
 * Check the hash chain runs unbroken from entry 1 to the head.
 * Returns { ok, reason }.
 */
export function chainIsIntact(entries, instance = null) {
  let expected = ZERO_PREV;
  // Every entry names the Crowdlock it was attested for. Given that
  // Crowdlock's fingerprint, every entry must name it; without one, they
  // must at least all name the same.
  const wanted = instance ?? entries[0]?.instance;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.instance !== wanted) return { ok: false, reason: `entry ${e.index} belongs to a different instance` };
    if (e.index !== i + 1) return { ok: false, reason: `entry at position ${i} has index ${e.index}, expected ${i + 1}` };
    if (e.prev !== expected) return { ok: false, reason: `entry ${e.index} chains to ${e.prev.slice(0, 12)}…, expected ${expected.slice(0, 12)}…` };
    expected = destinationHash(e);
  }
  return { ok: true, reason: "" };
}

/**
 * Is this destination permitted for a proposal opening at `opensAt`?
 *
 * Four things must hold, and all four exist because the destinations list is
 * the only thing standing between a supporter and an address an attacker
 * inserted. Breaking the lock is hard; getting a line into this file is the
 * easy attack, so this function is where the effort belongs.
 *
 * An entry's age is counted from its stamp on the chain (stampedAt): the
 * block time of a payment carrying the entry and its attestations. `stamps`
 * holds those payments as the explorer describes them, { txid: tx }. It is
 * deliberately NOT the `added` field, which the attestor writes and could set
 * to any date they liked. Until 17 November 2026 it was `firstSeen`, which was
 * no better: also a date written into the file by whoever added the entry.
 * Either handed an attestor exactly the backdating the waiting period exists
 * to prevent: add an address today, write last month's date, propose it this
 * afternoon. An entry with no stamp, or one not in a block yet, is refused.
 */
export function destinationIsPermitted({
  address,
  entries,
  opensAt,
  minimumAgeDays = MINIMUM_AGE_DAYS,
  attestors = null,
  threshold = null,
  hrp = "bc",
  instance = null,
  stamps = {},
}) {
  // The list must be this Crowdlock's own. Each entry carries the fingerprint
  // of the Crowdlock it was attested for, and until 17 November 2026 nothing
  // compared it with the Crowdlock doing the checking: an entry the same
  // attestor had signed for another Crowdlock passed.
  if (!/^[0-9a-f]{64}$/.test(String(instance ?? ""))) {
    return { permitted: false, reason: "no Crowdlock fingerprint was supplied, so the list cannot be tied to this Crowdlock" };
  }
  // And it must be checked for attestation: with no attestor set this used to
  // check age only.
  if (!Array.isArray(attestors) || !Number.isInteger(threshold)) {
    return { permitted: false, reason: "no attestor set was supplied, so the list cannot be checked for attestation" };
  }
  const chain = chainIsIntact(entries, instance);
  if (!chain.ok) return { permitted: false, reason: `the list itself is broken: ${chain.reason}` };

  const mine = entries.filter((e) => e.address === address);
  const added = mine.filter((e) => e.op === "add").pop();
  if (!added) return { permitted: false, reason: "not on the published destinations list" };

  const revoked = mine.filter((e) => e.op === "revoke" && e.index > added.index).pop();
  if (revoked) return { permitted: false, reason: `revoked by entry ${revoked.index}` };

  // Attestations are checked on the entry that put this address on the list.
  // A revocation is believed without them: it can only stop a payment, never
  // allow one, and whoever can write a revocation into the file can stop a
  // payment in simpler ways.
  const att = attestationsAreValid(added, { attestors, threshold, hrp });
  if (!att.ok) return { permitted: false, reason: att.reason };

  const stamped = stampedAt(added, stamps?.[added.stamp] ?? null);
  if (!stamped.ok) return { permitted: false, reason: stamped.reason };

  const opens = Date.parse(opensAt);
  if (Number.isNaN(opens)) return { permitted: false, reason: "the proposal's opening is not a readable date" };

  const ageDays = (opens - stamped.at * 1000) / 86_400_000;
  // A miner may set a block's time up to two hours ahead, so a stamp can look
  // younger than it is, never older. With no waiting period, being in a block
  // is enough (17 November 2026: a test destination was refused for five
  // minutes because its block's clock ran fast).
  if (minimumAgeDays > 0 && !(ageDays >= minimumAgeDays)) {
    return { permitted: false, reason: `only ${ageDays.toFixed(1)} days old at the proposal's opening, needs ${minimumAgeDays}` };
  }

  return { permitted: true, reason: "" };
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

/**
 * The canonical proposal document: the exact bytes a proposal's hash is over.
 *
 * Every commitment names a proposal by hash, and verifyCommitment refuses a
 * commitment whose named hash does not match. That check was resting on
 * nothing: the specification said a proposal was "a published document
 * containing, at a minimum" some fields, which is not a document — it is a
 * description of one. Two honest people writing out the same proposal would
 * have produced different bytes, hashed to different values, and each
 * correctly rejected the other's commitments.
 *
 * So the document is defined here rather than left to each reader. Same shape
 * as a destination entry, for the same reasons: pipe-delimited so it can be
 * read by eye, and beginning with the instance's declaration hash so a
 * proposal written for one Crowdlock cannot be replayed into another.
 *
 * Fields are fixed in number and order. "At a minimum" cannot survive in a
 * canonical form — an optional field is a second possible document, and a
 * second possible document is a second possible hash. Anything further a
 * proposal wants to say belongs in its prose, which is linked by `document`
 * and hashed as part of this line.
 *
 * `requires` is somebody else's invoice, so it is in THEIR money, and the
 * currency is named in the line beside it. It was pence with no currency
 * field until 2 November, which quietly made this a British document: a
 * Crowdlock run anywhere else could not state its own price at all. The
 * currency is an ISO 4217 three-letter code, and the amount is a whole
 * number of that currency's minor units — pence for GBP, cents for USD and
 * EUR, whole yen for JPY (which has none), thousandths for KWD. Integers
 * because floating-point money does not hash reliably.
 *
 * Note which way round that cuts. A currency belongs in the line precisely
 * because it NEVER MOVES once the proposal is written, the same as the
 * price. `target` — the equivalent in satoshis — is indicative and restated
 * as bitcoin moves, so it is NOT in this line. A proposal whose hash changed
 * every time bitcoin moved would invalidate every commitment gathered so
 * far, which is the exact failure that sank the assurance-contract design.
 */
export function proposalLine({ instance, destination, requiresMinor, currency, document, opens, closes, settlesBy, declarationVersion }) {
  if (!/^[0-9a-f]{64}$/.test(instance ?? "")) {
    throw new Error("instance must be a 64-character hex declaration hash");
  }
  if (!/^[0-9a-f]{64}$/.test(document ?? "")) {
    throw new Error("document must be the 64-character hex hash of the proposal's prose");
  }
  if (!Number.isInteger(requiresMinor) || requiresMinor <= 0) {
    throw new Error("requires must be a positive whole number of the currency's minor units");
  }
  // Three uppercase letters, and no list of real codes. A hard-coded list
  // ages into refusing a currency that exists, which is a worse failure than
  // accepting one that does not — a wrong code is visible to every reader of
  // the proposal, whereas a refusal would be ours and permanent. Lowercase is
  // refused rather than quietly upper-cased: silently rewriting the writer's
  // input would mean the document they published and the line we hashed were
  // not the same bytes, which is the whole thing this function exists to stop.
  if (!/^[A-Z]{3}$/.test(currency ?? "")) {
    throw new Error("currency must be an ISO 4217 three-letter code in capitals, e.g. GBP");
  }
  for (const [name, v] of [["destination", destination], ["opens", opens], ["closes", closes], ["settlesBy", settlesBy]]) {
    if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
    if (/[|\n\r]/.test(v)) throw new Error(`${name} may not contain | or a newline`);
  }
  if (!(Date.parse(opens) < Date.parse(closes))) throw new Error("closes must be after opens");
  if (!(Date.parse(closes) <= Date.parse(settlesBy))) throw new Error("settlesBy must be at or after closes");
  // The version of the declaration the proposal is published under, if it is
  // a later one. A version-1 proposal's line has nothing added, so every
  // line written before versions existed keeps its hash.
  if (declarationVersion !== undefined && !(Number.isInteger(declarationVersion) && declarationVersion >= 1)) {
    throw new Error("declarationVersion, if given, must be a whole number from 1");
  }
  const tail = declarationVersion > 1 ? `|v${declarationVersion}` : "";

  return `${instance}|proposal|${destination}|${requiresMinor}|${currency}|${document}|${opens}|${closes}|${settlesBy}${tail}`;
}

/** The hash a commitment names, and the only thing that identifies a proposal. */
export function proposalHash(proposal) {
  return sha256(Buffer.from(proposalLine(proposal).normalize("NFC"), "utf8")).toString("hex");
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * The supporter's half.
 *
 * utxo         { txid, vout, value } — the lock being spent
 * commitSats   how much reaches the destination (output 0)
 * feeSats      taken from the coin; what is left over goes to the remainder
 * remainder    optional { ownerPubkey, cosignerPubkey, locktime } for a new lock
 * proposalHash the proposal this is for. It goes into the payment itself, as
 *              the last output (see proposalMarker), so the owner's signature
 *              covers it.
 */
export function buildCommitment({
  utxo,
  witnessScript,
  destination,
  commitSats,
  feeSats,
  ownerKey,
  remainder = null,
  network,
  proposalHash,
}) {
  if (!/^[0-9a-f]{64}$/.test(String(proposalHash ?? ""))) throw new Error("a commitment names its proposal: proposalHash is needed");
  const leftover = utxo.value - commitSats - feeSats;
  if (leftover < 0) throw new Error("commitSats + feeSats exceeds the lock's value");
  if (leftover > 0 && !remainder) throw new Error("a partial commitment needs a remainder lock");
  if (leftover === 0 && remainder) throw new Error("nothing left over, so no remainder lock is needed");

  const tx = new Transaction();
  tx.version = 2;
  tx.locktime = 0; // the purchase exit declares none, and must not
  tx.addInput(Buffer.from(utxo.txid, "hex").reverse(), utxo.vout, 0xfffffffe);
  tx.addOutput(bitcoin.address.toOutputScript(destination, network), commitSats);

  if (remainder) {
    const back = lockAddress({ ...remainder, network });
    tx.addOutput(back.output, leftover);
  }
  // Last, the proposal itself: an output that carries no money and can never
  // be spent, holding the proposal's hash.
  tx.addOutput(proposalMarker(proposalHash), 0);

  const sighash = tx.hashForWitnessV0(0, witnessScript, utxo.value, Transaction.SIGHASH_ALL);
  const ownerSig = bscript.signature.encode(Buffer.from(ownerKey.sign(sighash)), Transaction.SIGHASH_ALL);

  // Purchase branch, co-signer's slot empty until settlement.
  // Layout: [co-signer sig, branch selector, owner sig, script].
  tx.setWitness(0, [Buffer.alloc(0), Buffer.alloc(0), ownerSig, witnessScript]);

  return { tx, hex: tx.toHex(), sighash, ownerSig };
}

// ---------------------------------------------------------------------------
// What a commitment must also be, for the network to take it
// ---------------------------------------------------------------------------

/**
 * The output that names the proposal: OP_RETURN and the proposal's 32-byte
 * hash, carrying no money. It is the last output of every commitment.
 *
 * Without it, nothing the owner signed said which proposal the payment was
 * for: only an address and an amount. A commitment to one proposal could be
 * relabelled for any other paying the same address, including one made long
 * after the first had failed. With it, the owner's signature covers the
 * proposal, and the chain itself carries which purchase each payment was for.
 */
export function proposalMarker(proposalHash) {
  return Buffer.concat([Buffer.from([0x6a, 0x20]), Buffer.from(proposalHash, "hex")]);
}

/**
 * The least an output of this kind may hold before the network refuses to
 * pass the payment on ("dust"). Bitcoin Core's rule: three sats for every
 * byte the output takes up, counting what it will cost to spend.
 */
export function dustFor(script) {
  const witness = script.length >= 4 && script.length <= 42 && (script[0] === 0x00 || (script[0] >= 0x51 && script[0] <= 0x60)) && script[1] === script.length - 2;
  return 3 * (8 + 1 + script.length + (witness ? 67 : 148));
}

// The co-signer's signature is still to come when a commitment is checked:
// at most this many bytes more.
const COSIGNER_SIGNATURE_BYTES = 72;
/** The size the finished payment will have, in virtual bytes, which is what its fee is measured against. */
export function completedVsize(tx) {
  return Math.ceil((tx.weight() + COSIGNER_SIGNATURE_BYTES) / 4);
}
/** The lowest fee rate the network passes on, in sats per virtual byte. */
export const MIN_FEE_RATE = 1;

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

/**
 * Check a commitment record. Offline except for `coinIsUnspent`, which the
 * caller supplies from any block explorer (omit it and that check is skipped
 * and reported as skipped).
 *
 * Pass `crowdlock` (the Crowdlock's own file) and its fee cap and destination
 * wait are used, and a commitment whose lock is not co-signed by that
 * Crowdlock is refused — a commitment can never be counted by the wrong one.
 *
 * Returns { valid, reason, committedSats, checks }.
 */
export function verifyCommitment({
  record,                 // { proposal, lock, tx }
  proposal,               // { hash, destination, opensAt }
  destinationEntries = [],
  destinationRules = null, // { attestors, threshold, instance } — used only when no Crowdlock is given
  destinationStamps = {},  // { txid: tx } — the stamp payments, as an explorer describes them
  utxoValue,              // the lock's value, needed to check the signature and the fee
  coinIsUnspent = null,
  network,
  crowdlock = null,
}) {
  const maxFee = crowdlock ? crowdlock.max_commitment_fee : MAX_FEE_FRACTION;
  const minimumAgeDays = crowdlock ? crowdlock.destination_wait_days : MINIMUM_AGE_DAYS;
  const checks = [];
  const fail = (reason) => ({ valid: false, reason, committedSats: 0, checks });
  const note = (name, ok, detail = "") => { checks.push({ name, ok, detail }); return ok; };

  if (record.proposal !== proposal.hash) return fail("record names a different proposal");
  note("names this proposal", true);

  // 1. the lock re-derives
  let derived;
  try {
    derived = lockAddress({
      fanPubkey: Buffer.from(record.lock.owner_pubkey, "hex"),
      cosignerPubkey: Buffer.from(record.lock.cosigner_pubkey, "hex"),
      locktime: record.lock.locktime,
      network,
    });
  } catch (e) {
    return fail(`lock fields are not a valid lock: ${e.message}`);
  }
  if (derived.address !== record.lock.address) return fail("lock address does not re-derive from the stated keys and locktime");
  note("lock address re-derives", true, derived.address);

  if (crowdlock) {
    if (!isCosignerOf(crowdlock, record.lock.cosigner_pubkey)) {
      return fail(`the lock's co-signer is not ${crowdlock.name}'s — this commitment belongs to a different Crowdlock, or to none`);
    }
    note("lock belongs to this Crowdlock", true, crowdlock.name);
  }

  // 2. exactly one input
  let tx;
  try { tx = Transaction.fromHex(record.tx); }
  catch (e) { return fail(`transaction will not parse: ${e.message}`); }
  if (tx.ins.length !== 1) return fail(`${tx.ins.length} inputs, must be exactly 1`);
  note("exactly one input", true);

  // 3. the witness is the purchase branch, co-signer's slot empty
  const w = tx.ins[0].witness;
  if (w.length !== 4) return fail(`witness has ${w.length} items, the purchase branch has 4`);
  if (w[0].length !== 0) return fail("the co-signer's slot is not empty — this is a completed spend, not a commitment");
  if (w[1].length !== 0) return fail("branch selector is not empty, so this takes the going-home branch");
  if (!w[3].equals(derived.witnessScript)) return fail("witness script is not the lock's script");
  note("purchase branch, co-signer's slot empty", true);

  // 4. the owner's signature. Strictly encoded, over the whole payment, and
  // with a low S value: the network does not pass on a high one.
  const sighash = tx.hashForWitnessV0(0, derived.witnessScript, utxoValue, Transaction.SIGHASH_ALL);
  let sigOk = false;
  try {
    const decoded = bscript.signature.decode(w[2]);
    sigOk = decoded.hashType === Transaction.SIGHASH_ALL &&
      ecc.verify(sighash, Buffer.from(record.lock.owner_pubkey, "hex"), decoded.signature, true);
  } catch { sigOk = false; }
  if (!sigOk) return fail("the owner's signature does not verify over this transaction");
  note("owner's signature verifies", true);

  // 5. no declared locktime, and nothing else that would keep it out of a
  // block. The owner's signature covers the version and the sequence number,
  // so a commitment that gets these wrong can never be put right by anyone
  // else: it would count toward a target and never be payable.
  if (tx.locktime !== 0) return fail(`declares nLockTime ${tx.locktime}, must be 0`);
  if (tx.version !== 1 && tx.version !== 2) return fail(`is transaction version ${tx.version}, which the network does not pass on — must be 1 or 2`);
  if ((tx.ins[0].sequence & 0x80000000) === 0) return fail("its sequence number sets a waiting period before it could be mined — it must set none");
  note("declares no locktime and no waiting period", true);

  // 6. the last output names this proposal, inside what the owner signed;
  // output 0 pays the proposal's destination, which must be permitted
  if (tx.outs.length < 2 || tx.outs.length > 3) return fail(`${tx.outs.length} outputs, must be 2 or 3`);
  const marker = tx.outs[tx.outs.length - 1];
  if (!marker.script.equals(proposalMarker(proposal.hash)) || marker.value !== 0) {
    return fail("the payment does not name this proposal inside it — it could have been signed for another");
  }
  note("the payment itself names this proposal", true);
  let out0;
  try { out0 = bitcoin.address.fromOutputScript(tx.outs[0].script, network); }
  catch { return fail("output 0 is not a recognisable address"); }
  if (out0 !== proposal.destination) return fail(`output 0 pays ${out0}, but the proposal names ${proposal.destination}`);
  note("output 0 pays the proposal's destination", true, out0);

  // The attestors and threshold come from the destinations file itself when
  // one is handed over, so a caller cannot accidentally check the list
  // against a weaker rule than the list publishes. Passing the entries alone,
  // with no attestor set, is refused rather than quietly checked for age
  // only — an unattested list is the attack this is here to stop.
  //
  // Given the Crowdlock's file, the attestors are the ones IT names
  // (attestor_keys), whatever the destinations file says about itself: a
  // list must not be able to appoint its own attestors.
  const hrpHere = network?.bech32 ?? "bc";
  const rules = crowdlock
    ? { attestors: (crowdlock.attestor_keys ?? []).map((k) => memberAddressForOwnerKey(k, hrpHere)), threshold: crowdlock.attestor_threshold, instance: crowdlock.declaration?.sha256 }
    : (destinationRules ?? {});
  if (!Array.isArray(rules.attestors) || rules.threshold === undefined) {
    return fail("no attestor set was supplied, so the destinations list cannot be checked for attestation");
  }
  const permitted = destinationIsPermitted({
    address: out0,
    entries: destinationEntries,
    opensAt: proposal.opensAt,
    minimumAgeDays,
    attestors: rules.attestors,
    threshold: rules.threshold,
    instance: rules.instance,
    // An attestor's address is written in the prefix of the network this
    // Crowdlock runs on. Checking a testnet attestation against mainnet
    // rules derives a different address and reports, misleadingly, that the
    // signature belongs to somebody else.
    hrp: hrpHere,
    stamps: destinationStamps,
  });
  if (!permitted.permitted) return fail(`destination not permitted: ${permitted.reason}`);
  note("destination is attested, on the published list, and stamped long enough ago", true);

  // 7. the remainder, if any, goes back into a lock the owner still cannot escape
  const committedSats = tx.outs[0].value;
  if (committedSats < dustFor(tx.outs[0].script)) return fail(`commits ${committedSats} sats, too little for the network to pass on`);
  if (tx.outs.length === 3) {
    const r = record.remainder;
    if (!r) return fail("has a second output but no remainder lock declared to check it against");
    let back;
    try {
      back = lockAddress({
        fanPubkey: Buffer.from(r.owner_pubkey, "hex"),
        cosignerPubkey: Buffer.from(r.cosigner_pubkey, "hex"),
        locktime: r.locktime,
        network,
      });
    } catch (e) { return fail(`remainder lock is not a valid lock: ${e.message}`); }
    if (!tx.outs[1].script.equals(back.output)) return fail("output 1 does not pay the declared remainder lock");
    if (r.owner_pubkey !== record.lock.owner_pubkey) return fail("remainder lock has a different owner — this would move coins out of the owner's hands");
    if (r.locktime < record.lock.locktime) return fail("remainder lock expires earlier than the lock being spent — an early escape");
    if (crowdlock && !isCosignerOf(crowdlock, r.cosigner_pubkey)) return fail("remainder lock is co-signed by a different Crowdlock");
    if (tx.outs[1].value < dustFor(tx.outs[1].script)) return fail(`returns ${tx.outs[1].value} sats to the lock, too little for the network to pass on`);
    note("remainder returns to the owner's own lock, no earlier", true);
  }

  // the fee sanity check
  const paidOut = tx.outs.reduce((n, o) => n + o.value, 0);
  const fee = utxoValue - paidOut;
  if (fee < 0) return fail("outputs exceed the input");
  if (fee > committedSats * maxFee) {
    return fail(`fee of ${fee} sats is more than ${maxFee * 100}% of the ${committedSats} committed — refusing in case of a client bug`);
  }
  const least = completedVsize(tx) * MIN_FEE_RATE;
  if (fee < least) return fail(`fee of ${fee} sats is below the ${least} the network needs to pass this payment on`);
  note("fee is sane", true, `${fee} sats`);

  // 8. still unspent
  if (coinIsUnspent === null) note("coin still unspent", true, "SKIPPED — needs a block explorer");
  else if (!coinIsUnspent) return fail("the coin has already been spent, so this commitment is void");
  else note("coin still unspent", true);

  return { valid: true, reason: "", committedSats, checks };
}

// ---------------------------------------------------------------------------
// Completing, at settlement
// ---------------------------------------------------------------------------

/**
 * The co-signer's half. Only ever called once a proposal's target is met and
 * every check in verifyCommitment has passed.
 */
export function completeCommitment({ record, cosignerKey, utxoValue, network }) {
  const derived = lockAddress({
    fanPubkey: Buffer.from(record.lock.owner_pubkey, "hex"),
    cosignerPubkey: Buffer.from(record.lock.cosigner_pubkey, "hex"),
    locktime: record.lock.locktime,
    network,
  });

  const tx = Transaction.fromHex(record.tx);
  const w = tx.ins[0].witness;
  if (w[0].length !== 0) throw new Error("already completed");

  const sighash = tx.hashForWitnessV0(0, derived.witnessScript, utxoValue, Transaction.SIGHASH_ALL);
  const cosignerSig = bscript.signature.encode(Buffer.from(cosignerKey.sign(sighash)), Transaction.SIGHASH_ALL);

  tx.setWitness(0, [cosignerSig, Buffer.alloc(0), w[2], w[3]]);
  return { tx, hex: tx.toHex(), txid: tx.getId(), sighash, cosignerSig };
}

export { lockScript, lockAddress };
