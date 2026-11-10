// A Crowdlock's published proposals, as the app and the register page read
// them. Browser-safe (no Node), like the rest of method/js.
//
// The canonical proposal line and its hash are the reference code's in
// method/lock/commitment.mjs, which runs in Node. This file repeats the same
// rules so a phone and a browser can compute the same hash, and
// proposals.test.mjs holds the two to the same bytes. If they ever differ,
// commitment.mjs is right and this file is wrong.
//
// The file format is spec/proposal-and-settlement.md, "Publishing a proposal".

import { sha256 } from "./vendor/noble-hashes/sha256.js";

export const PROPOSALS_FORMAT = "crowdlock-proposals/1";
export const PILE_FORMAT = "crowdlock-commitments/1";

const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 86400 * 1000;

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const utf8 = (s) => new TextEncoder().encode(String(s).normalize("NFC"));

/** The SHA-256 of a proposal's prose: its `document` field. */
export function documentHash(text) {
  return hex(sha256(utf8(text)));
}

/** The canonical line, exactly as method/lock/commitment.mjs builds it. */
export function proposalLine({ instance, destination, requiresMinor, currency, document, opens, closes, settlesBy }) {
  if (!HEX64.test(instance ?? "")) throw new Error("instance must be a 64-character hex declaration hash");
  if (!HEX64.test(document ?? "")) throw new Error("document must be the 64-character hex hash of the proposal's prose");
  if (!Number.isInteger(requiresMinor) || requiresMinor <= 0) {
    throw new Error("requires must be a positive whole number of the currency's minor units");
  }
  if (!/^[A-Z]{3}$/.test(currency ?? "")) {
    throw new Error("currency must be an ISO 4217 three-letter code in capitals, e.g. GBP");
  }
  for (const [name, v] of [["destination", destination], ["opens", opens], ["closes", closes], ["settlesBy", settlesBy]]) {
    if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
    if (/[|\n\r]/.test(v)) throw new Error(`${name} may not contain | or a newline`);
  }
  if (!(Date.parse(opens) < Date.parse(closes))) throw new Error("closes must be after opens");
  if (!(Date.parse(closes) <= Date.parse(settlesBy))) throw new Error("settlesBy must be at or after closes");
  return `${instance}|proposal|${destination}|${requiresMinor}|${currency}|${document}|${opens}|${closes}|${settlesBy}`;
}

/** The hash a commitment names, and the only thing that identifies a proposal. */
export function proposalHash(fields) {
  return hex(sha256(utf8(proposalLine(fields))));
}

/** A published proposal's fields, in the shape proposalLine takes. */
export function fieldsOf(p, instance) {
  return {
    instance, destination: p.destination, requiresMinor: p.requires, currency: p.currency,
    document: documentHash(p.text ?? ""), opens: p.opens, closes: p.closes, settlesBy: p.settles_by,
  };
}

const isoZ = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * Check a proposals file against its Crowdlock. Every proposal's hash is
 * recomputed from its own fields and prose, so a file cannot name one
 * proposal and describe another. Whether its destination is attested and old
 * enough is the destinations list's question, checked when committing.
 *
 * @returns {{ ok: boolean, problems: string[], proposals: any[] }}
 */
export function checkProposals(file, crowdlock) {
  const problems = [];
  const instance = crowdlock?.declaration?.sha256;
  if (file?.format !== PROPOSALS_FORMAT) problems.push(`the proposals file is not ${PROPOSALS_FORMAT}`);
  if (file?.instance !== instance) problems.push("the proposals file belongs to a different Crowdlock");
  const list = Array.isArray(file?.proposals) ? file.proposals : (problems.push("proposals must be a list"), []);
  const seen = new Set();
  const good = [];
  list.forEach((p, i) => {
    const where = `proposal ${i + 1}`;
    const bad = (why) => problems.push(`${where}: ${why}`);
    if (typeof p?.title !== "string" || !p.title.trim()) return bad("it has no title");
    if (typeof p.text !== "string" || !p.text.trim()) return bad("it has no text");
    for (const k of ["opens", "closes", "settles_by"]) {
      if (!isoZ(p[k])) return bad(`${k} must be a UTC time like 2026-12-01T00:00:00Z`);
    }
    let hash;
    try { hash = proposalHash(fieldsOf(p, instance)); } catch (e) { return bad(e.message); }
    if (p.hash !== hash) return bad("its hash is not the hash of its own fields and text");
    if (seen.has(hash)) return bad("it is listed twice");
    const gathering = (Date.parse(p.closes) - Date.parse(p.opens)) / DAY;
    const settling = (Date.parse(p.settles_by) - Date.parse(p.closes)) / DAY;
    if (gathering > crowdlock.gathering_window_max_days) return bad(`it gathers for longer than ${crowdlock.gathering_window_max_days} days`);
    if (settling > crowdlock.settlement_window_max_days) return bad(`it settles for longer than ${crowdlock.settlement_window_max_days} days`);
    const t = p.target;
    if (!t || !Number.isInteger(t.sats) || t.sats <= 0 || typeof t.rate !== "string" || !isoZ(t.at)) {
      return bad("its target must give whole sats, the rate used and when");
    }
    seen.add(hash);
    good.push({ ...p, hash });
  });
  return { ok: problems.length === 0, problems, proposals: good };
}

/**
 * Where a proposal is in its life, at `now` (ms).
 * "soon" — not open yet; "gathering" — commitments may be added;
 * "settling" — closed for new commitments, the co-signer may complete them;
 * "over" — past settles_by: nothing more can happen.
 */
export function phaseOf(p, now = Date.now()) {
  if (now < Date.parse(p.opens)) return "soon";
  if (now < Date.parse(p.closes)) return "gathering";
  if (now <= Date.parse(p.settles_by)) return "settling";
  return "over";
}

/** Where a proposal's pile is published: beside the proposals file. */
export function pilePath(proposalsPath, hash) {
  if (!HEX64.test(hash)) throw new Error("not a proposal's hash");
  const dir = proposalsPath.includes("/") ? proposalsPath.slice(0, proposalsPath.lastIndexOf("/") + 1) : "";
  return `${dir}commitments/${hash}.json`;
}

/** The shape of a pile file, before each commitment in it is verified. */
export function checkPileShape(file, hash) {
  if (file?.format !== PILE_FORMAT) return { ok: false, reason: `the pile is not ${PILE_FORMAT}` };
  if (file.proposal !== hash) return { ok: false, reason: "the pile is for a different proposal" };
  if (!Array.isArray(file.commitments)) return { ok: false, reason: "commitments must be a list" };
  for (const [i, c] of file.commitments.entries()) {
    if (!isoZ(c?.submitted) || typeof c?.record?.tx !== "string" || c.record.proposal !== hash) {
      return { ok: false, reason: `commitment ${i + 1} is not in the pile's format` };
    }
  }
  return { ok: true };
}
