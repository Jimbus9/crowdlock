// A new version of a declaration: one Crowdlock, a list of versions.
//
// Run:  node method/js/versions.test.mjs   (after npm ci in method/lock)
//
// What must hold (spec/registration-format.md, "Versioning"):
//   * the founding fingerprint stays the Crowdlock's identity;
//   * a newcomer joins by signing the current version;
//   * an existing member can sign a later version, keeping their number;
//   * no signature is read as agreeing to any version but the one it names;
//   * committing needs the version the proposal was published under;
//   * a version-1 proposal keeps the hash it always had.
// Signatures are made by an independent library, so the code under test and
// the signer share nothing.

import * as bitcoin from "../lock/node_modules/bitcoinjs-lib/src/index.js";
import { ECPairFactory } from "../lock/node_modules/ecpair/src/index.js";
import * as ecc from "../lock/node_modules/tiny-secp256k1/lib/index.js";
import bitcoinMessage from "../lock/node_modules/bitcoinjs-message/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  checkCrowdlock, checkRegisterFiles, membershipStatement, versionsOf, currentVersion,
  signedVersions, hasSigned, joinedVersion, declarationHash,
} from "./crowdlock.mjs";
import { addSignature, addRegistration } from "./append.mjs";
import { applyRecords, recordEventTemplate } from "./inbox.mjs";
import { proposalLine, proposalHash, fieldsOf, checkProposals, applyCommitments, commitmentEventTemplate, PROPOSALS_FORMAT, emptyPile } from "./proposals.mjs";
import { proposalLine as referenceLine } from "../lock/commitment.mjs";

const ECPair = ECPairFactory(ecc);
const NET = bitcoin.networks.bitcoin;
const R = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "the-kop-fund");
const v1 = JSON.parse(readFileSync(join(R, "crowdlocks/kop-fund.json"), "utf8"));

let failures = 0;
const check = (what, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  — ${detail}` : ""}`);
};

const V2_TEXT = "THE SUPPORTERS' DECLARATION\n\nVersion 2, a test text.\n";
const v2 = {
  ...v1,
  declaration_versions: [{
    version: 2, file: "spec/declaration-v2.txt", sha256: declarationHash(V2_TEXT),
    published: "2027-01-31", reason: "A solicitor asked for clause 4 to be clearer.",
  }],
};

const member = () => {
  const kp = ECPair.makeRandom({ network: NET });
  const address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: NET }).address;
  const sign = (msg) => bitcoinMessage.sign(msg, Buffer.from(kp.privateKey), true, { segwitType: "p2wpkh" }).toString("base64");
  return { address, sign, pubkey: Buffer.from(kp.publicKey).toString("hex") };
};

// --- The Crowdlock file -----------------------------------------------------

check("A Crowdlock with no later versions is unchanged: its current version is the founding one",
  currentVersion(v1).version === 1 && versionsOf(v1).length === 1);
check("…and its statement is exactly what it always was",
  membershipStatement(v1) === `I agree to the ${v1.declaration.title} v1 (sha256:${v1.declaration.sha256}) and join as a member.`);
check("A later version is accepted when it follows on and says when and why",
  checkCrowdlock(v2, { versionTexts: { 2: V2_TEXT } }).ok, checkCrowdlock(v2).problems.join("; "));
check("The current version is the newest listed", currentVersion(v2).version === 2);
check("The later version takes the founding title unless it gives its own",
  membershipStatement(v2) === `I agree to the ${v1.declaration.title} v2 (sha256:${declarationHash(V2_TEXT)}) and join as a member.`);
check("Version 1's statement can still be rebuilt, byte for byte",
  membershipStatement(v2, 1) === membershipStatement(v1));
check("The founding fingerprint stays the Crowdlock's identity", v2.declaration.sha256 === v1.declaration.sha256);

const bad = (what, patch, needle) => {
  const c = { ...v1, declaration_versions: [{ ...v2.declaration_versions[0], ...patch }] };
  const r = checkCrowdlock(c, { versionTexts: { 2: V2_TEXT } });
  check(`Refused: ${what}`, !r.ok && r.problems.some((p) => p.includes(needle)), r.problems.join("; "));
};
bad("a version that skips a number", { version: 3 }, "version must be 2");
bad("a version with no reason", { reason: "" }, "reason");
bad("a reason over more than one line", { reason: "one\ntwo" }, "reason");
bad("a version with no date", { published: "soon" }, "published");
bad("a version with the same text as version 1", { sha256: v1.declaration.sha256 }, "same text");
bad("a version whose text doesn't hash to what the file says", { sha256: "a".repeat(64) }, "hashes to");
bad("a title with brackets", { title: "Thing (v2)" }, "title");

