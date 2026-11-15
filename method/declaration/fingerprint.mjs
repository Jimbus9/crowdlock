// Work out a declaration's fingerprint, the way every register and app does.
//
//   node method/declaration/fingerprint.mjs spec/declaration-v2.txt
//   node method/declaration/fingerprint.mjs spec/declaration-v2.txt --fix
//   node method/declaration/fingerprint.mjs spec/declaration-v2.txt --crowdlock crowdlocks/kop-fund.json --reason "…"
//
// A declaration's fingerprint is the SHA-256 of its text in one exact form:
// NFC, LF line endings, no spaces or tabs at the end of a line, and exactly
// one newline at the very end (spec/registration-format.md, "Canonicalising
// the declaration"). Get that wrong by hand and every signature on that
// version fails to match. This prints the fingerprint the code will expect,
// says whether the file on disk is already in that form, and prints the
// line members will sign and the entry to add to the Crowdlock file.
//
// --fix rewrites the file in the canonical form, so the file you publish is
// byte for byte what gets hashed. Nothing else is changed, and nothing is
// sent anywhere. It needs nothing installed: only Node.
//
// Optional: --crowdlock <its file> fills in the next version number and the
// title from your Crowdlock file; --version N, --title "…" and --reason "…"
// fill them in by hand.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalise, declarationHash, versionsOf } from "../js/crowdlock.mjs";

/** Everything the script reports about one text: pure, so it can be tested. */
export function describe(raw, { file, version, title, newTitle, reason, today } = {}) {
  const canonical = canonicalise(raw);
  const sha256 = declarationHash(raw);
  const bytes = new TextEncoder().encode(canonical).length;
  const firstLine = canonical.split("\n")[0].trim();
  const entry = {
    version: version ?? "NEXT NUMBER",
    ...(newTitle ? { title: newTitle } : {}),
    file: file ?? "spec/declaration-vN.txt",
    sha256,
    published: today ?? new Date().toISOString().slice(0, 10),
    reason: reason ?? "ONE LINE, UP TO 300 CHARACTERS, SAYING WHY THIS VERSION EXISTS",
  };
  const statementTitle = title ?? "<your declaration's title, as in the Crowdlock file>";
  const statementVersion = version ?? "N";
  return {
    sha256, bytes, alreadyCanonical: raw === canonical, canonical, firstLine, entry,
    statement: `I agree to the ${statementTitle} v${statementVersion} (sha256:${sha256}) and join as a member.`,
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error("Usage: node method/declaration/fingerprint.mjs <declaration file> [--fix] [--version N] [--title \"…\"] [--reason \"…\"]");
    process.exit(2);
  }
  const raw = readFileSync(file, "utf8");
  let version = arg("version") === undefined ? undefined : Number(arg("version"));
  let title = arg("title");
  if (arg("crowdlock")) {
    const all = versionsOf(JSON.parse(readFileSync(arg("crowdlock"), "utf8")));
    const last = all[all.length - 1];
    version ??= last.version + 1;
    title ??= last.title;
  }
  // A title goes in the entry only when it is given by hand: a changed title.
  const d = describe(raw, { file, version, title, newTitle: arg("title"), reason: arg("reason") });

  if (!d.alreadyCanonical && process.argv.includes("--fix")) {
    writeFileSync(file, d.canonical);
    console.log(`Rewrote ${file} in the canonical form.`);
  } else if (!d.alreadyCanonical) {
    console.log(`NOTE: ${file} is not in the canonical form (stray spaces, CRLF line endings, or the wrong ending).`);
    console.log("      The fingerprint below is still the right one, but publish the canonical file: run again with --fix.");
  }
  console.log("");
  console.log(`Fingerprint  sha256:${d.sha256}`);
  console.log(`Length       ${d.bytes} bytes (canonical)`);
  console.log(`First line   ${d.firstLine}`);
  console.log("");
  console.log("The line members will sign:");
  console.log(`  ${d.statement}`);
  console.log("");
  console.log("Add this to the end of \"declaration_versions\" in your Crowdlock file:");
  console.log(JSON.stringify(d.entry, null, 2).replace(/^/gm, "  "));
}
