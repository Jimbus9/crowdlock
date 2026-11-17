// What the phone keeps of the wallet (app/src/storage.ts), run against a
// pretend keystore: the words locked to a fingerprint where the phone has one,
// read only for signing, and an older install's single entry moved over.
//
// storage.ts is TypeScript and talks to the phone's keystore, so this turns it
// into plain JavaScript and swaps the keystore for the pretend one below.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const ts = createRequire(join(here, "../package.json"))("typescript");
const dir = mkdtempSync(join(tmpdir(), "crowdlock-storage-"));
const FAKE = `// A pretend keystore: entries saved "locked" need the fingerprint, which the test answers.
export const mem = new Map();
export const world = { biometrics: true, answer: "ok", prompts: [] };
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;
export function canUseBiometricAuthentication() { return world.biometrics; }
function ask(prompt) { world.prompts.push(prompt ?? ""); if (world.answer !== "ok") throw new Error("User canceled the authentication. Cancel"); }
export async function setItemAsync(k, v, o = {}) {
  if (o.requireAuthentication) { if (!world.biometrics) throw new Error("No biometrics are currently enrolled"); ask(o.authenticationPrompt); }
  mem.set(k, { v, locked: !!o.requireAuthentication, invalid: false });
}
export async function getItemAsync(k, o = {}) {
  const e = mem.get(k); if (!e) return null;
  if (e.locked) { if (e.invalid) return null; ask(o.authenticationPrompt); }
  return e.v;
}
export async function deleteItemAsync(k) { mem.delete(k); }
`;
writeFileSync(join(dir, "fake-store.mjs"), FAKE);
const js = ts.transpileModule(readFileSync(join(here, "../src/storage.ts"), "utf8"), { compilerOptions: { module: "ESNext", target: "ES2022" } }).outputText
  .replace('from "expo-secure-store"', 'from "./fake-store.mjs"')
  .replace('from "./moves.mjs"', `from ${JSON.stringify(pathToFileURL(join(here, "../src/moves.mjs")).href)}`);
writeFileSync(join(dir, "storage.mjs"), js);
const { mem, world } = await import(pathToFileURL(join(dir, "fake-store.mjs")).href);
const S = await import(pathToFileURL(join(dir, "storage.mjs")).href);

console.log("-".repeat(80));
console.log("WHAT THE PHONE KEEPS OF THE WALLET");
console.log("-".repeat(80));
const ok = (name, cond, more = "") => { console.log(cond ? "PASS " : "FAIL ", name, more); if (!cond) process.exitCode = 1; };
const W = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const text = (locked) => `watch:{"locked":${locked}}`;
const reset = () => { mem.clear(); world.biometrics = true; world.answer = "ok"; world.prompts.length = 0; };

reset();
let t = await S.saveWordsWallet(W, text);
ok("New wallet on a phone with a fingerprint: saved locked, asked once", t.includes("true") && mem.get("crowdlock.secret.v2").locked && world.prompts.length === 1);
ok("…the public text is saved beside it and read at start with no prompt", (await S.loadWalletText()) === t && world.prompts.length === 1);
ok("…signing reads the words after the fingerprint", (await S.readWords("sign")) === W && world.prompts.at(-1) === "sign");
world.answer = "cancel";
let threw = ""; try { await S.readWords("sign"); } catch (e) { threw = e.message; }
ok("…cancelling the fingerprint gives no words", /cancel/i.test(threw));
world.answer = "ok"; mem.get("crowdlock.secret.v2").invalid = true;
ok("…a key the phone threw away reads as nothing, not an error", (await S.readWords("sign")) === null);

reset(); world.answer = "cancel";
t = await S.saveWordsWallet(W, text);
ok("New wallet, fingerprint cancelled: saved unlocked, and the words are there", t.includes("false") && !mem.get("crowdlock.secret.v2").locked && mem.get("crowdlock.secret.v2").v === W);
world.answer = "ok";
ok("…and read without a prompt", (await S.readWords("sign")) === W && world.prompts.length === 1);
t = await S.saveWordsWallet(W, text, true);
ok("…turning the lock on later saves them locked", t.includes("true") && mem.get("crowdlock.secret.v2").locked);