// --- Signing: joining, and signing a later version ----------------------------

const a = member(), b = member(), c = member();
const today = "2027-02-01";
let reg = { format: 1, declaration: { sha256: v1.declaration.sha256, statement: membershipStatement(v1) }, members: [], locks: [] };

// Member 1 joined under version 1, before version 2 existed.
let r = addSignature(reg, { address: a.address, signature: a.sign(membershipStatement(v1)) }, { crowdlock: v1, today: "2026-11-01" });
check("Before any later version, a join is recorded exactly as it always was",
  r.ok && r.n === 1 && !("version" in r.register.members[0]) && !("also_signed" in r.register.members[0]));
const viaOld = addRegistration(reg, { address: a.address, signature: a.sign(membershipStatement(v1)) }, { statement: membershipStatement(v1), today: "2026-11-01" });
check("…the same record the old join code writes", JSON.stringify(viaOld.register) === JSON.stringify(r.register));
reg = r.register;

r = addSignature(reg, { address: b.address, signature: b.sign(membershipStatement(v2, 1)) }, { crowdlock: v2, today });
check("Once version 2 is out, a newcomer signing version 1 is refused", !r.ok && /current one, version 2/.test(r.reason), r.reason);

r = addSignature(reg, { address: b.address, signature: b.sign(membershipStatement(v2)) }, { crowdlock: v2, today });
check("A newcomer signing version 2 joins, with the version recorded", r.ok && r.n === 2 && r.register.members[1].version === 2 && !r.resigned);
reg = r.register;

check("Member 1 has signed version 1 only", JSON.stringify(signedVersions(v2, reg.members[0])) === "[1]" && !hasSigned(v2, reg.members[0], 2));
check("Member 2 has signed version 2 only", JSON.stringify(signedVersions(v2, reg.members[1])) === "[2]" && joinedVersion(v2, reg.members[1]) === 2);

r = addSignature(reg, { address: a.address, signature: a.sign(membershipStatement(v2)) }, { crowdlock: v2, today });
check("Member 1 signing version 2 keeps number 1, and their first signature",
  r.ok && r.resigned && r.n === 1 && r.register.members[0].signature === reg.members[0].signature
  && r.register.members[0].also_signed?.[0]?.version === 2 && r.register.members.length === 2);
const before = reg;
reg = r.register;
check("…and the register handed in was not changed", !before.members[0].also_signed);
check("Member 1 has now signed versions 1 and 2", JSON.stringify(signedVersions(v2, reg.members[0])) === "[1,2]");

r = addSignature(reg, { address: a.address, signature: a.sign(membershipStatement(v2)) }, { crowdlock: v2, today });
check("Signing version 2 twice is refused", !r.ok && r.status === 409, r.reason);
r = addSignature(reg, { address: a.address, signature: a.sign(membershipStatement(v1)) }, { crowdlock: v2, today });
check("Signing version 1 again is refused as already on the register", !r.ok && /already on the register/.test(r.reason), r.reason);
r = addSignature(reg, { address: c.address, signature: a.sign(membershipStatement(v2)) }, { crowdlock: v2, today });
check("Someone else's signature is refused", !r.ok && r.status === 400);
r = addSignature(reg, { address: b.address, signature: b.sign(membershipStatement(v2, 1)) }, { crowdlock: v2, today });
check("A member who joined with version 2 may also sign version 1", r.ok && r.resigned && r.version === 1);

check("The register still agrees with the Crowdlock", checkRegisterFiles(v2, { registrations: reg }).ok,
  checkRegisterFiles(v2, { registrations: reg }).problems.join("; "));
check("A register naming a version the Crowdlock doesn't publish is caught",
  !checkRegisterFiles(v1, { registrations: reg }).ok);

// --- Through the relay inbox ------------------------------------------------

const ev = (record, t) => ({ ...recordEventTemplate(record, v1.declaration.sha256, t), id: String(t) });
const inbox = await applyRecords(before, [
  ev({ type: "join", address: a.address, signature: a.sign(membershipStatement(v2)) }, 100),
  ev({ type: "join", address: c.address, signature: c.sign(membershipStatement(v2)) }, 101),
], { crowdlock: v2, now: 1800000000, today, confirmedSats: async () => 0 });
const got = inbox.outcome.map((o) => `${o.added}:${o.n}:${o.version}:${o.resigned}`).join(" ");
check("The inbox takes a re-signature and a new join, on the same relay record type",
  got === "true:1:2:true true:3:2:false", got);

