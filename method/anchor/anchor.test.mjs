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
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const verifyScript = join(dirname(fileURLToPath(import.meta.url)), "verify.mjs");
const PENDING = "https://alice.btc.calendar.opentimestamps.org";
const HEIGHT = 974596;

// A pretend block explorer: one block, whose merkle root the test chooses.
const explorer = { root: "00".repeat(32) };
const server = createServer((req, res) => {
  if (req.url === `/block-height/${HEIGHT}`) return res.end("ab".repeat(32));
  if (req.url === `/block/${"ab".repeat(32)}`) return res.end(JSON.stringify({ merkle_root: explorer.root, timestamp: 1793800000 }));
  res.statusCode = 404; res.end("not found");
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const HERE = `http://127.0.0.1:${server.address().port}`;

/** Run verify.mjs on a small proof built here. `explorers` is where it may ask about blocks. */
async function runVerify(branches, { honest = true, explorers = HERE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anchor-test-"));
  try {
    const file = join(dir, "thing.txt");
    writeFileSync(file, "a file to anchor\n");
    const digest = createHash("sha256").update(readFileSync(file)).digest();
    // Each branch is its own short step from the file, as in a real proof.
    // The value a block branch works out must be the block's merkle root: an
    // honest block holds it; a made-up claim names a block holding something else.
    const proof = OTS.DetachedTimestampFile.fromHash(new OTS.Ops.OpSHA256(), digest);
    explorer.root = "11".repeat(32);
    branches.forEach((b, i) => {
      const step = proof.timestamp.add(new OTS.Ops.OpAppend([i])).add(new OTS.Ops.OpSHA256());
      if (b === "block") {
        step.attestations.push(new OTS.Notary.BitcoinBlockHeaderAttestation(HEIGHT));
        if (honest) explorer.root = Buffer.from([...step.msg]).reverse().toString("hex");
      } else if (b === "nowhere") step.attestations.push(new OTS.Notary.BitcoinBlockHeaderAttestation(99999999));
      else step.attestations.push(new OTS.Notary.PendingAttestation(PENDING));
    });
    writeFileSync(`${file}.ots`, Buffer.from(proof.serializeToBytes()));
    return await new Promise((done) => {
      const child = spawn(process.execPath, [verifyScript, file], { env: { ...process.env, ANCHOR_EXPLORERS: explorers } });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      const timer = setTimeout(() => child.kill(), 20000);
      child.on("close", (status) => { clearTimeout(timer); done({ out, status }); });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const pendingOnly = await runVerify(["pending"]);
  check("verify.mjs: a proof with only pending branches is unfinished",
    pendingOnly.out.includes("Not in a block yet") && !pendingOnly.out.includes("FINISHED"));

  const blockOnly = await runVerify(["block"]);
  check("verify.mjs: a proof that reaches a block, and is really in it, is finished",
    blockOnly.status === 0 && blockOnly.out.includes("FINISHED") && blockOnly.out.includes("fingerprint is in it"));

  const both = await runVerify(["pending", "block"]);
  check("verify.mjs: a proof with pending branches and a block is finished",
    both.status === 0 && both.out.includes("FINISHED"));

  // Until 17 November 2026 the three below were all called FINISHED: the
  // script saw a block named in the proof and never looked at the block.
  const madeUp = await runVerify(["block"], { honest: false });
  check("verify.mjs: a proof naming a block that does not hold it is refused, not finished",
    madeUp.status === 1 && madeUp.out.includes("NOT IN THE BLOCK IT CLAIMS") && !madeUp.out.includes("FINISHED"));

  const noSuchBlock = await runVerify(["nowhere"]);
  check("verify.mjs: a proof naming a block Bitcoin does not have is refused",
    noSuchBlock.status === 1 && noSuchBlock.out.includes("no such block") && !noSuchBlock.out.includes("FINISHED"));

  const cutOff = await runVerify(["block"], { explorers: "http://127.0.0.1:9" });
  check("verify.mjs: with no explorer to ask, a block claim is reported as not checked, never as finished",
    cutOff.out.includes("NOT CHECKED") && !cutOff.out.includes("FINISHED"));
}
server.close();

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
