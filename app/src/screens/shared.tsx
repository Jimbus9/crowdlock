// What every screen shares: the list of screens, the small helpers and parts
// they are all built from, what the app keeps in mind while it is open, and
// the styles. Nothing here is a screen, and nothing here touches keys or
// money: that is src/wallet/core.mjs, and only that.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { ComponentRef } from "react";
import type { TextInputProps } from "react-native";
// @ts-ignore — plain module shared with the chain tests
import { accountFromWords, ledgerAccountFrom } from "../wallet/core.mjs";
import { isLedgerWallet, readLedgerWallet, ledgerUser, ledgerAppFor } from "../ledgerDevice";
// @ts-ignore — plain module shared with the chain tests
import { STARTING_LIST } from "../crowdlocks.mjs";
import { loadAddedCrowdlocks, loadFeeSpeed, saveFeeSpeed, loadWalletText, loadOldEntry, saveWordsWallet, saveLedgerWallet, readWords } from "../storage";
import type { FeeSpeed } from "../storage";
import { NETWORK, chain } from "../config";
// The look (one theme file) and the shared parts every screen is built from.
import { banner, font, gap, radius, size, themeFor, useTheme } from "../ui/theme";
import type { Theme } from "../ui/theme";
import { Btn, Warning } from "../ui/parts";

// ---------------------------------------------------------------------------
// The screens, and what a loaded Crowdlock, a lock and Home's summary look like
// ---------------------------------------------------------------------------

export type Screen =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "showWords"; words: string }
  | { name: "checkWords"; words: string }
  | { name: "restore"; again?: string }
  | { name: "home"; words: string }
  | { name: "addMoney"; words: string }
  | { name: "lock"; words: string; url: string }
  | { name: "chooseLock"; words: string; options: { url: string; name: string }[] }
  | { name: "sign"; words: string; url: string }
  | { name: "allLocks"; words: string; url: string }
  | { name: "allProposals"; words: string; url: string }
  | { name: "share"; words: string; url: string }
  | { name: "lookAfter"; words: string; url: string; job?: "home" }
  | { name: "proposal"; words: string; url: string; hash: string }
  | { name: "commit"; words: string; url: string; hash: string }
  | { name: "takeHome"; words: string; url: string; address?: string; again?: boolean }
  | { name: "feeSpeed"; words: string }
  | { name: "wallet"; words: string }
  | { name: "founders"; words: string }
  | { name: "help"; words?: string; from?: string }
  | { name: "about"; words: string }
  | { name: "send"; words: string }
  | { name: "crowdlock"; words: string; url: string }
  | { name: "addCrowdlock"; words: string; link?: string }
  | { name: "startCrowdlock"; words: string }
  | { name: "findCrowdlocks"; words: string }
  | { name: "cosignerKey"; words: string; forStart?: "cosigner" | "testPasted" }
  | { name: "ledgerSetup"; from?: string };

export type Go = (s: Screen) => void;

export type Loaded = { ok: true; url: string; crowdlock: any; declarationText: string; versions: any[]; statement: string; register: any; destinations: any; proposals: any[]; proposalProblems: string[] }
  | { ok: false; url: string; problems: string[] };

export type LockTerms = { address: string; locktime: number; cosignerPubkey: string; cosignerXpub?: string; name?: string };

export type LockRow = LockTerms & { state: string; confirmed: bigint; arriving: bigint; onRegister: boolean; note?: string };

// `offline`: its Crowdlock couldn't be loaded, and it is shown from the terms this phone kept.
export type MyLock = { crowdlock: string; name: string; address: string; locktime: number; state: string; confirmed: bigint; arriving: bigint; offline?: boolean };

export type HomeAlert = { url: string; name: string; kind: "keys" | "version" | "rules" | "unsaved" };

export type OverviewData = { balance: { confirmed: bigint; arriving: bigint } | null; locks: MyLock[] | null; step: any | null; alerts: HomeAlert[] };

export type Overview = OverviewData & { error: string | null };

// ---------------------------------------------------------------------------
// While the app is open
// ---------------------------------------------------------------------------

