// Any anchor in this repository must be real.
//
// Run:  cd anchor && npm install && node anchor.test.mjs
//
// A proof file is small, opaque and binary. It looks exactly the same whether
// it is a sound timestamp or an 84-byte stump left behind by a connection
// that dropped half way through — which is not hypothetical, it is what
// happened the first time stamp.mjs was run, and the stump reached the disk
// looking entirely respectable.
//
// The failure would then lie there until the day somebody needed it, which is
// the worst possible day to find out. So every .ots in the repository is
// opened here and asked two questions: can any OpenTimestamps tool read it,
// and does it commit to the file it is named after.
//
// Both are answerable with no internet and no trust. Whether the proof has
// reached a block yet is a different question, answered by verify.mjs, and
// deliberately not asked here — a young proof is not a broken one.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import OTS from "javascript-opentimestamps";

const R = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;
const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(74));
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  line(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};

/** Every .ots in the repository, ignoring dependencies. */
function proofs(dir = R, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) proofs(path, found);
    else if (name.endsWith(".ots")) found.push(path);
  }
  return found;
}

line();
rule();
line("EVERY ANCHOR IN THIS REPOSITORY IS A REAL ONE");
rule();
line();

// --- verify.mjs: which proofs count as finished ------------------------------
//
// A finished proof keeps the calendars' pending branches beside the ones that
// reach a Bitcoin block. verify.mjs once called any proof with a pending
// branch unfinished. These build tiny proofs in a temp folder and run
// verify.mjs on them. Only the pending-only case can reach for the network
// (to ask the calendars), so it is given a short timeout and judged on what
// it prints before that.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const verifyScript = join(dirname(fileURLToPath(import.meta.url)), "verify.mjs");
const PENDING = "https://alice.btc.calendar.opentimestamps.org";

function runVerify(branches) {
  const dir = mkdtempSync(join(tmpdir(), "anchor-test-"));
  try {
    const file = join(dir, "thing.txt");
    writeFileSync(file, "a file to anchor\n");
    const digest = createHash("sha256").update(readFileSync(file)).digest();
    const proof = OTS.DetachedTimestampFile.fromHash(new OTS.Ops.OpSHA256(), digest);
    for (const b of branches) {
      proof.timestamp.attestations.push(b === "block"
        ? new OTS.Notary.BitcoinBlockHeaderAttestation(974596)
        : new OTS.Notary.PendingAttestation(PENDING));
    }
    writeFileSync(`${file}.ots`, Buffer.from(proof.serializeToBytes()));
    const r = spawnSync(process.execPath, [verifyScript, file], { encoding: "utf8", timeout: 20000 });
    return { out: r.stdout ?? "", status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const pendingOnly = runVerify(["pending"]);
  check("verify.mjs: a proof with only pending branches is unfinished",
    pendingOnly.out.includes("Not in a block yet") && !pendingOnly.out.includes("FINISHED"));

  const blockOnly = runVerify(["block"]);
  check("verify.mjs: a proof that reaches a block is finished",
    blockOnly.status === 0 && blockOnly.out.includes("FINISHED"));

  const both = runVerify(["pending", "block"]);
  check("verify.mjs: a proof with pending branches and a block is finished",
    both.status === 0 && both.out.includes("FINISHED"));
}

const all = proofs();

if (all.length === 0) {
  line("No anchors yet. Nothing to check, and nothing wrong.");
  line();
  line("  node method/anchor/stamp.mjs    to make the first one");
  line();
  process.exit(0);
}

for (const proofPath of all) {
  const shown = relative(R, proofPath);
  const target = proofPath.replace(/\.ots$/, "");

  if (!existsSync(target)) {
    check(`${shown} has the file it belongs to`, false, "the file it names is missing");
    continue;
  }

  let readBack;
  try {
    readBack = OTS.DetachedTimestampFile.deserialize(readFileSync(proofPath));
  } catch (e) {
    check(`${shown} can be read as a timestamp at all`, false, e.message);
    continue;
  }
  check(`${shown} can be read as a timestamp`, true, `${statSync(proofPath).size} bytes`);

  const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
  const commitsTo = Buffer.from(readBack.fileDigest()).toString("hex");
  check(`${shown} commits to ${relative(R, target)}`, commitsTo === digest,
    commitsTo === digest ? digest : `proof says ${commitsTo}, file is ${digest}`);
}

line();
rule();
line(failures === 0
  ? "Every anchor reads correctly and belongs to the file it names."
  : `${failures} problem(s) — an anchor here does not prove what it appears to.`);
rule();
line();
process.exit(failures === 0 ? 0 : 1);
