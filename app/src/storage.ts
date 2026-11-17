// What the phone keeps, all of it in the system's encrypted keystore (Android
// Keystore, via expo-secure-store): never in plain app storage, never sent
// anywhere. If the app is deleted it is gone from the phone, which is why the
// recovery words are written down first, and why restoring from them must work.
import * as SecureStore from "expo-secure-store";
import { moveRecords } from "./moves.mjs";

// ---------------------------------------------------------------------------
// The wallet, in two entries
//
//   WALLET  what the app needs to show the wallet: its public account, or a
//           Ledger's details. Not secret. Read at every start.
//   SECRET  the recovery words (a words wallet only; a Ledger keeps its own
//           key). Read only at the moment something is signed. Where the
//           phone has a fingerprint or face unlock, the keystore hands the
//           words over only after the person passes it ("locked").
//
// A locked entry is thrown away by the phone itself if a fingerprint or face
// is added or removed in its settings: reading it then gives nothing, and the
// person types their recovery words again. That is the phone's own rule, and
// the safe one.
// ---------------------------------------------------------------------------
const WALLET = "crowdlock.wallet.v2";
const SECRET = "crowdlock.secret.v2";
// Before 16 November 2026 one entry held either the words or a Ledger's details.
const OLD = "crowdlock.words.v1";

/** Can this phone lock the words to a fingerprint or face? (It needs one set up, of the strong kind.) */
export function canLock(): boolean {
  try { return SecureStore.canUseBiometricAuthentication(); } catch { return false; }
}

async function writeWords(words: string, lock: boolean): Promise<void> {
  await SecureStore.deleteItemAsync(SECRET).catch(() => {});
  await SecureStore.setItemAsync(SECRET, words, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(lock ? { requireAuthentication: true, authenticationPrompt: "Confirm it's you, to lock this wallet to you" } : {}),
  });
}

/** The saved wallet, as the public text the app starts from; null if there is none. */
export async function loadWalletText(): Promise<string | null> {
  return SecureStore.getItemAsync(WALLET);
}

/** What an install from before the two entries saved: the words, or a Ledger's details. */
export async function loadOldEntry(): Promise<string | null> {
  return SecureStore.getItemAsync(OLD);
}

/**
 * Save a words wallet. The words are locked to the person's fingerprint or
 * face where the phone can (it asks for it now); if they cancel, or the phone
 * can't, the words are saved unlocked and the lock can be turned on later.
 * `textFor(locked)` gives the public text to save beside them. Returns it.
 */
export async function saveWordsWallet(words: string, textFor: (locked: boolean) => string, lock = canLock()): Promise<string> {
  let locked = lock;
  try { await writeWords(words, locked); }
  catch (e) {
    if (!locked) throw e;
    locked = false;
    await writeWords(words, false);
  }
  // Unlocked words can be read back, so they are: if the phone did not keep them, say so now.
  if (!locked && (await SecureStore.getItemAsync(SECRET)) !== words) throw new Error("the phone did not save the recovery words");
  const text = textFor(locked);
  await SecureStore.setItemAsync(WALLET, text);
  await SecureStore.deleteItemAsync(OLD).catch(() => {});
  return text;
}

/** Save a Ledger wallet: only its public details; any words on this phone are forgotten. */
export async function saveLedgerWallet(text: string): Promise<void> {
  await SecureStore.setItemAsync(WALLET, text);
  await SecureStore.deleteItemAsync(SECRET).catch(() => {});
  await SecureStore.deleteItemAsync(OLD).catch(() => {});
}

/**
 * The recovery words, for signing. On a locked wallet the phone asks for the
 * fingerprint or face first, showing `prompt`; cancelling rejects. Null means
 * the phone no longer has them (see the note above about changed fingerprints).
 */
export async function readWords(prompt: string): Promise<string | null> {
  const words = await SecureStore.getItemAsync(SECRET, { authenticationPrompt: prompt });
  if (words) return words;
  // An install from before the two entries whose move didn't finish.
  const old = await SecureStore.getItemAsync(OLD);
  return old && !old.startsWith("ledger:") ? old : null;
}