reset(); world.biometrics = false;
t = await S.saveWordsWallet(W, text);
ok("A phone with no fingerprint: saved unlocked, never asked", t.includes("false") && world.prompts.length === 0 && (await S.readWords("x")) === W);

reset(); mem.set("crowdlock.words.v1", { v: W, locked: false });
ok("An older install's words are found", (await S.loadWalletText()) === null && (await S.loadOldEntry()) === W);
ok("…and can sign before the move", (await S.readWords("x")) === W);
t = await S.saveWordsWallet(W, text, false);
ok("…moved over without a prompt; the old entry is gone", t.includes("false") && !mem.has("crowdlock.words.v1") && world.prompts.length === 0 && (await S.readWords("x")) === W);

reset(); mem.set("crowdlock.words.v1", { v: 'ledger:{"deviceId":"x"}', locked: false });
ok("An older install's Ledger entry is never read as words", (await S.readWords("x")) === null);
await S.saveLedgerWallet('ledger:{"deviceId":"x"}');
ok("…a Ledger wallet keeps no words at all", (await S.loadWalletText()).startsWith("ledger:") && !mem.has("crowdlock.secret.v2") && !mem.has("crowdlock.words.v1"));

reset(); await S.saveWordsWallet(W, text); await S.forgetWallet();
ok("Removing the wallet removes every entry", mem.size === 0);

// A lock's terms, kept so it can be taken home with nothing from anybody else.
reset();
{
  const mine = { crowdlock: "https://a.example/crowdlocks/x.json", address: "bc1qlockone", locktime: 1900000000, cosignerPubkey: "03" + "aa".repeat(32) };
  await S.saveLock(mine);
  await S.rememberLocks([
    { ...mine, cosignerXpub: "xpubOfTheCosigner", name: "A Crowdlock" },                       // one the phone already holds
    { crowdlock: mine.crowdlock, address: "bc1qlocktwo", locktime: 1950000000, cosignerPubkey: mine.cosignerPubkey, cosignerXpub: "xpubOfTheCosigner", name: "A Crowdlock" }, // one made elsewhere, found on the register
  ]);
  const kept = await S.loadSavedLocks();
  ok("A lock found on the register is kept on the phone, with what a Ledger needs to take it home",
    kept.length === 2 && kept[1].address === "bc1qlocktwo" && kept[1].cosignerXpub === "xpubOfTheCosigner");
  ok("…and one the phone already held gains the co-signer's xpub and its Crowdlock's name, its terms untouched",
    kept[0].cosignerXpub === "xpubOfTheCosigner" && kept[0].name === "A Crowdlock" && kept[0].locktime === 1900000000 && kept[0].cosignerPubkey === mine.cosignerPubkey);
  await S.rememberLocks([{ ...mine, locktime: 1, cosignerPubkey: "02" + "bb".repeat(32) }]);
  const after = await S.loadSavedLocks();
  ok("A lock's own terms are never changed by what is read later", after[0].locktime === 1900000000 && after[0].cosignerPubkey === mine.cosignerPubkey && after.length === 2);
  await S.rememberLocks([]);
  ok("…and nothing is ever removed", (await S.loadSavedLocks()).length === 2);
  // A save the keystore refuses is reported, not swallowed (OpenAI review M-03).
  const real = mem.set.bind(mem);
  mem.set = (k, v) => { if (k === "crowdlock.locks.v1") throw new Error("storage full"); return real(k, v); };
  const said = await S.rememberLocks([{ crowdlock: mine.crowdlock, address: "bc1qlockthree", locktime: 1960000000, cosignerPubkey: mine.cosignerPubkey }]);
  mem.set = real;
  ok("A lock the phone couldn't keep is reported as not kept, and nothing is thrown", said === false && !(await S.loadSavedLocks()).some((l) => l.address === "bc1qlockthree"));
  ok("…and one it did keep is reported as kept", (await S.rememberLocks([{ ...mine }])) === true);
}

console.log(process.exitCode ? "\nThe wallet's storage has a problem." : "\nThe wallet's storage keeps the words apart, locked where it can.");
