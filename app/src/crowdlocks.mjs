// Loading and checking Crowdlocks. Network code only: nothing here sees a key.
//
// The app has no Crowdlock written into it. It starts from a list of links,
// and a fan can add any other Crowdlock by pasting a link to its file, hosted
// anywhere. Whether from the starting list or pasted in, every Crowdlock is
// checked here with exactly the code the register page uses (method/js/crowdlock.mjs)
// before the app will show it or let anybody sign anything:
//
//   * the file is complete and coherent
//   * its declaration really hashes to the fingerprint the file claims
//   * its register files agree with it about which declaration they are
//
// A Crowdlock that fails is refused, with the reason shown. So the starting
// list is a convenience, not a permission: we decide nothing about which
// Crowdlocks exist.
//
// WHERE A CROWDLOCK'S OTHER FILES ARE. A Crowdlock file is published at
// <site>/crowdlocks/<name>.json, and the paths inside it (declaration, register)
// are relative to <site>/ — that is how this project's own files are laid out.
// A file published anywhere else has its paths read relative to its own folder.

import { checkCrowdlock, checkRegisterFiles, membershipStatement, versionsOf, currentVersion, signedVersions, hasSigned } from "../../method/js/crowdlock.mjs";
import { proposalVersion, stampsFor, destinationHash, relayOnlyCommitments as relayOnly, RELAY_ONLY_PER_LOCK } from "../../method/js/proposals.mjs";
import { checkProposals } from "../../method/js/proposals.mjs";
import { esploraChain, EXPLORERS, BACKUP_EXPLORERS } from "./wallet/esplora.mjs";
import { earlyReleases, readHistory, clocksFor, locksToWatch as watchLocks, locksSeen as seenLocks } from "../../method/js/release.mjs";
import { checkCosignerXpubs, NETWORKS } from "./wallet/core.mjs";
import { lockIsGenuine, hrpFor } from "../../method/js/lockrecord.mjs";

// The prefix a Crowdlock's addresses carry, as the wallet knows its network.
const lockHrp = (crowdlock) => NETWORKS[crowdlock?.network]?.network?.bech32 ?? hrpFor(crowdlock?.network);

// This build's starting list and counting-rule link live in ./build.mjs, the
// one file that differs between builds of the app.
export { STARTING_LIST, COUNTING_RULE_URL, MOVED_ADDRESSES } from "./build.mjs";
import { OWN_DOMAINS, MOVED_ADDRESSES } from "./build.mjs";
import { movedUrl } from "./moves.mjs";

