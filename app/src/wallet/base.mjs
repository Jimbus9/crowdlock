// Networks, coin selection, and the small byte helpers every other part uses.
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


/** Networks the wallet knows, and the coin type each uses in its key path. */
export const NETWORKS = {
  mainnet:  { network: networks.bitcoin, coin: 0 },
  testnet4: { network: networks.testnet, coin: 1 },
  signet:   { network: networks.testnet, coin: 1 },
  regtest:  { network: networks.regtest, coin: 1 },
};

// Below this a native-segwit output is "dust": nodes will not relay a
// transaction creating one, so it would be stuck. Bitcoin Core's figure.
export const DUST_SATS = 294n;

// The most coins one payment spends. A payment's size is limited by the
// network; 200 lock coins come to about a sixth of that.
export const MOST_INPUTS = 200;
export const TOO_SMALL = "every coin here is too small to be worth its own fee at this fee rate — choose a slower fee";

/**
 * The coins worth spending at this fee rate: each must hold more than it
 * costs to spend, largest first, at most MOST_INPUTS. Anybody can send tiny
 * coins to a published address, and spending every one in one payment could
 * make it too large for the network, or refused. A coin left out is not lost:
 * it stays where it is.
 *   inputWeight  the weight of one such input, from the library
 */
export function worthSpending(coins, inputWeight, feeRate, most = MOST_INPUTS) {
  const cost = BigInt(Math.ceil((inputWeight / 4) * feeRate));
  return coins.filter((c) => BigInt(c.value) > cost)
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0))
    .slice(0, most);
}

/**
 * The same limit for any kind of output, by Bitcoin Core's rule: three sats
 * for every byte the output takes up, counting what it will cost to spend.
 * 294 for a plain segwit address, 330 for a lock (or a taproot address), 546
 * for an old-style one. A commitment pays a seller's address, of whatever
 * kind, and may return the rest to a lock, so one figure is not enough.
 */
export function dustFor(script) {
  const witness = script.length >= 4 && script.length <= 42 && (script[0] === 0x00 || (script[0] >= 0x51 && script[0] <= 0x60)) && script[1] === script.length - 2;
  return BigInt(3 * (8 + 1 + script.length + (witness ? 67 : 148)));
}


// ---------------------------------------------------------------------------

export function toBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromHex(hex) {
  return Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
}

export function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Is this a public key a lock can be built with: 66 hex characters starting 02
 * or 03, and a real point on the curve? A key that only looks right would make
 * every lock built from it unspendable by the purchase route, silently.
 */
export function isPublicKey(hex) {
  const h = String(hex ?? "").trim().toLowerCase();
  return /^0[23][0-9a-f]{64}$/.test(h) && ecc.isPoint(Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16)));
}
