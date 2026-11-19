import { Buffer } from "buffer";
// Setting up a founder's Crowdlock in their own GitHub account. Network code
// only: no bitcoin key passes through here.
//
// Sign-in is GitHub's device flow: the app shows a short code, the founder
// enters it at github.com/login/device in any browser and allows "Crowdlock",
// and GitHub hands this phone a permission that lasts a few hours. No server
// of ours is involved and no secret is needed. The permission is used for the
// minute it takes to create the repository, kept in memory only, and never
// saved.

export const CLIENT_ID = "Ov23li5lTD1JhdYTsd63";
// public_repo: create a public repository and write its files and site.
// workflow: write the relay inbox's job file, which GitHub guards separately.
export const SCOPES = "public_repo workflow";

const API = "https://api.github.com";

/** Ask GitHub for a sign-in code. Returns { userCode, verificationUri, deviceCode, interval, expiresIn }. */
export async function startSignIn(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok || !b.device_code) throw new Error(b.error_description ?? "GitHub didn't give a sign-in code — try again in a moment");
  return { userCode: b.user_code, verificationUri: b.verification_uri, deviceCode: b.device_code, interval: b.interval ?? 5, expiresIn: b.expires_in ?? 900 };
}

/**
 * Wait for the founder to allow the app. Resolves with the access token, or
 * throws if they decline or the code expires. `sleep` is injectable for tests.
 */
export async function waitForSignIn({ deviceCode, interval, expiresIn }, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let wait = interval;
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(wait * 1000);
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const b = await res.json().catch(() => ({}));
    if (b.access_token) return b.access_token;
    if (b.error === "authorization_pending") continue;
    if (b.error === "slow_down") { wait = (b.interval ?? wait + 5); continue; }
    if (b.error === "access_denied") throw new Error("You chose not to allow Crowdlock on GitHub, so nothing was created.");
    if (b.error === "expired_token") break;
    throw new Error(b.error_description ?? "GitHub refused the sign-in");
  }
  throw new Error("The sign-in code ran out. Start again for a new one.");
}

function client(token, fetchImpl) {
  return async (method, path, body, ok = [200, 201, 204]) => {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!ok.includes(res.status)) {
      const e = new Error(json?.message ?? `GitHub answered ${res.status}`);
      e.status = res.status; e.body = json;
      throw e;
    }
    return json;
  };
}

/** Who is signed in, and is a repository of this name free? */
export async function whoAmI(token, repoName, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const me = await gh("GET", "/user");
  let taken = true;
  try { await gh("GET", `/repos/${me.login}/${repoName}`); } catch (e) { if (e.status === 404) taken = false; else throw e; }
  return { login: me.login, taken };
}