// What the app keeps in mind while it is open, and forgets when it closes.
// None of it is secret and none of it is a record of anything: it saves
// asking the network again, or losing what somebody has typed.
export const whileOpen = {
  /** How fast payments should confirm. The saved choice, read when the app starts, so every screen that sends something uses the same one. */
  feeSpeed: "normal" as FeeSpeed,
  /** What Home last read: coming back to Home shows it at once, and nothing is asked again if it was read moments ago. Set to null after anything that moves money. */
  overview: null as { address: string; at: number; data: OverviewData } | null,
  /** What has been typed into Start a Crowdlock so far, so that leaving the form (to make a co-signer key) loses nothing. Every field in it ends up published. */
  startDraft: null as Record<string, any> | null,
};

// Home asks the block explorer as little as it can: the balance, the
// network's clock, and one question per lock. Whether an empty lock was ever
// funded doesn't matter here (it isn't shown), so that second question isn't
// asked (`quick`). The Crowdlock's own page still asks everything.
//
// Locks found empty after their date are noted here and not asked about again
// (see lockState), so nobody waits while the app re-asks about every lock they
// ever took home. "Check now" and pulling down empty it and ask everything.
export const finishedLocks = new Map<string, string>();

// Crowdlocks signed for on this phone since the app was opened, and when: the
// register takes a few minutes to show a new member, and until it does the
// Crowdlock's page says "waiting" instead of offering to sign again.
export const signedHere: Record<string, number> = {};

export const SIGNED_WAIT_MS = 20 * 60 * 1000;

/**
 * Versions signed in this app session and sent, but not yet on the register
 * (the relay inbox takes a few minutes). Without this, the page asks again
 * straight after signing. Forgotten when the app closes; by then the register
 * has it, or the card comes back, which is the honest answer.
 */
const signedThisSession = new Set<string>();

const signedKey = (c: Extract<Loaded, { ok: true }>, address: string) =>
  `${c.url}|${address}|${c.versions[c.versions.length - 1].version}`;

export function markSignedJustNow(c: Extract<Loaded, { ok: true }>, address: string) { signedThisSession.add(signedKey(c, address)); }

export function signedJustNow(c: Extract<Loaded, { ok: true }>, address: string) { return signedThisSession.has(signedKey(c, address)); }

export async function allLinks(): Promise<string[]> {
  const added = await loadAddedCrowdlocks();
  return [...STARTING_LIST, ...added.filter((u) => !STARTING_LIST.includes(u))];
}

// ---------------------------------------------------------------------------
// Back, and screens with pages of their own
// ---------------------------------------------------------------------------

// A screen that has pages of its own says what Back does while it is showing.
export const BackCtx = createContext<(f: () => boolean) => () => void>(() => () => {});

export function useBack(fn: () => boolean) {
  const set = useContext(BackCtx);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => set(() => latest.current()), [set]);
}

export type Refresher = () => Promise<unknown> | void;

// ---------------------------------------------------------------------------
// Checking again
//
// Pull down on a screen and everything on it that reads the chain or a
// Crowdlock's files reads them again. Screens also check when they open and
// when the app comes back to the front. A screen says what "check again"
// means for it with useRefresh; one pull runs them all. For anyone who can't
// pull down, the same thing is one tap away: the "Check now" in CheckedLine.
// ---------------------------------------------------------------------------

export const RefreshCtx = createContext<{ add: (f: Refresher) => () => void; checkNow: () => void; checkedAt: number | null }>(
  { add: () => () => {}, checkNow: () => {}, checkedAt: null },
);

export function useRefresh(fn: Refresher) {
  const { add } = useContext(RefreshCtx);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => add(() => latest.current()), [add]);
}