// --- Proposals ----------------------------------------------------------------

const fields = {
  instance: v1.declaration.sha256, destination: "bc1qexample", requiresMinor: 100000, currency: "GBP",
  document: "d".repeat(64), opens: "2027-02-01T00:00:00Z", closes: "2027-02-20T00:00:00Z", settlesBy: "2027-03-01T00:00:00Z",
};
check("A version-1 proposal's line is exactly what it always was",
  proposalLine(fields) === proposalLine({ ...fields, declarationVersion: 1 }) && !proposalLine(fields).includes("|v"));
check("A version-2 proposal's line ends |v2, so its version is fixed in its hash",
  proposalLine({ ...fields, declarationVersion: 2 }).endsWith("|v2")
  && proposalHash({ ...fields, declarationVersion: 2 }) !== proposalHash(fields));
check("The browser's line and the reference code's agree, for both",
  proposalLine({ ...fields, declarationVersion: 2 }) === referenceLine({ ...fields, declarationVersion: 2 })
  && proposalLine(fields) === referenceLine(fields));

const prop = (extra) => {
  const p = { title: "T", text: "Buy it.", destination: fields.destination, requires: 100000, currency: "GBP",
    opens: fields.opens, closes: fields.closes, settles_by: fields.settlesBy,
    target: { sats: 1000000, rate: "1 BTC = £50,000", at: "2027-02-01T00:00:00Z" }, ...extra };
  return { ...p, hash: proposalHash(fieldsOf(p, v1.declaration.sha256)) };
};
const pv2 = prop({ declaration_version: 2 });
check("A proposal naming version 2 checks against a Crowdlock that publishes it",
  checkProposals({ format: PROPOSALS_FORMAT, instance: v1.declaration.sha256, proposals: [pv2] }, v2).ok);
check("…and is refused by one that doesn't",
  !checkProposals({ format: PROPOSALS_FORMAT, instance: v1.declaration.sha256, proposals: [pv2] }, v1).ok);

// Commitments: the guard is on who signed what, not on the lock.
const lockOf = (m, n) => ({ address: `bc1qlock${n}`, owner_pubkey: m.pubkey, cosigner_pubkey: v1.cosigner_keys[0], locktime: 1900000000, member: m.address });
const regWithLocks = { ...before, members: [...before.members, { n: 2, address: b.address, signature: "x", signed: today, version: 2 }],
  locks: [lockOf(a, 1), lockOf(b, 2)] };
const commit = (lock, p, t) => ({ ...commitmentEventTemplate({ type: "commitment", proposal: p.hash,
  record: { proposal: p.hash, tx: (t % 256).toString(16).padStart(2, "0") + "00", lock: { address: lock.address, owner_pubkey: lock.owner_pubkey, cosigner_pubkey: lock.cosigner_pubkey, locktime: lock.locktime } } },
  v1.declaration.sha256, t), id: `c${t}` });
const t = Date.parse("2027-02-05T00:00:00Z") / 1000;
const signed = async (records) => records.map(() => ({ ok: true })); // the owner's signature is the relay inbox's to check
const out = await applyCommitments(emptyPile(pv2.hash), [commit(regWithLocks.locks[0], pv2, t), commit(regWithLocks.locks[1], pv2, t + 1)],
  { crowdlock: v2, proposal: pv2, register: regWithLocks, nowIso: "2027-02-05T00:00:00Z", signed });
check("Committing to a version-2 proposal: refused for a member who signed only version 1, taken for one who signed version 2",
  out.outcome.length === 2 && !out.outcome[0].added && /not signed version 2/.test(out.outcome[0].reason) && out.outcome[1].added,
  out.outcome.map((o) => o.reason ?? "added").join("; "));
const pv1 = prop({});
const out1 = await applyCommitments(emptyPile(pv1.hash), [commit(regWithLocks.locks[0], pv1, t), commit(regWithLocks.locks[1], pv1, t + 1)],
  { crowdlock: v2, proposal: pv1, register: regWithLocks, nowIso: "2027-02-05T00:00:00Z", signed });
check("Committing to a version-1 proposal: taken for the version-1 member, refused for one who joined with version 2",
  out1.outcome[0].added && !out1.outcome[1].added, out1.outcome.map((o) => o.reason ?? "added").join("; "));

console.log(failures === 0 ? "\nA new version of a declaration behaves as the spec says." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
