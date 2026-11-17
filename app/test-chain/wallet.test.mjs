// The app's key module, tested on a private chain.
//
// Run, from this folder:
//   npm install --ignore-scripts      (once)
//   npm test
//
// Milestone 3 adds locking: a lock is made, counted as locked, refused on the
// way home before its date, and taken home after it.
//
// Milestone 1 of the app plan is done when a wallet can be created, funded,
// deleted, restored from its 12 words with the same address and balance, and
// can send its waiting money out. Everything here does that against a real
// rule-enforcing node — bcoin on an in-memory regtest chain — using exactly
// the code the phone runs (../src/wallet/core.mjs). Nothing is mocked except
// the block explorer, which is replaced by the node itself.

import { createRequire } from "node:module";
import {
  newWords, wordsAreValid, tidyWords, accountFromWords, waitingBalance, buildSend, NETWORKS, DUST_SATS,
  signStatement, lockFor, lockDate, buildLock, lockState, takeHome, relock, newCosignerWords, cosignerKeyFromWords, suggestWords,
} from "../src/wallet/core.mjs";
import { lockAddress } from "../../method/js/lockrecord.mjs";
import { lockDate as siteLockDate } from "../../method/js/lockplan.mjs";
import { verifyMembership } from "../../method/js/verify.mjs";
import bitcoinMessage from "../../method/lock/node_modules/bitcoinjs-message/index.js";