/** When this screen last checked, and the one-tap way to check again. */
export function CheckedLine() {
  const { checkedAt, checkNow } = useContext(RefreshCtx);
  const d = checkedAt ? new Date(checkedAt) : null;
  const at = d ? `Checked at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}. ` : "";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${at}Check now`} onPress={checkNow} style={{ minHeight: 48, justifyContent: "center", marginTop: 8 }}>
      <Text style={s.note}>{at}Pull down to check again, or tap <Text style={s.link}>Check now</Text>.</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Typing: boxes that take words, and keeping a box above the keyboard
// ---------------------------------------------------------------------------

/** A text box in the app's colours (the hint text stays readable in the dark). */
// Settings for any box backup words are typed into. Without them the phone's
// keyboard predicts and learns the words, and may keep them in its own
// dictionary or send them to its maker for "better suggestions". A
// visible-password box is one Android keyboards don't predict in or learn
// from; the app's own word chips (from the standard word list, on the phone)
// do the suggesting instead. Pasting still works.
export const SECRET_WORDS: Partial<TextInputProps> = {
  autoCapitalize: "none", autoCorrect: false, spellCheck: false, autoComplete: "off",
  importantForAutofill: "no", keyboardType: "visible-password", textContentType: "none",
};

// The keyboard covers the bottom of the screen. When a box is tapped, the page
// is moved so the box sits near the top, with room under it (for word
// suggestions and messages) above the keyboard.
export type Box = ComponentRef<typeof TextInput>;

export const RevealCtx = createContext<(box: Box | null) => void>(() => {});

export function Input(props: TextInputProps) {
  const t = useTheme();
  const reveal = useContext(RevealCtx);
  const box = useRef<Box>(null);
  return (
    <TextInput
      ref={box} placeholderTextColor={t.soft} {...props}
      onFocus={(e) => { props.onFocus?.(e); reveal(box.current); }}
    />
  );
}

// ---------------------------------------------------------------------------
// The wallet on this phone
// ---------------------------------------------------------------------------

// The wallet on this phone: recovery words, or a Ledger that holds the key.
// Everything else in the app treats them the same; only signing differs.
//
// What the screens pass around (their `words` prop) is the wallet's public
// text, never the recovery words: "ledger:{…}" for a Ledger, "watch:{…}" for
// a words wallet. It is enough to show addresses, balances and locks. The
// words themselves are read from the keystore only by signingAccount, at the
// moment something is signed.
const WATCH = "watch:";
const watchText = (keyExpression: string, locked: boolean) => WATCH + JSON.stringify({ keyExpression, locked });

export function walletAccount(text: string): any {
  if (isLedgerWallet(text)) {
    const w = readLedgerWallet(text);
    return { ...ledgerAccountFrom({ keyExpression: w.keyExpression, network: NETWORK, useLedger: ledgerUser(w, NETWORK) }), ledgerName: w.name, ledgerVia: w.via };
  }
  if (text.startsWith(WATCH)) {
    const w = JSON.parse(text.slice(WATCH.length));
    // The same public account a Ledger wallet is shown from; it cannot sign.
    return {
      ...ledgerAccountFrom({ keyExpression: w.keyExpression, network: NETWORK, useLedger: null }),
      kind: "words", locked: !!w.locked,
      signer: () => { throw new Error("the wallet has to be unlocked before it can sign"); },
    };
  }
  // An install from before the words were kept apart, whose move didn't finish: as it was.
  return { ...accountFromWords(text, NETWORK), holdsKey: true };
}

/** Save a new or restored words wallet (see saveWordsWallet in src/storage). Returns its public text. */
export async function keepWords(words: string, lock?: boolean): Promise<string> {
  const { keyExpression } = accountFromWords(words, NETWORK);
  return saveWordsWallet(words, (locked) => watchText(keyExpression, locked), lock);
}

/**
 * The wallet this phone starts with, as its public text; null if there is none.
 * An install from before the words were kept apart is moved over here, once,
 * without asking for a fingerprint (so starting never waits on one): the lock
 * is offered on the Wallet screen.
 */
export async function loadWallet(): Promise<string | null> {
  const saved = await loadWalletText();
  if (saved) return saved;
  const old = await loadOldEntry();
  if (!old) return null;
  if (isLedgerWallet(old)) { await saveLedgerWallet(old).catch(() => {}); return old; }
  try { return await keepWords(old, false); }
  catch { return old; }   // shown and signed with as before; tried again next start
}

const KEY_GONE = "This phone can no longer unlock your wallet. That happens when a fingerprint or face is added or removed in the phone's settings: the phone throws its copy of the key away. Your money is safe. Go to More, then Wallet, then \"Type my recovery words again\", and use the words on your paper. Nothing was signed.";

/**
 * The account that can sign. A Ledger wallet signs on the device, so it is
 * the account as it is. A words wallet's words are read from the keystore
 * now, after the fingerprint or face check where the wallet is locked, and
 * are gone again when the caller has finished with what this returns.
 * Throws, in words for the screen, if the person cancels or the phone no
 * longer has the words.
 */
export async function signingAccount(account: any): Promise<any> {
  if (account.kind === "ledger" || account.holdsKey) return account;
  let words: string | null;
  try { words = await readWords("Confirm it's you, to sign"); }
  catch (e: any) {
    const why = String(e?.message ?? e);
    throw new Error(/cancel/i.test(why) ? "You cancelled, so nothing was signed." : `The phone wouldn't unlock your wallet, so nothing was signed. (${why})`);
  }
  if (!words) throw new Error(KEY_GONE);
  const full = accountFromWords(words, NETWORK);
  if (full.address !== account.address) throw new Error("The recovery words saved on this phone don't make this wallet's address, so nothing was signed.");
  return full;
}