export async function forgetWallet(): Promise<void> {
  await SecureStore.deleteItemAsync(WALLET);
  await SecureStore.deleteItemAsync(SECRET);
  await SecureStore.deleteItemAsync(OLD);
}

// How fast the fan wants their transactions to confirm: slow, normal or fast.
// Only a preference, so it is kept beside the rest, not with the words.
const FEE_SPEED = "crowdlock.feespeed.v1";
export type FeeSpeed = "slow" | "normal" | "fast";

export async function loadFeeSpeed(): Promise<FeeSpeed> {
  try { const v = await SecureStore.getItemAsync(FEE_SPEED); return v === "slow" || v === "fast" ? v : "normal"; } catch { return "normal"; }
}

export async function saveFeeSpeed(v: FeeSpeed): Promise<void> {
  try { await SecureStore.setItemAsync(FEE_SPEED, v); } catch {}
}

// Light or dark: the phone's own setting, or the fan's own choice. Only a preference.
const LOOK = "crowdlock.look.v1";
export type SavedLook = "phone" | "light" | "dark";

export async function loadLook(): Promise<SavedLook> {
  try { const v = await SecureStore.getItemAsync(LOOK); return v === "light" || v === "dark" ? v : "phone"; } catch { return "phone"; }
}

export async function saveLook(v: SavedLook): Promise<void> {
  try { await SecureStore.setItemAsync(LOOK, v); } catch {}
}

// Crowdlocks the fan has added by link, beyond the starting list. Not secret,
// but kept beside the words so removing the wallet removes them too.
const ADDED = "crowdlock.added.v1";

export async function loadAddedCrowdlocks(): Promise<string[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(ADDED)) ?? "[]"); } catch { return []; }
}

export async function saveAddedCrowdlocks(urls: string[]): Promise<void> {
  await SecureStore.setItemAsync(ADDED, JSON.stringify(urls));
}

export async function forgetAddedCrowdlocks(): Promise<void> {
  await SecureStore.deleteItemAsync(ADDED);
}

// The terms of every lock this wallet makes: which Crowdlock, the address, the
// date and the co-signer. Saved BEFORE the money is sent, because the terms
// are what let the money come home: without the date nobody can rebuild the
// lock. Once a lock is on the register its terms are public there too, so
// restoring from the backup words finds it again; this copy covers the minutes
// between sending and the register taking it.
// A lock's terms, kept on the phone: with these and the wallet's own key, a
// lock can be taken home after its date with nothing from anybody else, the
// Crowdlock's own website included. `cosignerXpub` is what a Ledger needs to
// do that; `name` is only for showing the lock when its Crowdlock can't be
// loaded. Both are filled in whenever the Crowdlock is next read.
export type SavedLock = { crowdlock: string; address: string; locktime: number; cosignerPubkey: string; cosignerXpub?: string; name?: string };
const LOCKS = "crowdlock.locks.v1";

export async function loadSavedLocks(): Promise<SavedLock[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(LOCKS)) ?? "[]"); } catch { return []; }
}

export async function saveLock(lock: SavedLock): Promise<void> {
  const all = await loadSavedLocks();
  if (!all.some((l) => l.address === lock.address)) all.push(lock);
  await SecureStore.setItemAsync(LOCKS, JSON.stringify(all));
  // Read it back: if the phone did not keep it, the money must not be sent.
  if (!(await loadSavedLocks()).some((l) => l.address === lock.address)) {
    throw new Error("the phone did not save the lock's terms, so nothing was sent");
  }
}

/**
 * Keep these locks' terms on the phone: any it doesn't hold yet (a lock made
 * on the website, or before the app was reinstalled, is found on the register
 * and kept from then on), and a co-signer xpub or a name it was missing.
 * Never removes or changes a lock's own terms. Best effort: reading a
 * Crowdlock must not fail because the phone's store is full.
 */
export async function rememberLocks(locks: SavedLock[]): Promise<void> {
  try {
    const all = await loadSavedLocks();
    let changed = false;
    for (const l of locks) {
      const have = all.find((x) => x.address === l.address);
      if (!have) { all.push(l); changed = true; continue; }
      if (l.cosignerXpub && have.cosignerXpub !== l.cosignerXpub) { have.cosignerXpub = l.cosignerXpub; changed = true; }
      if (l.name && have.name !== l.name) { have.name = l.name; changed = true; }
    }
    if (changed) await SecureStore.setItemAsync(LOCKS, JSON.stringify(all));
  } catch {}
}