const require = createRequire(import.meta.url);
const bcoin = require("bcoin");

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(66)} ${detail}`);
};
const rule = (t) => { console.log("-".repeat(80)); if (t) { console.log(t); console.log("-".repeat(80)); } };
const refuses = async (what, fn, expect) => {
  try { await fn(); check(what, false, "ACCEPTED IT"); }
  catch (e) { check(what, String(e.message).includes(expect), e.message.slice(0, 46)); }
};

// ---------------------------------------------------------------------------
rule("BACKUP WORDS");

const words = newWords();
check("New words are twelve words", words.split(" ").length === 12);
check("…and pass their own checksum", wordsAreValid(words));
check("Two sets of new words are never the same", newWords() !== words);
// Twelve "abandon"s fail the checksum — a fixed example, because changing one
// word of a random set still passes about one time in sixteen.
const broken = Array(12).fill("abandon").join(" ");
check("Words with one changed fail the checksum", !wordsAreValid(broken));
check("Messy typing is tidied (capitals, extra spaces)", tidyWords(`  ${words.toUpperCase().replace(/ /g, "   ")} `) === words);

// Wallets made elsewhere — a Ledger makes 24 words — must restore too.
const { generateMnemonic } = await import("../node_modules/@scure/bip39/index.js");
const { wordlist } = await import("../node_modules/@scure/bip39/wordlists/english.js");
const twentyFour = generateMnemonic(wordlist, 256);
check("24 backup words from another wallet are accepted", wordsAreValid(twentyFour) && twentyFour.split(" ").length === 24);
check("…and open a wallet", accountFromWords(twentyFour, "mainnet").address.startsWith("bc1q"));

// The published standard test vector (BIP84): these words must give this
// address in every wallet that follows the standard — including ours, or a fan
// could not take their words to Sparrow and find their money.
const vector = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
check("The standard BIP84 test words give the standard first address",
  accountFromWords(vector, "mainnet").address === "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  accountFromWords(vector, "mainnet").address);

// ---------------------------------------------------------------------------
rule("A CO-SIGNER KEY OF ITS OWN");

// The published BIP84 test words give this key at m/84'/0'/0'/0/0 — in the
// standard, in method/cosigner/generate.mjs, and so in Sparrow or Electrum. The app
// must agree, or a co-signer's paper would restore to a different key.
check("The standard test words give the standard co-signer key (same as method/cosigner/generate.mjs)",
  cosignerKeyFromWords(vector).publicKey === "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c");
const coWords = newCosignerWords();
check("A new co-signer key has its own 12 words", coWords.split(" ").length === 12 && wordsAreValid(coWords) && coWords !== words);
check("A co-signer key made with 24 words elsewhere still restores", /^0[23][0-9a-f]{64}$/.test(cosignerKeyFromWords(twentyFour).publicKey));
check("Checking a paper copy offers standard words for what's typed, never the answer itself",
  suggestWords("aban").includes("abandon") && suggestWords("").length === 0 && suggestWords("zzz").length === 0 && suggestWords("a").length === 4);
check("The same words always give the same key, typed messily or not",
  cosignerKeyFromWords(`  ${coWords.toUpperCase()} `).publicKey === cosignerKeyFromWords(coWords).publicKey);
// The standard slot is shared with an ordinary wallet's first address, so the
// SAME words would make the same key: a co-signer must always have words of
// its own. The app makes fresh ones, refuses a wallet's words as co-signer
// words, and every lock refuses a co-signer that is its owner's key.
check("Wallet words in the co-signer slot would be the wallet's own key — which is why they must differ",
  cosignerKeyFromWords(words).publicKey === accountFromWords(words, "mainnet").publicKey);

// ---------------------------------------------------------------------------
rule("SIGNING A DECLARATION (milestone 2)");

// A signature the register cannot verify would turn a fan away at the door,
// so each one is checked by the register's own verifier and by bitcoinjs-
// message, the library BlueWallet uses — two independent judges.
const statement = "I agree to the Test Declaration v1 (sha256:29f943a5bf2c110200cb33d0299b00960b19f10f1942d14699aec154b39316df) and join as a member.";
for (const net of ["testnet4", "mainnet"]) {
  const acct = accountFromWords(words, net);
  const sig = signStatement(acct, statement);
  const hrp = net === "mainnet" ? "bc" : "tb";
  const ours = verifyMembership({ address: acct.address, signature: sig, message: statement, hrp });
  check(`On ${net}: the register's verifier accepts the app's signature`, ours.valid, ours.reason ?? "");
  let theirs = false;
  try { theirs = bitcoinMessage.verify(statement, acct.address, sig, null, true); } catch (e) { theirs = e.message; }
  check(`On ${net}: bitcoinjs-message accepts it too`, theirs === true, String(theirs));
  check(`On ${net}: it is the same kind of signature Sparrow made for member 1`,
    Buffer.from(sig, "base64")[0] >= 31 && Buffer.from(sig, "base64")[0] <= 34);
}
const acct = accountFromWords(words, "testnet4");
const sig = signStatement(acct, statement);
check("Signing is deterministic (same words, same statement, same signature)", signStatement(acct, statement) === sig);
check("A signature over one statement does not verify for another",
  !verifyMembership({ address: acct.address, signature: sig, message: statement.replace("v1", "v2"), hrp: "tb" }).valid);
const other = accountFromWords(newWords(), "testnet4");
check("Another wallet's signature does not verify for this address",
  !verifyMembership({ address: acct.address, signature: signStatement(other, statement), message: statement, hrp: "tb" }).valid);

// ---------------------------------------------------------------------------
rule("A PRIVATE CHAIN");

// bcoin 1.0's regtest uses the address prefix "rb" instead of "bcrt"; only the
// text of the address differs.
const net = { network: { ...NETWORKS.regtest.network, bech32: "rb" }, coin: 1 };

const node = new bcoin.FullNode({
  network: "regtest", memory: true, workers: false, indexTX: true, indexAddress: true,
  logLevel: "error", listen: false,
});
await node.open();
const rpc = (method, params = []) => node.rpc.execute({ method, params });

// The chain object the key module talks to — the same shape as the phone's
// block-explorer connector, answered by the node.
const chain = {
  async utxos(address) {
    // Newly mined coins cannot be spent for 100 blocks; like a real explorer's
    // wallet view, those are left out.
    const tip = node.chain.height;
    const coins = await node.getCoinsByAddress([bcoin.Address.fromString(address, "regtest")]);
    return coins
      .filter((c) => !(c.coinbase && c.height !== -1 && tip - c.height < 100))
      .map((c) => ({ txid: c.txid(), vout: c.index, value: c.value, confirmed: c.height !== -1 }));
  },
  async txHex(txid) { return (await node.getMeta(bcoin.util.revHex(txid))).tx.toRaw().toString("hex"); },
  async broadcast(hex) { await node.mempool.addTX(bcoin.TX.fromRaw(Buffer.from(hex, "hex"))); },
  async everFunded(address) {
    return (await node.getMetaByAddress([bcoin.Address.fromString(address, "regtest")])).length > 0;
  },
  async medianTime() { return (await rpc("getblockchaininfo")).mediantime; },
  // One transaction as an Esplora explorer describes it: its outputs, and its block if it is in one.
  async tx(txid) {
    const m = await node.getMeta(bcoin.util.revHex(txid));
    if (!m) throw new Error("the block explorer answered 404");
    return {
      txid, status: m.height >= 0 ? { confirmed: true, block_time: m.time } : { confirmed: false },
      vout: m.tx.outputs.map((o) => ({ scriptpubkey: o.script.toRaw().toString("hex"), value: o.value })),
    };
  },
};

const minerWords = newWords();
const miner = accountFromWords(minerWords, net);
// Past segwit's activation first, paid to an address nobody uses, then 101
// blocks to the miner so exactly one of its mined coins has matured.
const nobody = accountFromWords(newWords(), net);
await rpc("generatetoaddress", [440, nobody.address]);
await rpc("generatetoaddress", [101, miner.address]);
check("The chain is up, with segwit active", (await rpc("getblockchaininfo")).bip9_softforks.segwit.status === "active");

// ---------------------------------------------------------------------------
rule("MILESTONE 1: CREATE, FUND, RESTORE, SEND OUT");

const fan = accountFromWords(words, net);
check("A new wallet has an address", fan.address.startsWith("rb1q"), fan.address.slice(0, 18) + "…");

const pay = await buildSend({ account: miner, chain, to: fan.address, amount: 2_500_000n, feeRate: 2 });
await chain.broadcast(pay.hex);
let bal = await waitingBalance(chain, fan.address);
check("Money sent to it shows as arriving before it confirms",
  bal.arriving === 2_500_000n && bal.confirmed === 0n, `${bal.arriving} arriving`);

await refuses("Nothing can be sent out until it confirms",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 10_000n, feeRate: 2 }), "no confirmed money");

await rpc("generatetoaddress", [1, miner.address]);
bal = await waitingBalance(chain, fan.address);
check("Once mined it shows as confirmed", bal.confirmed === 2_500_000n && bal.arriving === 0n, `${bal.confirmed} sats`);

// "Delete the app and restore from the words": nothing is carried over except
// the twelve words, typed back in messily.
const restored = accountFromWords(`  ${words.toUpperCase()} `, net);
const restoredBal = await waitingBalance(chain, restored.address);
check("Restored from the words: the same address", restored.address === fan.address);
check("Restored from the words: the same balance", restoredBal.confirmed === bal.confirmed, `${restoredBal.confirmed} sats`);

const out = await buildSend({ account: restored, chain, to: miner.address, amount: 1_000_000n, feeRate: 3 });
await chain.broadcast(out.hex);
await rpc("generatetoaddress", [1, miner.address]);
bal = await waitingBalance(chain, fan.address);
check("Sending money out works, signed by the restored wallet", bal.confirmed === out.change,
  `sent ${out.sent}, fee ${out.fee}, change ${out.change}`);
check("…and the sums add up exactly", out.sent + out.fee + out.change === 2_500_000n);

const all = await buildSend({ account: restored, chain, to: miner.address, amount: "all", feeRate: 3 });
await chain.broadcast(all.hex);
await rpc("generatetoaddress", [1, miner.address]);
bal = await waitingBalance(chain, fan.address);
check("Sending everything empties the waiting balance, no change left", bal.total === 0n && all.change === 0n,
  `sent ${all.sent}, fee ${all.fee}`);

// ---------------------------------------------------------------------------
rule("WHAT THE KEY MODULE REFUSES");

await rpc("generatetoaddress", [0, miner.address]);
const top = await buildSend({ account: miner, chain, to: fan.address, amount: 50_000n, feeRate: 2 });
await chain.broadcast(top.hex);
await rpc("generatetoaddress", [1, miner.address]);

await refuses("An amount below the dust limit",
  () => buildSend({ account: fan, chain, to: miner.address, amount: DUST_SATS - 1n, feeRate: 2 }), "dust");
await refuses("A fee more than a tenth of what is sent",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 2_000n, feeRate: 50 }), "more than a tenth");
await refuses("More than the balance",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 60_000n, feeRate: 2 }), "not enough");
await refuses("An address on another network",
  () => buildSend({ account: fan, chain, to: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", amount: 10_000n, feeRate: 2 }),
  "not an address on this network");
await refuses("Something that is not an address at all",
  () => buildSend({ account: fan, chain, to: "send it to my mate", amount: 10_000n, feeRate: 2 }), "not an address");
await refuses("A silly fee rate",
  () => buildSend({ account: fan, chain, to: miner.address, amount: 10_000n, feeRate: 5000 }), "fee rate");
// A block explorer that understates what a coin holds: the fee is worked out
// from its figure, so the difference would leave as fee. The coin's own
// transaction says what it really holds, and the two must agree.
const understating = { ...chain, utxos: async (a) => (await chain.utxos(a)).map((u) => ({ ...u, value: u.value - 20_000 })) };
await refuses("A send, when the explorer understates a coin (the rest would have gone as fee)",
  () => buildSend({ account: fan, chain: understating, to: miner.address, amount: 10_000n, feeRate: 2 }), "don't agree with the coin itself");
const wrongCoin = { ...chain, txHex: async () => chain.txHex(top.txid) };
await refuses("A send, when the explorer hands over a different transaction for a coin",
  () => buildSend({ account: miner, chain: wrongCoin, to: fan.address, amount: 10_000n, feeRate: 2 }), "don't agree with the coin itself");
// What the app shows a words wallet from: its public account only. The words
// stay in the keystore until something is signed, so every screen works from
// this, and it must be the same wallet in every respect but signing.
{
  const { ledgerAccountFrom } = await import("../src/wallet/core.mjs");
  const other = accountFromWords(newWords(), net);
  const shown = { ...ledgerAccountFrom({ keyExpression: fan.keyExpression, network: net, useLedger: null }), kind: "words", signer: () => { throw new Error("the wallet has to be unlocked before it can sign"); } };
  check("A wallet shown from its public half has the same address and key as the words give", shown.address === fan.address && shown.publicKey === fan.publicKey && shown.path === fan.path, shown.address);
  const LT = 1900000000;
  const a = lockFor({ account: shown, cosignerPubkey: other.publicKey, locktime: LT }), b = lockFor({ account: fan, cosignerPubkey: other.publicKey, locktime: LT });
  check("…and makes the same lock, so a lock planned on screen is the lock the words then sign for", a.address === b.address && a.ownerPubkey === b.ownerPubkey, a.address);
  await refuses("…but it cannot sign: a payment built with it is refused, nothing leaves",
    () => buildSend({ account: shown, chain, to: miner.address, amount: 10_000n, feeRate: 2 }), "has to be unlocked");
  const viaWords = await buildSend({ account: fan, chain, to: miner.address, amount: 10_000n, feeRate: 2 });
  check("The same payment signs once the words are read", /^[0-9a-f]{64}$/.test(viaWords.txid));
}
await refuses("Words that are not valid backup words",
  () => accountFromWords(broken, net), "not valid backup words");

// ---------------------------------------------------------------------------
rule("MILESTONE 3: LOCK, WATCH IT, TAKE IT HOME");

const saver = accountFromWords(newWords(), net);
const cosigner = accountFromWords(newWords(), net);
const toSaver = await buildSend({ account: miner, chain, to: saver.address, amount: 300_000n, feeRate: 2 });
await chain.broadcast(toSaver.hex);
await rpc("generatetoaddress", [1, miner.address]);

check("A one-year lock unlocks on a plain date, a year or so away",
  lockDate(1, 1800000000) % 86400 === 0 && lockDate(1, 1800000000) - 1800000000 >= 365 * 86400);
check("A test length under a day is not rounded", lockDate(1 / 8766, 1800000000) === 1800000000 + Math.ceil(3600));
{
  // The website's Lock page works out the date with its own copy of the rule.
  // The date decides the address, so a drift between the two would send a
  // member's money to an address the other side does not watch.
  const lengths = [1 / 8766, 1 / 365.25, 0.0027378507871321013, 1, 3, 5];
  const times = [1793491200, 1793491201, 1800000000, 1825027199, 1825027200, 1825027201, 1793516711];
  const same = lengths.every((y) => times.every((t) => lockDate(y, t) === siteLockDate(y, t)));
  check("The website and the app work out the same lock date for every length and time", same);
}

await refuses("A lock whose co-signer is the fan's own key",
  async () => lockFor({ account: saver, cosignerPubkey: saver.publicKey, locktime: 1900000000 }), "your own key");
await refuses("A lock whose date is a block height",
  async () => lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: 800000 }), "must be a date");

const T = (await chain.medianTime()) + 2 * 86400;
const lock = lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: T });
const registerSays = lockAddress({ ownerPubkey: saver.publicKey, cosignerPubkey: cosigner.publicKey, locktime: T }, "rb");
check("The app's lock address is the one the register rebuilds", lock.address === registerSays, lock.address.slice(0, 18) + "…");

const stateOf = async () => lockState({ chain, lock, medianTime: await chain.medianTime() });
check("Before anything is sent, the lock is empty", (await stateOf()).state === "empty");

await refuses("Locking to terms that do not make the address",
  () => buildLock({ account: saver, chain, lock: { ...lock, locktime: T + 1 }, feeRate: 2 }), "do not make that address");
// Part of it, first: the rest stays waiting for another lock or Crowdlock.
const partLock = lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: T + 86400 });
const part = await buildLock({ account: saver, chain, lock: partLock, feeRate: 2, amount: 100_000n });
await chain.broadcast(part.hex);
await rpc("generatetoaddress", [1, miner.address]);
const leftAfterPart = (await waitingBalance(chain, saver.address)).confirmed;
check("Locking part of it locks exactly that amount, and the rest stays waiting",
  (await lockState({ chain, lock: partLock, medianTime: await chain.medianTime() })).confirmed === 100_000n
    && leftAfterPart === 300_000n - 100_000n - part.fee, `${leftAfterPart} sats still waiting`);

const locking = await buildLock({ account: saver, chain, lock, feeRate: 2 });
await chain.broadcast(locking.hex);
check("Locking with no amount sends everything still waiting", (await stateOf()).state === "arriving",
  `${locking.sent} sats, fee ${locking.fee}`);
await rpc("generatetoaddress", [1, miner.address]);
let st = await stateOf();
check("Once confirmed it shows as locked", st.state === "locked" && st.confirmed === locking.sent, `${st.confirmed} sats`);
check("…and the waiting balance is empty", (await waitingBalance(chain, saver.address)).total === 0n);

const mt = await chain.medianTime();
await refuses("Taking it home before the date: the app refuses",
  () => takeHome({ account: saver, chain, lock, feeRate: 2, medianTime: mt }), "not passed yet");
const early = await takeHome({ account: saver, chain, lock, feeRate: 2, medianTime: mt, ignoreDate: true });
let earlyRefused;
try { await chain.broadcast(early.hex); earlyRefused = false; } catch (e) { earlyRefused = String(e.reason ?? e.message).split(" (")[0]; }
check("…and so does the network, if forced", earlyRefused !== false, String(earlyRefused));

// Move the private chain's clock past the date, as the library check does.
node.network.time.offset = T - Math.floor(Date.now() / 1000) + 3600;
for (let i = 0; i < 12; i++) await rpc("generatetoaddress", [1, miner.address]);
st = await stateOf();
check("After the date it shows as lapsed, still holding the money", st.state === "lapsed" && st.confirmed === locking.sent);

await refuses("Taking a lock home, when the explorer understates what the lock holds",
  async () => takeHome({ account: saver, chain: understating, lock, feeRate: 2, medianTime: await chain.medianTime() }), "don't agree with the coin itself");
const home = await takeHome({ account: saver, chain, lock, feeRate: 2, medianTime: await chain.medianTime() });
await chain.broadcast(home.hex);
await rpc("generatetoaddress", [1, miner.address]);
check("The owner alone takes it home, and the network accepts it", (await stateOf()).state === "withdrawn",
  `${home.sent} sats home, fee ${home.fee}`);
check("…back into the waiting balance, every sat accounted for",
  (await waitingBalance(chain, saver.address)).confirmed === home.sent && home.sent + home.fee === locking.sent);

// Renewal: the part-lock's date passes too, and it is locked again straight
// into a new lock, with the money that came home added in, in one transaction.
const partDate = partLock.locktime;
node.network.time.offset = partDate - Math.floor(Date.now() / 1000) + 3600;
for (let i = 0; i < 12; i++) await rpc("generatetoaddress", [1, miner.address]);
const mt2 = await chain.medianTime();
const partState = await lockState({ chain, lock: partLock, medianTime: mt2 });
check("The part-lock's date passes and it shows as lapsed", partState.state === "lapsed");

const waitingNow = (await waitingBalance(chain, saver.address)).confirmed;
const renewed = lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: mt2 + 2 * 86400 });
check("The new lock is one the register would rebuild",
  renewed.address === lockAddress({ ownerPubkey: saver.publicKey, cosignerPubkey: cosigner.publicKey, locktime: renewed.locktime }, "rb"));
await refuses("Locking again into the same lock",
  () => relock({ account: saver, chain, lock: partLock, newLock: partLock, feeRate: 2, medianTime: mt2 }), "new date");
await refuses("Locking again, when the explorer understates what the old lock holds",
  () => relock({ account: saver, chain: understating, lock: partLock, newLock: renewed, feeRate: 2, medianTime: mt2, addWaiting: true }), "don't agree with the coin itself");
const again = await relock({ account: saver, chain, lock: partLock, newLock: renewed, feeRate: 2, medianTime: mt2, addWaiting: true });
await chain.broadcast(again.hex);
await rpc("generatetoaddress", [1, miner.address]);
const renewedState = await lockState({ chain, lock: renewed, medianTime: await chain.medianTime() });
check("Locked again in one transaction: the old lock and the waiting money, minus one fee",
  renewedState.state === "locked" && renewedState.confirmed === partState.confirmed + waitingNow - again.fee,
  `${renewedState.confirmed} sats, fee ${again.fee}`);
check("…the old lock is emptied and the waiting balance with it",
  (await lockState({ chain, lock: partLock, medianTime: await chain.medianTime() })).state === "withdrawn"
    && (await waitingBalance(chain, saver.address)).total === 0n);
await refuses("Locking again before the date has passed",
  async () => relock({ account: saver, chain, lock: renewed, newLock: lockFor({ account: saver, cosignerPubkey: cosigner.publicKey, locktime: renewed.locktime + 86400 }), feeRate: 2, medianTime: await chain.medianTime() }),
  "not passed yet");

// ---------------------------------------------------------------------------
rule("MILESTONE 4: A LEDGER WALLET — JOIN, LOCK, TAKE IT HOME, LOCK AGAIN");

{
  const { fakeLedger } = await import("./fake-ledger.mjs");
  const bitcoinApi = await import("@ledgerhq/ledger-bitcoin");
  const { BIP32 } = await import("@bitcoinerlab/descriptors");
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const {
    readLedgerAccount, ledgerAccountFrom, signStatementWith, lockPolicyName, keyFromXpub, xpubForNetwork, checkLedgerKey,
  } = await import("../src/wallet/core.mjs");

  const ledgerWords = newWords();
  const device = fakeLedger(ledgerWords, net.network);
  const session = { client: device.client, bitcoinApi, network: net.network, store: {} };
  let connections = 0;
  const useLedger = async (fn) => { connections++; return fn(session); };
  const keyExpression = await readLedgerAccount(session, net);
  const led = ledgerAccountFrom({ keyExpression, network: net, useLedger });
  check("A Ledger opens the same standard account its words would",
    led.address === accountFromWords(ledgerWords, net).address && led.publicKey === accountFromWords(ledgerWords, net).publicKey, led.address.slice(0, 18) + "…");

  const statement = "I have read The Test Declaration and join as a member.";
  const sig = await signStatementWith(led, statement);
  check("It signs the declaration on the device, and the register's checker accepts it",
    verifyMembership({ address: led.address, signature: sig, message: statement, hrp: "rb" }).valid && device.log.messages[0]?.text === statement);

  // A co-signer that publishes its xpub, as hardware wallets need.
  const coRoot = BIP32.fromSeed(mnemonicToSeedSync(newWords()), net.network);
  const coXpub = coRoot.derivePath("m/84'/1'/0'").neutered().toBase58();
  const coKey = keyFromXpub(coXpub);

  await chain.broadcast((await buildSend({ account: miner, chain, to: led.address, amount: 400_000n, feeRate: 2 })).hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const LT = (await chain.medianTime()) + 2 * 86400;
  const ledLock = { ...lockFor({ account: led, cosignerPubkey: coKey, locktime: LT }), cosignerXpub: coXpub };
  check("The Ledger's lock is the one the register rebuilds",
    ledLock.address === lockAddress({ ownerPubkey: led.publicKey, cosignerPubkey: coKey, locktime: LT }, "rb"));
  await refuses("A Ledger won't lock money into a lock it couldn't take home (no co-signer xpub)",
    () => buildLock({ account: led, chain, lock: { ...ledLock, cosignerXpub: undefined }, feeRate: 2, amount: 250_000n }), "xpub");
  // A Ledger whose owner rejects the lock's rules: nothing is signed, so
  // nothing can be sent. (A different date, so it is a rule it hasn't approved.)
  const ledLockOther = { ...lockFor({ account: led, cosignerPubkey: coKey, locktime: LT + 86400 }), cosignerXpub: coXpub };
  const signedBefore = device.log.signed.length;
  device.options.refuseRegistration = true;
  await refuses("A Ledger that refuses the lock's rules stops the lock before anything is signed",
    () => buildLock({ account: led, chain, lock: ledLockOther, feeRate: 2, amount: 250_000n }), "denied");
  device.options.refuseRegistration = false;
  check("…and nothing was signed", device.log.signed.length === signedBefore);

  const sentIn = await buildLock({ account: led, chain, lock: ledLock, feeRate: 2, amount: 250_000n });
  check("Locking asks the device to approve the lock's rules first, then signs the payment",
    device.log.registered.length === 1 && device.log.registered[0].name === lockPolicyName(LT)
      && device.log.order.join() === "register,sign", device.log.order.join());
  await chain.broadcast(sentIn.hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const ledState = async (l) => lockState({ chain, lock: l, medianTime: await chain.medianTime() });
  check("The Ledger signs money into a lock, and the network accepts it", (await ledState(ledLock)).state === "locked");

  node.network.time.offset = LT - Math.floor(Date.now() / 1000) + 3600;
  for (let i = 0; i < 12; i++) await rpc("generatetoaddress", [1, miner.address]);

  await refuses("Taking it home when the co-signer's xpub isn't published",
    () => takeHome({ account: led, chain, lock: { ...ledLock, cosignerXpub: undefined }, feeRate: 2, medianTime: LT + 1 }), "xpub");
  const wrongXpub = BIP32.fromSeed(mnemonicToSeedSync(newWords()), net.network).derivePath("m/84'/1'/0'").neutered().toBase58();
  await refuses("…or when the xpub stands for a different key",
    () => takeHome({ account: led, chain, lock: { ...ledLock, cosignerXpub: wrongXpub }, feeRate: 2, medianTime: LT + 1 }), "doesn't stand for its key");

  // Locked again first, with the money still waiting added in: two kinds of
  // input, two policies, one transaction.
  const ledRenewed = { ...lockFor({ account: led, cosignerPubkey: coKey, locktime: (await chain.medianTime()) + 2 * 86400 }), cosignerXpub: coXpub };
  const waitingBefore = (await waitingBalance(chain, led.address)).confirmed;
  const lockedBefore = (await ledState(ledLock)).confirmed;
  const renewTx = await relock({ account: led, chain, lock: ledLock, newLock: ledRenewed, feeRate: 2, medianTime: await chain.medianTime(), addWaiting: true });
  await chain.broadcast(renewTx.hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const reg0 = device.log.registered[0], reg = device.log.registered.at(-1);
  check("The device approved the lock's rules once, by name, in the form a Ledger accepts",
    reg0?.template === `wsh(and_v(v:pk(@0/**),or_i(after(${LT}),pk(@1/**))))` && reg0.name === lockPolicyName(LT)
      && reg0.keys[1] === xpubForNetwork(coXpub, net.network), reg0?.name);
  check("Locking it again has the device approve the new lock's rules too (old ones were already approved)",
    device.log.registered.length === 2 && reg.name === lockPolicyName(ledRenewed.locktime)
      && reg.template === `wsh(and_v(v:pk(@0/**),or_i(after(${ledRenewed.locktime}),pk(@1/**))))`, `${device.log.registered.length} approvals`);
  check("The Ledger locks it again, old lock and waiting money together, and the network accepts it",
    (await ledState(ledRenewed)).confirmed === lockedBefore + waitingBefore - renewTx.fee && (await ledState(ledLock)).state === "withdrawn");

  node.network.time.offset = ledRenewed.locktime - Math.floor(Date.now() / 1000) + 3600;
  for (let i = 0; i < 12; i++) await rpc("generatetoaddress", [1, miner.address]);
  const before = connections;
  const homeTx = await takeHome({ account: led, chain, lock: ledRenewed, feeRate: 2, medianTime: await chain.medianTime() });
  await chain.broadcast(homeTx.hex);
  await rpc("generatetoaddress", [1, miner.address]);
  check("The Ledger takes it home after its date, and the network accepts it",
    (await ledState(ledRenewed)).state === "withdrawn" && (await waitingBalance(chain, led.address)).confirmed === homeTx.sent,
    `${homeTx.sent} sats home`);
  check("…one connection to the device for the whole transaction", connections === before + 1);
  check("Taking it home asks the device for no new approval: it approved those rules when the lock was made", device.log.registered.length === 2);

  // "Check my Ledger"
  const kc = await checkLedgerKey({ account: led, network: "regtest", now: new Date("2026-11-08T10:00:00Z") });
  check("Check my Ledger: same account, and it signs a dated message that verifies",
    kc.ok === true && kc.statement === "Crowdlock key check 2026-11-08" && kc.address === led.address
      && device.log.messages.at(-1)?.text === "Crowdlock key check 2026-11-08", JSON.stringify(kc));
  const other = fakeLedger(newWords(), net.network);
  const otherSession = { client: other.client, bitcoinApi, network: net.network, store: {} };
  const kcWrong = await checkLedgerKey({ account: { ...led, useLedger: async (fn) => fn(otherSession) }, network: "regtest" });
  check("Check my Ledger: a different Ledger's account is reported, and nothing is signed", kcWrong.ok === false && /different account/.test(kcWrong.reason ?? "") && other.log.messages.length === 0, kcWrong.reason);
  await refuses("Check my Ledger: refuses a wallet that isn't on a Ledger", () => checkLedgerKey({ account: miner, network: "regtest" }), "not on a Ledger");
  check("The key never left the device: the wallet can't sign by itself", (() => { try { led.signer(); return false; } catch { return true; } })());
}

// ---------------------------------------------------------------------------
rule("MILESTONE 5: COMMITTING A LOCK TO A PURCHASE");

{
  const { buildCommitment } = await import("../src/wallet/core.mjs");
  const { BIP32 } = await import("@bitcoinerlab/descriptors");
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const { ECPair } = await import("../../method/lock/lock.mjs");
  const C = await import("../../method/lock/commitment.mjs");
  const bitcoinjs = createRequire(new URL("../../method/lock/package.json", import.meta.url))("bitcoinjs-lib");

  // A co-signer key made the standard way, from its own words.
  const coWords5 = newCosignerWords();
  const coKey5 = cosignerKeyFromWords(coWords5).publicKey;
  const coPriv = BIP32.fromSeed(mnemonicToSeedSync(coWords5)).derivePath("m/84'/0'/0'/0/0").privateKey;
  const coSigner = ECPair.fromPrivateKey(Buffer.from(coPriv));
  check("The co-signer's words make the key the lock names", Buffer.from(coSigner.publicKey).toString("hex") === coKey5);

  // A destination on an attested list, and a proposal for it.
  const INSTANCE = "29f943a5bf2c110200cb33d0299b00960b19f10f1942d14699aec154b39316df";
  const destination = accountFromWords(newWords(), net).address;
  const attestor = accountFromWords(newWords(), net);
  const entry0 = { instance: INSTANCE, index: 1, op: "add", address: destination, text: "Test seller", added: "2026-10-01T00:00:00Z", prev: C.ZERO_PREV };
  const attested = { ...entry0, attestations: [{ address: attestor.address, signature: signStatement(attestor, C.attestationStatement(entry0)) }] };

  // The attestor stamps the entry on the chain: a payment back to itself carrying it.
  const { buildStamp } = await import("../src/wallet/core.mjs");
  const P0 = await import("../../method/js/proposals.mjs");
  await chain.broadcast((await buildSend({ account: miner, chain, to: attestor.address, amount: 50_000n, feeRate: 2 })).hex);
  await rpc("generatetoaddress", [1, miner.address]);
  await refuses("A stamp of something that isn't a stamp", () => buildStamp({ account: attestor, chain, script: "6a0100", feeRate: 2 }), "not a destination's stamp");
  const stampTx = await buildStamp({ account: attestor, chain, script: P0.stampScript(attested), feeRate: 2 });
  await chain.broadcast(stampTx.hex);
  const entry = { ...attested, stamp: stampTx.txid };
  const STAMPS = {};
  STAMPS[stampTx.txid] = await chain.tx(stampTx.txid);
  check("A stamp waiting for a block doesn't date the entry yet", !P0.stampedAt(entry, STAMPS[stampTx.txid]).ok && /not in a block/.test(P0.stampedAt(entry, STAMPS[stampTx.txid]).reason));
  await rpc("generatetoaddress", [1, miner.address]);
  STAMPS[stampTx.txid] = await chain.tx(stampTx.txid);
  const stampedAt = P0.stampedAt(entry, STAMPS[stampTx.txid]);
  {
    const t = bitcoinjs.Transaction.fromHex(stampTx.hex);
    const rate = Number(stampTx.fee) / t.virtualSize();
    check("The stamp: one OP_RETURN carrying the entry and nothing else, and the rest back to the attestor",
      t.outs.length === 2 && Buffer.from(t.outs[0].script).toString("hex") === P0.stampScript(attested) && Number(t.outs[0].value) === 0
        && bitcoinjs.address.fromOutputScript(t.outs[1].script, net.network) === attestor.address && rate >= 2 && rate < 2.2,
      `${stampTx.fee} sats for ${t.virtualSize()} vbytes`);
    check("…and once it is in a block, the block's time dates the entry, for the app and the reference alike",
      stampedAt.ok && stampedAt.at === C.stampedAt(entry, STAMPS[stampTx.txid]).at, stampedAt.reason);
  }
  // The proposal opens eight days after the stamp: old enough for a seven-day wait.
  const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
  const proposal = { instance: INSTANCE, destination, requiresMinor: 100000, currency: "GBP", document: "d".repeat(64), opens: iso(stampedAt.at + 8 * 86400), closes: iso(stampedAt.at + 30 * 86400), settlesBy: iso(stampedAt.at + 40 * 86400) };
  const pHash = C.proposalHash(proposal);
  const verifyArgs = (record, utxoValue) => ({
    record, utxoValue, network: net.network,
    proposal: { hash: pHash, destination, opensAt: proposal.opens },
    destinationStamps: STAMPS, destinationEntries: [entry], destinationRules: { attestors: [attestor.address], threshold: 1, instance: INSTANCE },
  });

  // A fan locks, then commits part of the lock.
  const fanWords = newWords();
  const fan = accountFromWords(fanWords, net);
  await chain.broadcast((await buildSend({ account: miner, chain, to: fan.address, amount: 500_000n, feeRate: 2 })).hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const FT = (await chain.medianTime()) + 30 * 86400;
  const fanLock = lockFor({ account: fan, cosignerPubkey: coKey5, locktime: FT });
  const fl = await buildLock({ account: fan, chain, lock: fanLock, feeRate: 2 });
  await chain.broadcast(fl.hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const [coin] = (await chain.utxos(fanLock.address)).filter((c) => c.confirmed);

  await refuses("A commitment for a lock whose terms don't make its address",
    () => buildCommitment({ account: fan, chain, lock: { ...fanLock, locktime: FT + 1 }, coin, proposalHash: pHash, destination, amount: 100_000n, feeRate: 2 }), "do not make that address");
  await refuses("A commitment whose fee would pass the 1% cap",
    () => buildCommitment({ account: fan, chain, lock: fanLock, coin, proposalHash: pHash, destination, amount: 10_000n, feeRate: 20 }), "more than 1%");

  await refuses("A commitment, when the coin is said to hold less than it does",
    () => buildCommitment({ account: fan, chain, lock: fanLock, coin: { ...coin, value: coin.value - 20_000 }, proposalHash: pHash, destination, amount: 200_000n, feeRate: 2 }), "don't agree with the coin itself");
  const part = await buildCommitment({ account: fan, chain, lock: fanLock, coin, proposalHash: pHash, destination, amount: 200_000n, feeRate: 2 });
  const vPart = C.verifyCommitment(verifyArgs(part.record, coin.value));
  check("Committing part of a lock: the method's own checker accepts the record", vPart.valid && vPart.committedSats === 200_000, vPart.reason || `${vPart.committedSats} committed, fee ${part.fee}`);
  check("…the rest goes back into the same lock, and every sat is accounted for",
    !!part.record.remainder && part.remainder + part.committed + part.fee === BigInt(coin.value), `${part.remainder} back to the lock`);
  const ptx = bitcoinjs.Transaction.fromHex(part.record.tx);
  check("…it declares no date and leaves the co-signer's slot empty", ptx.locktime === 0 && ptx.ins[0].witness[0].length === 0 && ptx.ins[0].witness.length === 4);

  // The owner's half alone cannot move anything.
  let alone;
  try { await chain.broadcast(part.record.tx); alone = false; } catch (e) { alone = String(e.reason ?? e.message).split(" (")[0]; }
  check("The owner's half alone is refused by the network: nothing moves", alone !== false, String(alone));
  check("…the money is still in the lock", (await lockState({ chain, lock: fanLock, medianTime: await chain.medianTime() })).confirmed === BigInt(coin.value));

  // Tampering is caught by the checker.
  const vWrong = C.verifyCommitment({ ...verifyArgs(part.record, coin.value), proposal: { hash: pHash, destination: fan.address, opensAt: proposal.opens } });
  check("A commitment checked against another destination is refused", !vWrong.valid, vWrong.reason);

  // Settlement: the co-signer completes it, long before the lock's date.
  const done = C.completeCommitment({ record: part.record, cosignerKey: coSigner, utxoValue: coin.value, network: net.network });
  await chain.broadcast(done.hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const paid = (await chain.utxos(destination)).filter((c) => c.confirmed).reduce((n, c) => n + BigInt(c.value), 0n);
  const backIn = (await chain.utxos(fanLock.address)).filter((c) => c.confirmed);
  check("Completed by the co-signer before the lock's date, the network accepts it: the seller is paid", paid === 200_000n, `${paid} sats to the destination`);
  check("…and the remainder is still locked, to the same date", backIn.length === 1 && BigInt(backIn[0].value) === part.remainder
    && (await lockState({ chain, lock: fanLock, medianTime: await chain.medianTime() })).state === "locked");

  // Committing everything in a coin.
  const [coin2] = (await chain.utxos(fanLock.address)).filter((c) => c.confirmed);
  const all = await buildCommitment({ account: fan, chain, lock: fanLock, coin: coin2, proposalHash: pHash, destination, amount: "all", feeRate: 2 });
  const vAll = C.verifyCommitment(verifyArgs(all.record, coin2.value));
  check("Committing a whole coin: one output, accepted by the checker", vAll.valid && !all.record.remainder && all.committed + all.fee === BigInt(coin2.value), vAll.reason);

  // A proposal that misses its target: nobody co-signs, and the fan's money
  // is untouched and still goes home on its date, alone.
  node.network.time.offset = FT - Math.floor(Date.now() / 1000) + 3600;
  for (let i = 0; i < 12; i++) await rpc("generatetoaddress", [1, miner.address]);
  const home5 = await takeHome({ account: fan, chain, lock: fanLock, feeRate: 2, medianTime: await chain.medianTime() });
  await chain.broadcast(home5.hex);
  await rpc("generatetoaddress", [1, miner.address]);
  check("A commitment nobody completes leaves the money untouched: the fan takes it home on the date", (await lockState({ chain, lock: fanLock, medianTime: await chain.medianTime() })).state === "withdrawn");
  // A late completion of it can never pay: its coin has gone home. (This node
  // parks such a transaction as an orphan rather than refusing it, so the
  // test looks at the result: a block later the seller has nothing more.)
  try { await chain.broadcast(C.completeCommitment({ record: all.record, cosignerKey: coSigner, utxoValue: coin2.value, network: net.network }).hex); } catch {}
  await rpc("generatetoaddress", [1, miner.address]);
  const paidAfter = (await chain.utxos(destination)).filter((c) => c.confirmed).reduce((n, c) => n + BigInt(c.value), 0n);
  const vGone = C.verifyCommitment({ ...verifyArgs(all.record, coin2.value), coinIsUnspent: false });
  check("…and once it has gone home, that commitment can never pay: the seller got nothing more, and the checker voids it",
    paidAfter === 200_000n && !vGone.valid && /already been spent/.test(vGone.reason), `${paidAfter} sats; ${vGone.reason}`);

  // The same with a Ledger: it signs its half on the device.
  const { fakeLedger } = await import("./fake-ledger.mjs");
  const bitcoinApi = await import("@ledgerhq/ledger-bitcoin");
  const { readLedgerAccount, ledgerAccountFrom, lockPolicyName } = await import("../src/wallet/core.mjs");
  const dev5 = fakeLedger(newWords(), net.network);
  const session5 = { client: dev5.client, bitcoinApi, network: net.network, store: {} };
  const led5 = ledgerAccountFrom({ keyExpression: await readLedgerAccount(session5, net), network: net, useLedger: async (fn) => fn(session5) });
  const coXpub5 = cosignerKeyFromWords(coWords5).xpub;
  await chain.broadcast((await buildSend({ account: miner, chain, to: led5.address, amount: 400_000n, feeRate: 2 })).hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const LT5 = (await chain.medianTime()) + 30 * 86400;
  const ledLock5 = { ...lockFor({ account: led5, cosignerPubkey: coKey5, locktime: LT5 }), cosignerXpub: coXpub5 };
  await chain.broadcast((await buildLock({ account: led5, chain, lock: ledLock5, feeRate: 2 })).hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const [lcoin] = (await chain.utxos(ledLock5.address)).filter((c) => c.confirmed);
  const signedBefore = dev5.log.signed.length;
  const lc = await buildCommitment({ account: led5, chain, lock: ledLock5, coin: lcoin, proposalHash: pHash, destination, amount: 150_000n, feeRate: 2 });
  const vL = C.verifyCommitment(verifyArgs(lc.record, lcoin.value));
  check("A Ledger signs its half on the device, and the checker accepts the record",
    vL.valid && dev5.log.signed.length === signedBefore + 1, vL.reason || `${vL.committedSats} committed`);
  check("…under the lock's rules it approved when the lock was made, with no new approval",
    dev5.log.registered.length === 1 && dev5.log.registered[0].name === lockPolicyName(LT5), `${dev5.log.registered.length} approvals`);
  const ldone = C.completeCommitment({ record: lc.record, cosignerKey: coSigner, utxoValue: lcoin.value, network: net.network });
  await chain.broadcast(ldone.hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const paidL = (await chain.utxos(destination)).filter((c) => c.confirmed).reduce((n, c) => n + BigInt(c.value), 0n);
  check("…the co-signer completes it and the network accepts it", paidL === 350_000n, `${paidL} sats to the destination in all`);

  // The app's own commitment checker gives the reference checker's verdicts.
  const { checkCommitment, completeCommitmentWith } = await import("../src/wallet/core.mjs");
  // The attestors are the ones the Crowdlock's own file names, and the list is tied to its fingerprint.
  const cl = { name: "Test", network: "regtest", cosigner_keys: [coKey5], destination_wait_days: 7, max_commitment_fee: 0.01,
    attestor_keys: [attestor.publicKey], attestor_threshold: 1, declaration: { sha256: INSTANCE } };
  const destFile = { attestors: [attestor.address], threshold: 1, entries: [entry] };
  const appProposal = { hash: pHash, destination, opens: proposal.opens };
  await chain.broadcast((await buildSend({ account: miner, chain, to: fan.address, amount: 300_000n, feeRate: 2 })).hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const FT2 = (await chain.medianTime()) + 30 * 86400;
  const lock2 = lockFor({ account: fan, cosignerPubkey: coKey5, locktime: FT2 });
  await chain.broadcast((await buildLock({ account: fan, chain, lock: lock2, feeRate: 2 })).hex);
  await rpc("generatetoaddress", [1, miner.address]);
  const [c3] = (await chain.utxos(lock2.address)).filter((c) => c.confirmed);
  const good = (await buildCommitment({ account: fan, chain, lock: lock2, coin: c3, proposalHash: pHash, destination, amount: 100_000n, feeRate: 2 })).record;
  const flip = (hexs, at) => hexs.slice(0, at) + (hexs[at] === "0" ? "1" : "0") + hexs.slice(at + 1);
  const otherOwner = accountFromWords(newWords(), net);
  const variants = {
    "a good one": good,
    "another proposal's": { ...good, proposal: "e".repeat(64) },
    "lock terms that don't make its address": { ...good, lock: { ...good.lock, locktime: good.lock.locktime + 1 } },
    "a tampered transaction": { ...good, tx: flip(good.tx, good.tx.length - 40) },
    "another owner's key": { ...good, lock: { ...good.lock, owner_pubkey: otherOwner.publicKey, address: lockAddress({ ownerPubkey: otherOwner.publicKey, cosignerPubkey: coKey5, locktime: good.lock.locktime }, "rb") } },
    "a remainder that expires sooner": { ...good, remainder: { ...good.remainder, locktime: good.lock.locktime - 1 } },
    "a co-signer from another Crowdlock": { ...good, lock: { ...good.lock, cosigner_pubkey: otherOwner.publicKey } },
  };
  // What a review found (17 November 2026): each of these is a commitment the
  // owner really signed, which used to count and could never have been paid,
  // or could have been counted for a proposal its owner never chose. They are
  // the good one with one thing changed, signed again with the fan's own key.
  const fanKey = ECPair.fromPrivateKey(Buffer.from(BIP32.fromSeed(mnemonicToSeedSync(fanWords), net.network).derivePath(`m/84'/${net.coin}'/0'/0/0`).privateKey));
  const lock2Script = (await import("../../method/lock/lock.mjs")).lockScript({ fanPubkey: Buffer.from(fan.publicKey, "hex"), cosignerPubkey: Buffer.from(coKey5, "hex"), locktime: FT2 });
  const remade = (change, { highS = false } = {}) => {
    const tx = bitcoinjs.Transaction.fromHex(good.tx);
    change(tx);
    const sighash = tx.hashForWitnessV0(0, lock2Script, c3.value, bitcoinjs.Transaction.SIGHASH_ALL);
    let sig = Buffer.from(fanKey.sign(sighash));
    if (highS) {
      const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
      sig = Buffer.concat([sig.subarray(0, 32), Buffer.from((N - BigInt("0x" + sig.subarray(32).toString("hex"))).toString(16).padStart(64, "0"), "hex")]);
    }
    tx.setWitness(0, [Buffer.alloc(0), Buffer.alloc(0), bitcoinjs.script.signature.encode(sig, bitcoinjs.Transaction.SIGHASH_ALL), lock2Script]);
    return { ...good, tx: tx.toHex() };
  };
  check("The fan's key, derived here, is the one the app signs with", Buffer.from(fanKey.publicKey).toString("hex") === fan.publicKey);
  Object.assign(variants, {
    "the good one signed again, unchanged": remade(() => {}),
    "a waiting period in its sequence number": remade((tx) => { tx.ins[0].sequence = 0x0000ffff; }),
    "a version the network does not pass on": remade((tx) => { tx.version = 7; }),
    "a high-S signature": remade(() => {}, { highS: true }),
    "no proposal inside the payment": remade((tx) => { tx.outs.pop(); }),
    "a proposal marker carrying money": remade((tx) => { tx.outs[2].value = 1; tx.outs[1].value -= 1; }),
    "a remainder under what a lock output needs": remade((tx) => { const spare = tx.outs[1].value - 300; tx.outs[1].value = 300; tx.outs[0].value += spare; }),
    "a fee below what the network needs": remade((tx) => { tx.outs[1].value += (c3.value - tx.outs.reduce((n, o) => n + o.value, 0)) - 50; }),
  });
  let agreeAll = true; const disagree = [];
  for (const [name, rec] of Object.entries(variants)) {
    const app = await checkCommitment({ record: rec, crowdlock: cl, proposal: appProposal, destinations: destFile, chain, network: net });
    const refv = C.verifyCommitment({ record: rec, utxoValue: c3.value, coinIsUnspent: true, network: net.network, crowdlock: cl,
      proposal: { hash: pHash, destination, opensAt: proposal.opens }, destinationStamps: STAMPS, destinationEntries: [entry], destinationRules: { attestors: [attestor.address], threshold: 1, instance: INSTANCE } });
    if (app.valid !== refv.valid || (!app.valid && app.reason !== refv.reason)) { agreeAll = false; disagree.push(`${name}: app "${app.reason}" vs ref "${refv.reason}"`); }
  }
  check("The app's commitment checker gives the reference checker's verdict and reason, good and tampered", agreeAll, disagree.join(" | "));
  const appGood = await checkCommitment({ record: good, crowdlock: cl, proposal: appProposal, destinations: destFile, chain, network: net });
  check("…and counts what a good one commits", appGood.valid && appGood.committedSats === 100_000, appGood.reason);
  check("…naming the coin it spends, so a pile can count each coin once", appGood.coin === `${c3.txid}:${c3.vout}`, appGood.coin);
  {
    // Relabelled: the same signed payment, offered for another proposal that pays the same address.
    const other = C.proposalHash({ ...proposal, document: "e".repeat(64) });
    const relabelled = { ...good, proposal: other };
    const app = await checkCommitment({ record: relabelled, crowdlock: cl, proposal: { ...appProposal, hash: other }, destinations: destFile, chain, network: net });
    const refv = C.verifyCommitment({ record: relabelled, utxoValue: c3.value, coinIsUnspent: true, network: net.network, crowdlock: cl,
      proposal: { hash: other, destination, opensAt: proposal.opens }, destinationStamps: STAMPS, destinationEntries: [entry] });
    check("A commitment relabelled for another proposal paying the same address is refused, by the app and the reference alike",
      !app.valid && !refv.valid && app.reason === refv.reason && /does not name this proposal inside it/.test(app.reason), `${app.reason} | ${refv.reason}`);
    // A list that names its own attestors: only the Crowdlock's file counts.
    const impostor = accountFromWords(newWords(), net);
    const forgedEntry = { ...entry0, attestations: [{ address: impostor.address, signature: signStatement(impostor, C.attestationStatement(entry0)) }] };
    const selfAppointed = await checkCommitment({ record: good, crowdlock: cl, proposal: appProposal, destinations: { attestors: [impostor.address], threshold: 1, entries: [forgedEntry] }, chain, network: net });
    check("A destinations list attested by somebody it names itself, not the Crowdlock's file, is refused", !selfAppointed.valid && /not a listed attestor/.test(selfAppointed.reason), selfAppointed.reason);
    const elsewhere0 = { ...entry0, instance: "7".repeat(64) };
    const elsewhere = { ...elsewhere0, attestations: [{ address: attestor.address, signature: signStatement(attestor, C.attestationStatement(elsewhere0)) }] };
    const crossed = await checkCommitment({ record: good, crowdlock: cl, proposal: appProposal, destinations: { entries: [elsewhere] }, chain, network: net });
    check("A destination the same attestor signed for another Crowdlock is refused", !crossed.valid && /different instance/.test(crossed.reason), crossed.reason);
    // Dated by its stamp, not by anything written in the file.
    const typed = { ...entry, stamp: undefined, firstSeen: "2026-01-01T00:00:00Z" };
    const unstamped = await checkCommitment({ record: good, crowdlock: cl, proposal: appProposal, destinations: { entries: [typed] }, chain, network: net });
    check("A destination with a date typed into the file and no stamp is refused", !unstamped.valid && /no stamp on the chain/.test(unstamped.reason), unstamped.reason);
    const tooSoon = await checkCommitment({ record: good, crowdlock: { ...cl, destination_wait_days: 9 }, proposal: appProposal, destinations: destFile, chain, network: net });
    check("A proposal opening before the stamp is old enough is refused", !tooSoon.valid && /days old at the proposal's opening, needs 9/.test(tooSoon.reason), tooSoon.reason);
  }

  await refuses("Completing with words that aren't this lock's co-signer", () => completeCommitmentWith({ words: newWords(), record: good, chain }), "don't make this lock's co-signer key");
  const finished = await completeCommitmentWith({ words: coWords5, record: good, chain });
  {
    // The fee is sized for the payment as it is finally sent: two signatures,
    // and the output naming the proposal. Until 17 November 2026 it was sized
    // for a smaller payment and came out under the rate asked for.
    const done = bitcoinjs.Transaction.fromHex(finished);
    const paidFee = c3.value - done.outs.reduce((n, o) => n + o.value, 0);
    const rate = paidFee / done.virtualSize();
    check("A commitment's fee is at least the rate asked for, measured on the finished payment", rate >= 2 && rate < 2.1, `${paidFee} sats for ${done.virtualSize()} vbytes, asked 2 sat/vB`);
  }
  await chain.broadcast(finished);
  await rpc("generatetoaddress", [1, miner.address]);
  const paid3 = (await chain.utxos(destination)).filter((c) => c.confirmed).reduce((n, c) => n + BigInt(c.value), 0n);
  check("The co-signer's words complete it in the app, and the network accepts it", paid3 === 450_000n, `${paid3} sats to the destination in all`);
  const afterSpend = await checkCommitment({ record: good, crowdlock: cl, proposal: appProposal, destinations: destFile, chain, network: net });
  check("…after which the same commitment checks as void", !afterSpend.valid && /already been spent/.test(afterSpend.reason), afterSpend.reason);
  const { commitmentPaid, signNoticeWith } = await import("../src/wallet/core.mjs");
  const P = await import("../../method/js/proposals.mjs");
  const { memberAddressForOwnerKey } = await import("../../method/js/verify.mjs");
  const notice = signNoticeWith({ words: coWords5, crowdlock: cl, statement: P.noticeStatement(pHash), network: net });
  check("The co-signer's words sign a failure notice that checks as genuine",
    P.noticeIsGenuine(notice, { crowdlock: cl, hash: pHash, hrp: "rb", addressOf: memberAddressForOwnerKey }).ok);
  await refuses("…and words that aren't the co-signer's are refused", async () => signNoticeWith({ words: newWords(), crowdlock: cl, statement: P.noticeStatement(pHash), network: net }), "co-signer key");
  check("…and is recognised as paid, for what it paid the seller (so a funded proposal shows as closed)",
    (await commitmentPaid({ record: good, chain })) === 100_000 && (await commitmentPaid({ record: all.record, chain })) === 0,
    `${await commitmentPaid({ record: good, chain })} / ${await commitmentPaid({ record: all.record, chain })}`);
}

await node.close();
rule();
console.log(failures === 0
  ? "The key module works on a real chain: create, fund, restore, send out, lock, and take a lock home after its date."
  : `${failures} check(s) failed.`);
rule();
process.exit(failures === 0 ? 0 : 1);
