// The fingerprint tool must agree with the code every register runs.
//
//   node method/declaration/fingerprint.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { describe } from "./fingerprint.mjs";
import { checkCrowdlock } from "../js/crowdlock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` (${detail})`}`); if (!ok) failed++; };

// The Kop Fund's founding declaration, whose fingerprint is fixed for good.
const KOP = "3a0a0bca96ec2161d98ff9da05ae885d6b8d68e55ed412bc85dcc7fb16209b96";
const v1 = readFileSync(join(ROOT, "spec", "declaration-v1.txt"), "utf8");
const d = describe(v1, { version: 1, title: "Supporters' Declaration" });
check("The Kop Fund's declaration gives its published fingerprint", d.sha256 === KOP, d.sha256);
check("…and its published length, 3,408 bytes", d.bytes === 3408, String(d.bytes));
check("…and is already canonical", d.alreadyCanonical);
check("The printed line is the protocol's sentence",
  d.statement === `I agree to the Supporters' Declaration v1 (sha256:${KOP}) and join as a member.`, d.statement);

// The same text saved carelessly (Windows line endings, trailing spaces, extra
// blank lines at the end) has the same fingerprint, and is flagged.
const messy = v1.replace(/\n/g, "  \r\n") + "\r\n\r\n";
const m = describe(messy);
check("A carelessly saved copy has the same fingerprint", m.sha256 === KOP, m.sha256);
check("…and is flagged as not canonical", !m.alreadyCanonical);
check("…and its canonical form is the published file", m.canonical === v1);

// The entry it prints passes the Crowdlock file's own checks.
const crowdlock = JSON.parse(readFileSync(join(ROOT, "crowdlocks", "kop-fund-testnet4.json"), "utf8"));
const v2text = v1.replace("THE PRINCIPLES", "THE PRINCIPLES, AS AMENDED");
const e = describe(v2text, { file: "spec/declaration-v2.txt", version: 2, reason: "A test reason.", today: "2027-01-31" }).entry;
const withV2 = { ...crowdlock, declaration_versions: [e] };
const r = checkCrowdlock(withV2, { versionTexts: { 2: v2text } });
check("The printed entry passes checkCrowdlock with that text", r.ok, r.problems.join("; "));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nAll passed.");
