// The proposals file, and the browser-safe proposal hash held to the
// reference code's bytes. Run: node method/js/proposals.test.mjs
import { readFileSync } from "node:fs";
import {
  proposalLine, proposalHash, documentHash, fieldsOf, checkProposals, phaseOf, pilePath, checkPileShape,
  PROPOSALS_FORMAT, PILE_FORMAT,
} from "./proposals.mjs";
import * as ref from "../lock/commitment.mjs";
import { checkCrowdlock } from "./crowdlock.mjs";

let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };
const throws = (fn, part) => { try { fn(); return false; } catch (e) { return e.message.includes(part); } };

const crowdlock = JSON.parse(readFileSync(new URL("../../crowdlocks/kop-fund-testnet4.json", import.meta.url)));
const instance = crowdlock.declaration.sha256;
const text = "Buy the test stake.\nA second line, and an accent: café.";
const p = {
  title: "Test purchase", text, destination: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  requires: 12345, currency: "GBP",
  opens: "2026-11-11T00:00:00Z", closes: "2026-11-25T00:00:00Z", settles_by: "2026-12-02T00:00:00Z",
  target: { sats: 250000, rate: "1 BTC = 66000.00 GBP", at: "2026-11-10T22:00:00Z" },
};
const fields = fieldsOf(p, instance);
const hash = proposalHash(fields);

// The same bytes as the reference code, for several proposals.
const cases = [fields, { ...fields, currency: "EUR", requiresMinor: 1 }, { ...fields, document: documentHash("Ünïcödé, decomposed: é") }];
check("The browser-safe line and hash are the reference code's, byte for byte",
  cases.every((f) => proposalLine(f) === ref.proposalLine(f) && proposalHash(f) === ref.proposalHash(f)));
check("The document is the SHA-256 of the prose, taken after NFC", documentHash("é") === documentHash("é"));
check("A lower-case currency is refused, not upper-cased", throws(() => proposalHash({ ...fields, currency: "gbp" }), "capitals"));

const file = { format: PROPOSALS_FORMAT, instance, proposals: [{ ...p, hash }] };
const ok = checkProposals(file, crowdlock);
check("A well-formed proposals file passes, and each hash is recomputed", ok.ok && ok.proposals[0].hash === hash, ok.problems.join("; "));
check("A proposal whose text was changed after its hash is refused",
  checkProposals({ ...file, proposals: [{ ...p, hash, text: text + " " }] }, crowdlock).problems.some((x) => x.includes("hash")));
check("A proposal whose price was changed after its hash is refused",
  !checkProposals({ ...file, proposals: [{ ...p, hash, requires: 12346 }] }, crowdlock).ok);
check("A proposals file from another Crowdlock is refused", !checkProposals({ ...file, instance: "0".repeat(64) }, crowdlock).ok);
check("A proposal gathering longer than the Crowdlock allows is refused",
  (() => { const q = { ...p, closes: "2027-01-30T00:00:00Z", settles_by: "2027-02-01T00:00:00Z" }; return !checkProposals({ ...file, proposals: [{ ...q, hash: proposalHash(fieldsOf(q, instance)) }] }, crowdlock).ok; })());
check("The same proposal listed twice is refused", !checkProposals({ ...file, proposals: [{ ...p, hash }, { ...p, hash }] }, crowdlock).ok);
check("A target without its rate and moment is refused",
  !checkProposals({ ...file, proposals: [{ ...p, hash, target: { sats: 1 } }] }, crowdlock).ok);

check("Phases: soon, gathering, settling, over",
  phaseOf(p, Date.parse("2026-11-10T00:00:00Z")) === "soon" && phaseOf(p, Date.parse("2026-11-12T00:00:00Z")) === "gathering"
    && phaseOf(p, Date.parse("2026-11-26T00:00:00Z")) === "settling" && phaseOf(p, Date.parse("2026-12-03T00:00:00Z")) === "over");
check("A pile lives beside the proposals file", pilePath("crowdlocks/test/proposals.json", hash) === `crowdlocks/test/commitments/${hash}.json`
  && pilePath("proposals.json", hash) === `commitments/${hash}.json`);
check("A pile's shape is checked before anything in it is trusted",
  checkPileShape({ format: PILE_FORMAT, proposal: hash, commitments: [] }, hash).ok
    && !checkPileShape({ format: PILE_FORMAT, proposal: "1".repeat(64), commitments: [] }, hash).ok
    && !checkPileShape({ format: PILE_FORMAT, proposal: hash, commitments: [{ submitted: "x", record: {} }] }, hash).ok);

check("A Crowdlock file may name its proposals file",
  checkCrowdlock({ ...crowdlock, register: { ...crowdlock.register, proposals: "crowdlocks/test/proposals.json" } }).ok);
check("…but not as anything other than a .json file",
  !checkCrowdlock({ ...crowdlock, register: { ...crowdlock.register, proposals: 7 } }).ok);

console.log(failures === 0 ? "Proposals behave as spec/proposal-and-settlement.md describes." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
