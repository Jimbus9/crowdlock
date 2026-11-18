// Waiting money: the balance, an ordinary send, and a destination's stamp.
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
import { accountFromWords } from "./keys.mjs";
import { signWith } from "./locks.mjs";

// ---------------------------------------------------------------------------
// What the chain says
// ---------------------------------------------------------------------------

/**
 * The waiting balance: confirmed coins, and coins still arriving.
 * Returns { confirmed, arriving, total } in sats, as BigInt.
 */
export async function waitingBalance(chain, address) {
  const coins = await chain.utxos(address);
  let confirmed = 0n, arriving = 0n;
  for (const c of coins) {
    if (c.confirmed) confirmed += BigInt(c.value);
    else arriving += BigInt(c.value);
  }
  return { confirmed, arriving, total: confirmed + arriving };
}

/**
 * The transaction a coin came from, checked against what the block explorer
 * said about the coin. Every fee here is worked out from the explorer's figure
 * for each coin, but what is signed spends the coin itself: if the explorer
 * understated a coin, the difference would leave as fee without anybody having
 * chosen it. So before anything is signed, the transaction must be the one the
 * coin names and hold exactly the amount stated, or nothing is built.
 */
export async function coinSource(chain, coin) {
  const txHex = await chain.txHex(coin.txid);
  let source;
  try { source = Transaction.fromHex(String(txHex).trim()); }
  catch { throw new Error("the block explorer's record of a coin can't be read — refusing, nothing was signed"); }
  const output = source.outs[coin.vout];
  if (source.getId() !== coin.txid || !output || BigInt(output.value) !== BigInt(coin.value)) {
    throw new Error("the block explorer's figures for a coin don't agree with the coin itself — refusing, nothing was signed");
  }
  return txHex;
}

// ---------------------------------------------------------------------------
// Sending waiting money out
// ---------------------------------------------------------------------------

/**
 * Build and sign a transaction sending waiting money to another address.
 *
 *   account   from accountFromWords
 *   chain     the chain object (utxos, txHex)
 *   to        destination address
 *   amount    sats as BigInt, or "all" to send everything (no change)
 *   feeRate   sats per vbyte
 *
 * Spends confirmed coins only. Returns { hex, txid, fee, sent, change }.
 *
 * @param {{ account: any, chain: any, to: string, amount: bigint | "all", feeRate: number }} args
 * @returns {Promise<{ hex: string, txid: string, fee: bigint, sent: bigint, change: bigint }>}
 * Refuses rather than build anything that would lose money to fees, strand
 * money as dust, or send to an address on the wrong network.
 */