export function LedgerHint({ account }: { account: any }) {
  if (account?.kind !== "ledger") return null;
  return <Text style={s.note}>This wallet signs on your Ledger ({account.ledgerName}). Keep it unlocked, close by or plugged in, with the {ledgerAppFor(NETWORK)} app open, and approve on its screen when it asks.</Text>;
}

// ---------------------------------------------------------------------------
// Writing amounts and dates
// ---------------------------------------------------------------------------

export function btc(sats: bigint) {
  const neg = sats < 0n; const v = neg ? -sats : sats;
  const whole = v / 100000000n; const frac = (v % 100000000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${whole}.${frac} BTC`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function when(locktime: number) {
  const d = new Date(locktime * 1000);
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  // A lock rounded to a plain date reads as a date; a short test lock needs the time.
  if (locktime % 86400 === 0) return date;
  return `${date}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function lengthLabel(years: number) {
  const hours = Math.round(years * 8766);
  if (years >= 1) return `${years} year${years === 1 ? "" : "s"}`;
  if (hours >= 24) return `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"} (test)`;
  return `${hours} hour${hours === 1 ? "" : "s"} (test)`;
}

export function minorDigits(currency: string) {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}

export function money(minor: number, currency: string) {
  const d = minorDigits(currency);
  return `${(minor / 10 ** d).toFixed(d)} ${currency}`;
}

export function parseBtc(text: string): bigint | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d{0,8}$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w || "0") * 100000000n + BigInt((f + "00000000").slice(0, 8));
}

export const atUtc = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

// ---------------------------------------------------------------------------
// Fees: the speed chosen, and a figure to show before anything is signed
// ---------------------------------------------------------------------------

export const SPEED_LABEL: Record<FeeSpeed, string> = { slow: "Slow", normal: "Normal", fast: "Fast" };

const SPEED_WHEN: Record<FeeSpeed, string> = { slow: "about an hour", normal: "about half an hour", fast: "the next block or two" };

/** Slow / Normal / Fast, with the network fee rate each means right now. */
// Roughly how big each kind of payment is, in vbytes, for showing a fee
// before anything is signed. The wallet works out the exact fee when it
// builds the payment; these only say about what to expect. Measured from
// real payments: taking one lock payment home is 122, and so is committing
// all of one; a new lock as the destination adds 12; keeping part of a lock
// back adds 43; each waiting payment swept in adds 68.
// A commitment leaves a lock with two signatures and carries one more output,
// naming its proposal: 183 vbytes for a whole lock, 226 for part of one.
export const VB_HOME = 122, VB_AGAIN = 134, VB_WAITING = 68, VB_COMMIT = 183, VB_COMMIT_PART = 226;

/** The fee rate at the chosen speed, and a way to read it again after the speed changes. */
export function useFeeRate(): [number | null, () => void] {
  const [rate, setRate] = useState<number | null>(null);
  const read = useCallback(() => { chain.feeRate(whileOpen.feeSpeed).then(setRate).catch(() => setRate(null)); }, []);
  useEffect(() => { read(); }, [read]);
  return [rate, read];
}

export const aboutFee = (rate: number | null, vb: number) => (rate ? `about ${Math.ceil(rate * vb).toLocaleString("en-GB")} sats (${SPEED_LABEL[whileOpen.feeSpeed]})` : "being worked out");

