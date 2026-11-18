// Keys: backup words, the account they make, co-signer keys and their xpubs, signing a message, and a Ledger account.
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

import { NETWORKS, toBase64, toHex } from "./base.mjs";

// ---------------------------------------------------------------------------
// Backup words
// ---------------------------------------------------------------------------

/** Twelve new backup words, from the phone's secure random source. */
export function newWords() {
  return generateMnemonic(wordlist, 128);
}

/** Tidy what a person typed: lower case, single spaces, nothing either side. */
export function tidyWords(text) {
  return String(text ?? "").trim().toLowerCase().split(/\s+/).join(" ");
}

/** Up to `n` standard backup words starting with what has been typed, to help checking a paper copy. */
export function suggestWords(prefix, n = 4) {
  const p = String(prefix ?? "").trim().toLowerCase();
  if (!p) return [];
  return wordlist.filter((w) => w.startsWith(p)).slice(0, n);
}

/** Are these valid backup words? Checks the words and their built-in checksum. */
export function wordsAreValid(text) {
  return validateMnemonic(tidyWords(text), wordlist);
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/**
 * The fan's one key and address, from their backup words.
 *
 * Standard native-segwit path (BIP84), first address: m/84'/coin'/0'/0/0, so
 * the same words open the same address in Sparrow, Electrum or any wallet
 * that follows the standard — the manual path the project promises.
 *
 * `network` may be a name from NETWORKS or { network, coin } directly, which
 * the tests use for a chain with its own address prefix.
 */
export function accountFromWords(text, network = "mainnet") {
  const words = tidyWords(text);
  if (!wordsAreValid(words)) throw new Error("those are not valid backup words");
  const { network: net, coin } = typeof network === "string" ? NETWORKS[network] : network;
  if (!net) throw new Error(`unknown network: ${network}`);

  const root = BIP32.fromSeed(mnemonicToSeedSync(words), net);
  const originPath = `/84'/${coin}'/0'`;
  const keyPath = "/0/0";
  // The key expression carries the key's origin (fingerprint and path), so
  // every transaction records which key signs it — what a Ledger needs later.
  const keyExpression = keyExpressionBIP32({ masterNode: root, originPath, keyPath });
  const output = new Output({ descriptor: `wpkh(${keyExpression})`, network: net });

  return {
    network: net,
    path: `m${originPath}${keyPath}`,
    publicKey: toHex(root.derivePath(`m${originPath}${keyPath}`).publicKey),
    address: output.getAddress(),
    keyExpression,
    /** For signing. The library finds the right key from the path above. */
    signer: () => root,
    output,
  };
}

/**
 * A co-signer key for a Crowdlock this wallet starts, from the same backup
 * words but on its own path (m/84'/coin'/7713'/0/0), so it is never the
 * member key and never an address another wallet would show by accident.
 * Only its public half is published.
 */
export function cosignerFromWords(text, network = "mainnet") {
  const words = tidyWords(text);
  if (!wordsAreValid(words)) throw new Error("those are not valid backup words");
  const { network: net, coin } = typeof network === "string" ? NETWORKS[network] : network;
  const root = BIP32.fromSeed(mnemonicToSeedSync(words), net);
  const account = `m/84'/${coin}'/7713'`;
  const path = `${account}/0/0`;
  return { path, publicKey: toHex(root.derivePath(path).publicKey), xpub: root.derivePath(account).neutered().toBase58() };
}

// ---------------------------------------------------------------------------
// A co-signer key of its own
//
// The key that co-signs purchases for a Crowdlock. It has its own 12 words,
// never the member's, and sits at the ordinary first-address slot of a
// standard wallet — m/84'/0'/0'/0/0, the same as method/cosigner/generate.mjs — so
// the same words give the same key here, in that script, in Sparrow or in
// Electrum, and nothing about it depends on this app. The words are shown
// once to be written on paper and are never saved; only the public half is
// published. Making it and signing with it are done with the phone offline.
// ---------------------------------------------------------------------------

export const COSIGNER_PATH = "m/84'/0'/0'/0/0";

/**
 * Twelve new words for a co-signer key, from the phone's secure random source.
 * Twelve, like the wallet's: 128 bits, as strong as the key they make, and
 * fewer to copy wrongly. Keys made with 24 elsewhere still restore here.
 */
export function newCosignerWords() {
  return generateMnemonic(wordlist, 128);
}

/** The co-signer public key these words make. Same answer as method/cosigner/generate.mjs. */
export function cosignerKeyFromWords(text) {
  const words = tidyWords(text);
  if (!wordsAreValid(words)) throw new Error("those are not valid backup words — check the spelling and the order");
  const root = BIP32.fromSeed(mnemonicToSeedSync(words), networks.bitcoin);
  return {
    path: COSIGNER_PATH,
    publicKey: toHex(root.derivePath(COSIGNER_PATH).publicKey),
    xpub: root.derivePath(COSIGNER_ACCOUNT_PATH).neutered().toBase58(),
  };
}

// ---------------------------------------------------------------------------
// Co-signer xpubs
//
// A hardware wallet will only sign for a lock whose keys it is given as
// xpubs: it works the plain key out itself. So a co-signer may publish the
// account xpub whose first key (/0/0) is their co-signer key, and the lock is
// byte-for-byte the same — the xpub only lets the device recognise it.
// ---------------------------------------------------------------------------

/** The account a co-signer key made the standard way sits under. */
export const COSIGNER_ACCOUNT_PATH = "m/84'/0'/0'";

/** Read an xpub (Bitcoin) or tpub (test networks); null if it is neither. */
export function readXpub(text) {
  const t = String(text ?? "").trim();
  for (const net of [networks.bitcoin, networks.testnet]) {
    try { return { node: BIP32.fromBase58(t, net), network: net }; } catch {}
  }
  return null;
}

/** The co-signer key an xpub stands for: its first key, /0/0. Null if it isn't an xpub. */
export function keyFromXpub(text) {
  const x = readXpub(text);
  if (!x || x.node.isPrivate?.() || x.node.privateKey) return null;
  return toHex(x.node.derive(0).derive(0).publicKey);
}

/**
 * The same xpub, written for the network a device expects (xpub or tpub).
 * Only the four version bytes change; the key, chain code, depth and parent
 * are exactly as the co-signer published them.
 */
export function xpubForNetwork(text, network) {
  const x = readXpub(text);
  if (!x) throw new Error("that is not an xpub");
  const net = typeof network === "string" ? NETWORKS[network].network : network;
  const raw = Uint8Array.from(bs58check.decode(String(text).trim()));
  new DataView(raw.buffer).setUint32(0, net.bip32.public);
  return bs58check.encode(raw);
}

/**
 * Every xpub in a Crowdlock file must stand for one of its co-signer keys, or
 * a hardware wallet would build a lock the register never counts. Returns
 * { ok, problems }.
 */
export function checkCosignerXpubs(c) {
  const problems = [];
  const keys = new Set((c?.cosigner_keys ?? []).map((k) => String(k).toLowerCase()));
  (c?.cosigner_xpubs ?? []).forEach((x, i) => {
    const k = keyFromXpub(x);
    if (!k) problems.push(`cosigner_xpubs[${i}] is not a public xpub`);
    else if (!keys.has(k)) problems.push(`cosigner_xpubs[${i}] stands for ${k.slice(0, 10)}…, which is not one of this Crowdlock's co-signer keys`);
  });
  return { ok: problems.length === 0, problems };
}

/** The xpub, if published, for a co-signer key. */
export function xpubForKey(c, key) {
  const k = String(key ?? "").toLowerCase();
  return (c?.cosigner_xpubs ?? []).find((x) => keyFromXpub(x) === k) ?? null;
}


// ---------------------------------------------------------------------------
// Signing a Crowdlock's declaration
// ---------------------------------------------------------------------------

/**
 * Sign a membership statement with the account's key, as a standard Bitcoin
 * Signed Message — the same kind Sparrow and Electrum produce, and the kind
 * member 1's Ledger signature is. Returns the base64 signature.
 *
 * The signing itself is the library's (deterministic, low-S, with the recovery
 * number a signed message carries). Ours is only the standard first byte:
 * 31 + recovery number, meaning "compressed key".
 */
export async function signStatementWith(account, statement) {
  if (account.kind !== "ledger") return signStatement(account, statement);
  // The Ledger signs the same standard Bitcoin Signed Message, shown on its
  // own screen first; the register checks it with exactly the same code.
  const sig = await account.useLedger((session) =>
    ledgerApi.signMessage({ descriptor: `wpkh(${account.keyExpression})`, session, message: statement }));
  return typeof sig === "string" ? sig : toBase64(sig);
}

export function signStatement(account, statement) {
  const node = account.signer().derivePath(account.path);
  const { signature, recoveryId } = ecc.signRecoverable(messageHash(statement), node.privateKey);
  const out = new Uint8Array(65);
  out[0] = 31 + recoveryId;
  out.set(signature, 1);
  return toBase64(out);
}


// ---------------------------------------------------------------------------
// A Ledger wallet
//
// The same standard account as backup words (m/84'/coin'/0', first address),
// but the key never leaves the device. Everything the app shows is worked out
// from the account's xpub, read from the Ledger once; signing asks the device
// each time, over whatever connection `useLedger` opens.
// ---------------------------------------------------------------------------

/** The origin path of a Ledger account, by network. */
export function ledgerOriginPath(network = "mainnet") {
  const { coin } = typeof network === "string" ? NETWORKS[network] : network;
  return `/84'/${coin}'/0'`;
}

/** Read a Ledger's account once: its key expression, from the device. */
export async function readLedgerAccount(session, network = "mainnet") {
  return ledgerApi.keyExpression({ session, originPath: ledgerOriginPath(network), keyPath: "/0/0" });
}

/**
 * "Check my Ledger": prove the device in hand is the one this wallet uses and
 * that it can still sign. In one connection (which already checks the right
 * Bitcoin app is open and the same Ledger, by fingerprint) it re-reads the
 * account and compares it with the saved one, then has the device sign a
 * harmless dated message, shown on its screen, and verifies that signature
 * with the same code the register uses. Nothing is sent anywhere.
 * `network` is the network's name (as in NETWORKS).
 */
export async function checkLedgerKey({ account, network, now = new Date() }) {
  if (account.kind !== "ledger") throw new Error("this wallet's key is not on a Ledger");
  const statement = `Crowdlock key check ${now.toISOString().slice(0, 10)}`;
  return account.useLedger(async (session) => {
    const keyExpression = await readLedgerAccount(session, network);
    if (keyExpression !== account.keyExpression) {
      return { ok: false, reason: "This Ledger gives a different account from the one this wallet uses." };
    }
    const sig = await ledgerApi.signMessage({ descriptor: `wpkh(${account.keyExpression})`, session, message: statement });
    const signature = typeof sig === "string" ? sig : toBase64(sig);
    const r = verifyMembership({ address: account.address, signature, message: statement, hrp: account.network.bech32 });
    if (!r.valid) return { ok: false, reason: `The signature didn't check out (${r.reason}).` };
    return { ok: true, fingerprint: account.fingerprint, address: account.address, statement };
  });
}

/**
 * A wallet whose key is on a Ledger. `keyExpression` is what readLedgerAccount
 * returned (saved, so the phone can show balances without the device);
 * `useLedger(fn)` connects, runs fn(session), and disconnects.
 */
export function ledgerAccountFrom({ keyExpression, network = "mainnet", useLedger }) {
  const { network: net } = typeof network === "string" ? NETWORKS[network] : network;
  const m = /^\[([0-9a-f]{8})(\/[0-9'h/]+)\]([xt]pub[1-9A-HJ-NP-Za-km-z]+)\/0\/0$/.exec(String(keyExpression ?? ""));
  if (!m) throw new Error("that is not a Ledger account the app understands");
  const x = readXpub(m[3]);
  if (!x) throw new Error("that Ledger account's xpub can't be read");
  const output = new Output({ descriptor: `wpkh(${keyExpression})`, network: net });
  return {
    kind: "ledger",
    network: net,
    fingerprint: m[1],
    path: `m${m[2]}/0/0`,
    publicKey: toHex(x.node.derive(0).derive(0).publicKey),
    address: output.getAddress(),
    keyExpression,
    output,
    useLedger,
    signer: () => { throw new Error("this wallet's key is on a Ledger"); },
  };
}