export async function buildSend({ account, chain, to, amount, feeRate, policies = [] }) {
  const net = account.network;
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) {
    throw new Error("fee rate must be between 1 and 1000 sats per vbyte");
  }

  let dest;
  try { dest = new Output({ descriptor: `addr(${String(to).trim()})`, network: net }); }
  catch { throw new Error("that is not an address on this network"); }

  const everyCoin = (await chain.utxos(account.address)).filter((c) => c.confirmed);
  if (everyCoin.length === 0) throw new Error("there is no confirmed money to send yet");
  // Coins that cost more to spend than they hold are left where they are.
  const coins = worthSpending(everyCoin, account.output.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES"), feeRate);
  if (coins.length === 0) throw new Error(TOO_SMALL);
  const inputTotal = coins.reduce((s, c) => s + BigInt(c.value), 0n);

  const sendAll = amount === "all";
  if (!sendAll && (typeof amount !== "bigint" || amount <= 0n)) throw new Error("amount must be a positive number of sats");

  // Fee from the library's own weights, never a guessed constant: every input,
  // the destination, and change if there is any.
  const inWeight = account.output.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES");
  const weightOf = (withChange) =>
    44 /* version, locktime, counts and the segwit marker, in weight units */
    + coins.length * inWeight + dest.outputWeight() + (withChange ? account.output.outputWeight() : 0);
  const feeFor = (withChange) => BigInt(Math.ceil((weightOf(withChange) / 4) * feeRate));

  let sent, change, fee;
  if (sendAll) {
    fee = feeFor(false);
    sent = inputTotal - fee;
    change = 0n;
  } else {
    fee = feeFor(true);
    sent = amount;
    change = inputTotal - amount - fee;
    if (change >= 0n && change < DUST_SATS) {
      // Change too small to keep: give it to the fee rather than strand it, but
      // only if that does not make the fee unreasonable (checked below).
      fee = inputTotal - amount;
      change = 0n;
    }
  }

  if (sent < DUST_SATS) throw new Error("that is too little to send — it would be stuck as dust");
  if (change < 0n) throw new Error("there is not enough money for that amount plus the fee");
  // The guard that matters most: never let the fee eat a large share of what
  // is being sent. Ten per cent is generous for a real payment.
  if (fee * 10n > sent) throw new Error("the fee would be more than a tenth of the amount — refusing");

  const psbt = new Psbt({ network: net });
  const finalizers = [];
  for (const c of coins) {
    const txHex = await coinSource(chain, c);
    finalizers.push(account.output.updatePsbtAsInput({ psbt, txHex, vout: c.vout }));
  }
  dest.updatePsbtAsOutput({ psbt, value: sent });
  if (change > 0n) account.output.updatePsbtAsOutput({ psbt, value: change });

  await signWith(account, psbt, policies);
  for (const finalize of finalizers) finalize({ psbt });

  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), fee, sent, change };
}

/**
 * A destination's stamp (spec/destinations-format.md, "The waiting period"):
 * a payment from this wallet back to itself whose other output is OP_RETURN
 * and the stamp hash, carrying nothing. The block it lands in dates the
 * destination, and nobody can backdate a block.
 *
 *   script   the stamp's output script, as hex (stampScript in method/js/proposals.mjs)
 *   feeRate  sats per vbyte
 *
 * Pays from the wallet's largest confirmed coin if that covers it, otherwise
 * from all of them. Returns { hex, txid, fee }; nothing is broadcast.
 */
export async function buildStamp({ account, chain, script, feeRate }) {
  const net = account.network;
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 1000) throw new Error("fee rate must be between 1 and 1000 sats per vbyte");
  if (!/^6a20[0-9a-f]{64}$/.test(String(script))) throw new Error("that is not a destination's stamp");
  const all = (await chain.utxos(account.address)).filter((c) => c.confirmed).sort((a, b) => b.value - a.value);
  if (all.length === 0) throw new Error("this wallet has no confirmed bitcoin to pay the stamp's network fee");
  const inWeight = account.output.inputWeight(true, "DANGEROUSLY_USE_FAKE_SIGNATURES");
  const feeFor = (n) => BigInt(Math.ceil(((44 + n * inWeight + (8 + 1 + 34) * 4 + account.output.outputWeight()) / 4) * feeRate));
  const coins = BigInt(all[0].value) - feeFor(1) >= DUST_SATS ? [all[0]] : all;
  const fee = feeFor(coins.length);
  const change = coins.reduce((n, c) => n + BigInt(c.value), 0n) - fee;
  if (change < DUST_SATS) throw new Error("there isn't enough bitcoin in this wallet to pay the stamp's network fee");
  if (fee > 100000n) throw new Error("the stamp's network fee would be over 100,000 sats — refusing");

  const psbt = new Psbt({ network: net });
  const finalizers = [];
  for (const c of coins) {
    const txHex = await coinSource(chain, c);
    finalizers.push(account.output.updatePsbtAsInput({ psbt, txHex, vout: c.vout }));
  }
  psbt.addOutput({ script: fromHex(script), value: 0n });
  account.output.updatePsbtAsOutput({ psbt, value: change });
  await signWith(account, psbt);
  for (const finalize of finalizers) finalize({ psbt });
  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), fee };
}
