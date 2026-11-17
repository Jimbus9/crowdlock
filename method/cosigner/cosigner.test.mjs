// Does the key generation do what it says?
//
//   cd cosigner && npm install && node cosigner.test.mjs
//
// This runs here, now, where a failure costs nothing — rather than on a
// disconnected Raspberry Pi with the words already written on paper.
//
// The important property is the boring one: the same words must always give
// the same key. Everything else about the co-signer rests on that, because
// the paper is the backup and the paper is only words.

import { pubkeyFromWords, xpubFromWords, PATH, ACCOUNT_PATH } from "./generate.mjs";

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};
const refuses = (what, words, expect) => {
  let message = "";
  try { pubkeyFromWords(words); } catch (e) { message = e.message; }
  check(what, message.includes(expect), message || "it was ACCEPTED");
};

console.log("\n" + "-".repeat(74));
console.log("THE CO-SIGNER KEY");
console.log("-".repeat(74) + "\n");

// A known phrase from BIP39's own test vectors, so this is checked against
// somebody else's arithmetic rather than against itself.
const KNOWN = "abandon abandon abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon abandon abandon abandon "
  + "abandon abandon abandon abandon abandon abandon abandon art";

const key = pubkeyFromWords(KNOWN);
check("A known recovery phrase gives a key", /^0[23][0-9a-f]{64}$/.test(key), key);
check("…the same one, every time", pubkeyFromWords(KNOWN) === key);
check("…compressed, 33 bytes, as the lock requires", key.length === 66);
check("…at the standard path, so any wallet can restore it", PATH === "m/84'/0'/0'/0/0", PATH);

// BIP84's own published example: these words, this account xpub, this first key.
const BIP84 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
check("The xpub is BIP84's published account key for its example words",
  xpubFromWords(BIP84) === "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V" && ACCOUNT_PATH === "m/84'/0'/0'");
check("…and its first key is the co-signer key the same words make",
  pubkeyFromWords(BIP84) === "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c");

// The things somebody will actually do wrong when typing words off paper.
check("Extra spaces and line breaks are forgiven",
  pubkeyFromWords(`  ${KNOWN.replace(/ /g, "   ")}\n `) === key);
check("Capitals are forgiven", pubkeyFromWords(KNOWN.toUpperCase()) === key);

refuses("A misspelled word is refused", KNOWN.replace("art", "arrt"), "not a valid recovery phrase");
refuses("A word swapped for another real word is refused",
  KNOWN.replace(/abandon art$/, "art abandon"), "not a valid recovery phrase");
refuses("Twenty-three words are refused", KNOWN.split(" ").slice(0, 23).join(" "), "not a valid recovery phrase");
refuses("Nothing at all is refused", "", "not a valid recovery phrase");

console.log();
console.log("  The checksum inside a recovery phrase is what catches these, which");
console.log("  is why a single wrong word is found on the night rather than years");
console.log("  later when the paper is all that is left.");

// Two runs must not produce the same key, which would mean the randomness is
// not random. A weak generator is the one failure that looks exactly like
// success from the outside.
const { generateMnemonic } = await import("@scure/bip39");
const { wordlist } = await import("@scure/bip39/wordlists/english");
const fresh = new Set();
for (let i = 0; i < 50; i++) fresh.add(pubkeyFromWords(generateMnemonic(wordlist, 256)));
console.log();
check("Fifty generated keys are fifty different keys", fresh.size === 50, `${fresh.size} distinct`);

// Run the way a founder runs it, from a folder with a space in its name. On
// Windows, and in any such folder, the script used to print nothing at all.
{
  const { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(mkdtempSync(join(tmpdir(), "cosigner-")), "a folder with spaces");
  mkdirSync(dir);
  for (const f of ["generate.mjs", "package.json"]) copyFileSync(join(here, f), join(dir, f));
  symlinkSync(join(here, "node_modules"), join(dir, "node_modules"), "dir");
  const run = spawnSync(process.execPath, ["generate.mjs", "Test"], { cwd: dir, encoding: "utf8" });
  console.log();
  check("Run from a folder with a space in its name, it prints the key (it used to print nothing)",
    run.status === 0 && /THE CO-SIGNER KEY/.test(run.stdout) && /12\. [a-z]+/.test(run.stdout) && /Test co-signer key/.test(run.stdout),
    `exit ${run.status}, ${run.stdout.length} characters printed`);
  check("…and saves only the public half beside it", existsSync(join(dir, "cosigner-pubkey.txt")) && existsSync(join(dir, "cosigner-xpub.txt")));
  rmSync(dirname(dir), { recursive: true, force: true });
}

console.log("\n" + "-".repeat(74));
console.log(failures === 0
  ? "The words make the key, the same way every time, and bad words are refused."
  : `${failures} check(s) failed.`);
console.log("-".repeat(74) + "\n");
process.exit(failures === 0 ? 0 : 1);