export async function forgetSavedLocks(): Promise<void> {
  await SecureStore.deleteItemAsync(LOCKS);
}

// The co-signer keys this phone last saw for each Crowdlock, so it can say when
// they change. Not secret. A change is a public commit anyone can read; this is
// what makes somebody look at it.
const SEEN_KEYS = "crowdlock.seenkeys.v1";

export async function loadSeenKeys(url: string): Promise<string[] | null> {
  try { return JSON.parse((await SecureStore.getItemAsync(SEEN_KEYS)) ?? "{}")[url] ?? null; } catch { return null; }
}

export async function saveSeenKeys(url: string, keys: string[]): Promise<void> {
  let all: Record<string, string[]> = {};
  try { all = JSON.parse((await SecureStore.getItemAsync(SEEN_KEYS)) ?? "{}"); } catch {}
  all[url] = keys;
  await SecureStore.setItemAsync(SEEN_KEYS, JSON.stringify(all));
}

// Keys this phone added itself, waiting for the website to show them. Kept
// apart from what it has seen, because the website lags a minute or more
// behind GitHub: treating an added key as already seen made the stale page
// look like the key had been removed.
const EXPECTED_KEYS = "crowdlock.expectedkeys.v1";

export async function loadExpectedKeys(url: string): Promise<string[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(EXPECTED_KEYS)) ?? "{}")[url] ?? []; } catch { return []; }
}

export async function saveExpectedKeys(url: string, keys: string[]): Promise<void> {
  let all: Record<string, string[]> = {};
  try { all = JSON.parse((await SecureStore.getItemAsync(EXPECTED_KEYS)) ?? "{}"); } catch {}
  if (keys.length) all[url] = keys; else delete all[url];
  await SecureStore.setItemAsync(EXPECTED_KEYS, JSON.stringify(all));
}

// What a Ledger has approved (each lock's rules, once) and its fingerprint.
// Not secret — it proves nothing without the device — but keeping it means
// the device isn't asked to approve the same lock twice.
const LEDGER_STORE = "crowdlock.ledgerstore.v1";

export async function loadLedgerStore(): Promise<any> {
  try { return JSON.parse((await SecureStore.getItemAsync(LEDGER_STORE)) ?? "{}"); } catch { return {}; }
}

export async function saveLedgerStore(store: any): Promise<void> {
  await SecureStore.setItemAsync(LEDGER_STORE, JSON.stringify(store ?? {}));
}

export async function forgetLedgerStore(): Promise<void> {
  await SecureStore.deleteItemAsync(LEDGER_STORE);
}

// When a Crowdlock's address has changed, refile everything above that is
// kept under its old address (see ./moves.mjs). Run at every start, before
// anything reads these records; running it again changes nothing. A failure
// leaves the records as they were, under the old address, to try next start.
export async function moveSavedRecords(moves: string[][], starting: string[]): Promise<boolean> {
  try {
    const read = async (key: string, empty: string) => JSON.parse((await SecureStore.getItemAsync(key)) ?? empty);
    const before = {
      locks: await read(LOCKS, "[]"),
      seen: await read(SEEN_KEYS, "{}"),
      expected: await read(EXPECTED_KEYS, "{}"),
      added: await read(ADDED, "[]"),
    };
    const after = moveRecords(before, moves, starting);
    if (!after.changed) return false;
    // Lock terms first, and checked, because they are the ones that matter.
    await SecureStore.setItemAsync(LOCKS, JSON.stringify(after.locks));
    const kept = await loadSavedLocks();
    if (kept.length !== after.locks.length) return false;
    await SecureStore.setItemAsync(SEEN_KEYS, JSON.stringify(after.seen));
    await SecureStore.setItemAsync(EXPECTED_KEYS, JSON.stringify(after.expected));
    await SecureStore.setItemAsync(ADDED, JSON.stringify(after.added));
    return true;
  } catch { return false; }
}