/** Write files to a repository's main branch as one commit. Returns the commit's sha. */
async function commitFiles(gh, owner, repo, files, message) {
  const head = await gh("GET", `/repos/${owner}/${repo}/git/ref/heads/main`);
  const base = await gh("GET", `/repos/${owner}/${repo}/git/commits/${head.object.sha}`);
  const tree = await gh("POST", `/repos/${owner}/${repo}/git/trees`, {
    base_tree: base.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  const commit = await gh("POST", `/repos/${owner}/${repo}/git/commits`, { message, tree: tree.sha, parents: [head.object.sha] });
  await gh("PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: commit.sha });
  return commit.sha;
}

/**
 * Create the Crowdlock: a public repository in the founder's account holding
 * every file, in one commit; its site switched on; its relay inbox started.
 * `files` is { path: text }. `progress(step)` is told each step as it starts.
 * Returns { owner, repo, siteBase, repoUrl }.
 */
export async function createCrowdlockRepo({ token, repoName, description, files, progress = () => {} }, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const gh = client(token, fetchImpl);
  const me = await gh("GET", "/user");
  const owner = me.login;

  progress("Creating the repository in your account");
  // auto_init gives the repository its first commit, which GitHub needs before
  // files can be added in one go.
  await gh("POST", "/user/repos", { name: repoName, description, private: false, auto_init: true, has_wiki: false, has_projects: false });

  let ready = false;
  for (let i = 0; i < 10 && !ready; i++) {
    try { await gh("GET", `/repos/${owner}/${repoName}/git/ref/heads/main`); ready = true; }
    catch (e) { if (e.status !== 404 && e.status !== 409) throw e; await sleep(1500); }
  }
  if (!ready) throw new Error("GitHub made the repository but it isn't ready yet — try again in a minute");

  progress("Writing the declaration, register and inbox");
  await commitFiles(gh, owner, repoName, files,
    "Start this Crowdlock\n\nSet up by the Crowdlock app: the declaration, an empty register, a plain front page, and the relay inbox that collects members' registrations and locks.");

  progress("Switching on its website");
  try { await gh("POST", `/repos/${owner}/${repoName}/pages`, { source: { branch: "main", path: "/" } }); }
  catch (e) { if (e.status !== 409) throw e; }   // 409: already on

  progress("Starting its relay inbox");
  let started = false;
  for (let i = 0; i < 6 && !started; i++) {
    try { await gh("POST", `/repos/${owner}/${repoName}/actions/workflows/relay-inbox.yml/dispatches`, { ref: "main" }); started = true; }
    catch (e) { if (e.status !== 404 && e.status !== 422) throw e; await sleep(3000); }   // the job file can take a moment to register
  }

  return {
    owner, repo: repoName, inboxStarted: started,
    siteBase: `https://${owner.toLowerCase()}.github.io/${repoName}/`,
    repoUrl: `https://github.com/${owner}/${repoName}`,
  };
}

// ---------------------------------------------------------------------------
// Looking after a Crowdlock: updates and maintainers
//
// Only people GitHub lets write to the repository — its founder and the
// maintainers they add — can do either. Nobody else's sign-in can, and the
// app does not pretend otherwise.
// ---------------------------------------------------------------------------

/** Can the signed-in person write to this repository? */
export async function canWrite(token, owner, repo, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  try {
    const r = await gh("GET", `/repos/${owner}/${repo}`);
    return !!(r.permissions?.push || r.permissions?.admin || r.permissions?.maintain);
  } catch (e) { if (e.status === 404) return false; throw e; }
}

/**
 * Bring a Crowdlock's inbox up to date: the template's files written in one
 * commit whose message lists what changed. The Crowdlock's own files — its
 * declaration, register and settings — are never touched.
 */
export async function updateCrowdlockRepo({ token, owner, repo, files, message }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const sha = await commitFiles(gh, owner, repo, files, message);
  // Restart the inbox on the new code; if it is mid-run, it picks the new code
  // up at its next run anyway.
  try { await gh("POST", `/repos/${owner}/${repo}/actions/workflows/relay-inbox.yml/dispatches`, { ref: "main" }); } catch {}
  return sha;
}

/**
 * Invite someone to be a maintainer. GitHub emails them; they accept. Returns
 * "invited", or "already" if they already have access.
 */
export async function addMaintainer({ token, owner, repo, username }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const who = String(username ?? "").trim().replace(/^@/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(who)) throw new Error("That isn't a GitHub username — it's letters, numbers and dashes, like the name in their profile's address");
  try { await gh("GET", `/users/${who}`); } catch (e) { if (e.status === 404) throw new Error(`There's no GitHub account called ${who} — check the spelling with them`); throw e; }
  let res;
  try { res = await gh("PUT", `/repos/${owner}/${repo}/collaborators/${who}`, { permission: "push" }, [201, 204]); }
  catch (e) {
    if (e.status === 403 || e.status === 404 || e.status === 422) {
      throw new Error(`GitHub didn't let the app add ${who} (${e.message}). You can do it on github.com instead: open github.com/${owner}/${repo}, then Settings → Collaborators → Add people, and type ${who}.`);
    }
    throw e;
  }
  return res ? "invited" : "already";
}

// Signed in for this session only: kept in memory, never saved, and GitHub
// ends it by itself within hours. Saves a founder typing a code twice in a row.
let session = null;
/**
 * Add a co-signer key to a Crowdlock that already exists, alongside the keys it
 * has. Never removes one: a lock names its co-signer inside its address, so
 * removing a key would stop every lock naming it from being counted. Reads the
 * file from the repository itself (not the website, which can lag), adds the
 * key at the end — the newest key is the one new locks use — and commits.
 * `check(file)` is run on the result and must return { ok, problems }.
 */
/** Put a signed `home` into a Crowdlock's file (wallet/core.mjs, signHomeWith). Nothing else in it changes. */
export async function setHome({ token, owner, repo, path, home, check }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const got = await gh("GET", `/repos/${owner}/${repo}/contents/${path}`);
  const c = JSON.parse(Buffer.from(String(got.content).replace(/\s/g, ""), "base64").toString("utf8"));
  const next = { ...c, home };
  const r = check ? check(next) : { ok: true };
  if (!r.ok) throw new Error(`That would break the Crowdlock file: ${r.problems.join("; ")}`);
  const sha = await commitFiles(gh, owner, repo, { [path]: JSON.stringify(next, null, 2) + "\n" },
    `Say where ${c.name ?? path} lives\n\nSigned from the Crowdlock app with one of its co-signer keys: this Crowdlock lives at ${home.url}. A copy of its file put up anywhere else now sends people here.`);
  return { sha };
}

export async function addCosignerKey({ token, owner, repo, path, key, xpub = null, homeSignature = null, check }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const got = await gh("GET", `/repos/${owner}/${repo}/contents/${path}`);
  const c = JSON.parse(Buffer.from(String(got.content).replace(/\s/g, ""), "base64").toString("utf8"));
  const k = String(key).trim().toLowerCase();
  const keys = Array.isArray(c.cosigner_keys) ? c.cosigner_keys : [];
  const xpubs = Array.isArray(c.cosigner_xpubs) ? c.cosigner_xpubs : [];
  const hasKey = keys.some((x) => x.slice(2) === k.slice(2));
  const x = xpub ? String(xpub).trim() : null;
  // An xpub for a key already there is added on its own: the key keeps its
  // place, and members with a hardware wallet can now lock with it.
  if (hasKey && (!x || xpubs.includes(x))) throw new Error("This Crowdlock already has that co-signer key.");
  const newKeys = hasKey ? keys : [...keys, k];
  const newXpubs = x && !xpubs.includes(x) ? [...xpubs, x] : xpubs;
  // Keep the xpubs beside the keys in the file, where a person reading it expects them.
  const next = {};
  for (const [name, v] of Object.entries(c)) {
    if (name === "cosigner_xpubs") continue;
    next[name] = name === "cosigner_keys" ? newKeys
      // A Crowdlock that says where it lives needs every co-signer key to have signed that, the new one too.
      : name === "home" && homeSignature && v && typeof v === "object" ? { ...v, signatures: { ...(v.signatures ?? {}), [k]: homeSignature } }
      : v;
    if (name === "cosigner_keys" && newXpubs.length) next.cosigner_xpubs = newXpubs;
  }
  const r = check ? check(next) : { ok: true };
  if (!r.ok) throw new Error(`That would break the Crowdlock file: ${r.problems.join("; ")}`);
  const what = hasKey ? "the xpub for a co-signer key it already has" : x ? "a co-signer key, with its xpub," : "a co-signer key";
  const sha = await commitFiles(gh, owner, repo, { [path]: JSON.stringify(next, null, 2) + "\n" },
    hasKey
      ? `Add a co-signer xpub to ${c.name ?? path}\n\nAdded from the Crowdlock app by its founder or a maintainer: ${what}, so members with a hardware wallet can lock with it. The keys are unchanged.`
      : `Add a co-signer key to ${c.name ?? path}\n\nAdded from the Crowdlock app by its founder or a maintainer: ${what} alongside the ${keys.length} already there, none removed, so every existing lock still counts. New locks use this key.`);
  return { sha, keys: next.cosigner_keys, xpubs: next.cosigner_xpubs ?? [] };
}

/**
 * Add an attestor key: one of the keys that approve destinations
 * (spec/destinations-format.md). The Crowdlock file names it in
 * attestor_keys, and its destinations list repeats the attestors as addresses
 * (`addressOf(key)`); both take the new rule of a simple majority. Only while
 * the list holds no entry: a larger majority would need every entry attested
 * again, and the app doesn't do that. Both files go in one commit.
 */
export async function addAttestorKey({ token, owner, repo, path, destinationsPath, key, addressOf, check }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const got = await gh("GET", `/repos/${owner}/${repo}/contents/${path}`);
  const c = JSON.parse(Buffer.from(String(got.content).replace(/\s/g, ""), "base64").toString("utf8"));
  const list = await readJson(gh, owner, repo, destinationsPath);
  if (!list) throw new Error("This Crowdlock's destinations list isn't in its repository.");
  if ((list.entries ?? []).length) throw new Error("Its destinations list already has entries, and adding an attestor would mean attesting every one of them again. The app only adds attestors before the first destination.");
  const k = String(key).trim().toLowerCase();
  const keys = Array.isArray(c.attestor_keys) ? c.attestor_keys : [];
  if (keys.some((x) => x.slice(2) === k.slice(2))) throw new Error("This Crowdlock already has that attestor key.");
  const newKeys = [...keys, k];
  const threshold = Math.floor(newKeys.length / 2) + 1;
  const next = Object.fromEntries(Object.entries(c).map(([name, v]) => [name, name === "attestor_keys" ? newKeys : name === "attestor_threshold" ? threshold : v]));
  if (!("attestor_keys" in next)) next.attestor_keys = newKeys;
  next.attestor_threshold = threshold;
  const r = check ? check(next) : { ok: true };
  if (!r.ok) throw new Error(`That would break the Crowdlock file: ${r.problems.join("; ")}`);
  const nextList = { ...list, threshold, attestors: newKeys.map((x) => addressOf(x)) };
  const sha = await commitFiles(gh, owner, repo, {
    [path]: JSON.stringify(next, null, 2) + "\n",
    [destinationsPath]: JSON.stringify(nextList, null, 2) + "\n",
  }, `Add an attestor key to ${c.name ?? path}\n\nAdded from the Crowdlock app by its founder or a maintainer. It can now approve destinations; a destination needs ${threshold} of its ${newKeys.length} attestor${newKeys.length === 1 ? "" : "s"}.`);
  return { sha, keys: newKeys, threshold };
}

// ---------------------------------------------------------------------------
// Destinations and proposals (milestone 5). Both read the files from the
// repository itself, not the website (which can lag), add one thing at the
// end, check the result and commit. Neither ever edits or removes an entry.
// ---------------------------------------------------------------------------

async function readJson(gh, owner, repo, path) {
  try {
    const got = await gh("GET", `/repos/${owner}/${repo}/contents/${path}`);
    return JSON.parse(Buffer.from(String(got.content).replace(/\s/g, ""), "base64").toString("utf8"));
  } catch (e) { if (e.status === 404) return null; throw e; }
}

/**
 * Add a destination to a Crowdlock's destinations list, attested by the
 * signed-in founder's wallet and stamped on the chain. `makeEntry(file)`
 * returns { entry, at } (method/js/proposals.mjs nextDestination);
 * `attest(entry)` returns the attestation { address, signature } signed by an
 * attestor key; `stamp(entry)` sends the stamp payment for the attested entry
 * and returns its txid; `check(file)` must pass on the result.
 *
 * The stamp is sent before the list is changed. If saving the list then
 * fails, the stamp is wasted (its fee spent) and nothing else happens: an
 * entry is never published without its stamp.
 */
export async function addDestination({ token, owner, repo, path, makeEntry, attest, stamp, check }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const file = await readJson(gh, owner, repo, path);
  if (!file) throw new Error("This Crowdlock's destinations list isn't in its repository.");
  const { entry, at } = makeEntry(file);
  const attestation = await attest(entry);
  if (!(file.attestors ?? []).includes(attestation.address)) {
    throw new Error("This wallet isn't one of this Crowdlock's attestors, so it can't approve a destination. Its attestors are listed in its Crowdlock file.");
  }
  const attested = { ...entry, attestations: [attestation] };
  const next0 = { ...file, updated: at.slice(0, 10), entries: [...(file.entries ?? []), attested] };
  const r0 = check ? check(next0) : { ok: true };
  if (!r0.ok) throw new Error(`That would break the destinations list: ${r0.problems.join("; ")}`);
  const txid = await stamp(attested);
  const next = { ...next0, entries: [...(file.entries ?? []), { ...attested, stamp: txid }] };
  const sha = await commitFiles(gh, owner, repo, { [path]: JSON.stringify(next, null, 2) + "\n" },
    `Add destination ${entry.index}: ${entry.text}\n\nAdded, attested and stamped from the Crowdlock app. Address ${entry.address}. Stamp ${txid}. A proposal may name it once its stamp has been in a block for this Crowdlock's waiting period.`);
  return { sha, entry: next.entries.at(-1), stamp: txid };
}

/**
 * Publish a proposal: appended to the Crowdlock's proposals file (created if
 * it has none, and named in the Crowdlock file). `proposal` is complete, with
 * its hash; `check({ crowdlock, file })` must pass on the result.
 */
export async function publishProposal({ token, owner, repo, crowdlockPath, proposalsPath, proposal, check }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const c = await readJson(gh, owner, repo, crowdlockPath);
  if (!c) throw new Error("This Crowdlock's file isn't in its repository.");
  const files = {};
  let next = c;
  if (c.register?.proposals !== proposalsPath) {
    if (c.register?.proposals) throw new Error("This Crowdlock already names a different proposals file.");
    next = { ...c, register: { ...c.register, proposals: proposalsPath } };
    files[crowdlockPath] = JSON.stringify(next, null, 2) + "\n";
  }
  const file = (await readJson(gh, owner, repo, proposalsPath)) ?? { format: "crowdlock-proposals/1", instance: c.declaration.sha256, proposals: [] };
  if (file.proposals.some((p) => p.hash === proposal.hash)) throw new Error("That proposal is already published.");
  const after = { ...file, proposals: [...file.proposals, proposal] };
  const r = check ? check({ crowdlock: next, file: after }) : { ok: true };
  if (!r.ok) throw new Error(`That proposal can't be published: ${r.problems.join("; ")}`);
  files[proposalsPath] = JSON.stringify(after, null, 2) + "\n";
  const sha = await commitFiles(gh, owner, repo, files,
    `Propose: ${proposal.title}\n\nPublished from the Crowdlock app. Proposal ${proposal.hash}: ${proposal.requires} ${proposal.currency} (minor units) to ${proposal.destination}, gathering ${proposal.opens} to ${proposal.closes}, settling by ${proposal.settles_by}.`);
  return { sha };
}

export function rememberSignIn(token) { session = { token, until: Date.now() + 60 * 60 * 1000 }; }
export function currentSignIn() { return session && session.until > Date.now() ? session.token : null; }

/**
 * Publish a new version of the declaration (spec/registration-format.md,
 * "Versioning"). Its text goes in a file of its own beside the first, and the
 * Crowdlock file lists it, with today's date and the reason, after the
 * versions already there; nothing earlier is edited. One commit, so the text
 * and the listing can't arrive apart. The founding fingerprint, the register,
 * every member's number and every lock are untouched.
 *
 *   text      the new version, already in canonical form
 *   sha256    its fingerprint
 *   reason    one line, shown to every member before they sign it
 *   today     "YYYY-MM-DD"
 *   check(file, text) must pass on the new Crowdlock file.
 * Returns { sha, version, file }.
 */
export async function publishDeclarationVersion({ token, owner, repo, crowdlockPath, text, sha256, reason, today, check }, fetchImpl = globalThis.fetch) {
  const gh = client(token, fetchImpl);
  const c = await readJson(gh, owner, repo, crowdlockPath);
  if (!c) throw new Error("This Crowdlock's file isn't in its repository.");
  const later = Array.isArray(c.declaration_versions) ? c.declaration_versions : [];
  const last = later.length ? later[later.length - 1] : c.declaration;
  if ([c.declaration, ...later].some((v) => v.sha256 === sha256)) throw new Error("That text is the same as a version already published.");
  const version = last.version + 1;
  const first = String(c.declaration.file);
  const file = /v\d+\.txt$/.test(first) ? first.replace(/v\d+\.txt$/, `v${version}.txt`) : first.replace(/[^/]*$/, `declaration-v${version}.txt`);
  const next = { ...c, declaration_versions: [...later, { version, file, sha256, published: today, reason: String(reason).trim() }] };
  // Keep the versions next to the first declaration, where a person reading the file expects them.
  const ordered = {};
  for (const [k, v] of Object.entries(next)) {
    if (k === "declaration_versions") continue;
    ordered[k] = v;
    if (k === "declaration") ordered.declaration_versions = next.declaration_versions;
  }
  const r = check ? check(ordered, text) : { ok: true };
  if (!r.ok) throw new Error(`That would break the Crowdlock file: ${r.problems.join("; ")}`);
  const sha = await commitFiles(gh, owner, repo, { [file]: text, [crowdlockPath]: JSON.stringify(ordered, null, 2) + "\n" },
    `Publish version ${version} of the declaration\n\nPublished from the Crowdlock app by its founder or a maintainer.\n\nWhy: ${String(reason).trim()}\n\nFingerprint sha256:${sha256}. The founding version stays this Crowdlock's identity. Existing signatures stay valid for the version they signed; members are asked whether they wish to sign this one. No member's number and no lock changes.`);
  return { sha, version, file };
}
