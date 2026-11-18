// The build workflows, read as text: a job that runs code from npm or Gradle
// must not hold a token that can write to the repository, or the signing key.
//
// Any token that can write a repository's contents can delete and re-create
// its releases, the real-bitcoin app's ("app-mainnet") among them. Until
// 17 November 2026 the test build ran every library it installed with such a
// token (security loop, round 1). This cannot prove a workflow safe; it fails
// when the one mistake found comes back.
//
// Run: node method/js/workflows.test.mjs

import { readFileSync } from "node:fs";

let failures = 0;
const check = (what, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${what.padEnd(72)} ${detail}`); };
const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** A workflow's jobs, as { name: text }, and what comes before them. */
function jobsOf(text) {
  const at = text.indexOf("\njobs:\n");
  const head = text.slice(0, at), body = text.slice(at + 7);
  const jobs = {};
  let name = null;
  for (const line of body.split("\n")) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; jobs[name] = ""; } else if (name) jobs[name] += line + "\n";
  }
  return { head, jobs };
}
const strip = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const canWrite = (t) => /contents:\s*write/.test(strip(t));
const runsLibraries = (t) => /\bnpm (ci|install|test)\b|\bnpx \b|gradlew/.test(strip(t));
const usesSecrets = (t) => /secrets\./.test(strip(t));
const checkoutsKeepToken = (t) => {
  const s = strip(t);
  return [...s.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?:\s+with:\n(?:\s{10,}[^\n]*\n)*)?)/g)].some((m) => !/persist-credentials:\s*false/.test(m[1]));
};

for (const name of ["app.yml", "app-mainnet.yml"]) {
  const { head, jobs } = jobsOf(read(name));
  check(`${name}: the workflow's own token can only read`, !canWrite(head));
  for (const [job, text] of Object.entries(jobs)) {
    if (runsLibraries(text)) {
      check(`${name}: "${job}" runs libraries, so its token can only read`, !canWrite(text));
      check(`${name}: "${job}" runs libraries, so it is handed no secrets`, !usesSecrets(text));
      check(`${name}: "${job}" does not leave its token on disk for them`, !checkoutsKeepToken(text));
    }
    if (canWrite(text) || usesSecrets(text)) {
      check(`${name}: "${job}" can publish, so it runs no libraries`, !runsLibraries(text));
      check(`${name}: "${job}" can publish, so any checkout keeps no token`, !checkoutsKeepToken(text));
    }
  }
}
{
  const { jobs } = jobsOf(read("app-mainnet.yml"));
  check("app-mainnet.yml: only the signing job is in the real-bitcoin environment",
    /environment:\s*real-bitcoin/.test(strip(jobs.sign ?? "")) && !/environment:/.test(strip(jobs.build ?? "")));
  check("app-mainnet.yml: it is started by hand only", /\non:\n  workflow_dispatch:\n/.test(read("app-mainnet.yml")) && !/\n  push:/.test(strip(read("app-mainnet.yml"))));
}

// Every action, in every workflow here and in the template a Crowdlock copies,
// is pinned to an exact commit: a version tag can be moved to other code
// (security loop, "Needs James" item 11, 18 November 2026).
{
  const { readdirSync } = await import("node:fs");
  const dirs = [new URL("../../.github/workflows/", import.meta.url), new URL("../../app/template/", import.meta.url)];
  for (const dir of dirs) for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
    const t = readFileSync(new URL(f, dir), "utf8");
    const loose = [...t.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]).filter((u) => !/@[0-9a-f]{40}$/.test(u));
    check(`${f}: every action pinned to a commit`, loose.length === 0, loose.join(" "));
  }
}
// A published app is never replaced in place: each build is a new release
// with a tag of its own, so immutable releases can protect every one.
for (const name of ["app.yml", "app-mainnet.yml"]) {
  const t = strip(read(name));
  check(`${name}: each build is a new release, made as a draft first`, /gh release create "\$tag"[^\n]*\\\n(?:[^\n]*\\\n)*\s*--draft/.test(t) && /gh release edit "\$tag" --draft=false/.test(t));
}

console.log("-".repeat(80));
console.log(failures === 0 ? "No job that runs libraries can write to the repository or see a secret." : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