export function FeeChoice({ onChange }: { onChange?: () => void } = {}) {
  const [speed, setSpeed] = useState<FeeSpeed>(whileOpen.feeSpeed);
  const [rates, setRates] = useState<{ slow: number; normal: number; fast: number } | null>(null);
  useEffect(() => { chain.feeRates().then(setRates).catch(() => {}); loadFeeSpeed().then((v) => { whileOpen.feeSpeed = v; setSpeed(v); }); }, []);
  const pick = (v: FeeSpeed) => { whileOpen.feeSpeed = v; setSpeed(v); saveFeeSpeed(v); onChange?.(); };
  return (
    <View>
      <Text style={s.h2}>Fee speed</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["slow", "normal", "fast"] as FeeSpeed[]).map((v) => (
          <Pressable key={v} onPress={() => pick(v)} style={[s.btn, speed !== v && s.btnPlain, { flex: 1, paddingHorizontal: 4 }]}>
            <Text style={[s.btnText, speed !== v && s.btnTextPlain, { fontSize: 14 }]}>{SPEED_LABEL[v]}{rates ? `\nabout ${Math.ceil(rates[v] * 141)} sats` : ""}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.note}>
        {SPEED_LABEL[speed]}: usually confirms in {SPEED_WHEN[speed]}. A higher fee is quicker; a low one can wait many hours when the network is busy. The figures are for a typical lock (a sat is the smallest unit of bitcoin); other payments cost a little more or less.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Small parts the flows share
// ---------------------------------------------------------------------------

export function SumRow({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.rule }}>
      <Text style={[s.p, { marginBottom: 0 }]}>{label}</Text>
      <Text style={[s.p, s.bold, { marginBottom: 0, flexShrink: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// A yes-or-no before something that can't be undone, in the app's own look:
// what happens, then one clear button. The app never uses the phone's pop-up
// boxes for this.
// ---------------------------------------------------------------------------

export function Confirm({ title, text, yes, onYes, onCancel }: { title: string; text: string; yes: string; onYes: () => void; onCancel: () => void }) {
  return (
    <View>
      <Warning level="stop" title={title}>{text}</Warning>
      <Btn kind="danger" label={yes} onPress={onYes} />
      <Btn kind="second" label="Cancel" onPress={onCancel} />
    </View>
  );
}

/**
 * Old lines against new: lines taken out struck through, lines put in marked,
 * and long runs of unchanged lines folded to one line.
 */
export function Changes({ changes }: { changes: { kind: "same" | "gone" | "new"; text: string }[] }) {
  const near = (i: number) => changes.slice(Math.max(0, i - 1), i + 2).some((x) => x.kind !== "same");
  const rows: any[] = [];
  let folded = 0;
  changes.forEach((x, i) => {
    if (x.kind === "same" && !near(i)) { folded++; return; }
    if (folded) { rows.push(<Text key={`f${i}`} style={s.note}>… {folded} line{folded === 1 ? "" : "s"} unchanged</Text>); folded = 0; }
    if (x.kind === "same") rows.push(<Text key={i} style={s.declaration}>{x.text || " "}</Text>);
    else if (x.kind === "gone") rows.push(<Text key={i} style={[s.declaration, { textDecorationLine: "line-through", opacity: 0.6 }]}>− {x.text || " "}</Text>);
    else rows.push(<Text key={i} style={[s.declaration, s.bold]}>+ {x.text || " "}</Text>);
  });
  if (folded) rows.push(<Text key="fend" style={s.note}>… {folded} line{folded === 1 ? "" : "s"} unchanged</Text>);
  if (!changes.some((x) => x.kind !== "same")) rows.push(<Text key="none" style={s.note}>No line differs. Only the version changed.</Text>);
  return <View style={s.panel}>{rows}<Text style={s.note}>− taken out · + put in</Text></View>;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Text and layout styles shared by the screens in this file, drawn from the
// one theme (src/ui/theme.ts) so they follow the phone's light or dark
// setting. Buttons, cards, warnings and the bars are in src/ui/parts.tsx.
function makeStyles(t: Theme) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: t.page },
    bannerReal: { backgroundColor: banner.real.bg, color: banner.real.text, textAlign: "center", paddingVertical: 6, fontFamily: font.bold, fontSize: 12 },
    banner: { backgroundColor: banner.test.bg, color: banner.test.text, textAlign: "center", paddingVertical: 6, fontFamily: font.bold, fontSize: 12 },
    body: { paddingHorizontal: 20, paddingTop: gap.s, paddingBottom: 60 },
    h1: { fontSize: size.h1, lineHeight: 32, fontFamily: font.bold, marginTop: 12, marginBottom: 12, color: t.ink },
    h2: { fontSize: size.h2, lineHeight: 26, fontFamily: font.bold, marginTop: 28, marginBottom: 8, color: t.ink },
    p: { fontSize: size.body, lineHeight: 23, fontFamily: font.regular, color: t.ink, marginBottom: 10 },
    note: { fontSize: size.small, lineHeight: 20, fontFamily: font.regular, color: t.soft, marginVertical: 8 },
    good: { fontSize: size.small, lineHeight: 20, fontFamily: font.bold, color: t.good, marginVertical: 8 },
    error: { fontSize: 15, lineHeight: 21, fontFamily: font.bold, color: t.stop, marginVertical: 8 },
    big: { fontSize: size.big, lineHeight: 40, fontFamily: font.bold, color: t.ink, marginBottom: 4 },
    bold: { fontFamily: font.bold },
    kick: { fontSize: size.small, fontFamily: font.bold, color: t.soft },
    label: { fontSize: size.small, fontFamily: font.bold, color: t.ink, marginTop: 12, marginBottom: 4 },
    input: { borderWidth: 1, borderColor: t.soft, borderRadius: radius, padding: 12, minHeight: 48, fontSize: size.body, fontFamily: font.regular, color: t.ink, backgroundColor: t.page },
    mono: { fontFamily: font.mono, fontSize: 14, color: t.ink, marginVertical: 8 },
    words: { flexDirection: "row", flexWrap: "wrap", marginVertical: 12 },
    word: { width: "50%", fontSize: 18, paddingVertical: 6, fontFamily: font.regular, color: t.ink },
    wordNum: { color: t.soft },
    // A code to scan stays dark on white in both modes, so any camera can read it.
    qr: { alignSelf: "center", padding: 16, backgroundColor: "#FFFFFF", borderRadius: radius, marginVertical: 8 },
    panel: { borderWidth: 1, borderColor: t.rule, backgroundColor: t.panel, borderRadius: radius, padding: 14, marginTop: 14 },
    btn: { backgroundColor: t.brand, borderRadius: radius, paddingVertical: 12, paddingHorizontal: 12, minHeight: 54, alignItems: "center", justifyContent: "center", marginTop: 14 },
    btnPlain: { backgroundColor: "transparent", borderWidth: 1, borderColor: t.soft, minHeight: 48 },
    btnText: { color: t.onBrand, fontSize: size.body, fontFamily: font.bold, textAlign: "center" },
    btnTextPlain: { color: t.ink },
    onBrand: { color: t.onBrand, fontFamily: font.bold },
    card: { borderWidth: 1, borderColor: t.rule, borderRadius: radius, padding: 14, marginTop: 10 },
    cardTitle: { fontSize: 17, fontFamily: font.bold, color: t.ink },
    link: { fontSize: 15, color: t.brand, fontFamily: font.bold, marginTop: 4, textDecorationLine: "underline" },
    declaration: { fontSize: 15, lineHeight: 22, fontFamily: font.regular, color: t.ink, marginVertical: 8 },
    box: { width: 24, height: 24, borderWidth: 2, borderColor: t.soft, borderRadius: 4, marginRight: 10, alignItems: "center", justifyContent: "center" },
    boxOn: { backgroundColor: t.brand, borderColor: t.brand },
    chip: { borderWidth: 1, borderColor: t.soft, borderRadius: radius, paddingVertical: 8, paddingHorizontal: 14, minHeight: 48, justifyContent: "center" },
    chipOn: { backgroundColor: t.ink, borderColor: t.ink },
    chipText: { fontSize: 15, color: t.ink, fontFamily: font.bold },
    chipTextOn: { color: t.page },
  });
}

// The styles every screen reads as it draws. One object, refilled when the
// look changes (light or dark), so a screen never holds a stale copy.
export const s = { ...makeStyles(themeFor(null)) };
let styledDark: boolean | null = null;

/** Fill `s` for the look in use. The app's first line calls this, before any screen draws. */
export function setStyles(t: Theme) {
  if (styledDark === t.dark) return;
  Object.assign(s, makeStyles(t));
  styledDark = t.dark;
}