// Links are handled as plain text rather than with URL objects: a phone's
// JavaScript engine has an incomplete URL implementation, and these few rules
// are all that is needed.
const LINK = /^https:\/\/[^\s/?#]+\/[^\s]*$/;
const stripQuery = (u) => u.split(/[?#]/)[0];

/** Where a Crowdlock file's relative paths start from. */
export function baseFor(fileUrl) {
  const u = stripQuery(fileUrl);
  const i = u.lastIndexOf("/crowdlocks/");
  return i >= 0 ? u.slice(0, i + 1) : u.slice(0, u.lastIndexOf("/") + 1);
}

/** A path from inside a Crowdlock file, as a full link. */
export function resolvePath(path, base) {
  const p = String(path ?? "");
  if (/^https:\/\//.test(p)) return p;
  if (p.includes("..") || p.startsWith("/")) throw new Error(`refusing the path ${p}`);
  return base + p;
}

// A Crowdlock's files come from wherever its link points, and Find loads
// every announced Crowdlock without being asked, so a link may be hostile.
// Each file is given a time limit and a size limit: a server that never
// answers, or answers without end, costs one Crowdlock its place on the list
// and nothing else.
const LOAD_LIMIT_MS = 20000;
const SMALL_FILE = 300000;      // a Crowdlock file, a declaration, a proposals file
const REGISTER_FILE = 50000000; // registrations and destinations grow with the members
const MOST_VERSIONS = 50;

/** One file, within the limits: { ok, status, text }. Throws on silence or an oversized file. */
async function getLimited(fetchImpl, u, maxChars, limitMs = LOAD_LIMIT_MS) {
  const stop = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const silence = new Promise((_, reject) => { timer = setTimeout(() => { stop?.abort(); reject(new Error(`${u} didn't answer within ${limitMs / 1000} seconds`)); }, limitMs); });
  try {
    return await Promise.race([silence, (async () => {
      const r = await fetchImpl(u, { cache: "no-store", ...(stop ? { signal: stop.signal } : {}) });
      if (!r.ok) return { ok: false, status: r.status, text: "" };
      const declared = Number(r.headers?.get?.("content-length") ?? 0);
      if (declared > maxChars) throw new Error(`${u} is too large to be what it says it is`);
      const text = await r.text();
      if (text.length > maxChars) throw new Error(`${u} is too large to be what it says it is`);
      return { ok: true, status: r.status, text };
    })()]);
  } finally { clearTimeout(timer); }
}

/**
 * Load a Crowdlock from a link and check it. Never throws: returns
 * { ok: true, url, crowdlock, statement, register } or { ok: false, url, problems }.
 *
 * @returns {Promise<{ ok: true, url: string, crowdlock: any, declarationText: string, versions: any[], statement: string, register: any, destinations: any, proposals: any[], proposalProblems: string[] }
 *                 | { ok: false, url: string, problems: string[] }>}
 */
export async function loadCrowdlock(url, fetchImpl = globalThis.fetch, { limitMs = LOAD_LIMIT_MS } = {}) {
  const fail = (...problems) => ({ ok: false, url, problems });
  const fileUrl = String(url ?? "").trim();
  if (/^http:\/\//i.test(fileUrl)) return fail("a Crowdlock link must start with https://");
  if (!LINK.test(fileUrl)) return fail("that is not a link");

  const getText = async (u, max = SMALL_FILE) => { const r = await getLimited(fetchImpl, u, max, limitMs); if (!r.ok) throw new Error(`${r.status} from ${u}`); return r.text; };
  const getJson = async (u, max = SMALL_FILE) => JSON.parse(await getText(u, max));

  let crowdlock;
  try { crowdlock = await getJson(fileUrl); }
  catch (e) {
    return fail(String(e.message).startsWith("404 ")
      ? "There's no Crowdlock file at that link. Check it was copied in full."
      : `could not load the Crowdlock file: ${e.message}`);
  }

  const base = baseFor(fileUrl);
  let declarationText;
  try { declarationText = await getText(resolvePath(crowdlock?.declaration?.file, base)); }
  catch (e) { return fail(`could not load its declaration: ${e.message}`); }

  // Later versions of its declaration, each checked against its fingerprint.
  const versionTexts = {};
  if (Array.isArray(crowdlock?.declaration_versions) && crowdlock.declaration_versions.length > MOST_VERSIONS) {
    return fail(`it lists more than ${MOST_VERSIONS} versions of its declaration`);
  }
  for (const v of Array.isArray(crowdlock?.declaration_versions) ? crowdlock.declaration_versions : []) {
    try { versionTexts[v.version] = await getText(resolvePath(v.file, base)); }
    catch (e) { return fail(`could not load version ${v?.version} of its declaration: ${e.message}`); }
  }

  const fileCheck = checkCrowdlock(crowdlock, { declarationText, versionTexts });
  // An xpub that doesn't stand for one of its co-signer keys would have a
  // hardware wallet build a lock the register never counts.
  if (fileCheck.ok) { const xc = checkCosignerXpubs(crowdlock); if (!xc.ok) return fail(...xc.problems); }
  if (!fileCheck.ok) return fail(...fileCheck.problems);

  let registrations, destinations;
  try {
    registrations = await getJson(resolvePath(crowdlock.register.registrations, base), REGISTER_FILE);
    destinations = await getJson(resolvePath(crowdlock.register.destinations, base), REGISTER_FILE);
  } catch (e) { return fail(`could not load its register: ${e.message}`); }

  const agree = checkRegisterFiles(crowdlock, { registrations, destinations });
  if (!agree.ok) return fail(...agree.problems);

  // Proposals, if it publishes any. A proposals file that doesn't check is
  // reported, not fatal: the Crowdlock itself is still fine to show.
  let proposals = [], proposalProblems = [];
  if (crowdlock.register.proposals) {
    try {
      const r = await getLimited(fetchImpl, resolvePath(crowdlock.register.proposals, base), SMALL_FILE * 10, limitMs);
      if (r.ok) {
        const pc = checkProposals(JSON.parse(r.text), crowdlock);
        proposals = pc.proposals; proposalProblems = pc.problems;
      } else if (r.status !== 404) proposalProblems = [`could not load its proposals: ${r.status}`];
    } catch (e) { proposalProblems = [`could not load its proposals: ${e.message}`]; }
  }

  // Every version, oldest first, with its text and the line that signs it.
  const versions = versionsOf(crowdlock).map((v, i) => ({
    ...v, text: i === 0 ? declarationText : versionTexts[v.version], statement: membershipStatement(crowdlock, v.version),
  }));
  return {
    ok: true,
    url: fileUrl,
    crowdlock,
    // The current version's text: the words a new member signs.
    declarationText: versions[versions.length - 1].text,
    versions,
    statement: membershipStatement(crowdlock),
    register: registrations,
    destinations,
    proposals,
    proposalProblems,
  };
}

// ---------------------------------------------------------------------------
// Sharing a Crowdlock
//
// crowdlock://add?url=<the Crowdlock file's link> opens this app straight onto
// that Crowdlock, checked like any other before it is shown. A phone's own
// camera reads it from a QR code; a web page can use it as a button. It only
// ever carries a link — the app decides nothing from it but where to look.
// ---------------------------------------------------------------------------

/** The app link that opens a Crowdlock in the app. */
export function openLinkFor(fileUrl) {
  return `crowdlock://add?url=${encodeURIComponent(fileUrl)}`;
}

/** The Crowdlock file link inside an app link, or null if it isn't one. */
export function fileUrlFromOpenLink(link) {
  const m = /^crowdlock:\/\/add\?url=([^&#\s]+)/i.exec(String(link ?? "").trim());
  if (!m) return null;
  let u;
  try { u = decodeURIComponent(m[1]); } catch { return null; }
  // A link shared before a Crowdlock moved still opens it, at its new address.
  return LINK.test(u) ? movedUrl(u, MOVED_ADDRESSES) : null;
}

/** Where to send people when sharing: the Crowdlock's own page if it names one, else its site. */
export function shareLinkFor(loaded) {
  const site = loaded.crowdlock?.site;
  return typeof site === "string" && /^https:\/\//.test(site) ? site : baseFor(loaded.url);
}

/**
 * A newer version of the declaration this member hasn't signed: what to show
 * them, or null. `previous` is the newest version they have signed, and
 * `changes` compares its lines with the current version's.
 */
export function newVersionToSign(loaded, address) {
  if (!loaded?.ok) return null;
  const me = membershipOf(loaded.register, address);
  if (!me) return null;
  const cur = currentVersion(loaded.crowdlock);
  if (hasSigned(loaded.crowdlock, me, cur.version)) return null;
  const mine = signedVersions(loaded.crowdlock, me);
  const previous = loaded.versions.find((v) => v.version === mine[mine.length - 1]) ?? loaded.versions[0];
  const current = loaded.versions.find((v) => v.version === cur.version);
  return { current, previous, changes: lineChanges(previous.text ?? "", current.text ?? "") };
}

/** The newest version of the declaration this member has signed, with its text. */
export function versionSignedBy(loaded, member) {
  const mine = signedVersions(loaded.crowdlock, member);
  return loaded.versions.find((v) => v.version === mine[mine.length - 1]) ?? loaded.versions[0];
}

/** May this member commit to this proposal? Only with the version it was published under. */
export function mayCommitTo(loaded, member, proposal) {
  return !!member && hasSigned(loaded.crowdlock, member, proposalVersion(proposal, loaded.crowdlock));
}

/**
 * Old against new, line by line: [{ kind: "same" | "gone" | "new", text }].
 * The longest run of lines the two share is kept as "same"; everything else
 * is a line taken out or put in. Plain and small on purpose: a declaration is
 * a page, not a codebase.
 * @returns {{ kind: "same" | "gone" | "new", text: string }[]}
 */
export function lineChanges(oldText, newText) {
  const a = String(oldText).replace(/\n$/, "").split("\n"), b = String(newText).replace(/\n$/, "").split("\n");
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: "gone", text: a[i++] });
    else out.push({ kind: "new", text: b[j++] });
  }
  while (i < n) out.push({ kind: "gone", text: a[i++] });
  while (j < m) out.push({ kind: "new", text: b[j++] });
  return out;
}

/** Is this address a member, and which number? */
export function membershipOf(register, address) {
  const a = String(address).toLowerCase();
  return (register.members ?? []).find((m) => String(m.address).toLowerCase() === a) ?? null;
}

/**
 * Where the app reads the chain for a Crowdlock: its own block explorer for
 * the Crowdlock's network (with its backup), and never the address the
 * Crowdlock's file names as `chain_api`. A total is only worth showing if
 * nobody with something to gain chose who counted it: a founder who could
 * name the explorer could name one of their own that reports locks which
 * don't exist, and hides the releases the co-signer's record is there to show.
 * Throws for a network this app has no explorer for.
 */
export function explorerFor(crowdlock) {
  const api = EXPLORERS[crowdlock?.network];
  if (!api) throw new Error(`this app has no block explorer for the ${crowdlock?.network} network`);
  return api;
}
const chainFor = (crowdlock, fetchImpl) => {
  const api = explorerFor(crowdlock);
  return esploraChain(api, fetchImpl, undefined, { backup: BACKUP_EXPLORERS[api] ?? "" });
};

/**
 * The committed total, by the counting rule: confirmed coins at every lock
 * whose date is still ahead and which meets the minimum. Read from the app's
 * own explorer (see explorerFor), never from anything the register or the
 * Crowdlock's file claims.
 *
 * The only count of people it gives is committed members: members holding at
 * least one lock that counts. A count of signatures is never shown, because a
 * signature costs nothing to make; anyone who wants that number can count the
 * published register.
 */
export async function committedTotal(loaded, fetchImpl = globalThis.fetch, now = Math.floor(Date.now() / 1000)) {
  const { crowdlock, register } = loaded;
  const chain = chainFor(crowdlock, fetchImpl);
  const seen = new Set();
  const committed = new Set();
  let sats = 0n, counted = 0, notLocks = 0;
  for (const lock of register.locks ?? []) {
    const address = String(lock.address).toLowerCase();
    if (seen.has(address) || !(lock.locktime > now)) continue;
    seen.add(address);
    // A register is a file, and a file can say anything: a record only counts
    // if it really is a lock of this Crowdlock (its address is the lock its
    // terms make, co-signed by this Crowdlock). The chain is not asked about
    // one that isn't.
    const genuine = lockIsGenuine(lock, { crowdlock, register, hrp: lockHrp(crowdlock) });
    if (!genuine.ok) { notLocks++; continue; }
    const coins = (await chain.utxos(lock.address)).filter((c) => c.confirmed);
    const total = coins.reduce((s, c) => s + BigInt(c.value), 0n);
    if (total >= BigInt(crowdlock.minimum_counted_lock_sats)) {
      sats += total; counted++;
      // Its owner, worked out from the lock's own key and not read from the
      // record's label, is a committed member if they are a member at all.
      if (genuine.member) committed.add(genuine.owner);
    }
  }
  return { sats, locks: counted, members: committed.size, notLocks };
}

const CLOSED_AFTER = 3 * 3600;
const closedRecords = new Map();

/**
 * The co-signer's record: every lock on the register that the co-signer helped
 * open before its date, other than for a purchase (method/js/release.mjs: every
 * output a listed destination, money staying locked, or a marker). Read from the
 * chain alone. Which locks it reads about comes from the register and from
 * `remembered`, the locks this phone saw on the register before (locksSeen):
 * a lock taken off the register is still read, and counted in `gone`.
 * Returns { releases: [{ address, member, txid, at, sats, paidTo, confirmed, cosigner, removed? }], unreadable, gone }.
 * @param {any} loaded
 * @param {any} [fetchImpl]
 * @param {number} [now]
 * @param {{ remembered?: any }} [options]
 */
export async function coSignerRecord(loaded, fetchImpl = globalThis.fetch, now = Math.floor(Date.now() / 1000), { remembered = null } = {}) {
  const { crowdlock, register, destinations } = loaded;
  const chain = chainFor(crowdlock, fetchImpl);
  const seen = new Set();
  const releases = [];
  let unreadable = 0;
  // A payment counts as a purchase only to a destination stamped on the
  // chain, so the stamps are read once for the whole page.
  const entries = destinations?.entries ?? [];
  let stamps = {};
  try { stamps = await stampsFor(entries, [...new Set(entries.filter((e) => e.op === "add").map((e) => e.address))], (id) => chain.tx(id)); } catch {}
  // Every genuine lock on the register, and every lock this phone saw there
  // before that has since gone from it (not a lock of this Crowdlock, and
  // never seen as one: nothing of the co-signer's to record).
  const watched = locksToWatch(loaded, remembered);
  for (const lock of watched.locks) {
    const address = String(lock.address).toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    try {
      // Only a spend before the lock's date can be a release, so once a lock is
      // well past its date its record is closed: what was read then is kept for
      // as long as the app is open, and a page doesn't re-ask about every lock
      // the register has ever held. (The margin covers how far a block's own
      // time can sit from the real time.)
      const key = `${explorerFor(crowdlock)} ${address}`;
      const closed = lock.locktime + CLOSED_AFTER < now;
      let txs = closed ? closedRecords.get(key) : undefined;
      if (!txs) {
        // The whole history: a release can't be pushed out of sight by
        // small payments to the lock's address after it.
        const h = await readHistory(() => chain.txs(lock.address), (last) => chain.txsAfter(lock.address, last));
        txs = h.txs;
        if (!h.complete) unreadable++;
        else if (closed) closedRecords.set(key, txs);
      }
      // The network's clock for spends in blocks stamped just after the date.
      const clocks = await clocksFor(lock, txs, (h) => chain.block(h));
      let undecided = false;
      for (const r of earlyReleases(lock, txs, { destinations: destinations ?? null, crowdlock, register, stamps, clocks, hrp: lockHrp(crowdlock) }, now)) {
        if (r.undecided) { undecided = true; continue; }
        releases.push({ address: lock.address, member: lock.member ?? null, ...r, ...(lock.removed ? { removed: true } : {}) });
      }
      if (undecided) unreadable++;
    } catch { unreadable++; }
  }
  // `rewritten`: the locks this phone saw before are not all still there as
  // they were. Then the record cannot be called clean, whatever it found.
  return { releases, unreadable, gone: watched.gone.length, rewritten: watched.rewritten };
}

// ---------------------------------------------------------------------------
// Locks this phone has seen on a register, and commitments that are only on
// the relays (security loop, 17 November 2026). The rules are the method's
// own (method/js/release.mjs, method/js/proposals.mjs), shared with the
// website; here they are given the app's address prefix for the network.
// ---------------------------------------------------------------------------

/** The locks to read the co-signer's record for: the register's, and those this phone saw there before. */
export function locksToWatch(loaded, remembered = null) {
  return watchLocks({ crowdlock: loaded.crowdlock, register: loaded.register, remembered, hrp: lockHrp(loaded.crowdlock) });
}

/** What this phone remembers of a register's locks now: their terms. */
export function locksSeen(loaded, remembered = null) {
  return seenLocks({ crowdlock: loaded.crowdlock, register: loaded.register, remembered, hrp: lockHrp(loaded.crowdlock) });
}

export { RELAY_ONLY_PER_LOCK };

/** Of what the relays hold for a proposal, what this phone goes on to check. */
export function relayOnlyCommitments(found, { crowdlock, register, inPile = new Set() }) {
  return relayOnly(found, { crowdlock, register, inPile, hrp: lockHrp(crowdlock) });
}

// ---------------------------------------------------------------------------
// Copies (security loop, 17 November 2026).
//
// A lock counts for the Crowdlock whose co-signer key it names. Nothing stops
// a second Crowdlock's file naming the same key, or the same declaration, and
// every lock of the first then counts for the copy too: a stranger's file
// showed The Kop Fund's locked bitcoin and members as its own, level with it
// in Find. Which of two such files is the real one cannot be read from the
// files. So: one the app or the person already has is believed over one that
// is merely announced, and where neither is, both are marked.
// ---------------------------------------------------------------------------

/**
 * Mark the copies among found Crowdlocks.
 *   items    [{ url, name, sats, members, declaration, cosigners }]
 *   trusted  links the app ships with, or the person has already added
 * Returns the items with:
 *   copyOf   the name of a trusted Crowdlock it shares a declaration or a
 *            co-signer key with. Its locked total is that Crowdlock's, so it
 *            is shown as nothing.
 *   sharesWith  the name of another found Crowdlock it shares one with,
 *            where neither is trusted: the totals stand, with a warning.
 */
export function markCopies(items, trusted = []) {
  const keysOf = (it) => [`d:${it.declaration}`, ...(it.cosigners ?? []).map((k) => `k:${String(k).slice(2).toLowerCase()}`)];
  const believed = new Map();
  for (const it of items) if (trusted.includes(it.url)) for (const k of keysOf(it)) if (!believed.has(k)) believed.set(k, it);
  const firstSeen = new Map();
  return items.map((it) => {
    if (trusted.includes(it.url)) return it;
    const keys = keysOf(it);
    const real = keys.map((k) => believed.get(k)).find(Boolean);
    if (real) return { ...it, sats: 0n, members: 0, copyOf: real.name };
    const other = keys.map((k) => firstSeen.get(k)).find((x) => x && x.url !== it.url);
    for (const k of keys) if (!firstSeen.has(k)) firstSeen.set(k, it);
    return other ? { ...it, sharesWith: other.name } : it;
  }).map((it, _i, all) => {
    // The first of an untrusted pair is marked too, once its pair is known.
    if (it.copyOf || it.sharesWith || trusted.includes(it.url)) return it;
    const keys = new Set(keysOf(it));
    const pair = all.find((x) => x.url !== it.url && !trusted.includes(x.url) && keysOf(x).some((k) => keys.has(k)));
    return pair ? { ...it, sharesWith: pair.name } : it;
  });
}


/**
 * The Crowdlock counting rule, where it explains the minimum. The rule is one
 * of the method's general documents, the same for every Crowdlock; only the
 * minimum's size is each Crowdlock's own (minimum_counted_lock_sats).
 */

/**
 * Pounds per bitcoin right now, for an indicative figure only — never a
 * headline, never stored. Real bitcoin only: test coins have no value.
 * Returns a number, or null if there is no honest figure to give.
 */
export async function poundsPerBtc(crowdlock, fetchImpl = globalThis.fetch) {
  if (crowdlock.network !== "mainnet") return null;
  try {
    const r = await fetchImpl(`${EXPLORERS.mainnet}/v1/prices`, { cache: "no-store" });
    const gbp = (await r.json()).GBP;
    return typeof gbp === "number" && gbp > 0 ? gbp : null;
  } catch { return null; }
}

/** "0.002 BTC" — a minimum written without the trailing zeros. */
export function shortBtc(sats) {
  const v = BigInt(sats);
  const frac = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${v / 100000000n}${frac ? "." + frac : ""} BTC`;
}

/**
 * This member's locks on the register, as the app's lock terms. Only records
 * that really are a lock of this Crowdlock whose owner key is this member's
 * own: the address is rebuilt from the terms, and the owner is worked out
 * from the key, never read from the record's `member` label. Until
 * 17 November 2026 the label was believed, so a register could show any
 * funded address as a member's lock, or a member's real lock with another
 * date, which then could not be taken home from the app.
 */
export function locksOnRegister(register, memberAddress, crowdlock) {
  const a = String(memberAddress).toLowerCase();
  return (register.locks ?? [])
    .filter((l) => { const g = lockIsGenuine(l, { crowdlock, register, hrp: lockHrp(crowdlock) }); return g.ok && g.owner === a; })
    .map((l) => ({ address: String(l.address).toLowerCase(), locktime: l.locktime, cosignerPubkey: l.cosigner_pubkey }));
}

// ---------------------------------------------------------------------------
// A Crowdlock's destination rules, as this phone last saw them
//
// Who attests a destination, how many must, how long one waits, and the
// destinations list itself are all whatever the Crowdlock's repository says
// today. Whoever can write to it could name an attestor of their own, set the
// wait to none, or cut a revocation off the end of the list. So the phone
// keeps what it saw, says when any of it changes, and pauses committing and
// co-signing until the person has looked (second review, 17 November 2026).
// ---------------------------------------------------------------------------

/** What this phone remembers of a loaded Crowdlock's destination rules. */
export function rulesOf(loaded) {
  const c = loaded?.crowdlock ?? {};
  const entries = Array.isArray(loaded?.destinations?.entries) ? loaded.destinations.entries : [];
  let head = null;
  try { head = entries.length ? destinationHash(entries[entries.length - 1]) : null; } catch { head = "unreadable"; }
  return {
    attestors: [...(c.attestor_keys ?? [])].map((k) => String(k).toLowerCase()).sort(),
    threshold: c.attestor_threshold ?? null,
    wait: c.destination_wait_days ?? null,
    entries: entries.length,
    head,
    hashes: entries.map((e) => { try { return destinationHash(e); } catch { return "unreadable"; } }),
    // Two more numbers the file's writer could change unseen (security loop,
    // round 3): the largest fee a commitment may leave, which also decides
    // what the early-release record lets pass as a purchase; and each
    // proposal's target, which is outside its hash and decides "the target
    // is met" and whether the co-signer's button is live.
    fee: typeof c.max_commitment_fee === "number" ? c.max_commitment_fee : null,
    targets: Object.fromEntries((Array.isArray(loaded?.proposals) ? loaded.proposals : [])
      .filter((p) => typeof p?.hash === "string" && Number.isInteger(p?.target?.sats))
      .map((p) => [p.hash, p.target.sats])),
    titles: Object.fromEntries((Array.isArray(loaded?.proposals) ? loaded.proposals : [])
      .filter((p) => typeof p?.hash === "string").map((p) => [p.hash, String(p.title ?? "a proposal").slice(0, 60)])),
  };
}

/**
 * What to remember when nothing changed: the rules as they are now, with
 * each proposal's target kept at the HIGHEST this phone has seen. A target is
 * restated as the price moves, so a small fall is ordinary; remembering the
 * highest means one walked down in small steps is still noticed.
 */
export function rulesKept(seen, now) {
  const targets = { ...(now.targets ?? {}) };
  for (const [hash, sats] of Object.entries(seen?.targets ?? {})) if (hash in targets && sats > targets[hash]) targets[hash] = sats;
  return { ...now, targets };
}

/**
 * What changed since `seen` (null the first time: nothing to compare).
 * Returns { changed, notes }: one plain sentence per change. Adding entries
 * to the end of the list is how it grows and is not a change.
 */
export function rulesChanges(seen, now) {
  if (!seen || typeof seen !== "object") return { changed: false, notes: [] };
  const notes = [];
  const added = now.attestors.filter((k) => !(seen.attestors ?? []).includes(k));
  const removed = (seen.attestors ?? []).filter((k) => !now.attestors.includes(k));
  for (const k of added) notes.push(`An attestor was added: ${k.slice(0, 10)}…${k.slice(-8)}. An attestor approves where committed money may be paid.`);
  for (const k of removed) notes.push(`An attestor was removed: ${k.slice(0, 10)}…${k.slice(-8)}.`);
  if (seen.threshold !== now.threshold) notes.push(`The number of attestors a destination needs went from ${seen.threshold} to ${now.threshold}.`);
  if (seen.wait !== now.wait) notes.push(`The waiting period before a new destination can be paid went from ${seen.wait} to ${now.wait} days.`);
  const kept = (seen.hashes ?? []).every((h, i) => now.hashes[i] === h);
  if (now.entries < (seen.entries ?? 0)) notes.push(`The destinations list is shorter than when you last looked (${now.entries} entries, was ${seen.entries}). Nothing is ever meant to be taken off it: a revocation may have been removed.`);
  else if (!kept) notes.push("An earlier entry in the destinations list has been rewritten. Nothing on it is ever meant to change.");
  // Only where this phone has something to compare: rules remembered before
  // these two were kept say nothing about them.
  if ("fee" in seen && seen.fee !== now.fee) {
    const pc = (v) => (typeof v === "number" ? `${+(v * 100).toFixed(4)}%` : "not set");
    notes.push(`The largest network fee a commitment may leave went from ${pc(seen.fee)} to ${pc(now.fee)} of what it commits. The same limit decides what the co-signer's record lets pass as a purchase.`);
  }
  for (const [hash, was] of Object.entries(seen.targets ?? {})) {
    const is = now.targets?.[hash];
    if (Number.isInteger(is) && is * 2 < was) {
      notes.push(`The target of "${now.titles?.[hash] ?? "a proposal"}" was cut from ${was} to ${is} sats, to less than half. A target is restated as the price moves, but not by that much: with a lower target, far less has to be committed before the co-signer completes.`);
    }
  }
  return { changed: notes.length > 0, notes };
}

/**
 * Put a lock on the Crowdlock's register, through its lock endpoint. Needs the
 * lock's money to have confirmed. Returns { ok: true } or { ok: false, error }.
 * "Already on the register" counts as success.
 */
export async function submitLock(crowdlock, { ownerPubkey, cosignerPubkey, locktime, address }, fetchImpl = globalThis.fetch) {
  if (!crowdlock.lock_endpoint) {
    return { ok: false, error: "this Crowdlock has no lock endpoint — submit the lock by pull request instead" };
  }
  try {
    const res = await fetchImpl(crowdlock.lock_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner_pubkey: ownerPubkey, cosigner_pubkey: cosignerPubkey, locktime, address }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true };
    if (res.status === 409 && /already on the register/.test(body.error ?? "")) return { ok: true };
    return { ok: false, error: body.error ?? `the register answered ${res.status}` };
  } catch {
    return { ok: false, error: "could not reach the register — the lock is safe, it will be tried again" };
  }
}

/**
 * Send a signed registration to the Crowdlock's join endpoint.
 * Returns { ok: true, n } or { ok: false, error }.
 */
export async function submitJoin(crowdlock, { address, signature }, fetchImpl = globalThis.fetch) {
  if (!crowdlock.join_endpoint) {
    return { ok: false, error: "this Crowdlock has no join endpoint — submit your registration by pull request instead" };
  }
  try {
    const res = await fetchImpl(crowdlock.join_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true, n: body.n };
    return { ok: false, error: body.error ?? `the register answered ${res.status}`, alternative: body.alternative };
  } catch {
    return { ok: false, error: "could not reach the register — your signature is fine, try again in a moment" };
  }
}

/**
 * Order found Crowdlocks the way the register counts: committed bitcoin
 * first, then committed members, then name. Neither can be faked by
 * announcing, so a flood of junk announcements sinks to the bottom.
 */
export function rankFound(items) {
  return [...items].sort((a, b) =>
    (b.sats > a.sats ? 1 : b.sats < a.sats ? -1 : 0) || (b.members - a.members) || String(a.name).localeCompare(String(b.name)));
}

/** Does a found Crowdlock match what was typed in the search box? */
export function matchesSearch(item, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return `${item.name} ${item.about ?? ""}`.toLowerCase().includes(q);
}

/**
 * The GitHub repository behind a Crowdlock published on GitHub Pages, from
 * its file's link — or null if it isn't hosted that way.
 */
/**
 * The co-signer key new locks name: the newest in the list. Older keys stay
 * listed so the locks already naming them keep counting.
 */
export function newestCosigner(crowdlock) {
  const keys = crowdlock?.cosigner_keys ?? [];
  return keys.length ? keys[keys.length - 1] : undefined;
}

/**
 * What changed in a Crowdlock's co-signer keys since this phone last looked.
 * `seen` is the list it saw then, or null the first time (nothing to compare,
 * so nothing to warn about). Compared on the x-coordinate, as the checks are.
 */
export function keyChanges(seen, now, expected = []) {
  if (!Array.isArray(seen)) return { added: [], removed: [], changed: false };
  const x = (list) => new Set((list ?? []).map((k) => String(k).toLowerCase().slice(2)));
  // `expected` is a key this phone added itself: no warning when it appears,
  // and none while the website hasn't caught up with it yet either.
  const before = x([...seen, ...(expected ?? [])]), after = x(now);
  const added = (now ?? []).filter((k) => !before.has(String(k).toLowerCase().slice(2)));
  const removed = seen.filter((k) => !after.has(String(k).toLowerCase().slice(2)));
  return { added, removed, changed: added.length + removed.length > 0 };
}

/** The public history of a Crowdlock's file on GitHub, where any key change shows who made it. */
export function historyLinkFor(fileUrl) {
  const where = repoFromFileUrl(fileUrl), path = pathInRepo(fileUrl);
  return where && path ? `https://github.com/${where.owner}/${where.repo}/commits/main/${path}` : null;
}

/** Where a Crowdlock's file sits inside its repository, from its link. */
export function pathInRepo(fileUrl, domains = OWN_DOMAINS) {
  const u = String(fileUrl ?? "");
  const site = ownDomainOf(u, domains);
  if (site) { const rest = u.slice(site.length).split(/[?#]/)[0]; return rest ? decodeURIComponent(rest) : null; }
  const m = /^https:\/\/[a-z0-9-]+\.github\.io\/[A-Za-z0-9._-]+\/(.+)$/i.exec(u);
  return m ? decodeURIComponent(m[1].split(/[?#]/)[0]) : null;
}

/** The GitHub repository behind a Crowdlock file's link: from a github.io address, or a site on its own domain the build knows. */
export function repoFromFileUrl(fileUrl, domains = OWN_DOMAINS) {
  const site = ownDomainOf(String(fileUrl ?? ""), domains);
  if (site) return { ...domains[site] };
  const m = /^https:\/\/([a-z0-9-]+)\.github\.io\/([A-Za-z0-9._-]+)\//i.exec(String(fileUrl ?? ""));
  return m ? { owner: m[1], repo: m[2] } : null;
}

function ownDomainOf(u, domains) {
  return Object.keys(domains ?? {}).find((site) => u.startsWith(site)) ?? null;
}

/**
 * What a Crowdlock's published inbox version means, given the app's.
 *   "source"   The Crowdlock method's reference repository, where this code is written — never offered an update
 *   "current"  up to date
 *   "behind"   an update is available
 *   "unknown"  not made by the app
 * `published` is the text of its method/relay/VERSION, or null if there is none.
 */
export function versionStatus(published, appVersion, hasInbox) {
  const v = typeof published === "string" ? published.trim() : null;
  if (v === "source") return "source";
  if (v === null) return hasInbox ? "behind" : "unknown";   // made before versions existed
  return v >= appVersion ? "current" : "behind";
}

/** The changes a Crowdlock on `published` would get by updating. */
export function changesSince(published, changes) {
  const v = typeof published === "string" ? published.trim() : "";
  return changes.filter((c) => c.version > v);
}
