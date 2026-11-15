// A wallet a fan who has never held bitcoin can use, and the Crowdlocks they
// can join with it.
//
//   Welcome    →  New: show the 12 words → check three of them → Home
//              →  Restore: type the recovery words → Home
//   Home       →  four places along the bottom: Home (your next step, from
//                 the six steps), My bitcoin (waiting, Add money, Send out,
//                 your locks), Crowdlocks (each one checked before it is
//                 shown), More (help, fee speed, wallet, founders)
//   Crowdlock  →  its declaration, and Sign to join in one tap; then, for a
//                 member, Your locks: progress to the minimum, Lock it,
//                 each lock's state, and Take it home after its date
//   Add        →  any other Crowdlock, by link, checked the same way
//   Start      →  a new Crowdlock: write its declaration, sign in to GitHub
//                 with a short code, and it is set up in the founder's own
//                 account, with a test copy beside it
//
// Every screen here is presentation. Anything touching keys or money goes
// through src/wallet/core.mjs, and nothing else may.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, AppState, BackHandler, Dimensions, Keyboard, Linking, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, View,
} from "react-native";
import type { ComponentRef } from "react";
import type { TextInputProps } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
// @ts-ignore — plain module shared with the chain tests
import {
  newWords, wordsAreValid, tidyWords, accountFromWords, suggestWords, waitingBalance, buildSend, signStatement,
  lockFor, lockDate, buildLock, lockState, takeHome, relock, checkLedgerKey, cosignerFromWords, newCosignerWords, cosignerKeyFromWords, COSIGNER_PATH,
  isPublicKey, keyFromXpub, xpubForKey, ledgerAccountFrom, readLedgerAccount, signStatementWith,
  buildCommitment, checkCommitment, completeCommitmentWith, commitmentPaid, signNoticeWith, NETWORKS,
} from "./src/wallet/core.mjs";
import { address as bitcoinAddress } from "bitcoinjs-lib";
import { memberAddressForOwnerKey } from "../method/js/verify.mjs";
import {
  phaseOf, proposalHash, fieldsOf, nextDestination, attestationStatement, destinationIsPermitted, checkProposals, chainIsIntact, attestationsAreValid,
  pilePath, checkPileShape, noticeStatement, noticeIsGenuine, proposalVersion,
} from "../method/js/proposals.mjs";
import {
  isLedgerWallet, readLedgerWallet, ledgerWalletText, ledgerUser, withLedger, lookForLedgers, askForBluetooth, ledgerAppFor,
} from "./src/ledgerDevice";
// @ts-ignore — plain modules shared with the tests
import { buildCrowdlock, declarationSkeleton, slugify, DEFAULT_RELAYS, checkWithNewKey, NO_RETURNS } from "./src/start.mjs";
// @ts-ignore
import {
  startSignIn, waitForSignIn, whoAmI, createCrowdlockRepo, canWrite, updateCrowdlockRepo, addMaintainer, rememberSignIn, currentSignIn, addCosignerKey,
  addDestination, publishProposal, publishDeclarationVersion,
} from "./src/github.mjs";
// @ts-ignore — plain module shared with the tests
import { canonicalise, declarationHash, checkCrowdlock, currentVersion } from "../method/js/crowdlock.mjs";
// @ts-ignore
import template from "./src/template.mjs";
// Plain JavaScript modules: their results are used as loosely typed here.
const build = buildCrowdlock as (x: any) => any;
const createRepo = createCrowdlockRepo as (x: any) => Promise<any>;
// @ts-ignore — plain module shared with the chain tests
import {
  STARTING_LIST, MOVED_ADDRESSES, loadCrowdlock, membershipOf, committedTotal, submitJoin, COUNTING_RULE_URL, poundsPerBtc, shortBtc,
  locksOnRegister, submitLock, newestCosigner, pathInRepo, keyChanges, historyLinkFor, coSignerRecord, openLinkFor, fileUrlFromOpenLink, shareLinkFor, rankFound, matchesSearch,
  repoFromFileUrl, versionStatus, changesSince, baseFor, resolvePath, newVersionToSign, versionSignedBy, mayCommitTo, lineChanges,
} from "./src/crowdlocks.mjs";
// @ts-ignore — plain module
import { postToRelays, announce, fetchAnnouncements, postCommitment, fetchCommitments } from "./src/relays.mjs";
import {
  loadWords, saveWords, forgetWords, loadAddedCrowdlocks, saveAddedCrowdlocks, forgetAddedCrowdlocks,
  loadSavedLocks, saveLock, forgetSavedLocks, forgetLedgerStore, loadSeenKeys, saveSeenKeys, loadExpectedKeys, saveExpectedKeys, loadFeeSpeed, saveFeeSpeed, loadLook, saveLook, moveSavedRecords } from "./src/storage";
import type { FeeSpeed } from "./src/storage";
import { NETWORK, IS_TEST_MONEY, chain, EXPLORER_WEB, EXPLORER_BACKUP_WEB } from "./src/config";
import { askAfresh } from "./src/wallet/esplora.mjs";
// The look (one theme file) and the shared parts every screen is built from.
import { banner, font, gap, radius, setLook, size, themeFor, useLook, useTheme } from "./src/ui/theme";
import type { Look, Theme } from "./src/ui/theme";
import { Btn, Card, NavRow, StepBar, TabBar, TopBar, Warning } from "./src/ui/parts";
import type { TabName } from "./src/ui/parts";
// @ts-ignore — plain module, tested in test-chain
import { nextStep } from "./src/nextStep.mjs";

type Screen =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "showWords"; words: string }
  | { name: "checkWords"; words: string }
  | { name: "restore" }
  | { name: "home"; words: string }
  | { name: "addMoney"; words: string }
  | { name: "lock"; words: string; url: string }
  | { name: "chooseLock"; words: string; options: { url: string; name: string }[] }
  | { name: "sign"; words: string; url: string }
  | { name: "allLocks"; words: string; url: string }
  | { name: "allProposals"; words: string; url: string }
  | { name: "share"; words: string; url: string }
  | { name: "lookAfter"; words: string; url: string }
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

// ---------------------------------------------------------------------------
// Checking again
//
// Pull down on a screen and everything on it that reads the chain or a
// Crowdlock's files reads them again. Screens also check when they open and
// when the app comes back to the front. A screen says what "check again"
// means for it with useRefresh; one pull runs them all. For anyone who can't
// pull down, the same thing is one tap away: the "Check now" in CheckedLine.
// ---------------------------------------------------------------------------

// A screen that has pages of its own says what Back does while it is showing.
const BackCtx = createContext<(f: () => boolean) => () => void>(() => () => {});
function useBack(fn: () => boolean) {
  const set = useContext(BackCtx);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => set(() => latest.current()), [set]);
}

type Refresher = () => Promise<unknown> | void;
const RefreshCtx = createContext<{ add: (f: Refresher) => () => void; checkNow: () => void; checkedAt: number | null }>(
  { add: () => () => {}, checkNow: () => {}, checkedAt: null },
);

function useRefresh(fn: Refresher) {
  const { add } = useContext(RefreshCtx);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => add(() => latest.current()), [add]);
}

/** When this screen last checked, and the one-tap way to check again. */
function CheckedLine() {
  const { checkedAt, checkNow } = useContext(RefreshCtx);
  const d = checkedAt ? new Date(checkedAt) : null;
  const at = d ? `Checked at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}. ` : "";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${at}Check now`} onPress={checkNow} style={{ minHeight: 48, justifyContent: "center", marginTop: 8 }}>
      <Text style={s.note}>{at}Pull down to check again, or tap <Text style={s.link}>Check now</Text>.</Text>
    </Pressable>
  );
}

/** A text box in the app's colours (the hint text stays readable in the dark). */
// Settings for any box backup words are typed into. Without them the phone's
// keyboard predicts and learns the words, and may keep them in its own
// dictionary or send them to its maker for "better suggestions". A
// visible-password box is one Android keyboards don't predict in or learn
// from; the app's own word chips (from the standard word list, on the phone)
// do the suggesting instead. Pasting still works.
const SECRET_WORDS: Partial<TextInputProps> = {
  autoCapitalize: "none", autoCorrect: false, spellCheck: false, autoComplete: "off",
  importantForAutofill: "no", keyboardType: "visible-password", textContentType: "none",
};

// The keyboard covers the bottom of the screen. When a box is tapped, the page
// is moved so the box sits near the top, with room under it (for word
// suggestions and messages) above the keyboard.
type Box = ComponentRef<typeof TextInput>;
const RevealCtx = createContext<(box: Box | null) => void>(() => {});

function Input(props: TextInputProps) {
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

// Screens where pulling down checks again. Forms and word screens are left
// out: nothing on them comes from outside the phone.
const REFRESHABLE = new Set(["home", "crowdlock", "findCrowdlocks", "proposal"]);
const TAB_TITLE: Record<TabName, string> = { home: "Crowdlock", bitcoin: "My bitcoin", crowdlocks: "Crowdlocks", more: "More" };

export default function App() {
  const t = useTheme();
  // Every screen below reads `s` as it draws, so it is set before they do.
  s = useMemo(() => makeStyles(t), [t.dark]);

  // Where the person is, and how they got there: the last entry is on screen,
  // and Back (the phone's own, or the one at the top) drops it.
  const [stack, setStack] = useState<Screen[]>([{ name: "loading" }]);
  const [tab, setTab] = useState<TabName>("home");
  const screen = stack[stack.length - 1];
  const stackRef = useRef(stack); stackRef.current = stack;
  const tabRef = useRef(tab); tabRef.current = tab;
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // How tall the keyboard is while it is up, and how far the page is scrolled.
  const [keyboard, setKeyboard] = useState(0);
  const keyboardRef = useRef(0);
  const scrolledTo = useRef(0);
  const focused = useRef<Box | null>(null);
  const settle = useCallback(() => {
    const box = focused.current;
    if (!box || !keyboardRef.current) return;
    box.measureInWindow((_x: number, y: number, _w: number, h: number) => {
      const top = 150;                                   // just under the banner and the top bar
      const bottom = Dimensions.get("window").height - keyboardRef.current;
      // Leave it alone if the box and about three lines under it already show.
      if (y >= top - 20 && y + h + 150 <= bottom) return;
      scroll.current?.scrollTo({ y: Math.max(0, scrolledTo.current + y - top), animated: true });
    });
  }, []);
  const reveal = useCallback((box: Box | null) => { focused.current = box; setTimeout(settle, 350); }, [settle]);
  useEffect(() => {
    const up = Keyboard.addListener("keyboardDidShow", (e) => { keyboardRef.current = e.endCoordinates.height; setKeyboard(e.endCoordinates.height); setTimeout(settle, 80); });
    const down = Keyboard.addListener("keyboardDidHide", () => { keyboardRef.current = 0; setKeyboard(0); focused.current = null; });
    return () => { up.remove(); down.remove(); };
  }, [settle]);

  // A Crowdlock link the app was opened with (crowdlock://add?url=…, from a
  // QR code or a web page's button). Held until there is a wallet to add it
  // to, then opened in Add a Crowdlock, where it is checked like any other.
  const pending = useRef<string | null>(null);

  const setScreen = useCallback((next: Screen) => {
    let link: string | null = null;
    if (next.name === "home" && pending.current) { link = pending.current; pending.current = null; }
    setStack((old) => {
      // Home and Welcome are where everything starts: going there clears the way back.
      if (next.name === "home") return link ? [next, { name: "addCrowdlock", words: next.words, link }] : [next];
      if (next.name === "welcome") return [next];
      // Going to a screen already behind us is going back to it, not piling it on top.
      const i = old.findIndex((x) => x.name === next.name);
      return i >= 0 ? [...old.slice(0, i), next] : [...old.filter((x) => x.name !== "loading"), next];
    });
  }, []);

  // A screen with pages of its own (locking) answers Back first; otherwise Back drops the screen.
  const intercept = useRef<null | (() => boolean)>(null);
  const backCtx = useMemo(() => (f: () => boolean) => { intercept.current = f; return () => { if (intercept.current === f) intercept.current = null; }; }, []);
  const goBack = useCallback(() => {
    if (intercept.current?.()) return;
    setStack((old) => (old.length > 1 ? old.slice(0, -1) : old));
  }, []);

  // The phone's own Back: one screen back; from another tab, to Home; on Home
  // (or Welcome) it leaves the app, as every Android app does.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (stackRef.current.length > 1) { goBack(); return true; }
      if (stackRef.current[0].name === "home" && tabRef.current !== "home") { setTab("home"); return true; }
      return false;
    });
    return () => sub.remove();
  }, [goBack]);

  useEffect(() => {
    // Opened by a link: note it, then show the first screen once; "home" picks
    // the link up. A link arriving while the app is open is opened at once if
    // there is a wallet, or waits for one.
    loadFeeSpeed().then((v) => { feeSpeed = v; });
    loadLook().then(setLook);
    // Refile anything saved under an address that has since moved, before
    // anything reads it (see src/moves.mjs).
    moveSavedRecords(MOVED_ADDRESSES, STARTING_LIST).catch(() => false).then(() => Linking.getInitialURL()).then((u) => {
      pending.current = fileUrlFromOpenLink(u ?? null);
      loadWords().then((w) => setScreen(w ? { name: "home", words: w } : { name: "welcome" }));
    });
    const sub = Linking.addEventListener("url", (e) => {
      const file = fileUrlFromOpenLink(e.url);
      if (!file) return;
      pending.current = file;
      loadWords().then((w) => { if (w) setScreen({ name: "home", words: w }); });
    });
    return () => sub.remove();
  }, [setScreen]);

  // Checking again: by pulling down, by "Check now", and when the app comes back to the front.
  const refreshers = useRef(new Set<Refresher>());
  const [refreshing, setRefreshing] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const lastRun = useRef(0);
  const runAll = useCallback(async (spin: boolean) => {
    lastRun.current = Date.now();
    // Asked for by hand: really ask, about everything, old locks included.
    if (spin) { askAfresh(); finishedLocks.clear(); setRefreshing(true); }
    await Promise.all([...refreshers.current].map((f) => Promise.resolve().then(f).catch(() => {})));
    setCheckedAt(Date.now());
    if (spin) setRefreshing(false);
  }, []);
  const refreshCtx = useMemo(() => ({
    add: (f: Refresher) => { refreshers.current.add(f); return () => { refreshers.current.delete(f); }; },
    checkNow: () => { runAll(true); },
    checkedAt,
  }), [runAll, checkedAt]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => { if (state === "active" && Date.now() - lastRun.current > 60000) runAll(false); });
    return () => sub.remove();
  }, [runAll]);

  // A new screen starts at its top, and has just read what it shows.
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
    setCheckedAt(Date.now());
  }, [stack.length, screen.name, tab]);

  const onTabs = screen.name === "home";
  const words = "words" in screen ? screen.words : undefined;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.page}>
        <StatusBar style={t.dark ? "light" : "dark"} />
        {IS_TEST_MONEY && <Text style={s.banner}>TEST MONEY · {NETWORK} · not real bitcoin</Text>}
        {!IS_TEST_MONEY && <Text style={s.bannerReal}>REAL BITCOIN · early build, not yet independently reviewed</Text>}
        {screen.name !== "loading" && (
          <TopBar
            title={onTabs ? TAB_TITLE[tab] : screen.name === "welcome" ? "Crowdlock" : undefined}
            showLogo={(onTabs && tab === "home") || screen.name === "welcome"}
            onBack={stack.length > 1 ? goBack : undefined}
            onHelp={screen.name === "help" ? undefined : () => setScreen({ name: "help", words, from: screen.name === "home" ? tab : screen.name })}
          />
        )}
        <BackCtx.Provider value={backCtx}><RefreshCtx.Provider value={refreshCtx}>
          <RevealCtx.Provider value={reveal}>
          <ScrollView
            ref={scroll} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
            style={{ marginBottom: keyboard }} scrollEventThrottle={16}
            onScroll={(e) => { scrolledTo.current = e.nativeEvent.contentOffset.y; }}
            refreshControl={REFRESHABLE.has(screen.name)
              ? <RefreshControl refreshing={refreshing} onRefresh={() => runAll(true)} colors={[t.brand]} tintColor={t.brand} progressBackgroundColor={t.panel} />
              : undefined}
          >
            {screen.name === "loading" && <ActivityIndicator style={{ marginTop: 80 }} />}
            {screen.name === "welcome" && <Welcome go={setScreen} />}
            {screen.name === "showWords" && <ShowWords words={screen.words} go={setScreen} />}
            {screen.name === "checkWords" && <CheckWords words={screen.words} go={setScreen} />}
            {screen.name === "restore" && <Restore go={setScreen} />}
            {screen.name === "home" && <Tabs words={screen.words} tab={tab} setTab={setTab} go={setScreen} />}
            {screen.name === "addMoney" && <AddMoney words={screen.words} />}
            {screen.name === "lock" && <LockFlow words={screen.words} url={screen.url} go={setScreen} />}
            {screen.name === "takeHome" && <HomeFlow words={screen.words} url={screen.url} address={screen.address} again={screen.again} go={setScreen} />}
            {screen.name === "proposal" && <ProposalScreen words={screen.words} url={screen.url} hash={screen.hash} go={setScreen} />}
            {screen.name === "commit" && <CommitFlow words={screen.words} url={screen.url} hash={screen.hash} go={setScreen} />}
            {screen.name === "allLocks" && <AllOf what="locks" words={screen.words} url={screen.url} go={setScreen} />}
            {screen.name === "allProposals" && <AllOf what="proposals" words={screen.words} url={screen.url} go={setScreen} />}
            {screen.name === "chooseLock" && (
              <View>
                <Text style={s.kick}>Step 4 of 6: Lock</Text>
                <Text style={s.h1}>Lock for which Crowdlock?</Text>
                <Text style={s.p}>Your waiting bitcoin belongs to no Crowdlock until you choose. A lock counts for one Crowdlock only, and it can't be moved to another before its date.</Text>
                {screen.options.map((o) => <NavRow key={o.url} title={o.name} sub="Lock for this one" onPress={() => setScreen({ name: "lock", words: screen.words, url: o.url })} />)}
              </View>
            )}
            {screen.name === "sign" && <SignScreen words={screen.words} url={screen.url} go={setScreen} />}
            {screen.name === "share" && <ShareScreen url={screen.url} />}
            {screen.name === "lookAfter" && <LookAfterScreen words={screen.words} url={screen.url} />}
            {screen.name === "send" && <Send words={screen.words} go={setScreen} />}
            {screen.name === "feeSpeed" && <FeeSpeedScreen />}
            {screen.name === "wallet" && <WalletScreen words={screen.words} go={setScreen} />}
            {screen.name === "founders" && <Founders words={screen.words} go={setScreen} />}
            {screen.name === "help" && <Help from={screen.from} />}
            {screen.name === "about" && <About />}
            {screen.name === "crowdlock" && <CrowdlockScreen words={screen.words} url={screen.url} go={setScreen} />}
            {screen.name === "addCrowdlock" && <AddCrowdlock key={screen.link ?? "add"} words={screen.words} link={screen.link} go={setScreen} />}
            {screen.name === "startCrowdlock" && <StartCrowdlock words={screen.words} go={setScreen} />}
            {screen.name === "findCrowdlocks" && <FindCrowdlocks words={screen.words} go={setScreen} />}
            {screen.name === "cosignerKey" && <CosignerKey words={screen.words} forStart={screen.forStart} go={setScreen} />}
            {screen.name === "ledgerSetup" && <LedgerSetup from={screen.from} go={setScreen} />}
          </ScrollView>
          </RevealCtx.Provider>
        </RefreshCtx.Provider></BackCtx.Provider>
        {onTabs && <TabBar tab={tab} onTab={setTab} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

type Go = (s: Screen) => void;

// ---------------------------------------------------------------------------

// The wallet on this phone: recovery words, or a Ledger that holds the key.
// Everything else in the app treats them the same; only signing differs.
function walletAccount(words: string): any {
  if (isLedgerWallet(words)) {
    const w = readLedgerWallet(words);
    return { ...ledgerAccountFrom({ keyExpression: w.keyExpression, network: NETWORK, useLedger: ledgerUser(w, NETWORK) }), ledgerName: w.name };
  }
  return accountFromWords(words, NETWORK);
}

// Shown wherever a Ledger wallet is about to be asked to sign.
function LedgerHint({ account }: { account: any }) {
  if (account?.kind !== "ledger") return null;
  return <Text style={s.note}>This wallet signs on your Ledger ({account.ledgerName}). Keep it unlocked, close by or plugged in, with the {ledgerAppFor(NETWORK)} app open, and approve on its screen when it asks.</Text>;
}

function Welcome({ go }: { go: Go }) {
  return (
    <View>
      <Text style={s.p}>Your own bitcoin wallet. Nobody else holds your money — not us, not anyone.</Text>
      <Button label="Create a new wallet" onPress={() => go({ name: "showWords", words: newWords() })} />
      <Button label="I already have recovery words" kind="plain" onPress={() => go({ name: "restore" })} />
      <Button label="Use a Ledger" kind="plain" onPress={() => go({ name: "ledgerSetup" })} />
    </View>
  );
}

// Setting up a Ledger as this phone's wallet. The key stays on the device;
// the phone keeps only the account's public part, to show balances without it.
function LedgerSetup({ from, go }: { from?: string; go: Go }) {
  const [stage, setStage] = useState<"start" | "looking" | "reading" | "found">("start");
  const [devices, setDevices] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<{ deviceId: string; name: string; keyExpression: string; via?: "bluetooth" | "cable" } | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const app = ledgerAppFor(NETWORK);

  const look = async () => {
    setError(null); setDevices([]);
    // Without Bluetooth permission a cable still works, so carry on and say so.
    const bt = await askForBluetooth();
    if (!bt) setError("Without Bluetooth permission the app can only find a Ledger plugged in by cable. To use Bluetooth, allow it in your phone's settings for Crowdlock.");
    setStage("looking");
    stop.current?.();
    stop.current = lookForLedgers(
      (d) => setDevices((old) => (old.some((x) => x.id === d.id) ? old : [...old, d])),
      // A Bluetooth problem is shown but the search carries on, so a cable still works.
      (e, via) => { setError(e.message); if (via === "cable") setStage("start"); },
    );
  };

  const choose = async (d: any) => {
    stop.current?.(); stop.current = null;
    setStage("reading"); setError(null);
    try {
      const keyExpression = await withLedger({ deviceId: d.id, device: d.device }, NETWORK, (session) => readLedgerAccount(session, NETWORK));
      setWallet({ deviceId: d.id, name: d.name, keyExpression, via: d.via });
      setStage("found");
    } catch (e: any) { setError(String(e.message ?? e)); setStage("start"); }
  };

  const account = wallet ? walletAccount(ledgerWalletText(wallet)) : null;
  return (
    <View>
      <Text style={s.h1}>Use a Ledger</Text>
      {stage === "start" && <>
        <Text style={s.p}>Your Ledger keeps the key. This phone only shows your balance and asks the Ledger to sign, and you approve every signature on the Ledger's own screen.</Text>
        <Text style={s.note}>1. Turn the Ledger on and unlock it with its PIN.</Text>
        <Text style={s.note}>2. Open the {app} app on it{(NETWORK as string) === "mainnet" ? "" : " (install it in Ledger Live if it isn't there: My Ledger, with Developer mode on in Settings)"}.</Text>
        <Text style={s.note}>3. Either plug it into the phone with a USB-C cable, or turn Bluetooth on, on the phone and the Ledger (Nano X, Flex and Stax have Bluetooth).</Text>
        <Button label="Find my Ledger" onPress={look} />
      </>}
      {stage === "looking" && <>
        <Text style={s.p}>Looking for Ledgers nearby…</Text>
        {devices.length === 0 && <ActivityIndicator style={{ marginVertical: 16 }} />}
        {devices.map((d) => <Button key={d.id} label={`Use ${d.name} (${d.via === "cable" ? "cable" : "Bluetooth"})`} onPress={() => choose(d)} />)}
        <Text style={s.note}>By Bluetooth, the first time, the phone and the Ledger may ask to pair, each showing a code. Check they match, then accept on both. By cable, the phone asks whether Crowdlock may use the Ledger: allow it.</Text>
        <Button label="Stop looking" kind="plain" onPress={() => { stop.current?.(); setStage("start"); }} />
      </>}
      {stage === "reading" && <>
        <Text style={s.p}>Reading your account from the Ledger…</Text>
        <ActivityIndicator style={{ marginVertical: 16 }} />
      </>}
      {stage === "found" && account && <>
        <Text style={s.p}>This is your Ledger's wallet. It's the same address Ledger Live, Sparrow or any standard wallet shows for this Ledger's first native segwit account.</Text>
        <Text style={s.mono} selectable>{account.address}</Text>
        <Button label="Copy address" kind="plain" onPress={() => Clipboard.setStringAsync(account.address)} />
        {from && <Text style={s.note}>To move money onto it first, copy the address, go Back, and send it from this phone's wallet. Then come back here. Using this Ledger replaces that wallet on this phone — only do it once its 12 words are written down.</Text>}
        <Button label="Use this Ledger" onPress={async () => {
          const text = ledgerWalletText(wallet!);
          // A different wallet: forget the old one's saved lock terms (they're
          // on the register, and restoring its words finds them again).
          if (from) { await forgetSavedLocks(); await forgetLedgerStore(); }
          await saveWords(text); go({ name: "home", words: text });
        }} />
        <Button label="Try again" kind="plain" onPress={() => { setWallet(null); setStage("start"); }} />
      </>}
      {error && <Text style={s.error}>{error}</Text>}
      <Button label="Back" kind="plain" onPress={() => { stop.current?.(); go(from ? { name: "home", words: from } : { name: "welcome" }); }} />
    </View>
  );
}

function ShowWords({ words, go }: { words: string; go: Go }) {
  const list = words.split(" ");
  return (
    <View>
      <Text style={s.h1}>Write these down</Text>
      <Text style={s.p}>
        These 12 words are your wallet. Write them on paper, in order, and keep the paper safe.
        Anyone with them can take your money. If you lose your phone and these words, the money is gone — nobody can get it back for you.
      </Text>
      <View style={s.words}>
        {list.map((w, i) => (
          <Text key={i} style={s.word}><Text style={s.wordNum}>{i + 1}. </Text>{w}</Text>
        ))}
      </View>
      <Text style={s.note}>Do not screenshot them or save them in notes, email or cloud storage.</Text>
      <Button label="I have written them down" onPress={() => go({ name: "checkWords", words })} />
    </View>
  );
}

function CheckWords({ words, go }: { words: string; go: Go }) {
  return (
    <CheckEveryWord
      words={words}
      onDone={async () => { await saveWords(words); go({ name: "home", words }); }}
      onShowAgain={() => go({ name: "showWords", words })}
    />
  );
}

/**
 * Check a paper copy of recovery words, every word, one at a time — the way a
 * hardware wallet does. A copy wrong in a single word is not a backup, and
 * checking only a few words leaves most of them unchecked. Suggestions come
 * from the standard word list, never from the words themselves.
 */
function CheckEveryWord({ words, onDone, onShowAgain }: { words: string; onDone: () => void; onShowAgain: () => void }) {
  const list = words.split(" ");
  const [i, setI] = useState(0);
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const accept = (w: string) => {
    if (w.trim().toLowerCase() !== list[i]) { setWrong(true); return; }
    setWrong(false); setTyped("");
    if (i + 1 === list.length) onDone(); else setI(i + 1);
  };
  return (
    <View>
      <Text style={s.h1}>Check your paper</Text>
      <Text style={s.p}>Type each word from what you wrote down. Every word is checked — one wrong word and the paper wouldn't bring your money back.</Text>
      <Text style={s.label}>Word {i + 1} of {list.length}</Text>
      <Input
        style={s.input} {...SECRET_WORDS} autoFocus value={typed}
        onChangeText={(t) => { setTyped(t); setWrong(false); }} onSubmitEditing={() => accept(typed)} returnKeyType="next"
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        {suggestWords(typed).map((w: string) => (
          <Pressable key={w} onPress={() => accept(w)} style={s.chip}><Text style={s.chipText}>{w}</Text></Pressable>
        ))}
      </View>
      {wrong && <Text style={s.error}>That isn't word {i + 1}. Check your paper — if it's wrong there, go back and copy the words out again.</Text>}
      <Button label="Next" disabled={!typed.trim()} onPress={() => accept(typed)} />
      <Button label="Show the words again" kind="plain" onPress={onShowAgain} />
    </View>
  );
}

/**
 * Typing recovery words in: the same box everywhere — restoring a wallet,
 * checking a co-signer key's paper, co-signing a purchase. As each word is
 * typed it offers the standard words that start that way (from the word list,
 * never from anything saved), and says how many words there are and whether
 * they check out.
 */
function WordsInput({ value, onChange, placeholder }: { value: string; onChange: (t: string) => void; placeholder?: string }) {
  const endsWithSpace = /\s$/.test(value);
  const parts = value.split(/\s+/);
  const partial = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
  const suggestions = partial ? suggestWords(partial).filter((w: string) => w !== partial.toLowerCase() || suggestWords(partial).length > 1) : [];
  const pick = (w: string) => {
    const head = endsWithSpace ? value : value.slice(0, value.length - partial.length);
    onChange(head + w + " ");
  };
  const count = tidyWords(value).split(" ").filter(Boolean).length;
  const rightLength = [12, 15, 18, 21, 24].includes(count);
  const valid = rightLength && wordsAreValid(value);
  return <>
    <Input
      style={[s.input, { minHeight: 100, textAlignVertical: "top" }]} multiline
      {...SECRET_WORDS} value={value} onChangeText={onChange} placeholder={placeholder}
    />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
      {suggestions.map((w: string) => (
        <Pressable key={w} onPress={() => pick(w)} style={s.chip}><Text style={s.chipText}>{w}</Text></Pressable>
      ))}
    </View>
    <Text style={valid ? s.good : s.note}>
      {valid ? "Those words are valid."
        : rightLength ? `${count} words, but they don't check out — look for a misspelt word.`
        : `${count} word${count === 1 ? "" : "s"} so far`}
    </Text>
  </>;
}

function Restore({ go }: { go: Go }) {
  const [text, setText] = useState("");
  // 12 is what this app makes; 15 to 24 come from other wallets (a Ledger
  // makes 24). All are standard, so all are accepted.
  const count = tidyWords(text).split(" ").filter(Boolean).length;
  const rightLength = [12, 15, 18, 21, 24].includes(count);
  const valid = rightLength && wordsAreValid(text);

  const finish = async () => {
    const words = tidyWords(text);
    await saveWords(words);
    go({ name: "home", words });
  };

  return (
    <View>
      <Text style={s.h1}>Restore your wallet</Text>
      <Text style={s.p}>Type your recovery words, in order, with spaces between them. Usually 12 or 24.</Text>
      <WordsInput value={text} onChange={setText} />
      <Button label="Restore" disabled={!valid} onPress={finish} />
    </View>
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The four places: Home, My bitcoin, Crowdlocks, More
//
// Home shows one thing to do next, worked out from the six steps (understand,
// sign, get bitcoin, lock, commit to a purchase, take it home), then what is
// waiting and what is locked. Everything read here is read the same way the
// Crowdlock's own page reads it; nothing is decided here about money.
// ---------------------------------------------------------------------------

type MyLock = { crowdlock: string; name: string; address: string; locktime: number; state: string; confirmed: bigint; arriving: bigint };
type HomeAlert = { url: string; name: string; kind: "keys" | "version" };
type OverviewData = { balance: { confirmed: bigint; arriving: bigint } | null; locks: MyLock[] | null; step: any | null; alerts: HomeAlert[] };
type Overview = OverviewData & { error: string | null };

// What Home last read, kept while the app is open: coming back to Home shows
// it at once, and nothing is asked again if it was read moments ago.
let lastOverview: { address: string; at: number; data: OverviewData } | null = null;
const OVERVIEW_FRESH_MS = 20000;

/** Has this wallet already committed to this proposal? Read from the Crowdlock's own published pile. */
async function inPile(c: Extract<Loaded, { ok: true }>, p: any, publicKey: string): Promise<boolean> {
  try {
    if (!c.crowdlock.register?.proposals) return false;
    const r = await fetch(resolvePath(pilePath(c.crowdlock.register.proposals, p.hash), baseFor(c.url)), { cache: "no-store" });
    if (!r.ok) return false;
    const file = await r.json();
    return checkPileShape(file, p.hash).ok && file.commitments.some((x: any) => x.record?.lock?.owner_pubkey === publicKey);
  } catch { return false; }
}

// Home asks the block explorer as little as it can: the balance, the
// network's clock, and one question per lock. Whether an empty lock was ever
// funded doesn't matter here (it isn't shown), so that second question isn't
// asked (`quick`). The Crowdlock's own page still asks everything.
//
// Locks found empty after their date are noted here and not asked about again
// (see lockState), so nobody waits while the app re-asks about every lock they
// ever took home. "Check now" and pulling down empty it and ask everything.
const finishedLocks = new Map<string, string>();

function useOverview(account: any): Overview {
  const held = lastOverview && lastOverview.address === account.address ? lastOverview : null;
  const [data, setData] = useState<OverviewData>(held?.data ?? { balance: null, locks: null, step: null, alerts: [] });
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setError(null);
    let waiting: { confirmed: bigint; arriving: bigint };
    // If the explorer doesn't answer this, it won't answer the rest: stop here
    // rather than queue more questions behind it, and keep what was last read.
    try { waiting = await waitingBalance(chain, account.address); }
    catch (e: any) { if (alive.current) setError(String(e.message ?? e)); return; }
    if (!alive.current) return;
    setData((old) => ({ ...old, balance: waiting }));

    const loaded: Loaded[] = await Promise.all((await allLinks()).map((u) => loadCrowdlock(u)));
    const here = loaded.filter((c) => c.ok && c.crowdlock.network === NETWORK) as Extract<Loaded, { ok: true }>[];
    const saved = await loadSavedLocks();
    // If the network's clock can't be read, no lock is called ready: 0 keeps them all "locked".
    let medianTime = 0;
    try { medianTime = await chain.medianTime(); } catch {}

    const all: MyLock[] = [];
    const notes: HomeAlert[] = [];
    const forStep: any[] = [];
    let missed = 0;
    for (const c of here) {
      const member = !!membershipOf(c.register, account.address);
      const cosigner: string | undefined = newestCosigner(c.crowdlock);
      const changed = keyChanges(await loadSeenKeys(c.url), c.crowdlock.cosigner_keys ?? [], await loadExpectedKeys(c.url)).changed;
      if (member && changed) notes.push({ url: c.url, name: c.crowdlock.name, kind: "keys" });
      if (newVersionToSign(c, account.address)) notes.push({ url: c.url, name: c.crowdlock.name, kind: "version" });
      const mine: MyLock[] = [];
      if (member) {
        const terms: { address: string; locktime: number; cosignerPubkey: string }[] = [...locksOnRegister(c.register, account.address)];
        for (const l of saved.filter((x) => x.crowdlock === c.url)) if (!terms.some((x) => x.address === l.address)) terms.push(l);
        for (const l of terms) {
          if (!alive.current) return;   // Home has been left: stop asking
          try {
            const st = await lockState({ chain, lock: l, medianTime, quick: true, finished: finishedLocks });
            if (st.confirmed > 0n || st.arriving > 0n) mine.push({ crowdlock: c.url, name: c.crowdlock.name, address: l.address, locktime: l.locktime, ...st });
          } catch { missed++; }
        }
      }
      all.push(...mine);
      const open = (c.proposals ?? []).find((p: any) => phaseOf(p) === "gathering") ?? null;
      forStep.push({
        url: c.url, name: c.crowdlock.name, member, minimum: BigInt(c.crowdlock.minimum_counted_lock_sats),
        canLock: !!cosigner && !changed && !(account.kind === "ledger" && !xpubForKey(c.crowdlock, cosigner)),
        locks: mine, openProposal: open ? { title: open.title, hash: open.hash } : null,
        committed: member && open ? await inPile(c, open, account.publicKey) : false,
      });
    }
    if (!alive.current) return;
    all.sort((a, b) => a.locktime - b.locktime);
    const next: OverviewData = { balance: waiting, locks: all, step: nextStep({ waiting: waiting.confirmed, crowdlocks: forStep }), alerts: notes };
    setData(next);
    if (missed) setError(`${missed} of your locks couldn't be read just now`);
    else lastOverview = { address: account.address, at: Date.now(), data: next };
  }, [account.address]);

  // Read on arriving, unless it was read moments ago.
  useEffect(() => { if (!held || Date.now() - held.at > OVERVIEW_FRESH_MS) load(); }, [load]);
  useRefresh(load);
  return { ...data, error };
}

function Tabs({ words, tab, setTab, go }: { words: string; tab: TabName; setTab: (t: TabName) => void; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const o = useOverview(account);
  if (tab === "bitcoin") return <BitcoinTab o={o} words={words} go={go} />;
  if (tab === "crowdlocks") return <CrowdlocksTab words={words} address={account.address} go={go} />;
  if (tab === "more") return <MoreTab words={words} account={account} go={go} />;
  return <HomeTab o={o} words={words} go={go} setTab={setTab} />;
}

/** The words for each next step: a title, a sentence, and the one button. */
function stepWords(step: any, o: Overview, words: string, go: Go): { title: string; text: string; button?: string; onPress?: () => void } {
  const open = () => go({ name: "crowdlock", words, url: step.url });
  switch (step.kind) {
    case "find": return {
      title: "Find a Crowdlock",
      text: "A Crowdlock is a crowd of people who each lock their own bitcoin towards buying something together. Nobody holds anyone else's money.",
      button: "Find Crowdlocks", onPress: () => go({ name: "findCrowdlocks", words }),
    };
    case "understand": return {
      title: `Read what ${step.name} asks`,
      text: "Start with its declaration: the words you would sign. Signing is free and moves no money.",
      button: "Read the declaration", onPress: open,
    };
    case "getBitcoin": return {
      title: "Get bitcoin",
      text: (o.balance && o.balance.confirmed > 0n
        ? `You have ${btc(o.balance.confirmed)} waiting. ${btc(step.need)} more and you can lock it for ${step.name}.`
        : `To lock for ${step.name} you need at least ${btc(step.need)} in this wallet.`)
        + (o.balance && o.balance.arriving > 0n ? ` ${btc(o.balance.arriving)} is on its way and counts once it confirms.` : ""),
      button: "Add money", onPress: () => go({ name: "addMoney", words }),
    };
    case "lock": return step.options ? {
      title: "Lock your bitcoin",
      text: `You have ${btc(step.sats)} waiting. You have joined ${step.options.length} Crowdlocks, so choose which one to lock it for.`,
      button: "Choose a Crowdlock", onPress: () => go({ name: "chooseLock", words, options: step.options }),
    } : {
      title: "Lock your bitcoin",
      text: `You have ${btc(step.sats)} waiting. Lock it for ${step.name}.`,
      button: "Lock my bitcoin", onPress: () => go({ name: "lock", words, url: step.url }),
    };
    case "blocked": return {
      title: "Locking is waiting on something",
      text: `You have enough waiting, but ${step.name} can't take a lock just now. Its page says why.`,
      button: `Look at ${step.name}`, onPress: open,
    };
    case "commit": return {
      title: "A purchase is open",
      text: `"${step.title}" is gathering commitments in ${step.name}. You can commit your locked bitcoin to it. This step is optional.`,
      button: "Look at the proposal", onPress: () => (step.hash ? go({ name: "proposal", words, url: step.url, hash: step.hash }) : open()),
    };
    case "takeHome": return {
      title: "Take it home",
      text: `${btc(step.sats)} in ${step.name} has passed its date. Take it home, or lock it again.`,
      button: "Take it home", onPress: () => go({ name: "takeHome", words, url: step.url }),
    };
    default: return {
      title: "Nothing to do",
      text: `Your bitcoin is locked.${step.opens ? ` The next lock opens on ${when(step.opens)}.` : ""} Steps 1 to 4 are done. Steps 5 and 6 come later.`,
    };
  }
}

function HomeTab({ o, words, go, setTab }: { o: Overview; words: string; go: Go; setTab: (t: TabName) => void }) {
  const held = (o.locks ?? []).filter((l) => l.state === "locked" || l.state === "lapsed");
  const lockedSats = held.reduce((n, l) => n + l.confirmed, 0n);
  const ready = held.some((l) => l.state === "lapsed");
  const nextDate = held.filter((l) => l.state === "locked").map((l) => l.locktime)[0];
  const w = o.step ? stepWords(o.step, o, words, go) : null;
  return (
    <View>
      {o.alerts.map((a) => a.kind === "version" ? (
        <Warning key={a.url + a.kind} level="know" title={`${a.name}: its declaration has a new version`}>
          <Btn kind="link" label="Read what changed" onPress={() => go({ name: "sign", words, url: a.url })} />
        </Warning>
      ) : (
        <Warning key={a.url + a.kind} level="know" title={`${a.name}: its co-signer keys have changed`}>
          <Btn kind="link" label={`Look at ${a.name}`} onPress={() => go({ name: "crowdlock", words, url: a.url })} />
        </Warning>
      ))}

      <Card>
        <Text style={s.kick}>Your next step</Text>
        {!w && !o.error && <ActivityIndicator style={{ marginVertical: 24 }} />}
        {!w && !!o.error && <Text style={s.error}>The next step can't be worked out yet: {o.error}. Pull down to try again.</Text>}
        {w && <>
          <Text style={[s.h1, { marginTop: 4, marginBottom: 6 }]}>{w.title}</Text>
          <Text style={[s.p, { marginBottom: 0 }]}>{w.text}</Text>
          {w.button && w.onPress && <Btn label={w.button} onPress={w.onPress} />}
          <Btn kind="link" label="What do the six steps mean?" onPress={() => go({ name: "help", words })} />
        </>}
      </Card>
      {w && !!o.error && <Text style={s.error}>Couldn't check just now: {o.error}. This is what was last read.</Text>}
      {!!o.step && o.step.step > 0 && <StepBar step={o.step.step} />}

      <Text style={s.h2}>Your bitcoin</Text>
      <NavRow
        title={`Waiting: ${o.balance ? btc(o.balance.confirmed) : "…"}`}
        sub={o.balance && o.balance.arriving > 0n ? `Yours to lock or send. ${btc(o.balance.arriving)} more is arriving` : "Yours to lock or send"}
        onPress={() => setTab("bitcoin")}
      />
      <NavRow
        title={`Locked: ${o.locks ? btc(lockedSats) : "…"}`}
        sub={!o.locks ? (o.error ? "Couldn't be read just now" : "Reading your locks") : held.length === 0 ? "Nothing locked yet" : nextDate ? `Next one opens ${when(nextDate)}` : undefined}
        state={ready ? { text: "One is ready to take home", good: true } : undefined}
        onPress={() => setTab("bitcoin")}
      />
      <CheckedLine />
    </View>
  );
}

const LOCK_WORDS: Record<string, string> = { arriving: "Arriving", lapsed: "Ready to take home" };

function BitcoinTab({ o, words, go }: { o: Overview; words: string; go: Go }) {
  const shown = (o.locks ?? []).filter((l) => l.state === "locked" || l.state === "lapsed" || l.state === "arriving");
  return (
    <View>
      <Card>
        <Text style={s.kick}>Waiting</Text>
        <Text style={s.big}>{o.balance ? btc(o.balance.confirmed) : "…"}</Text>
        {o.balance && o.balance.arriving > 0n && <Text style={s.note}>+ {btc(o.balance.arriving)} arriving (not yet confirmed)</Text>}
        {o.error && <Text style={s.error}>Couldn't check just now: {o.error}.{o.balance ? " This is what was last read." : ""}</Text>}
        <Text style={[s.p, { marginBottom: 0 }]}>Yours to lock or send. It is in your own wallet: nobody else holds it.</Text>
        <Btn label="Add money" onPress={() => go({ name: "addMoney", words })} />
        <Btn kind="second" label="Send money out" onPress={() => go({ name: "send", words })} />
      </Card>

      <Text style={s.h2}>Locked</Text>
      {o.locks === null && !o.error && <ActivityIndicator style={{ marginVertical: 16 }} />}
      {o.locks === null && !!o.error && <Text style={s.note}>Your locks couldn't be read just now. Pull down to try again.</Text>}
      {o.locks !== null && shown.length === 0 && <Text style={s.note}>Nothing locked yet. When you lock bitcoin for a Crowdlock, it shows here with its date.</Text>}
      {shown.map((l) => (
        <NavRow
          key={l.address}
          title={btc(l.confirmed > 0n ? l.confirmed : l.arriving)}
          sub={l.name}
          state={{ text: LOCK_WORDS[l.state] ?? `Locked until ${when(l.locktime)}`, good: l.state === "lapsed" }}
          onPress={() => go(l.state === "lapsed" ? { name: "takeHome", words, url: l.crowdlock, address: l.address } : { name: "crowdlock", words, url: l.crowdlock })}
        />
      ))}
      <CheckedLine />
    </View>
  );
}

function CrowdlocksTab({ words, address, go }: { words: string; address: string; go: Go }) {
  return (
    <View>
      <CrowdlockList words={words} address={address} go={go} />
      <Btn label="Find Crowdlocks" onPress={() => go({ name: "findCrowdlocks", words })} />
      <Btn kind="second" label="Add one by link" onPress={() => go({ name: "addCrowdlock", words })} />
      <CheckedLine />
    </View>
  );
}

const LOOKS: [Look, string][] = [["phone", "Same as phone"], ["light", "Light"], ["dark", "Dark"]];

function MoreTab({ words, account, go }: { words: string; account: any; go: Go }) {
  const look = useLook();
  return (
    <View>
      <NavRow title="Help" sub="What the words mean, and the six steps" onPress={() => go({ name: "help", words })} />
      <NavRow title="Fee speed" sub={SPEED_LABEL[feeSpeed]} onPress={() => go({ name: "feeSpeed", words })} />
      <NavRow title="Wallet" sub={account.kind === "ledger" ? `On your Ledger (${account.ledgerName})` : "Recovery words, kept on this phone"} onPress={() => go({ name: "wallet", words })} />
      <NavRow title="For founders and co-signers" sub="Start a Crowdlock, make a co-signer key, look after one" onPress={() => go({ name: "founders", words })} />
      <NavRow title="About this app" sub={`${IS_TEST_MONEY ? "Test version" : "Real bitcoin version"} · ${NETWORK}`} onPress={() => go({ name: "about", words })} />
      <Text style={s.h2}>Light or dark</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
        {LOOKS.map(([value, label]) => (
          <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected: look === value }}
            onPress={() => { setLook(value); saveLook(value); }} style={[s.chip, look === value && s.chipOn]}>
            <Text style={[s.chipText, look === value && s.chipTextOn]}>{look === value ? "✓ " : ""}{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.note}>"Same as phone" follows your phone's own light or dark setting.</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 3: get bitcoin
// ---------------------------------------------------------------------------

function AddMoney({ words }: { words: string }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [copied, setCopied] = useState(false);
  return (
    <View>
      <Text style={s.kick}>Step 3 of 6: Get bitcoin</Text>
      <Text style={s.h1}>Add money</Text>
      <Text style={s.p}>Send bitcoin to this address. It is yours alone. Another phone can scan the square; anywhere else, paste the address.</Text>
      <View style={s.qr}><QRCode value={account.address} size={200} /></View>
      <Text style={s.mono} selectable>{account.address}</Text>
      <Btn label={copied ? "Copied. Copy it again" : "Copy my address"} onPress={async () => { await Clipboard.setStringAsync(account.address); setCopied(true); }} />
      <Warning level="know" title="Buying bitcoin is not instant anywhere">
        Expect to prove who you are and to wait for a bank transfer. In some countries you wait again before you can move the bitcoin out. How long depends on where you live and who you buy from.
      </Warning>
      <Text style={s.note}>
        Want it automatic? Set up a standing order with a service that sends bitcoin to your own wallet, and give it this address.
      </Text>
      <Text style={s.note}>Never type your recovery words into a website or give them to anyone. No Crowdlock will ever ask for them. If you lose them, your bitcoin is gone and nobody can bring it back.</Text>
      <Text style={s.note}>In many countries buying, sending or spending bitcoin has tax or reporting rules. They differ, and finding out yours is up to you.</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// More: fee speed, wallet, founders and co-signers, help, about
// ---------------------------------------------------------------------------

function FeeSpeedScreen() {
  return (
    <View>
      <FeeChoice />
      <Text style={s.p}>Every bitcoin payment pays a small fee to the network. A higher fee is quicker. Your choice is saved and used for every lock and payment.</Text>
    </View>
  );
}

function WalletScreen({ words, go }: { words: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [checking, setChecking] = useState(false);
  const [keyCheck, setKeyCheck] = useState<{ ok: boolean; text: string } | null>(null);

  // "Check my Ledger": the same Ledger, the same account, and it can still sign.
  const checkKey = async () => {
    setChecking(true); setKeyCheck(null);
    try {
      const r = await checkLedgerKey({ account, network: NETWORK });
      setKeyCheck(r.ok
        ? { ok: true, text: `Your Ledger is working. It's the same Ledger (${r.fingerprint}), it gave the same address, and it signed "${r.statement}", which checks out.` }
        : { ok: false, text: r.reason ?? "The check failed." });
    } catch (e: any) { setKeyCheck({ ok: false, text: String(e.message ?? e) }); }
    setChecking(false);
  };

  const [asking, setAsking] = useState(false);
  const remove = async () => { await forgetWords(); await forgetAddedCrowdlocks(); await forgetSavedLocks(); await forgetLedgerStore(); go({ name: "welcome" }); };

  return (
    <View>
      <Text style={s.h1}>Wallet</Text>
      <Text style={s.p}>{account.kind === "ledger"
        ? `This wallet signs on your Ledger (${account.ledgerName}). The key never leaves the Ledger.`
        : "This wallet's key is kept on this phone. Your recovery words on paper are its only backup."}</Text>
      <Text style={s.label}>Your address</Text>
      <Text style={s.mono} selectable>{account.address}</Text>
      {account.kind === "ledger" && <>
        <Btn label={checking ? "Look at your Ledger…" : "Check my Ledger"} disabled={checking} onPress={checkKey} />
        {keyCheck && <Text style={keyCheck.ok ? s.good : s.error}>{keyCheck.text}</Text>}
        <Text style={s.note}>Checks it's the same Ledger, gives the same address, and can still sign. It signs a harmless dated message you approve on its screen; nothing is sent.</Text>
      </>}
      {account.kind !== "ledger" && <Btn label="Use a Ledger instead" onPress={() => go({ name: "ledgerSetup", from: words })} />}
      {asking
        ? <Confirm
            title="Remove this wallet from the phone?"
            text={account.kind === "ledger"
              ? "Your Ledger keeps the key. This only forgets it on this phone. You can connect it again any time."
              : "Only do this if your recovery words are written down. Without them the money cannot be recovered."}
            yes="Remove this wallet" onYes={remove} onCancel={() => setAsking(false)} />
        : <Btn kind="danger" label="Remove wallet from this phone" onPress={() => setAsking(true)} />}
    </View>
  );
}

function Founders({ words, go }: { words: string; go: Go }) {
  return (
    <View>
      <Text style={s.h1}>For founders and co-signers</Text>
      <Text style={s.p}>Most people never need this page. It is for someone starting a Crowdlock of their own, or helping to run one.</Text>
      <NavRow title="Start a Crowdlock" sub="Write what it is for; the app sets it up in your own GitHub account" onPress={() => go({ name: "startCrowdlock", words })} />
      <NavRow title="Make a co-signer key" sub="The key that adds the second signature to a funded purchase" onPress={() => go({ name: "cosignerKey", words })} />
      <Text style={s.h2}>Look after a Crowdlock</Text>
      <Text style={s.p}>Update it, add co-signer keys and destinations, publish a proposal, add maintainers. Pick the Crowdlock:</Text>
      <LookAfterList words={words} go={go} />
      <Text style={s.p}>Co-signing a purchase, and declaring a proposal dead, are on the proposal itself, under "For the co-signer".</Text>
    </View>
  );
}

const SIX_STEPS: [string, string][] = [
  ["Understand", "Read what the Crowdlock is for and what you would be signing."],
  ["Sign", "Sign its declaration with your wallet. It is free and moves no money. It puts you on the public register."],
  ["Get bitcoin", "Put bitcoin into this wallet. Until you lock it, it is just yours, waiting."],
  ["Lock", "Choose how long, and lock it. Until your date nobody can move it, not even you, except into a purchase you sign for yourself."],
  ["Commit to a purchase", "Optional. If a purchase is proposed, you can sign your locked bitcoin towards it. Nothing moves unless it reaches its target."],
  ["Take it home", "On your date, whatever has not gone into a purchase is yours to take back, or to lock again."],
];

const WORDS_MEAN: [string, string][] = [
  ["Crowdlock", "A crowd of people who each lock their own bitcoin towards buying something together. Nobody holds anyone else's money, and nobody gets anything financial back."],
  ["Wallet", "An app that holds your keys. This app is one."],
  ["Key", "A secret number that proves bitcoin is yours and lets you move it."],
  ["Recovery words", "The 12 or 24 words a wallet gives you when you set it up. They are its only backup. Anyone who has them has your bitcoin."],
  ["Ledger", "A small device that keeps your key off your phone. You approve each signature on its own screen."],
  ["Blockchain", "The public record of every bitcoin payment."],
  ["Sat", "The smallest unit of bitcoin. 100,000,000 sats make one bitcoin."],
  ["Network fee", "A small payment to the bitcoin network for carrying your payment. A higher fee is quicker."],
  ["Confirmation", "The moment the network writes a payment into its record. Until then it is \"arriving\"."],
  ["Lock (timelock)", "Bitcoin that can't be moved until a date you chose. It stays in an address only you can open."],
  ["The register", "A Crowdlock's public list of who has signed and what is locked. Anyone can check it."],
  ["Fingerprint", "A short code made from exact words. Change one word and the code changes, so it proves a text is the real one."],
  ["Co-signer", "The second signature a purchase needs. A co-signer can't take or keep anyone's money: only complete what members signed for, or refuse."],
  ["xpub", "The long form of a public key. A Ledger needs it before it will lock."],
  ["Proposal", "A purchase put to a Crowdlock: what, from whom, for how much, by when."],
  ["Test network", "A practice copy of bitcoin. Its coins are worthless."],
];

function Help({ from }: { from?: string }) {
  return (
    <View>
      <Text style={s.h1}>Help</Text>
      {from && HELP_FOR[from] && <Card><Text style={s.kick}>The screen you were on</Text><Text style={[s.p, { marginBottom: 0 }]}>{HELP_FOR[from]}</Text></Card>}
      <Text style={s.h2}>The six steps</Text>
      {SIX_STEPS.map(([name, text], i) => (
        <Text key={name} style={s.p}><Text style={s.bold}>{i + 1}. {name}. </Text>{text}</Text>
      ))}
      <Text style={s.note}>Steps 1 to 4 you do now. Steps 5 and 6 come later.</Text>
      <Text style={s.h2}>What the words mean</Text>
      {WORDS_MEAN.map(([word, text]) => (
        <Text key={word} style={s.p}><Text style={s.bold}>{word}. </Text>{text}</Text>
      ))}
      <Text style={s.h2}>Getting about</Text>
      <Text style={s.p}>The phone's own Back goes back one screen. Pull a screen down to make it check again, or tap "Check now" at its foot.</Text>
    </View>
  );
}

function About() {
  return (
    <View>
      <Text style={s.h1}>About this app</Text>
      <Text style={s.p}>{IS_TEST_MONEY ? `This is the test version. It uses ${NETWORK}, a practice copy of bitcoin. Its coins are worthless: do not send real bitcoin to it.` : "This version uses real bitcoin. It is an early build and has not yet been independently reviewed."}</Text>
      <Text style={s.p}>Crowdlock is a set of published rules, not this app. Every key, record and action here can also be made with standard tools, so nothing depends on the app.</Text>
      <Text style={s.p}>This is not an investment. There is no return, no dividend and no payout, now or ever. Bitcoin rises and falls, and bitcoin you lock can fall in value while it is locked. Nothing here is legal or financial advice.</Text>
      <Text style={s.label}>Where the app reads the blockchain</Text>
      <Text style={s.mono} selectable>{EXPLORER_WEB}</Text>
      {EXPLORER_BACKUP_WEB && <>
        <Text style={s.note}>If that one doesn't answer, the app asks this one instead:</Text>
        <Text style={s.mono} selectable>{EXPLORER_BACKUP_WEB}</Text>
        <Text style={s.note}>Neither can move your money. The app believes whichever answers about balances and the time on the chain.</Text>
      </>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 4: lock
//
// Three short pages, one question each: how long, how much, then a check page
// that shows the amount, the date and the fee above the one button. The check
// page is the confirmation: nothing is signed or sent before that button.
// The money side is unchanged: the same calls, in the same order, as before.
// ---------------------------------------------------------------------------

function SumRow({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.rule }}>
      <Text style={[s.p, { marginBottom: 0 }]}>{label}</Text>
      <Text style={[s.p, s.bold, { marginBottom: 0, flexShrink: 1, textAlign: "right" }]}>{value}</Text>
    </View>
  );
}

function LockFlow({ words, url, go }: { words: string; url: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [c, setC] = useState<Loaded | null>(null);
  const [waiting, setWaiting] = useState<{ confirmed: bigint; arriving: bigint } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [page, setPage] = useState(1);
  const [years, setYears] = useState<number | null>(null);
  const [amountText, setAmountText] = useState("");
  const [rate, setRate] = useState<number | null>(null);
  const [showSpeeds, setShowSpeeds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ sent: bigint; fee: bigint; locktime: number } | null>(null);

  useEffect(() => {
    (async () => {
      const loaded: Loaded = await loadCrowdlock(url);
      setC(loaded);
      if (!loaded.ok) return;
      setYears(loaded.crowdlock.lock_lengths_years[0]);
      setPaused(keyChanges(await loadSeenKeys(url), loaded.crowdlock.cosigner_keys ?? [], await loadExpectedKeys(url)).changed);
      try { setWaiting(await waitingBalance(chain, account.address)); }
      catch (e: any) { setLoadError(String(e.message ?? e)); }
    })();
  }, [url, account.address]);

  const readRate = useCallback(() => { chain.feeRate(feeSpeed).then(setRate).catch(() => setRate(null)); }, []);
  useEffect(() => { if (page === 3) readRate(); }, [page, readRate]);

  // Back, on pages 2 and 3, goes to the page before; anywhere else it leaves.
  useBack(() => { if (page === 2 || page === 3) { if (!busy) setPage(page - 1); return true; } return false; });

  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  const openPage = () => go({ name: "crowdlock", words, url });
  if (!c.ok) return (
    <View>
      <Text style={s.h1}>This Crowdlock failed its checks</Text>
      {c.problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}
    </View>
  );

  const name: string = c.crowdlock.name;
  const cosigner: string | undefined = newestCosigner(c.crowdlock);
  const minimum = BigInt(c.crowdlock.minimum_counted_lock_sats);
  const lengths: number[] = c.crowdlock.lock_lengths_years;
  const viaRelays = Array.isArray(c.crowdlock.relays);

  // Reasons a lock can't be made here just now, each said plainly.
  const stop =
    c.crowdlock.network !== NETWORK ? "This Crowdlock uses a different network from this app."
    : !membershipOf(c.register, account.address) ? `You haven't joined ${name} yet. Read its declaration and sign first.`
    : !cosigner ? "This Crowdlock hasn't published its co-signer key yet, so nothing can be locked for it yet. Your waiting money stays yours in the meantime."
    : account.kind === "ledger" && !xpubForKey(c.crowdlock, cosigner) ? "This Crowdlock's co-signer hasn't published the xpub a Ledger needs, so a Ledger can't lock here yet: it couldn't take the lock home. Ask its founder to add it."
    : paused ? "This Crowdlock's co-signer keys have changed since you last looked. New locks are paused on this phone until you've looked at its page."
    : loadError ? `Could not read your money: ${loadError}`
    : null;
  if (stop) return (
    <View>
      <Text style={s.kick}>Step 4 of 6: Lock</Text>
      <Text style={s.h1}>Lock your bitcoin</Text>
      <Text style={s.error}>{stop}</Text>
      <Btn kind="second" label={`Look at ${name}`} onPress={openPage} />
    </View>
  );
  if (!waiting || years === null) return <ActivityIndicator style={{ marginTop: 60 }} />;

  if (!done && (waiting.confirmed === 0n || waiting.confirmed < minimum)) return (
    <View>
      <Text style={s.kick}>Step 4 of 6: Lock</Text>
      <Text style={s.h1}>Not enough waiting yet</Text>
      <Text style={s.p}>
        {waiting.confirmed === 0n
          ? `Nothing is waiting yet. Once ${shortBtc(c.crowdlock.minimum_counted_lock_sats)} is waiting, you can lock it for ${name}.`
          : `${btc(waiting.confirmed)} is waiting. ${btc(minimum - waiting.confirmed)} more and you can lock it.`}
      </Text>
      {waiting.arriving > 0n && <Text style={s.note}>+ {btc(waiting.arriving)} arriving. It can be locked once it confirms.</Text>}
      <Btn label="Add money" onPress={() => go({ name: "addMoney", words })} />
    </View>
  );

  // What the fan has asked to lock: everything, or an amount they typed.
  const chosen = ((): { amount: bigint | "all"; shown: bigint; problem?: string } => {
    const all = waiting.confirmed;
    const t = amountText.trim().replace(",", ".");
    if (t === "") return { amount: "all", shown: all };
    if (!/^\d*\.?\d{0,8}$/.test(t) || t === ".") return { amount: 0n, shown: 0n, problem: "Type an amount in BTC, like 0.001" };
    const [w, f = ""] = t.split(".");
    const sats = BigInt(w || "0") * 100000000n + BigInt((f + "00000000").slice(0, 8));
    if (sats < minimum) return { amount: sats, shown: sats, problem: `That's below this Crowdlock's minimum of ${shortBtc(c.crowdlock.minimum_counted_lock_sats)}, so it wouldn't count.` };
    if (sats > all) return { amount: sats, shown: sats, problem: "That's more than you have waiting." };
    // Asking for exactly what is waiting means everything: the fee comes out of it.
    return sats === all ? { amount: "all", shown: all } : { amount: sats, shown: sats };
  })();
  const locktime = lockDate(years);

  const lockIt = async () => {
    setBusy(true); setError(null);
    try {
      const lock = { ...lockFor({ account, cosignerPubkey: cosigner, locktime }), cosignerXpub: xpubForKey(c.crowdlock, cosigner!) };
      const feeRate = await chain.feeRate(feeSpeed);
      const tx = await buildLock({ account, chain, lock, feeRate, amount: chosen.amount });
      // The terms are saved before the money moves, and checked saved.
      await saveLock({ crowdlock: c.url, address: lock.address, locktime, cosignerPubkey: cosigner! });
      await chain.broadcast(tx.hex);
      if (viaRelays) await postToRelays(c.crowdlock, { type: "lock", owner_pubkey: account.publicKey, cosigner_pubkey: cosigner, locktime, address: lock.address }).catch(() => {});
      lastOverview = null;   // Home reads afresh
      setDone({ sent: tx.sent, fee: tx.fee, locktime });
      setPage(4);
    } catch (e: any) { setError(String(e.message ?? e)); }
    setBusy(false);
  };

  if (page === 4 && done) return (
    <View>
      <Text style={s.kick}>Step 4 of 6: Lock</Text>
      <Text style={s.h1}>Locked</Text>
      <Text style={s.good}>Locked {btc(done.sent)} for {name} until {when(done.locktime)}. The network fee was {btc(done.fee)}.</Text>
      <Text style={s.p}>Once it confirms it goes on the register by itself. You don't need to do anything.</Text>
      <Text style={s.note}>Steps 1 to 4 are done. Committing to a purchase and taking it home come later.</Text>
      <Btn label="Back to Home" onPress={() => go({ name: "home", words })} />
    </View>
  );

  if (page === 1) return (
    <View>
      <Text style={s.kick}>Step 4 of 6 · Lock · 1 of 3</Text>
      <Text style={s.h1}>How long?</Text>
      <Text style={s.p}>You are locking for <Text style={s.bold}>{name}</Text>. If that is the wrong Crowdlock, go back.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
        {lengths.map((y) => (
          <Pressable key={y} accessibilityRole="radio" accessibilityState={{ selected: years === y }} onPress={() => setYears(y)} style={[s.chip, years === y && s.chipOn]}>
            <Text style={[s.chipText, years === y && s.chipTextOn]}>{years === y ? "✓ " : ""}{lengthLabel(y)}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.p}>Opens {when(locktime)}. After that you can take it home whenever you like.</Text>
      {lengths.some((y) => y < 1) && <Text style={s.note}>The test network's clock can run ahead of real time, so a short test lock may unlock early. Real bitcoin's never does.</Text>}
      <Warning level="stop" title="Until your date, you can't touch it">
        If bitcoin's price halves, you cannot sell. Only lock what you can leave alone for the whole time. A longer lock counts for longer, and leaves you exposed for longer.
      </Warning>
      <Btn label="Next" onPress={() => setPage(2)} />
    </View>
  );

  if (page === 2) return (
    <View>
      <Text style={s.kick}>Step 4 of 6 · Lock · 2 of 3</Text>
      <Text style={s.h1}>How much?</Text>
      <Text style={s.p}><Text style={s.bold}>{btc(waiting.confirmed)}</Text> is waiting. You are locking for <Text style={s.bold}>{name}</Text>.</Text>
      <Text style={s.label}>Amount to lock, in BTC</Text>
      <Input style={s.input} keyboardType="decimal-pad" placeholder="Everything waiting" value={amountText} onChangeText={setAmountText} />
      <Text style={chosen.problem ? s.error : s.note}>
        {chosen.problem ?? `Leave it empty to lock everything. At least ${shortBtc(c.crowdlock.minimum_counted_lock_sats)}, so that it counts. Whatever you don't lock stays waiting.`}
      </Text>
      <Warning level="know" title="No outside review yet">
        Nobody outside this project has checked the code that builds a lock. A mistake could leave coins stuck. If you are thinking of a large amount, wait for that review.
      </Warning>
      <Text style={s.note}>In many countries sending, receiving or moving bitcoin has tax or reporting rules. They differ, and finding out yours is up to you.</Text>
      <Btn label="Next" disabled={!!chosen.problem} onPress={() => setPage(3)} />
    </View>
  );

  return (
    <View>
      <Text style={s.kick}>Step 4 of 6 · Lock · 3 of 3</Text>
      <Text style={s.h1}>Check and lock</Text>
      <SumRow label="You lock" value={chosen.amount === "all" ? `${btc(waiting.confirmed)} (everything waiting)` : btc(chosen.shown)} />
      <SumRow label="For" value={name} />
      <SumRow label="Until" value={when(locktime)} />
      <SumRow label="Network fee" value={rate ? `about ${Math.ceil(rate * 141)} sats (${SPEED_LABEL[feeSpeed]})` : "being worked out"} />
      <Text style={s.note}>
        A sat is the smallest unit of bitcoin: 100,000,000 make one bitcoin. {chosen.amount === "all" ? "The fee comes out of what you lock." : "The fee is paid from what stays waiting."}
      </Text>
      {!showSpeeds
        ? <Btn kind="link" label="Change the fee speed" onPress={() => setShowSpeeds(true)} />
        : <FeeChoice onChange={readRate} />}
      <Text style={s.p}>Until that date it can only leave the lock into a purchase you sign for yourself. After it, you can take it home whenever you like.</Text>
      <Warning level="stop" title="Public and permanent">
        Your lock goes on the register, with your membership and the amount, for anyone to see. It can't be undone. Anyone can work out your lock address from your public key. If you don't want this to be public, don't lock.
      </Warning>
      <LedgerHint account={account} />
      {account.kind === "ledger" && <Text style={s.note}>Your Ledger will first ask you to approve the lock's rules, then the payment. If it refuses the rules, nothing is sent.</Text>}
      {error && <Text style={s.error}>{error}</Text>}
      <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Locking…") : "Lock my bitcoin"} disabled={busy} onPress={lockIt} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 6: take it home (or lock it again)
//
// One page to take a lock home once its date has passed, with "Lock it again
// instead" as the smaller choice. Each has its own check page in place of the
// old pop-up. The money side is unchanged: the same calls, in the same order.
// ---------------------------------------------------------------------------

function HomeFlow({ words, url, address, again, go }: { words: string; url: string; address?: string; again?: boolean; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [c, setC] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<LockRow[] | null>(null);
  const [waiting, setWaiting] = useState<{ confirmed: bigint; arriving: bigint } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [picked, setPicked] = useState<string | null>(address ?? null);
  const [page, setPage] = useState<"home" | "again" | "done">(again ? "again" : "home");
  const [years, setYears] = useState<number | null>(null);
  const [addWaiting, setAddWaiting] = useState(false);
  const [showSpeeds, setShowSpeeds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const loaded: Loaded = await loadCrowdlock(url);
      setC(loaded);
      if (!loaded.ok) return;
      setYears(loaded.crowdlock.lock_lengths_years[0]);
      setPaused(keyChanges(await loadSeenKeys(url), loaded.crowdlock.cosigner_keys ?? [], await loadExpectedKeys(url)).changed);
      try {
        setWaiting(await waitingBalance(chain, account.address));
        const medianTime = await chain.medianTime();
        const onReg = locksOnRegister(loaded.register, account.address) as LockTerms[];
        const saved = (await loadSavedLocks()).filter((l) => l.crowdlock === loaded.url);
        const all: LockTerms[] = [...onReg];
        for (const l of saved) if (!all.some((x) => x.address === l.address)) all.push(l);
        const out: LockRow[] = [];
        for (const l of all) {
          const st = await lockState({ chain, lock: l, medianTime, finished: finishedLocks });
          if (st.state === "lapsed") out.push({ ...l, ...st, onRegister: onReg.some((x) => x.address === l.address) });
        }
        out.sort((a, b) => a.locktime - b.locktime);
        setRows(out);
      } catch (e: any) { setLoadError(String(e.message ?? e)); }
    })();
  }, [url, account.address]);

  // Back from "Lock it again" returns to "Take it home", unless it was opened there.
  useBack(() => { if (page === "again" && !again) { if (!busy) { setPage("home"); setError(null); } return true; } return false; });

  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return (
    <View>
      <Text style={s.h1}>This Crowdlock failed its checks</Text>
      {c.problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}
    </View>
  );
  const name: string = c.crowdlock.name;
  const kick = <Text style={s.kick}>Step 6 of 6: Take it home</Text>;

  if (page === "done" && done) return (
    <View>
      {kick}
      <Text style={s.h1}>Done</Text>
      <Text style={s.good}>{done}</Text>
      <Btn label="Back to Home" onPress={() => go({ name: "home", words })} />
    </View>
  );
  if (loadError) return (
    <View>
      {kick}
      <Text style={s.h1}>Take it home</Text>
      <Text style={s.error}>Could not read your locks: {loadError}</Text>
    </View>
  );
  if (!rows || !waiting || years === null) return <ActivityIndicator style={{ marginTop: 60 }} />;

  const row = rows.find((r) => r.address === picked) ?? (rows.length === 1 && !picked ? rows[0] : null);
  if (!row) return (
    <View>
      {kick}
      <Text style={s.h1}>Take it home</Text>
      {rows.length === 0
        ? <Text style={s.p}>No lock in {name} is ready to take home. A lock is ready once its date has passed on the bitcoin network's own clock, which runs about an hour behind real time.</Text>
        : <>
            <Text style={s.p}>Which lock?</Text>
            {rows.map((r) => <NavRow key={r.address} title={btc(r.confirmed)} sub={`Unlocked ${when(r.locktime)}`} onPress={() => setPicked(r.address)} />)}
          </>}
    </View>
  );

  const cosigner: string | undefined = newestCosigner(c.crowdlock);
  const noLedgerXpub = account.kind === "ledger" && !!cosigner && !xpubForKey(c.crowdlock, cosigner);
  const lengths: number[] = c.crowdlock.lock_lengths_years;
  const viaRelays = Array.isArray(c.crowdlock.relays);
  const oldLock = { ...row, cosignerXpub: xpubForKey(c.crowdlock, row.cosignerPubkey) };
  const feeNote = (
    <>
      <Text style={s.note}>The network fee comes out of this amount, at the {SPEED_LABEL[feeSpeed]} speed. The exact fee is shown as soon as it is sent. If the fee would be too large a share, nothing is sent.</Text>
      {!showSpeeds
        ? <Btn kind="link" label="Change the fee speed" onPress={() => setShowSpeeds(true)} />
        : <FeeChoice onChange={() => setShowSpeeds(true)} />}
    </>
  );

  const takeIt = async () => {
    setBusy(true); setError(null);
    try {
      const tx = await takeHome({ account, chain, lock: oldLock, feeRate: await chain.feeRate(feeSpeed), medianTime: await chain.medianTime() });
      await chain.broadcast(tx.hex);
      lastOverview = null;
      setDone(`${btc(tx.sent)} is on its way back to your waiting balance. The network fee was ${btc(tx.fee)}.`);
      setPage("done");
    } catch (e: any) { setError(String(e.message ?? e)); }
    setBusy(false);
  };

  if (page === "home") return (
    <View>
      {kick}
      <Text style={s.h1}>Take it home</Text>
      <SumRow label="You take home" value={btc(row.confirmed)} />
      <SumRow label="From" value={name} />
      <SumRow label="Unlocked" value={when(row.locktime)} />
      <SumRow label="It goes to" value="Your waiting balance, in this wallet" />
      <Text style={s.p}>There you can lock it again or send it out. It stops counting towards this Crowdlock's total.</Text>
      {feeNote}
      <Warning level="know" title="The network's clock runs about an hour behind">
        The date is judged by the bitcoin network's own clock, which runs about an hour behind real time on real bitcoin. If this is refused for its date, wait an hour and try again.
      </Warning>
      <LedgerHint account={account} />
      {error && <Text style={s.error}>{error}</Text>}
      <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Sending…") : "Take it home"} disabled={busy} onPress={takeIt} />
      <Btn kind="second" label="Lock it again instead" disabled={busy} onPress={() => { setError(null); setPage("again"); }} />
    </View>
  );

  // Lock it again
  const stop =
    !cosigner ? "This Crowdlock has no co-signer key published, so nothing can be locked for it."
    : noLedgerXpub ? "This Crowdlock's co-signer hasn't published the xpub a Ledger needs, so a Ledger can't lock here yet: it couldn't take the lock home. Ask its founder to add it."
    : paused ? "This Crowdlock's co-signer keys have changed since you last looked. New locks are paused on this phone until you've looked at its page."
    : null;
  if (stop) return (
    <View>
      {kick}
      <Text style={s.h1}>Lock it again</Text>
      <Text style={s.error}>{stop}</Text>
      <Btn kind="second" label={`Look at ${name}`} onPress={() => go({ name: "crowdlock", words, url })} />
    </View>
  );
  const locktime = lockDate(years);
  const extra = addWaiting ? waiting.confirmed : 0n;

  const lockAgain = async () => {
    setBusy(true); setError(null);
    try {
      const newLock = { ...lockFor({ account, cosignerPubkey: cosigner, locktime }), cosignerXpub: xpubForKey(c.crowdlock, cosigner!) };
      const tx = await relock({
        account, chain, lock: oldLock, newLock, addWaiting: extra > 0n,
        feeRate: await chain.feeRate(feeSpeed), medianTime: await chain.medianTime(),
      });
      // The new terms are saved before the money moves.
      await saveLock({ crowdlock: c.url, address: newLock.address, locktime, cosignerPubkey: cosigner! });
      await chain.broadcast(tx.hex);
      if (viaRelays) await postToRelays(c.crowdlock, { type: "lock", owner_pubkey: account.publicKey, cosigner_pubkey: cosigner, locktime, address: newLock.address }).catch(() => {});
      lastOverview = null;
      setDone(`Locked ${btc(tx.sent)} again for ${name} until ${when(locktime)}. The network fee was ${btc(tx.fee)}. Once it confirms it goes on the register by itself.`);
      setPage("done");
    } catch (e: any) { setError(String(e.message ?? e)); }
    setBusy(false);
  };

  return (
    <View>
      <Text style={s.kick}>Step 4 of 6: Lock</Text>
      <Text style={s.h1}>Lock it again</Text>
      <Text style={s.label}>For how long?</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
        {lengths.map((y) => (
          <Pressable key={y} accessibilityRole="radio" accessibilityState={{ selected: years === y }} onPress={() => setYears(y)} style={[s.chip, years === y && s.chipOn]}>
            <Text style={[s.chipText, years === y && s.chipTextOn]}>{years === y ? "✓ " : ""}{lengthLabel(y)}</Text>
          </Pressable>
        ))}
      </View>
      {waiting.confirmed > 0n && (
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: addWaiting }} onPress={() => setAddWaiting(!addWaiting)} style={{ flexDirection: "row", alignItems: "center", marginTop: 12, minHeight: 48 }}>
          <View style={[s.box, addWaiting && s.boxOn]}>{addWaiting && <Text style={s.onBrand}>✓</Text>}</View>
          <Text style={[s.p, { marginBottom: 0, flex: 1 }]}>Add the {btc(waiting.confirmed)} waiting too</Text>
        </Pressable>
      )}
      <View style={{ marginTop: 12 }}>
        <SumRow label="You lock" value={extra > 0n ? `${btc(row.confirmed + extra)} (this lock plus what is waiting)` : btc(row.confirmed)} />
        <SumRow label="For" value={name} />
        <SumRow label="Until" value={when(locktime)} />
      </View>
      <Text style={s.p}>It moves straight into the new lock in one payment. Until the new date it can only leave into a purchase you sign for yourself.</Text>
      {feeNote}
      <Warning level="stop" title="Until your date, you can't touch it">
        If bitcoin's price halves, you cannot sell. Only lock what you can leave alone for the whole time. A longer lock counts for longer, and leaves you exposed for longer.
      </Warning>
      <LedgerHint account={account} />
      {error && <Text style={s.error}>{error}</Text>}
      <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Locking…") : "Lock it again"} disabled={busy} onPress={lockAgain} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 5: commit to a purchase
//
// A proposal has its own page, with one button: Commit to this purchase.
// Committing is two short pages (which lock and how much, then a check page
// with the warning above the one button) in place of the old pop-up.
// The commitment is built, checked and posted by the same calls as before.
// ---------------------------------------------------------------------------

/** Load a Crowdlock and pick one proposal out of it by its fingerprint. */
function useProposal(url: string, hash: string) {
  const [c, setC] = useState<Loaded | null>(null);
  const load = useCallback(async () => { setC(await loadCrowdlock(url)); }, [url]);
  useEffect(() => { load(); }, [load]);
  const p = c && c.ok ? (c.proposals ?? []).find((x: any) => x.hash === hash) ?? null : null;
  return { c, p, load };
}

function ProposalScreen({ words, url, hash, go }: { words: string; url: string; hash: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const { c, p, load } = useProposal(url, hash);
  useRefresh(load);
  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return (
    <View>
      <Text style={s.h1}>This Crowdlock failed its checks</Text>
      {c.problems.map((x, i) => <Text key={i} style={s.error}>{x}</Text>)}
    </View>
  );
  if (!p) return (
    <View>
      <Text style={s.h1}>Proposal not found</Text>
      <Text style={s.p}>{c.crowdlock.name} has no proposal with that fingerprint just now. Pull down to check again.</Text>
    </View>
  );
  const member = !!membershipOf(c.register, account.address);
  return (
    <View>
      <Text style={s.kick}>A proposal in {c.crowdlock.name}</Text>
      <Text style={s.h1}>{p.title}</Text>
      <Text style={s.note}>A proposal is a purchase this Crowdlock's members are asked to pay for together. Committing to it is step 5 of 6, and it is optional.</Text>
      <ProposalDetail c={c} p={p} account={account} member={member} onCommit={() => go({ name: "commit", words, url, hash })} />
      <CheckedLine />
    </View>
  );
}

function CommitFlow({ words, url, hash, go }: { words: string; url: string; hash: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const { c, p } = useProposal(url, hash);
  const [coins, setCoins] = useState<{ lock: any; coin: any }[] | null>(null);
  // Which locks are ticked, by their place in the list. The biggest starts ticked.
  const [picks, setPicks] = useState<number[]>([0]);
  const [amount, setAmount] = useState("");
  const [page, setPage] = useState(1);
  const [progress, setProgress] = useState<string | null>(null);
  const [showSpeeds, setShowSpeeds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!c || !c.ok) return;
    (async () => {
      const out: { lock: any; coin: any }[] = [];
      const now = Math.floor(Date.now() / 1000);
      for (const l of locksOnRegister(c.register, account.address)) {
        if (l.locktime <= now) continue; // its date has passed: it goes home instead
        for (const coin of (await chain.utxos(l.address)).filter((u: any) => u.confirmed)) {
          out.push({ lock: { ...l, cosignerXpub: xpubForKey(c.crowdlock, l.cosignerPubkey) }, coin });
        }
      }
      out.sort((a, b) => b.coin.value - a.coin.value);
      setCoins(out);
    })().catch(() => setCoins([]));
  }, [c, account.address]);

  useBack(() => { if (page === 2) { if (!busy) { setPage(1); setError(null); } return true; } return false; });

  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok || !p) return (
    <View>
      <Text style={s.h1}>This can't be opened just now</Text>
      <Text style={s.p}>The Crowdlock or its proposal couldn't be read. Go back and try again.</Text>
    </View>
  );
  const kick = (n: string) => <Text style={s.kick}>Step 5 of 6 · Commit to a purchase{n}</Text>;
  const back = () => go({ name: "proposal", words, url, hash });

  if (page === 3 && done) return (
    <View>
      {kick("")}
      <Text style={s.h1}>Committed</Text>
      <Text style={s.good}>{done}</Text>
      <Text style={s.p}>Nothing has moved. Your bitcoin stays locked unless the proposal reaches its target and the co-signer completes it.</Text>
      <Btn label="Back to the proposal" onPress={back} />
    </View>
  );

  const meNow = membershipOf(c.register, account.address);
  const stop =
    !meNow ? `You haven't joined ${c.crowdlock.name}, so you can't commit to its proposals.`
    : !mayCommitTo(c, meNow, p) ? `This proposal was published under version ${proposalVersion(p, c.crowdlock)} of the declaration, and you haven't signed that version. Sign it from ${c.crowdlock.name}'s page first; it can take a few minutes to reach the register.`
    : phaseOf(p) !== "gathering" ? "This proposal isn't gathering commitments just now."
    : coins && coins.length === 0 ? "You have no locked bitcoin on this Crowdlock's register to commit. Lock some first."
    : null;
  if (stop) return (
    <View>
      {kick("")}
      <Text style={s.h1}>Commit to this purchase</Text>
      <Text style={s.error}>{stop}</Text>
      <Btn kind="second" label="Back to the proposal" onPress={back} />
    </View>
  );
  if (!coins) return <ActivityIndicator style={{ marginTop: 60 }} />;

  const chosen = picks.filter((i) => i < coins.length).sort((x, y) => x - y).map((i) => coins[i]);
  const several = chosen.length > 1;
  // An amount can be typed only with one lock ticked; with several, all of each is committed.
  const sats = !several && amount.trim() ? parseBtc(amount) : null;
  const total = chosen.reduce((n, x) => n + BigInt(x.coin.value), 0n);
  const problem = chosen.length === 0 ? "Tick at least one lock."
    : !several && amount.trim() && sats === null ? "Type the amount in BTC, like 0.001."
    : sats !== null && sats > BigInt(chosen[0].coin.value) ? "That's more than this lock holds." : null;
  const toggle = (i: number) => setPicks((old) => (old.includes(i) ? old.filter((x) => x !== i) : [...old, i]));

  // Each lock is its own commitment, signed one after another. If one fails,
  // it stops there and says how many were done; those stay committed.
  const commit = async () => {
    setBusy(true); setError(null);
    let committed = 0n, fee = 0n, remainder = 0n, made = 0;
    try {
      const feeRate = await chain.feeRate(feeSpeed);
      for (const x of chosen) {
        if (several) setProgress(`Signing ${made + 1} of ${chosen.length}…`);
        const r = await buildCommitment({ account, chain, lock: x.lock, coin: x.coin, proposalHash: p.hash, destination: p.destination, amount: sats === null ? "all" : sats, feeRate, maxFee: c.crowdlock.max_commitment_fee });
        const v = await checkCommitment({ record: r.record, crowdlock: c.crowdlock, proposal: p, destinations: c.destinations, chain, network: NETWORK });
        if (!v.valid) throw new Error(`the commitment didn't pass its own check: ${v.reason}`);
        const posted = await postCommitment(c.crowdlock, { type: "commitment", proposal: p.hash, record: r.record });
        if (!posted.ok) throw new Error("Signed, but it couldn't be sent just now. Check your connection or VPN and try again.");
        committed += r.committed; fee += r.fee; remainder += r.remainder; made++;
      }
      lastOverview = null;
      setDone(`You committed ${btc(committed)} to "${p.title}"${several ? `, from ${made} locks` : ""}. The network fee would be ${btc(fee)}, paid only if it settles.${remainder > 0n ? ` The other ${btc(remainder)} would stay locked to the same date.` : ""}`);
      setPage(3);
    } catch (e: any) {
      if (made > 0) lastOverview = null;
      setError((made > 0 ? `${made} of ${chosen.length} were committed (${btc(committed)}); they stay committed. Then this went wrong: ` : "") + String(e.message ?? e));
    }
    setProgress(null); setBusy(false);
  };

  if (page === 1) return (
    <View>
      {kick(" · 1 of 2")}
      <Text style={s.h1}>Which lock, how much?</Text>
      <Text style={s.p}>A commitment is your signed promise to pay towards "{p.title}" from a lock. Nothing moves unless the proposal reaches its target.</Text>
      <Text style={s.label}>{coins.length > 1 ? "From which locks? Tick one or more." : "From this lock"}</Text>
      <View>
        {coins.map((x, i) => (
          <Pressable key={x.coin.txid + x.coin.vout} accessibilityRole="checkbox" accessibilityState={{ checked: picks.includes(i) }} onPress={() => toggle(i)} style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
            <View style={[s.box, picks.includes(i) && s.boxOn]}>{picks.includes(i) && <Text style={s.onBrand}>✓</Text>}</View>
            <Text style={[s.p, { marginBottom: 0, flex: 1 }]}>{btc(BigInt(x.coin.value))}, locked until {when(x.lock.locktime)}</Text>
          </Pressable>
        ))}
      </View>
      {several ? (
        <Text style={s.note}>You have ticked {chosen.length} locks: {btc(total)} in all. All of each one is committed. To commit only part of a lock, tick that lock alone.</Text>
      ) : (
        <>
          <Text style={s.label}>Amount to commit, in BTC</Text>
          <Input style={s.input} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} placeholder="All of this lock" />
          {!problem && <Text style={s.note}>Leave it empty to commit all of this lock. Whatever you don't commit stays locked to the same date.</Text>}
        </>
      )}
      {problem && <Text style={s.error}>{problem}</Text>}
      <Btn label="Next" disabled={!!problem} onPress={() => setPage(2)} />
    </View>
  );

  return (
    <View>
      {kick(" · 2 of 2")}
      <Text style={s.h1}>Check and sign</Text>
      <SumRow label="You commit" value={several ? `${btc(total)} (all of ${chosen.length} locks)` : sats === null ? `${btc(total)} (all of this lock)` : btc(sats)} />
      {several && chosen.map((x) => <Text key={x.coin.txid + x.coin.vout} style={s.note}>{btc(BigInt(x.coin.value))}, locked until {when(x.lock.locktime)}</Text>)}
      <SumRow label="To" value={p.title} />
      <SumRow label="Binding until" value={atUtc(p.closes)} />
      <Text style={s.label}>It would pay this address (the seller)</Text>
      <Text style={s.mono} selectable>{p.destination}</Text>
      <Text style={s.note}>The network fee comes out of what you commit, at the {SPEED_LABEL[feeSpeed]} speed, and is paid only if it settles. The exact fee is shown as soon as you have signed. If the fee would be too large a share, nothing is signed.</Text>
      {!showSpeeds
        ? <Btn kind="link" label="Change the fee speed" onPress={() => setShowSpeeds(true)} />
        : <FeeChoice />}
      <Warning level="stop" title="A commitment can't be withdrawn">
        A commitment holds until the proposal closes, and can't be withdrawn. Nothing moves unless the proposal reaches its target and the co-signer completes it. If it doesn't, your money stays locked and comes home on its date. One catch: until then your signed commitment stays valid, so a dishonest co-signer could still complete it, but only to that same listed seller.
      </Warning>
      <LedgerHint account={account} />
      {several && <Text style={s.p}>Each lock is signed as its own commitment, one after another.{account.kind === "ledger" ? ` Your Ledger will ask you to approve ${chosen.length} times.` : ""}</Text>}
      {account.kind === "ledger" && <Text style={s.note}>Your Ledger will show the payment to the seller: approve it only if the address matches the one above.</Text>}
      {error && <Text style={s.error}>{error}</Text>}
      {busy && progress && <Text style={s.note}>{progress}</Text>}
      <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Signing…") : several ? `Sign ${chosen.length} commitments` : "Sign the commitment"} disabled={busy} onPress={commit} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// A yes-or-no before something that can't be undone, in the app's own look
// (in place of the phone's pop-up box): what happens, then one clear button.
// ---------------------------------------------------------------------------

function Confirm({ title, text, yes, onYes, onCancel }: { title: string; text: string; yes: string; onYes: () => void; onCancel: () => void }) {
  return (
    <View>
      <Warning level="stop" title={title}>{text}</Warning>
      <Btn kind="danger" label={yes} onPress={onYes} />
      <Btn kind="second" label="Cancel" onPress={onCancel} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 2: sign to join. Its own page, with its two warnings above the button.
// The signing and sending are the same calls as before.
// ---------------------------------------------------------------------------

function SignScreen({ words, url, go }: { words: string; url: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [c, setC] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => { setC(await loadCrowdlock(url)); }, [url]);
  useEffect(() => { load(); }, [load]);

  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return (
    <View>
      <Text style={s.h1}>This Crowdlock failed its checks</Text>
      {c.problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}
    </View>
  );
  const name: string = c.crowdlock.name;
  const back = () => go({ name: "crowdlock", words, url });
  const me = membershipOf(c.register, account.address);

  const join = async () => {
    setBusy(true); setResult(null);
    let signature: string;
    try { signature = await signStatementWith(account, c.statement); }
    catch (e: any) { setResult({ ok: false, text: String(e.message ?? e) }); setBusy(false); return; }
    // A Crowdlock that names relays takes its members from there: posted
    // publicly, collected by its own repository within a few minutes.
    if (Array.isArray(c.crowdlock.relays)) {
      const p = await postToRelays(c.crowdlock, { type: "join", address: account.address, signature });
      setResult(p.ok
        ? { ok: true, text: "Signed and sent. You'll be on the register within a few minutes." }
        : { ok: false, text: "It couldn't be sent just now. Your signature is fine. Check your connection, or turn off any VPN, and try again." });
      setBusy(false);
      return;
    }
    const r = await submitJoin(c.crowdlock, { address: account.address, signature });
    setResult(r.ok ? { ok: true, text: `You are member ${r.n}.` } : { ok: false, text: r.error + (r.alternative ? ` You can still ${r.alternative}.` : "") });
    setBusy(false);
    if (r.ok) setTimeout(load, 4000);
  };

  // A member asked to sign a newer version of the declaration.
  const toSign = newVersionToSign(c, account.address);
  const signNew = async () => {
    if (!toSign) return;
    setBusy(true); setResult(null);
    let signature: string;
    try { signature = await signStatementWith(account, toSign.current.statement); }
    catch (e: any) { setResult({ ok: false, text: String(e.message ?? e) }); setBusy(false); return; }
    if (!Array.isArray(c.crowdlock.relays)) {
      setResult({ ok: false, text: "This Crowdlock doesn't collect signatures from relays, so the app can't send this one. Ask its founder how to sign the new version." });
      setBusy(false); return;
    }
    const p = await postToRelays(c.crowdlock, { type: "join", address: account.address, signature });
    setResult(p.ok
      ? { ok: true, text: `Signed version ${toSign.current.version} and sent. The register will show it within a few minutes. You are still member ${me!.n}.` }
      : { ok: false, text: "It couldn't be sent just now. Your signature is fine. Check your connection, or turn off any VPN, and try again." });
    setBusy(false);
  };
  if (toSign && c.crowdlock.network === NETWORK) {
    if (result?.ok) return (
      <View>
        <Text style={s.h1}>Signed</Text>
        <Text style={s.good}>{result.text}</Text>
        <Btn label={`Back to ${name}`} onPress={back} />
      </View>
    );
    return (
      <View>
        <Text style={s.kick}>A new version of the declaration</Text>
        <Text style={s.h1}>Sign the new version?</Text>
        <Text style={s.p}>{name} has published version {toSign.current.version} of its declaration on {toSign.current.published}. You signed version {toSign.previous.version}.</Text>
        <Text style={s.label}>Why</Text>
        <Text style={s.p}>{toSign.current.reason}</Text>
        <Text style={s.label}>What changed</Text>
        <Changes changes={toSign.changes} />
        <Warning level="know" title="Nothing happens to your money either way">
          Your locks still count whether you sign or not, and your earlier signature still stands for the version you signed. Signing lets you back purchases proposed under the new version. There is no deadline.
        </Warning>
        <Text style={s.label}>What you sign</Text>
        <Text style={s.mono}>{toSign.current.statement}</Text>
        <Warning level="stop" title="This is public, and it can't be taken back">
          Your signature goes on the public register beside your first one. Once it is published, you cannot unpublish it.
        </Warning>
        <LedgerHint account={account} />
        {result && <Text style={s.error}>{result.text}</Text>}
        <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Signing and sending…") : "Sign the new version"} disabled={busy} onPress={signNew} />
        <Btn kind="second" label="Not now" onPress={back} />
      </View>
    );
  }

  if (me || result?.ok) return (
    <View>
      <Text style={s.kick}>Step 2 of 6: Sign</Text>
      <Text style={s.h1}>{me ? "You have joined" : "Signed"}</Text>
      <Text style={s.good}>{me ? `You are member ${me.n} of ${name}. Signed ${me.signed}.` : result!.text}</Text>
      <Text style={s.p}>Next is getting bitcoin into this wallet, then locking it. There is no hurry.</Text>
      <Btn label={`Back to ${name}`} onPress={back} />
    </View>
  );
  if (c.crowdlock.network !== NETWORK) return (
    <View>
      <Text style={s.h1}>Sign to join</Text>
      <Text style={s.error}>This Crowdlock uses a different network from this app.</Text>
    </View>
  );

  return (
    <View>
      <Text style={s.kick}>Step 2 of 6: Sign</Text>
      <Text style={s.h1}>Sign to join</Text>
      <Text style={s.p}>Signing is free and moves no money. It proves this wallet agrees to {name}'s declaration, and the register checks it before adding you.</Text>
      <Text style={s.label}>What you sign</Text>
      <Text style={s.mono}>{c.statement}</Text>
      <Warning level="know" title="Sign with a wallet you will keep">
        The key you sign with is the key that will own your locks, if you ever lock bitcoin. Use a wallet you mean to keep, with its recovery words written down. Recovery words are the 12 or 24 words a wallet gives you when you set it up. They are its only backup.
      </Warning>
      <Warning level="stop" title="This is public, and it can't be taken back">
        Your address and your signature go on a public register for anyone to see. Once they are published, you cannot unpublish them.
      </Warning>
      <LedgerHint account={account} />
      {result && <Text style={s.error}>{result.text}</Text>}
      <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Signing and sending…") : "Sign to join"} disabled={busy} onPress={join} />
    </View>
  );
}

/**
 * Old lines against new: lines taken out struck through, lines put in marked,
 * and long runs of unchanged lines folded to one line.
 */
function Changes({ changes }: { changes: { kind: "same" | "gone" | "new"; text: string }[] }) {
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

/** Every lock, or every proposal, of one Crowdlock: the full list its page keeps short. */
function AllOf({ what, words, url, go }: { what: "locks" | "proposals"; words: string; url: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [c, setC] = useState<Loaded | null>(null);
  const load = useCallback(async () => { setC(await loadCrowdlock(url)); }, [url]);
  useEffect(() => { load(); }, [load]);
  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return <Text style={s.error}>This Crowdlock failed its checks.</Text>;
  return (
    <View>
      <Text style={s.kick}>{c.crowdlock.name}</Text>
      {what === "locks"
        ? <MyLocks all account={account} c={c} onChange={load} onLock={() => go({ name: "lock", words, url })} onHome={(address, again) => go({ name: "takeHome", words, url, address, again })} />
        : <Proposals all c={c} account={account} onOpen={(hash) => go({ name: "proposal", words, url, hash })} />}
    </View>
  );
}

function ShareScreen({ url }: { url: string }) {
  const [c, setC] = useState<Loaded | null>(null);
  useEffect(() => { loadCrowdlock(url).then(setC); }, [url]);
  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return <Text style={s.error}>This Crowdlock failed its checks, so it can't be shared from here.</Text>;
  return (
    <View>
      <Text style={s.h1}>Share {c.crowdlock.name}</Text>
      <Text style={s.p}>Anyone with the app can point their phone's camera at this code to open it.</Text>
      <View style={s.qr}><QRCode value={openLinkFor(c.url)} size={200} /></View>
      <Btn label="Share a link" onPress={() => Share.share({
        message: `${c.crowdlock.name} — a Crowdlock. Nobody pools money, and nobody gets anything financial back. Have a look: ${shareLinkFor(c)}`,
      })} />
    </View>
  );
}

function LookAfterScreen({ words, url }: { words: string; url: string }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [c, setC] = useState<Loaded | null>(null);
  const load = useCallback(async () => { setC(await loadCrowdlock(url)); }, [url]);
  useEffect(() => { load(); }, [load]);
  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return <Text style={s.error}>This Crowdlock failed its checks, so nothing can be changed from here.</Text>;
  return (
    <View>
      <Text style={s.kick}>For its founder and maintainers</Text>
      <Text style={s.h1}>Look after {c.crowdlock.name}</Text>
      <Text style={s.p}>Most members never need this page. Everything here needs the GitHub account of the founder or of a maintainer they have added.</Text>
      {repoFromFileUrl(c.url)
        ? <LookAfter c={c} account={account} onChange={load} alone />
        : <Text style={s.note}>This Crowdlock isn't published from GitHub, so the app can't change it.</Text>}
    </View>
  );
}

/** More → For founders and co-signers: pick which Crowdlock to look after. */
function LookAfterList({ words, go }: { words: string; go: Go }) {
  const [items, setItems] = useState<Loaded[] | null>(null);
  useEffect(() => { allLinks().then((links) => Promise.all(links.map((u) => loadCrowdlock(u)))).then(setItems).catch(() => setItems([])); }, []);
  if (!items) return <ActivityIndicator style={{ marginVertical: 16 }} />;
  const mine = items.filter((c) => c.ok && repoFromFileUrl(c.url)) as Extract<Loaded, { ok: true }>[];
  if (mine.length === 0) return <Text style={s.note}>None of the Crowdlocks in your list can be looked after from the app.</Text>;
  return <>{mine.map((c) => <NavRow key={c.url} title={c.crowdlock.name} sub="Updates, co-signer keys, destinations, proposals, maintainers" onPress={() => go({ name: "lookAfter", words, url: c.url })} />)}</>;
}

// What the Help button says about the screen it was pressed on.
const HELP_FOR: Record<string, string> = {
  home: "Home shows one next step and how much bitcoin you have waiting and locked. Do the step, or leave it: nothing here has a deadline except taking part in a purchase.",
  bitcoin: "My bitcoin shows what is waiting (yours to lock or send) and every lock, with its date. Tap a lock marked \"Ready to take home\" to take it home or lock it again.",
  crowdlocks: "Crowdlocks lists the ones you have joined or added. Tap one to read it, join it, lock for it, or see its proposals.",
  more: "More holds Help, the fee speed, your wallet, and the pages for people who start or run a Crowdlock.",
  crowdlock: "This is one Crowdlock's page. From the top: anything that needs your attention, what is locked in all, your own locks, and its proposals. Its declaration, sharing and upkeep are at the bottom.",
  sign: "Signing puts your address on this Crowdlock's public register. It is free, it moves no money, and it can't be taken back.",
  addMoney: "This is your wallet's address. Send bitcoin to it from wherever you buy bitcoin. It shows as \"arriving\" until the network confirms it, then as \"waiting\".",
  lock: "Locking moves your waiting bitcoin into an address only you can open, and only after the date you choose. Three pages: how long, how much, then a check page. Nothing is sent before the last button.",
  takeHome: "Once a lock's date has passed, it is yours to take home to your waiting balance, or to lock again. The date is judged by the bitcoin network's own clock, which runs about an hour behind.",
  proposal: "A proposal is a purchase the members are asked to pay for together. You can commit locked bitcoin to it while it is gathering. Nothing moves unless it reaches its target.",
  commit: "A commitment is your signed promise to pay towards a purchase from a lock. Tick one lock or several. It can't be withdrawn, and nothing moves unless the target is reached.",
  send: "Send money out pays waiting bitcoin to any bitcoin address. A payment can't be called back, so check the address.",
  feeSpeed: "A higher fee is quicker; a lower one is cheaper and can wait hours when the network is busy. The choice is used for every payment until you change it.",
  wallet: "Your wallet is the key that owns your bitcoin. If it is kept on this phone, your recovery words on paper are its only backup.",
  founders: "These pages are for someone starting a Crowdlock of their own or helping to run one. Most people never need them.",
  lookAfter: "Looking after a Crowdlock means updating it, listing its co-signer keys and destinations, publishing proposals, adding maintainers and, rarely, publishing a new version of its declaration. Each needs the founder's or a maintainer's GitHub account.",
  share: "Sharing gives someone a link or a code that opens this Crowdlock in their app. It shares nothing about you.",
  findCrowdlocks: "Find lists Crowdlocks that have announced themselves. Each one is checked on this phone before it is shown.",
  addCrowdlock: "Paste a link to a Crowdlock's file to add it to your list. It is checked on this phone first.",
};

function Send({ words, go }: { words: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [review, setReview] = useState<null | { hex: string; txid: string; fee: bigint; sent: bigint }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      const sats = all ? "all" : BigInt(Math.round(Number(amount) * 1e8));
      const feeRate = await chain.feeRate(feeSpeed);
      setReview(await buildSend({ account, chain, to, amount: sats, feeRate }));
    } catch (e: any) { setError(String(e.message ?? e)); }
    setBusy(false);
  };
  const confirm = async () => {
    if (!review) return;
    setBusy(true); setError(null);
    try { await chain.broadcast(review.hex); setDone(review.txid); }
    catch (e: any) { setError(String(e.message ?? e)); }
    setBusy(false);
  };

  if (done) return (
    <View>
      <Text style={s.h1}>Sent</Text>
      <Text style={s.p}>How soon it confirms depends on the fee speed you chose.</Text>
      <Text style={s.mono} selectable>{EXPLORER_WEB}/tx/{done}</Text>
      <Button label="Back to wallet" onPress={() => go({ name: "home", words })} />
    </View>
  );

  return (
    <View>
      <Text style={s.h1}>Send money out</Text>
      <Text style={s.label}>To address</Text>
      <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={to} onChangeText={(t) => { setTo(t); setReview(null); }} />
      <Text style={s.label}>Amount in BTC</Text>
      <Input
        style={s.input} keyboardType="decimal-pad" editable={!all}
        value={all ? "everything" : amount} onChangeText={(t) => { setAmount(t); setReview(null); }}
      />
      <Button label={all ? "Send a set amount instead" : "Send everything"} kind="plain" onPress={() => { setAll(!all); setReview(null); }} />

      {!review && <FeeChoice />}
      {error && <Text style={s.error}>{error}</Text>}
      {!review && <LedgerHint account={account} />}
      {!review && <Button label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Checking…") : "Review"} disabled={busy || !to} onPress={prepare} />}
      {review && (
        <View style={s.panel}>
          <Text style={s.p}>Sending <Text style={s.bold}>{btc(review.sent)}</Text></Text>
          <Text style={s.p}>Network fee {btc(review.fee)}</Text>
          <Text style={s.p}>To <Text style={s.mono}>{to}</Text></Text>
          <Button label={busy ? "Sending…" : "Confirm and send"} disabled={busy} onPress={confirm} />
        </View>
      )}
      <Button label="Cancel" kind="plain" onPress={() => go({ name: "home", words })} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Crowdlocks
// ---------------------------------------------------------------------------

type Loaded = { ok: true; url: string; crowdlock: any; declarationText: string; versions: any[]; statement: string; register: any; destinations: any; proposals: any[]; proposalProblems: string[] }
  | { ok: false; url: string; problems: string[] };

async function allLinks(): Promise<string[]> {
  const added = await loadAddedCrowdlocks();
  return [...STARTING_LIST, ...added.filter((u) => !STARTING_LIST.includes(u))];
}

function CrowdlockList({ words, address, go }: { words: string; address: string; go: Go }) {
  const [items, setItems] = useState<Loaded[] | null>(null);
  const [totals, setTotals] = useState<Record<string, { sats: bigint; members: number }>>({});
  const [tick, setTick] = useState(0);
  useRefresh(() => setTick((n) => n + 1));
  useEffect(() => {
    let live = true;
    allLinks().then((links) => Promise.all(links.map((u) => loadCrowdlock(u)))).then((r) => {
      if (!live) return;
      setItems(r);
      for (const c of r) {
        if (c.ok && c.crowdlock.network === NETWORK) {
          committedTotal(c).then((t) => { if (live) setTotals((old) => ({ ...old, [c.url]: t })); }).catch(() => {});
        }
      }
    });
    return () => { live = false; };
  }, [tick]);

  if (!items) return <ActivityIndicator style={{ marginVertical: 16 }} />;
  const here = items.filter((c) => c.ok && c.crowdlock.network === NETWORK) as Extract<Loaded, { ok: true }>[];
  const elsewhere = items.filter((c) => c.ok && c.crowdlock.network !== NETWORK) as Extract<Loaded, { ok: true }>[];
  const broken = items.filter((c) => !c.ok) as Extract<Loaded, { ok: false }>[];

  return (
    <View>
      {here.map((c) => {
        const m = membershipOf(c.register, address);
        return (
          <Pressable key={c.url} style={s.card} onPress={() => go({ name: "crowdlock", words, url: c.url })}>
            <Text style={s.cardTitle}>{c.crowdlock.name}</Text>
            <Text style={s.note}>{totals[c.url]
              ? `${btc(totals[c.url].sats)} locked · ${totals[c.url].members} member${totals[c.url].members === 1 ? "" : "s"} with a lock that counts`
              : "Counting what is locked…"}</Text>
            <Text style={m ? s.good : s.link}>{m ? `You are member ${m.n}` : "Read the declaration and join →"}</Text>
          </Pressable>
        );
      })}
      {elsewhere.map((c) => (
        <View key={c.url} style={[s.card, { opacity: 0.6 }]}>
          <Text style={s.cardTitle}>{c.crowdlock.name}</Text>
          <Text style={s.note}>Uses {c.crowdlock.network === "mainnet" ? "real bitcoin" : c.crowdlock.network} — not available in this {IS_TEST_MONEY ? "test " : ""}app.</Text>
        </View>
      ))}
      {broken.map((c) => (
        <View key={c.url} style={s.card}>
          <Text style={s.error}>This Crowdlock failed its checks: {c.url}</Text>
          <Text style={s.note}>{c.problems[0]}</Text>
        </View>
      ))}
    </View>
  );
}

function CrowdlockScreen({ words, url, go }: { words: string; url: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [c, setC] = useState<Loaded | null>(null);
  const [total, setTotal] = useState<{ sats: bigint; locks: number; members: number } | null>(null);
  const [showText, setShowText] = useState(false);
  const [gbp, setGbp] = useState<number | null>(null);
  const [keyChange, setKeyChange] = useState<{ added: string[]; removed: string[] } | null>(null);
  const [record, setRecord] = useState<{ releases: any[]; unreadable: number } | null>(null);

  const load = useCallback(async () => {
    const loaded: Loaded = await loadCrowdlock(url);
    setC(loaded);
    if (loaded.ok) {
      // Has anyone changed its co-signer keys since this phone last looked?
      const keys: string[] = loaded.crowdlock.cosigner_keys ?? [];
      const seen = await loadSeenKeys(url);
      const expected = await loadExpectedKeys(url);
      const ch = keyChanges(seen, keys, expected);
      if (seen === null) await saveSeenKeys(url, keys).catch(() => {});
      else if (!ch.changed && keys.length !== seen.length) {
        // A key this phone added has now reached the website: it's seen.
        await saveSeenKeys(url, keys).catch(() => {});
        const x = new Set(keys.map((k) => k.slice(2)));
        await saveExpectedKeys(url, expected.filter((k) => !x.has(k.slice(2)))).catch(() => {});
      }
      setKeyChange(ch.changed ? { added: ch.added, removed: ch.removed } : null);
      // One after the other, not both at once: each asks the explorer about every
      // lock on the register, and a phone only keeps a few questions open at a time.
      committedTotal(loaded).then(setTotal).catch(() => setTotal(null))
        .then(() => coSignerRecord(loaded)).then(setRecord).catch(() => setRecord(null));
      poundsPerBtc(loaded.crowdlock).then(setGbp);
    }
  }, [url]);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return (
    <View>
      <Text style={s.h1}>This Crowdlock failed its checks</Text>
      <Text style={s.p}>So the app will not show it or let you sign anything for it.</Text>
      {c.problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}
    </View>
  );

  const me = membershipOf(c.register, account.address);
  const here = c.crowdlock.network === NETWORK;
  const toSign = here ? newVersionToSign(c, account.address) : null;
  const mine = me ? versionSignedBy(c, me) : null;

  return (
    <View>
      {!me && here && <Text style={s.kick}>Step 1 of 6: Understand</Text>}
      <Text style={s.h1}>{c.crowdlock.name}</Text>
      {c.crowdlock.about && <Text style={s.p}>{c.crowdlock.about}</Text>}
      {c.crowdlock.disclaimer && <Text style={s.note}>{c.crowdlock.disclaimer}</Text>}

      {keyChange && <View style={s.panel}>
        <Text style={s.error}>This Crowdlock's co-signer keys have changed since you last looked.</Text>
        {keyChange.added.map((k) => <Text key={k} style={s.note}>Added: {k.slice(0, 10)}…{k.slice(-8)}{k === newestCosigner(c.crowdlock) ? " — new locks would use this one" : ""}</Text>)}
        {keyChange.removed.map((k) => <Text key={k} style={s.note}>Removed: {k.slice(0, 10)}…{k.slice(-8)} — locks naming it no longer count</Text>)}
        <Text style={s.note}>Founders add keys for good reasons, but a co-signer decides which purchases go ahead, so a key you don't recognise matters. Check with the founder that it was them. Every change is public, with the name of the account that made it.</Text>
        {historyLinkFor(c.url) && <Button label="See who changed it" kind="plain" onPress={() => Linking.openURL(historyLinkFor(c.url)!)} />}
        <Text style={s.note}>New locks are paused on this phone until you've looked. Taking money home isn't affected.</Text>
        <Button label="I've checked — carry on" onPress={async () => { await saveSeenKeys(url, c.crowdlock.cosigner_keys ?? []).catch(() => {}); setKeyChange(null); }} />
      </View>}

      {toSign && <View style={s.panel}>
        <Text style={s.error}>This Crowdlock's declaration has a new version.</Text>
        <Text style={s.note}>Why: {toSign.current.reason}</Text>
        <Text style={s.note}>Doing nothing changes nothing about your money: your locks still count, and your signature still stands for the version you signed. Signing the new version lets you back purchases proposed under it.</Text>
        <Btn label="Read what changed" onPress={() => go({ name: "sign", words, url })} />
      </View>}

      {record && record.releases.length > 0 && <View style={s.panel}>
        <Text style={s.error}>The co-signer has released {record.releases.length === 1 ? "a lock" : `${record.releases.length} locks`} early.</Text>
        <Text style={s.note}>A lock can only open before its date with the co-signer's signature, and the co-signer is meant to sign only for a purchase. {record.releases.length === 1 ? "This one wasn't" : "These weren't"} — the money went somewhere other than a listed destination. The chain records it, so it can't be hidden.</Text>
        {record.releases.map((r) => <Text key={r.txid + r.address} style={s.note}>• {btc(BigInt(r.sats))} on {new Date(r.at * 1000).toISOString().slice(0, 10)}{r.confirmed ? "" : " (not yet in a block)"}, co-signer {String(r.cosigner ?? "?").slice(0, 10)}…, paid to {String(r.paidTo ?? "?").slice(0, 12)}…</Text>)}
        <Text style={s.note}>Ask the founder why. A co-signer who signs early releases makes the locked total untrustworthy.</Text>
      </View>}

      <View style={s.panel}>
        <Text style={s.big}>{total ? btc(total.sats) : "…"}</Text>
        <Text style={s.note}>locked and counted{total ? ` · ${total.members} member${total.members === 1 ? "" : "s"} with a lock that counts` : ""}</Text>
        <Text style={s.good}>Checked on this phone: the declaration matches its fingerprint and the register agrees.</Text>
      </View>
      <Text style={s.p}>
        A lock counts from <Text style={s.bold}>{shortBtc(c.crowdlock.minimum_counted_lock_sats)}</Text>
        {gbp ? ` (about £${Math.round(Number(c.crowdlock.minimum_counted_lock_sats) / 1e8 * gbp)} today)` : ""}.
        {" "}A smaller lock is still yours and still locked. It just isn't added to the total.
      </Text>
      <Pressable onPress={() => Linking.openURL(COUNTING_RULE_URL)} style={{ minHeight: 48, justifyContent: "center" }}>
        <Text style={s.link}>Why there is a minimum →</Text>
      </Pressable>

      {me && <Text style={[s.good, { fontSize: 18, marginTop: 8 }]}>You are member {me.n}. Signed {me.signed}.</Text>}
      {!me && !here && <Text style={s.note}>This Crowdlock uses a different network from this app.</Text>}
      {!me && here && <>
        <Warning level="know" title="This is not an investment">
          There is no return, no dividend and no payout, now or ever. If you hope to make money here, do not take part.
        </Warning>
        <Text style={s.p}>If it fails, every lock still comes home on its date, because the money never went anywhere else. There is no pot to lose.</Text>
        <Text style={s.h2}>The declaration</Text>
        <Text style={s.note}>These are the words you would sign. Read them first.</Text>
        {showText
          ? <Text style={s.declaration}>{c.declarationText}</Text>
          : <Btn kind="second" label="Read it in full" onPress={() => setShowText(true)} />}
        <Btn label="Go on to sign" onPress={() => go({ name: "sign", words, url })} />
      </>}

      {me && here && <MyLocks account={account} c={c} onChange={load} paused={!!keyChange} onLock={() => go({ name: "lock", words, url })} onHome={(address, again) => go({ name: "takeHome", words, url, address, again })} onAll={() => go({ name: "allLocks", words, url })} />}

      {here && <Proposals c={c} account={account} onOpen={(hash) => go({ name: "proposal", words, url, hash })} onAll={() => go({ name: "allProposals", words, url })} />}

      <Text style={s.h2}>More about this Crowdlock</Text>
      {me && (showText
        ? <><Text style={s.label}>The declaration you signed{c.versions.length > 1 && mine ? ` (version ${mine.version})` : ""}</Text><Text style={s.declaration}>{mine?.text ?? c.declarationText}</Text></>
        : <NavRow title="The declaration" sub={c.versions.length > 1 && mine ? `The words you signed: version ${mine.version}` : "The words you signed"} onPress={() => setShowText(true)} />)}
      {record && record.releases.length === 0 && (c.register.locks ?? []).length > 0 && <Text style={s.note}>Co-signer's record: no early releases{record.unreadable ? ` (${record.unreadable} lock${record.unreadable === 1 ? "" : "s"} couldn't be checked just now)` : ""}.</Text>}
      <NavRow title="Share it" sub="A link or a code that opens it in someone's app" onPress={() => go({ name: "share", words, url })} />
      {repoFromFileUrl(c.url) && <NavRow title="Look after it" sub="For its founder and maintainers" onPress={() => go({ name: "lookAfter", words, url })} />}

      <CheckedLine />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Locking
//
// On each Crowdlock's own page, not on Home: the waiting balance belongs to no
// Crowdlock until the fan picks one (James, 29 October). Progress towards THIS
// Crowdlock's minimum shows here, and becomes the lock button once past it.
// ---------------------------------------------------------------------------

type LockTerms = { address: string; locktime: number; cosignerPubkey: string };
type LockRow = LockTerms & { state: string; confirmed: bigint; arriving: bigint; onRegister: boolean; note?: string };

function MyLocks({ account, c, onChange, onLock, onHome, onAll, all = false, paused = false }: { account: any; c: Extract<Loaded, { ok: true }>; onChange: () => void; onLock: () => void; onHome: (address: string, again?: boolean) => void; onAll?: () => void; all?: boolean; paused?: boolean }) {
  // New locks name the newest key; older ones stay listed for the locks that name them.
  const cosigner: string | undefined = newestCosigner(c.crowdlock);
  // A Ledger can't take home a lock whose co-signer xpub it was never given.
  const noLedgerXpub = account.kind === "ledger" && !!cosigner && !xpubForKey(c.crowdlock, cosigner);
  const minimum = BigInt(c.crowdlock.minimum_counted_lock_sats);
  const [waiting, setWaiting] = useState<{ confirmed: bigint; arriving: bigint } | null>(null);
  const [rows, setRows] = useState<LockRow[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const viaRelays = Array.isArray(c.crowdlock.relays);
  // Locks already posted to the relays while this page is open, so opening it
  // again does not post them again and again. The inbox ignores repeats anyway.
  const posted = useRef(new Set<string>());

  /** Put a lock on the register: through the relays if the Crowdlock names them, else its lock endpoint. */
  const publish = useCallback(async (l: LockTerms): Promise<{ ok: boolean; note: string }> => {
    const terms = { ownerPubkey: account.publicKey, ...l };
    if (viaRelays) {
      if (posted.current.has(l.address)) return { ok: true, note: "Sent. It will be on the register within a few minutes." };
      const p = await postToRelays(c.crowdlock, { type: "lock", owner_pubkey: account.publicKey, cosigner_pubkey: l.cosignerPubkey, locktime: l.locktime, address: l.address });
      if (p.ok) posted.current.add(l.address);
      return p.ok
        ? { ok: true, note: "Sent. It will be on the register within a few minutes." }
        : { ok: false, note: "Not on the register yet: it couldn't be sent just now. It will be tried again when you open this page." };
    }
    const r = await submitLock(c.crowdlock, terms);
    return r.ok ? { ok: true, note: "Sent to the register just now — it appears within a minute." } : { ok: false, note: `Not on the register yet: ${r.error}` };
  }, [account.publicKey, c, viaRelays]);

  const refresh = useCallback(async () => {
    try {
      setWaiting(await waitingBalance(chain, account.address));
      const medianTime = await chain.medianTime();
      const onReg = locksOnRegister(c.register, account.address) as LockTerms[];
      const saved = (await loadSavedLocks()).filter((l) => l.crowdlock === c.url);
      const all: LockTerms[] = [...onReg];
      for (const l of saved) if (!all.some((x) => x.address === l.address)) all.push(l);
      const out: LockRow[] = [];
      for (const l of all) {
        const st = await lockState({ chain, lock: l, medianTime, finished: finishedLocks });
        const row: LockRow = { ...l, ...st, onRegister: onReg.some((x) => x.address === l.address) };
        // A lock with confirmed money that the register does not have yet is
        // sent to it now, every time this page opens, until it is taken.
        if (!row.onRegister && st.confirmed > 0n) {
          const p = await publish(l);
          row.note = p.note;
        }
        out.push(row);
      }
      out.sort((a, b) => a.locktime - b.locktime);
      setRows(out);
    } catch (e: any) {
      setMessage({ ok: false, text: `Could not read your money: ${e.message ?? e}` });
      setWaiting((w) => w ?? { confirmed: 0n, arriving: 0n, failed: true } as any);
      setRows((r) => r ?? []);
    }
  }, [account.address, c, publish]);
  useEffect(() => { refresh(); }, [refresh]);

  if (!cosigner) return (
    <View>
      <Text style={s.h2}>Your locks</Text>
      <Text style={s.p}>This Crowdlock hasn't published its co-signer key yet, so nothing can be locked for it yet. Your waiting money stays yours in the meantime. (If it's yours, add one under "Look after this Crowdlock" below.)</Text>
    </View>
  );

  const ready = waiting !== null && waiting.confirmed >= minimum && waiting.confirmed > 0n;

  // The Crowdlock's page lists only locks that hold money. Ones taken home, or
  // never paid into, are history: they sit behind one row, on a page of their own.
  const live = (r: LockRow) => r.state === "locked" || r.state === "arriving" || r.state === "lapsed";
  const shown = rows === null ? null : all ? rows : rows.filter(live);
  const past = rows === null ? 0 : rows.filter((r) => !live(r)).length;

  return (
    <View>
      <Text style={all ? s.h1 : s.h2}>{all ? "All your locks" : "Your locks"}</Text>
      <LedgerHint account={account} />
      {account.kind === "ledger" && !xpubForKey(c.crowdlock, cosigner) && <Text style={s.error}>This Crowdlock's co-signer hasn't published the xpub a Ledger needs, so a Ledger can't lock here yet: it couldn't take the lock home. Ask its founder to add it.</Text>}

      {all ? null : waiting === null ? <ActivityIndicator /> : (waiting as any).failed ? null : ready ? (
        <View style={s.panel}>
          <Text style={s.p}><Text style={s.bold}>{btc(waiting.confirmed)}</Text> is waiting, enough for a lock that counts.</Text>
          {paused && <Text style={s.note}>New locks are paused until you've looked at the changed co-signer keys above.</Text>}
          <Button label="Lock my bitcoin" disabled={paused || noLedgerXpub} onPress={onLock} />
        </View>
      ) : (
        <Text style={s.p}>
          {waiting.confirmed === 0n
            ? `Nothing waiting yet. Add money in My bitcoin; once ${shortBtc(c.crowdlock.minimum_counted_lock_sats)} is waiting, you can lock it here.`
            : `${btc(waiting.confirmed)} waiting. ${btc(minimum - waiting.confirmed)} more and you can lock it.`}
        </Text>
      )}
      {!all && waiting && waiting.arriving > 0n && <Text style={s.note}>+ {btc(waiting.arriving)} arriving — it can be locked once it confirms.</Text>}
      {message && <Text style={message.ok ? s.good : s.error}>{message.text}</Text>}

      {all && rows !== null && rows.length === 0 && <Text style={s.note}>You have no locks in this Crowdlock yet.</Text>}
      {shown === null ? null : shown.map((r) => (
        <View key={r.address} style={s.card}>
          <Text style={s.cardTitle}>{r.state === "withdrawn" || r.state === "empty" ? "" : `${btc(r.confirmed > 0n ? r.confirmed : r.arriving)} · `}{STATE[r.state] ?? r.state}</Text>
          <Text style={s.note}>
            {r.state === "lapsed" || r.state === "withdrawn" ? "Unlocked" : "Unlocks"} {when(r.locktime)}
            {r.state === "locked" && r.confirmed < minimum ? " · below the minimum, so not counted" : ""}
            {r.state === "locked" && r.locktime * 1000 < Date.now() ? " · date reached; the network's clock catches up within about an hour" : ""}
          </Text>
          {r.confirmed > 0n && <Text style={r.onRegister ? s.good : s.note}>{r.note ?? (r.onRegister ? "On the register" : "Goes on the register once it confirms")}</Text>}
          {r.state === "arriving" && <Text style={s.note}>Goes on the register once it confirms.</Text>}
          {all && <Text style={[s.mono, { fontSize: 12 }]} selectable>{r.address}</Text>}
          {r.state === "lapsed" && <>
            <Button label="Take it home" onPress={() => onHome(r.address)} />
            <Button label="Lock it again" kind="plain" disabled={paused || noLedgerXpub} onPress={() => onHome(r.address, true)} />
          </>}
        </View>
      ))}
      {!all && onAll && rows !== null && rows.length > 0 && (
        <NavRow title="All your locks" sub={past > 0 ? `${rows.length} in all, ${past} already taken home. With each lock's address.` : "With each lock's address"} onPress={onAll} />
      )}
    </View>
  );
}

const STATE: Record<string, string> = {
  empty: "waiting for money",
  arriving: "arriving",
  locked: "locked",
  lapsed: "ready to take home",
  withdrawn: "taken home",
};

function lengthLabel(years: number) {
  const hours = Math.round(years * 8766);
  if (years >= 1) return `${years} year${years === 1 ? "" : "s"}`;
  if (hours >= 24) return `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"} (test)`;
  return `${hours} hour${hours === 1 ? "" : "s"} (test)`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function when(locktime: number) {
  const d = new Date(locktime * 1000);
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  // A lock rounded to a plain date reads as a date; a short test lock needs the time.
  if (locktime % 86400 === 0) return date;
  return `${date}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function AddCrowdlock({ words, go, link: given }: { words: string; go: Go; link?: string }) {
  const [link, setLink] = useState(given ?? "");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);

  // Opened from a QR code or a web page: check it straight away.
  useEffect(() => { if (given) add(given); }, [given]);

  const add = async (which: string = link) => {
    setBusy(true); setProblems(null);
    const loaded: Loaded = await loadCrowdlock(which);
    setBusy(false);
    if (!loaded.ok) { setProblems(loaded.problems); return; }
    const added = await loadAddedCrowdlocks();
    if (!added.includes(loaded.url) && !STARTING_LIST.includes(loaded.url)) await saveAddedCrowdlocks([...added, loaded.url]);
    go({ name: "crowdlock", words, url: loaded.url });
  };

  return (
    <View>
      <Text style={s.h1}>Add a Crowdlock</Text>
      <Text style={s.p}>Paste the link to a Crowdlock's file. It is checked on this phone before it is added.</Text>
      <Input style={s.input} autoCapitalize="none" autoCorrect={false} placeholder="https://…/crowdlocks/name.json" value={link} onChangeText={(t) => { setLink(t); setProblems(null); }} />
      {problems && <><Text style={s.error}>It failed its checks, so it wasn't added:</Text>{problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}</>}
      <Button label={busy ? "Checking…" : "Check and add"} disabled={busy || !link} onPress={() => add()} />
      <Text style={s.note}>Someone showing you a Crowdlock's QR code? Point your phone's own camera at it — it opens here by itself.</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Making a co-signer key
//
// Its own 12 words, shown once to be written on paper and never saved; only
// the public half leaves the screen, by QR code. The same words make the same
// key in method/cosigner/generate.mjs, Sparrow or Electrum, so nothing here is
// needed to use it later. Done with the phone in airplane mode.
// ---------------------------------------------------------------------------

function CosignerKey({ words: walletWords, forStart, go }: { words: string; forStart?: "cosigner" | "testPasted"; go: Go }) {
  const [stage, setStage] = useState<"intro" | "show" | "check" | "result" | "existing">("intro");
  const [coWords, setCoWords] = useState("");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pub, setPub] = useState<string | null>(null);
  const [xpub, setXpub] = useState<string | null>(null);
  const list = coWords.split(" ");
  // Leave this screen and the words are gone from memory with it.
  // Opened from Start a Crowdlock, it goes back there, taking the public half
  // (never the words) with it. Opened from More, it goes Home.
  const leave = () => {
    if (forStart && startDraft && (xpub || pub)) startDraft[forStart] = xpub ?? pub;
    setCoWords(""); setTyped(""); setPub(null); setXpub(null);
    go(forStart ? { name: "startCrowdlock", words: walletWords } : { name: "home", words: walletWords });
  };

  if (stage === "intro") return (
    <View>
      <Text style={s.h1}>Make a co-signer key</Text>
      <Text style={s.p}>A Crowdlock's co-signer adds the second signature that lets a funded purchase go through. The key can't take or keep anyone's money — it can only complete what members already signed for, or refuse.</Text>
      <Text style={[s.p, s.bold]}>Switch on airplane mode before you start, and leave it on until you've finished.</Text>
      <Text style={s.note}>You'll get 12 words to write on paper, twice — one copy kept outside your house. Those words are the key. They're never saved on this phone, and the same words work in other wallets (Sparrow, Electrum) or the project's own script, so you never depend on this app. Never use your wallet's own words for this.</Text>
      <Button label="Make a new co-signer key" onPress={() => { setCoWords(newCosignerWords()); setStage("show"); }} />
      <Button label="Check words I already have" kind="plain" onPress={() => setStage("existing")} />
      <Button label="Back" kind="plain" onPress={leave} />
    </View>
  );

  if (stage === "show") return (
    <View>
      <Text style={s.h1}>Write these down</Text>
      <Text style={s.p}>On paper, in order, twice. Label each copy so whoever finds it in five years knows what it is:</Text>
      <Text style={s.mono}>Co-signer key · {new Date().toISOString().slice(0, 10)} · {COSIGNER_PATH}</Text>
      <View style={s.words}>
        {list.map((w, i) => <Text key={i} style={s.word}><Text style={s.wordNum}>{i + 1}. </Text>{w}</Text>)}
      </View>
      <Text style={s.note}>No screenshots, notes, email or cloud. Once you leave this screen, these words are gone from the phone.</Text>
      <Button label="I've written them down twice" onPress={() => setStage("check")} />
    </View>
  );

  if (stage === "check") return (
    <CheckEveryWord
      words={coWords}
      onDone={() => { const k = cosignerKeyFromWords(coWords); setPub(k.publicKey); setXpub(k.xpub); setCoWords(""); setStage("result"); }}
      onShowAgain={() => setStage("show")}
    />
  );

  if (stage === "existing") return (
    <View>
      <Text style={s.h1}>Check co-signer words</Text>
      <Text style={s.p}>Type the words from your paper (12, or 24 for a key made elsewhere) to see the public key they make — the way to prove the paper works.</Text>
      <WordsInput value={typed} onChange={(t) => { setTyped(t); setProblem(null); }} />
      {problem && <Text style={s.error}>{problem}</Text>}
      <Button label="Show the key" onPress={() => {
        if (tidyWords(typed) === tidyWords(walletWords)) { setProblem("Those are this wallet's own words. A co-signer key must have words of its own — otherwise it would be the same key as your member key."); return; }
        try { const k = cosignerKeyFromWords(typed); setPub(k.publicKey); setXpub(k.xpub); setTyped(""); setStage("result"); }
        catch (e: any) { setProblem(String(e.message ?? e)); }
      }} />
      <Button label="Back" kind="plain" onPress={() => setStage("intro")} />
    </View>
  );

  return (
    <View>
      <Text style={s.h1}>The public half</Text>
      <Text style={s.p}>This is safe to share. It goes in the Crowdlock's file as its co-signer key. Copy it, or scan it from another device — never retype it by hand: one wrong character makes every lock built from it unable to go into a purchase.</Text>
      <View style={s.qr}><QRCode value={pub ?? ""} size={220} /></View>
      <Text style={s.mono} selectable>{pub}</Text>
      <Text style={s.note}>Check what's scanned starts {pub?.slice(0, 6)} and ends {pub?.slice(-6)}.</Text>
      <Button label="Copy it" onPress={() => pub && Clipboard.setStringAsync(pub)} />
      <Text style={s.h2}>Its xpub, for hardware wallets</Text>
      <Text style={s.p}>Also public. It's the same key in the longer form a Ledger needs before it will lock with it. Paste this one into "Add this co-signer key" instead of the key above and the app adds both.</Text>
      <Text style={s.mono} selectable>{xpub}</Text>
      <Button label="Copy the xpub" kind="plain" onPress={() => xpub && Clipboard.setStringAsync(xpub)} />
      <Text style={s.note}>You can switch airplane mode off now. Keep the two paper copies apart.</Text>
      <Button label={forStart ? "Use this key and go back to my Crowdlock" : "Done"} onPress={leave} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Looking after a Crowdlock: updates and maintainers
//
// For its founder and the maintainers they add — the people GitHub lets write
// to its repository. Nobody's update is pushed into anybody's Crowdlock: an
// update is offered, and only someone with access can apply it, in a commit
// that says what changed.
// ---------------------------------------------------------------------------

/** Sign in to GitHub when needed, showing the short code; reuses this session's sign-in. */
function useGitHub(step: (text: string) => void = () => {}) {
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const withSignIn = async (task: (token: string) => Promise<void>) => {
    let token = currentSignIn();
    if (!token) {
      step("Asking GitHub for a sign-in code…");
      const c = await startSignIn();
      step("Waiting for you to sign in to GitHub…");
      setCode({ userCode: c.userCode, verificationUri: c.verificationUri });
      try { token = await waitForSignIn(c); } finally { setCode(null); }
      rememberSignIn(token);
    }
    await task(token as string);
  };
  const codeView = code && (
    <View style={s.panel}>
      <Text style={s.p}>Sign in to GitHub and type this code:</Text>
      <Text style={[s.big, { textAlign: "center", letterSpacing: 2 }]} selectable>{code.userCode}</Text>
      <Button label="Copy the code" kind="plain" onPress={() => Clipboard.setStringAsync(code.userCode)} />
      <Button label="Open GitHub" onPress={() => Linking.openURL(code.verificationUri)} />
      <Text style={s.note}>Come back here once you've allowed it — this carries on by itself.</Text>
    </View>
  );
  return { withSignIn, codeView };
}

function MaintainerAdvice() {
  return <>
    <Text style={s.p}>A maintainer can keep this Crowdlock running if you can't. They can update it and change what's published at its address — the same as you. They can never touch anyone's money.</Text>
    <Text style={s.note}>Choose someone you trust personally, in a different household, likely to be reachable in a year. Being a committed member is a good sign but not enough on its own — anyone can become one for the price of a lock. Two maintainers is the right number.</Text>
    <Text style={s.note}>They don't need to know GitHub: they make a free account at github.com (an email and a password) and tell you their username. You add it here; GitHub emails them an invitation; they tap Accept.</Text>
  </>;
}

function MaintainerForm({ owner, repo }: { owner: string; repo: string }) {
  const { withSignIn, codeView } = useGitHub();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      await withSignIn(async (token) => {
        if (!(await canWrite(token, owner, repo))) throw new Error("You're signed in to a GitHub account that isn't this Crowdlock's founder or a maintainer, so it can't add anyone.");
        const r = await addMaintainer({ token, owner, repo, username: name });
        setMsg({ ok: true, text: r === "already" ? `${name.trim()} already looks after it.` : `Invitation sent to ${name.trim()}. GitHub will email them — once they tap Accept, they're a maintainer.` });
        setName("");
      });
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setBusy(false);
  };
  return <>
    <Text style={s.label}>Their GitHub username</Text>
    <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={name} onChangeText={setName} placeholder="e.g. janesmith" />
    {codeView}
    {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
    <Button label={busy ? "Adding…" : "Add a maintainer"} disabled={busy || !name.trim()} onPress={add} />
  </>;
}

// Adding a co-signer key to a Crowdlock that already exists. Only ever adds:
// a lock names its co-signer inside its address, so removing a key would stop
// every lock naming it from being counted. The newest key is the one new locks
// use; the older ones retire on their own once the locks naming them lapse.
function CosignerKeys({ c, account, owner, repo, onChange }: { c: Extract<Loaded, { ok: true }>; account: any; owner: string; repo: string; onChange: () => void }) {
  const { withSignIn, codeView } = useGitHub();
  const keys: string[] = c.crowdlock.cosigner_keys ?? [];
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // A pasted xpub stands for its first key, and is published beside it.
  const pastedXpub = keyFromXpub(key) ? key.trim() : null;
  const k: string = (pastedXpub ? keyFromXpub(pastedXpub) : key.trim().toLowerCase()) ?? "";
  const xpubs: string[] = c.crowdlock.cosigner_xpubs ?? [];
  const has = keys.some((x) => x.slice(2) === k.slice(2));
  const problem = !k ? null
    : !isPublicKey(k) ? "That isn't a public key or an xpub. Copy it whole from where the key was made."
    : k.slice(2) === String(account.publicKey).slice(2) ? "That's your own wallet's key. A co-signer must be a separate key, or the person who locks could also approve the purchase alone."
    : has && (!pastedXpub || xpubs.includes(pastedXpub)) ? "This Crowdlock already has that key."
    : null;
  const path = pathInRepo(c.url);
  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      await withSignIn(async (token) => {
        if (!(await canWrite(token, owner, repo))) throw new Error("Only this Crowdlock's founder and its maintainers can change it, and the GitHub account you signed in with isn't one of them.");
        await addCosignerKey({ token, owner, repo, path, key: k, xpub: pastedXpub as any, check: checkWithNewKey });
        // You made this change, so this phone needn't warn you about it —
        // but the website hasn't caught up yet, so it's expected, not seen.
        await saveExpectedKeys(c.url, [...(await loadExpectedKeys(c.url)), k]).catch(() => {});
        setKey("");
        setMsg({ ok: true, text: has ? "Added its xpub. Its website updates in a minute or two." : "Added. Its website updates in a minute or two — then pull down to check again and new locks will use it." });
        setTimeout(onChange, 90000);
      });
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setBusy(false);
  };
  return <>
    <Text style={s.label}>Co-signer keys</Text>
    {keys.length === 0 ? <Text style={s.note}>None yet, so nobody can lock for it. Add one below.</Text>
      : keys.map((x, i) => (
        <View key={x} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[s.note, { flex: 1 }]}>{x.slice(0, 10)}…{x.slice(-8)}{i === keys.length - 1 ? "  · new locks use this one" : "  · kept for locks already made"}{xpubForKey(c.crowdlock, x) ? "  · hardware wallets can lock" : ""}</Text>
          <Button label="Copy" kind="plain" onPress={() => Clipboard.setStringAsync(x)} />
        </View>))}
    <Text style={s.note}>Adding a key never removes one, so every lock already made keeps counting. Don't have one? Make it from More → "For founders and co-signers", ideally on a phone that holds no money{c.crowdlock.network === "mainnet" ? ", and keep its words on paper only" : ""}.</Text>
    <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={key} onChangeText={(t) => { setKey(t); setMsg(null); }} placeholder="Paste its xpub, or its key: 02… or 03…" />
    {!!pastedXpub && <Text style={s.note}>That xpub stands for {k.slice(0, 10)}…{k.slice(-8)}.{has ? " This Crowdlock already has that key, so only the xpub will be added." : ""}</Text>}
    {keys.length > 0 && keys.some((x) => !xpubForKey(c.crowdlock, x)) && <Text style={s.note}>Members with a hardware wallet can only lock with a key whose xpub is published. To add one for a key already here, paste its xpub.</Text>}
    {problem && <Text style={s.error}>{problem}</Text>}
    {!path && <Text style={s.error}>Can't tell where this Crowdlock's file sits in its repository.</Text>}
    {codeView}
    {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
    <Button label={busy ? "Adding…" : "Add this co-signer key"} disabled={busy || !k || !!problem || !path} onPress={add} />
  </>;
}

function LookAfter({ c, account, onChange, alone }: { c: Extract<Loaded, { ok: true }>; account: any; onChange: () => void; alone?: boolean }) {
  const where = repoFromFileUrl(c.url);
  const [status, setStatus] = useState<string>("unknown");
  const [published, setPublished] = useState<string | null>(null);
  const [open, setOpen] = useState(!!alone);
  // On its own page, each job has a row; this is the one that is open.
  const [job, setJob] = useState<null | "update" | "keys" | "destinations" | "proposal" | "maintainers" | "version">(null);
  useBack(() => { if (alone && job) { setJob(null); return true; } return false; });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { withSignIn, codeView } = useGitHub();

  useEffect(() => {
    if (!where) return;
    const site = baseFor(c.url);
    (async () => {
      let v: string | null = null, hasInbox = false;
      // A founder's site keeps its inbox at relay/; this repository keeps it under method/.
      for (const folder of ["relay/", "method/relay/"]) {
        try { const r = await fetch(`${site}${folder}VERSION`, { cache: "no-store" }); if (r.ok) { v = await r.text(); break; } } catch {}
      }
      if (v === null) {
        for (const folder of ["relay/", "method/relay/"]) {
          try { if ((await fetch(`${site}${folder}inbox.mjs`, { cache: "no-store" })).ok) { hasInbox = true; break; } } catch {}
        }
      }
      setPublished(v);
      setStatus(versionStatus(v, template.version, hasInbox));
    })();
  }, [c.url]);

  // Not on GitHub Pages: nothing here can help. The Crowdlock method's reference
  // repository ("source") is where this code is written, so it is never offered an
  // update — but its maintainers can still be added here.
  if (!where) return null;

  const update = async () => {
    setBusy(true); setMsg(null);
    try {
      await withSignIn(async (token) => {
        if (!(await canWrite(token, where.owner, where.repo))) throw new Error("Only this Crowdlock's founder and its maintainers can update it, and the GitHub account you signed in with isn't one of them.");
        const changes = changesSince(published, template.changes);
        await updateCrowdlockRepo({
          token, owner: where.owner, repo: where.repo, files: template.files,
          message: `Update this Crowdlock's inbox to ${template.version}\n\nApplied from the Crowdlock app by a maintainer. Only the inbox's code changes; the declaration, register and settings are untouched.\n\n${changes.map((x: any) => `- ${x.change}`).join("\n")}`,
        });
        setStatus("current"); setPublished(template.version);
        setMsg({ ok: true, text: "Updated. Its inbox restarts on the new code within a few minutes." });
      });
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setBusy(false);
  };

  const updateBox = <>
    {status === "behind" && <View style={s.panel}>
      <Text style={s.p}>What the update brings:</Text>
      {changesSince(published, template.changes).map((x: any) => <Text key={x.version} style={s.note}>• {x.change}</Text>)}
      <Text style={s.note}>It changes only the inbox's code, in one commit anyone can read. The declaration, register and settings are untouched.</Text>
      <Button label={busy ? "Updating…" : "Update it"} disabled={busy} onPress={update} />
    </View>}
    {status === "current" && <Text style={s.good}>Its inbox is up to date.</Text>}
    {status !== "behind" && status !== "current" && <Text style={s.note}>Nothing to update just now.</Text>}
    {codeView}
    {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
  </>;
  const here = c.crowdlock.network === NETWORK;

  // On its own page: a list of jobs, then one job at a time.
  if (alone) return job === null ? (
    <View>
      <NavRow title="Update it" sub={status === "behind" ? "An update is available" : status === "current" ? "Its inbox is up to date" : "Keep its inbox on the newest code"} state={status === "behind" ? { text: "Update available", good: false } : undefined} onPress={() => setJob("update")} />
      <NavRow title="Co-signer keys" sub="The keys that can add the second signature to a purchase" onPress={() => setJob("keys")} />
      {here && <NavRow title="Destinations" sub="The addresses a proposal is allowed to pay" onPress={() => setJob("destinations")} />}
      {here && <NavRow title="Write a proposal" sub="Put a purchase to the members" onPress={() => setJob("proposal")} />}
      <NavRow title="Maintainers" sub="Other people who can help run it" onPress={() => setJob("maintainers")} />
      <NavRow title="Publish a new version of the declaration" sub={c.versions.length > 1 ? `It is on version ${c.versions[c.versions.length - 1].version}` : "If its words ever need to change"} onPress={() => setJob("version")} />
    </View>
  ) : (
    <View>
      <Btn kind="link" label="‹ All the jobs" onPress={() => setJob(null)} />
      {job === "update" && <><Text style={s.h2}>Update it</Text><Text style={s.note}>A Crowdlock's inbox is the small program, in its own GitHub account, that collects new members, locks and commitments. The app can bring it up to the newest version.</Text>{updateBox}</>}
      {job === "keys" && <><CosignerKeys c={c} account={account} owner={where.owner} repo={where.repo} onChange={onChange} /></>}
      {job === "destinations" && <><Destinations c={c} account={account} owner={where.owner} repo={where.repo} onChange={onChange} /></>}
      {job === "proposal" && <><WriteProposal c={c} owner={where.owner} repo={where.repo} onChange={onChange} /></>}
      {job === "maintainers" && <><Text style={s.h2}>Maintainers</Text><MaintainerAdvice /><MaintainerForm owner={where.owner} repo={where.repo} /></>}
      {job === "version" && <NewDeclarationVersion c={c} owner={where.owner} repo={where.repo} onChange={onChange} />}
    </View>
  );

  return (
    <View>
      <Text style={s.h2}>Look after this Crowdlock</Text>
      {status === "behind" && <Text style={s.note}>An update is available for this Crowdlock's inbox.</Text>}
      {!open ? <Button label="For its founder and maintainers" kind="plain" onPress={() => setOpen(true)} /> : <>
        {updateBox}
        <CosignerKeys c={c} account={account} owner={where.owner} repo={where.repo} onChange={onChange} />
        {here && <Destinations c={c} account={account} owner={where.owner} repo={where.repo} onChange={onChange} />}
        {here && <WriteProposal c={c} owner={where.owner} repo={where.repo} onChange={onChange} />}
        <Text style={s.label}>Maintainers</Text>
        <MaintainerAdvice />
        <MaintainerForm owner={where.owner} repo={where.repo} />
      </>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Proposals and committing (milestone 5)
//
// A proposal is read from the Crowdlock's own proposals file and checked on
// the phone (method/js/proposals.mjs). Commitments travel on the Crowdlock's
// relays; every one is checked here before it is counted
// (checkCommitment, held to the reference checker). Nothing moves until the
// co-signer completes them, which happens only when the target is met.
// ---------------------------------------------------------------------------

const PHASE_TEXT: Record<string, string> = {
  soon: "Not open yet",
  gathering: "Gathering commitments",
  settling: "Closed — settling",
  over: "Over",
};

function minorDigits(currency: string) {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}
function money(minor: number, currency: string) {
  const d = minorDigits(currency);
  return `${(minor / 10 ** d).toFixed(d)} ${currency}`;
}
function parseBtc(text: string): bigint | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d{0,8}$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w || "0") * 100000000n + BigInt((f + "00000000").slice(0, 8));
}
const atUtc = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

type Pile = { count: number; sats: number; mine: { sats: number; record: any; paid?: boolean }[]; good: { record: any; at: number; sats: number }[]; completed: number; refused: string[]; paid: number; paidCount: number; notice: any | null };

async function readPile(c: Extract<Loaded, { ok: true }>, p: any, account: any): Promise<Pile> {
  // The repository's pile first — the lasting record, in the order the
  // Crowdlock received them — then anything on the relays it hasn't taken yet.
  const items: any[] = [];
  const inPile = new Set<string>();
  const hrp = c.crowdlock.network === "mainnet" ? "bc" : "tb";
  let notice: any = null;
  const genuine = (n: any) => noticeIsGenuine(n, { crowdlock: c.crowdlock, hash: p.hash, hrp, addressOf: memberAddressForOwnerKey }).ok;
  try {
    const r = await fetch(resolvePath(pilePath(c.crowdlock.register.proposals, p.hash), baseFor(c.url)), { cache: "no-store" });
    if (r.ok) {
      const file = await r.json();
      if (checkPileShape(file, p.hash).ok) {
        for (const x of file.commitments) { items.push({ type: "commitment", record: x.record, at: Date.parse(x.submitted) / 1000 }); inPile.add(x.record.tx); }
        if (file.notice && genuine(file.notice)) notice = file.notice;
      }
    }
  } catch {}
  for (const it of await fetchCommitments(c.crowdlock, p.hash)) {
    if (it.type === "commitment" && inPile.has(it.record.tx)) continue;
    // Not yet in the repository: ordered after everything that is.
    items.push(it.type === "commitment" ? { ...it, at: Math.max(it.at, ...items.map((x) => x.at ?? 0)) + 1 } : it);
  }
  const pile: Pile = { count: 0, sats: 0, mine: [], good: [], completed: 0, refused: [], paid: 0, paidCount: 0, notice };
  for (const it of items) {
    if (it.type === "completed") { pile.completed++; continue; }
    if (it.type === "notice") { if (!pile.notice && genuine(it.notice)) pile.notice = { ...it.notice, published: new Date(it.at * 1000).toISOString() }; continue; }
    const v = await checkCommitment({ record: it.record, crowdlock: c.crowdlock, proposal: p, destinations: c.destinations, chain, network: NETWORK });
    if (!v.valid) {
      // A commitment whose coin is gone may be one the co-signer completed:
      // then it was paid, not refused.
      if (/already been spent/.test(v.reason)) {
        const paid = await commitmentPaid({ record: it.record, chain });
        if (paid > 0) {
          pile.paid += paid; pile.paidCount++;
          if (it.record.lock?.owner_pubkey === account.publicKey) pile.mine.push({ sats: paid, record: it.record, paid: true });
          continue;
        }
      }
      pile.refused.push(v.reason); continue;
    }
    pile.count++; pile.sats += v.committedSats;
    pile.good.push({ record: it.record, at: it.at, sats: v.committedSats });
    if (v.ownerPubkey === account.publicKey) pile.mine.push({ sats: v.committedSats, record: it.record });
  }
  return pile;
}

function Proposals({ c, account, onOpen, onAll, all = false }: { c: Extract<Loaded, { ok: true }>; account: any; onOpen: (hash: string) => void; onAll?: () => void; all?: boolean }) {
  const list: any[] = c.proposals ?? [];
  // Which proposals are finished: paid in full, declared dead, or past their dates.
  const [ended, setEnded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    for (const p of list) {
      readPile(c, p, account).then((x) => {
        if (live && (x.paid >= p.target.sats || !!x.notice)) setEnded((old) => ({ ...old, [p.hash]: true }));
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [c]);
  if (!c.crowdlock.register.proposals && list.length === 0) return null;
  const finished = (p: any) => !!ended[p.hash] || phaseOf(p) === "over";
  const newest = list.slice().reverse();
  const shown = all ? newest : newest.filter((p) => !finished(p));
  const past = newest.length - newest.filter((p) => !finished(p)).length;
  return (
    <View>
      <Text style={all ? s.h1 : s.h2}>{all ? "All proposals" : "Proposals"}</Text>
      {(c.proposalProblems ?? []).map((x: string, i: number) => <Text key={i} style={s.error}>{x}</Text>)}
      {list.length === 0 && <Text style={s.note}>No proposals yet. A proposal is a purchase the members are asked to pay for together. When one is published, you can commit your locked bitcoin to it here. Nothing moves unless it reaches its target.</Text>}
      {!all && list.length > 0 && shown.length === 0 && <Text style={s.note}>No proposal is open just now. When one is published, it shows here.</Text>}
      {shown.map((p) => (
        <Pressable key={p.hash} accessibilityRole="button" onPress={() => onOpen(p.hash)} style={s.card}>
          <Text style={[s.p, s.bold]}>{p.title}</Text>
          <ProposalStatus c={c} p={p} account={account} />
          <Text style={s.link}>Read it and see who's committed →</Text>
        </Pressable>
      ))}
      {!all && onAll && past > 0 && <NavRow title="Past proposals" sub={`${past} finished: paid, declared dead, or over`} onPress={onAll} />}
    </View>
  );
}

/** The one line under a proposal's title: its phase, or that it has been paid, or declared dead. */
function ProposalStatus({ c, p, account }: { c: Extract<Loaded, { ok: true }>; p: any; account: any }) {
  const [paid, setPaid] = useState<number | null>(null);
  const [dead, setDead] = useState(false);
  useEffect(() => { readPile(c, p, account).then((x) => { setPaid(x.paid); setDead(!!x.notice); }).catch(() => setPaid(null)); }, [c, p]);
  if (paid !== null && paid >= p.target.sats) return <Text style={s.good}>Funded and paid · {btc(BigInt(paid))} sent to the seller · closed</Text>;
  if (dead) return <Text style={s.note}>Declared dead · didn't reach its target · closed · nothing will move</Text>;
  return <Text style={s.note}>{PHASE_TEXT[phaseOf(p)]} · needs {money(p.requires, p.currency)} · target about {shortBtc(p.target.sats)}{paid ? ` · ${btc(BigInt(paid))} paid so far` : ""}</Text>;
}

function ProposalDetail({ c, p, account, member, onCommit }: { c: Extract<Loaded, { ok: true }>; p: any; account: any; member: boolean; onCommit: () => void }) {
  const [pile, setPile] = useState<Pile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timePhase = phaseOf(p);
  const refresh = useCallback(() => { setErr(null); readPile(c, p, account).then(setPile).catch((e) => setErr(String(e?.message ?? e))); }, [c, p]);
  useEffect(() => { refresh(); }, [refresh]);
  // Once the co-signer has paid out the target, the proposal is finished:
  // nothing more can be committed or completed, whatever its dates say.
  const funded = !!pile && pile.paid >= p.target.sats;
  const dead = !!pile?.notice && !funded;
  const phase = funded ? "funded" : dead ? "dead" : timePhase;
  const met = pile ? pile.paid + pile.sats >= p.target.sats : false;
  return (
    <View>
      <Text style={s.declaration}>{p.text}</Text>
      <Text style={s.label}>Pays</Text>
      <Text style={s.mono}>{p.destination}</Text>
      <Text style={s.note}>Needs {money(p.requires, p.currency)}. Target {btc(BigInt(p.target.sats))} at {p.target.rate} ({p.target.at.slice(0, 10)}); the target is restated as the price moves.</Text>
      <Text style={s.note}>Gathers from {atUtc(p.opens)} to {atUtc(p.closes)}. Settles by {atUtc(p.settles_by)}.</Text>
      <Text style={s.label}>Committed so far</Text>
      {err ? <Text style={s.error}>{err}</Text> : !pile ? <ActivityIndicator /> : <>
        {dead ? <>
          <Text style={s.error}>Declared dead by the co-signer{pile.notice.published ? ` on ${String(pile.notice.published).slice(0, 10)}` : ""}: it didn't reach its target, and none of its commitments will be completed. Your money stays locked and comes home on its date as usual.</Text>
          <Text style={s.note}>The notice is signed by the co-signer's key and checked on this phone.</Text>
        </> : funded ? <>
          <Text style={s.good}>Funded and paid. {btc(BigInt(pile.paid))} went to the seller in {pile.paidCount} payment{pile.paidCount === 1 ? "" : "s"}, completed by the co-signer and sent. This proposal is closed.</Text>
        </> : <>
          <Text style={s.big}>{btc(BigInt(pile.sats + pile.paid))}</Text>
          <Text style={s.note}>{pile.count} waiting{pile.paidCount ? ` · ${pile.paidCount} paid (${btc(BigInt(pile.paid))})` : ""}, each checked on this phone{pile.refused.length ? ` · ${pile.refused.length} refused` : ""}. {met ? "The target is met." : `${btc(BigInt(Math.max(0, p.target.sats - pile.sats - pile.paid)))} to go.`}</Text>
        </>}
        {pile.refused.slice(0, 3).map((r, i) => <Text key={i} style={s.note}>Refused: {r}</Text>)}
        {pile.mine.length > 0 && <Text style={s.good}>{pile.mine.some((m) => m.paid) ? "Your commitment was paid: " : "You've committed "}{btc(BigInt(pile.mine.reduce((n, m) => n + m.sats, 0)))}.</Text>}
      </>}
      {member && phase === "gathering" && <Btn label={pile && pile.mine.length > 0 ? "Commit more to this purchase" : "Commit to this purchase"} onPress={onCommit} />}
      {!member && phase === "gathering" && <Text style={s.note}>Only members can commit. Join this Crowdlock and lock bitcoin first.</Text>}
      {member && phase === "soon" && <Text style={s.note}>You can commit once it opens.</Text>}
      {pile && (phase === "gathering" || phase === "settling") && <CoSign c={c} p={p} pile={pile} onDone={() => setTimeout(refresh, 3000)} />}
      {pile && (phase === "settling" || phase === "over") && !met && <DeclareDead c={c} p={p} onDone={() => setTimeout(refresh, 3000)} />}
    </View>
  );
}

const SEND_FROM_APP = 25;
const SEND_PER_PASS_NOTE = "up to 25 every few minutes";

function DeclareDead({ c, p, onDone }: { c: Extract<Loaded, { ok: true }>; p: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const askDead: [string, string] = ["Declare this proposal dead?",
    "This publishes a notice, signed with the co-signer key, that the proposal didn't reach its target and that you will complete none of its commitments. Anyone can check it. It can't be taken back."];
  const deadGo = async () => { setAsking(false); {
      setBusy(true); setMsg(null);
      try {
        const notice = signNoticeWith({ words, crowdlock: c.crowdlock, statement: noticeStatement(p.hash), network: NETWORK });
        const posted = await postCommitment(c.crowdlock, { type: "notice", proposal: p.hash, notice });
        setWords("");
        setMsg(posted.ok ? { ok: true, text: `Published to ${posted.accepted} of ${posted.total} relays. The Crowdlock's repository records it on its next pass.` }
          : { ok: false, text: "Signed, but no relay took it just now. Check your connection and try again." });
        onDone();
      } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
      setBusy(false);
    } };
  return !open ? <Button label="For the co-signer: declare it dead" kind="plain" onPress={() => setOpen(true)} /> : (
    <View style={s.panel}>
      <Text style={s.label}>It closed short of its target</Text>
      <Text style={s.note}>Nothing has to happen: without your signature no commitment can ever move. Publishing a signed notice tells every member so, publicly, and promises you won't complete any of them. Type the co-signer key's words; they're used once and not saved.</Text>
      <WordsInput value={words} onChange={setWords} placeholder="The co-signer key's 12 words" />
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      {asking ? <Confirm title={askDead[0]} text={askDead[1]} yes="Sign and publish" onYes={deadGo} onCancel={() => setAsking(false)} /> : <Button label={busy ? "Signing…" : "Sign and publish the notice"} disabled={busy || !wordsAreValid(tidyWords(words))} onPress={() => setAsking(true)} />}
    </View>
  );
}

function CoSign({ c, p, pile, onDone }: { c: Extract<Loaded, { ok: true }>; p: any; pile: Pile; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const met = pile.sats + pile.paid >= p.target.sats;
  // Settled in submission order, until the target is met and no further
  // (counting what has already been paid).
  const order = pile.good.slice().sort((a, b) => a.at - b.at);
  const take: typeof order = [];
  let sum = pile.paid;
  for (const g of order) { if (sum >= p.target.sats) break; take.push(g); sum += g.sats; }
  const [asking, setAsking] = useState(false);
  const askSend: [string, string] = ["Complete and send?",
      `This completes ${take.length} commitment${take.length === 1 ? "" : "s"} (${btc(BigInt(sum - pile.paid))}) and sends them to ${p.destination.slice(0, 14)}…. It can't be undone. Do this only if the proposal is genuine and its target is met.`];
  const sendGo = async () => {
     setAsking(false); {
        setBusy(true); setMsg(null);
        // A handful are sent from here at once. More than that are published
        // only, for the Crowdlock's repository to send a few at a time
        // (pacing: thousands at once would push up fees for everyone).
        const sendHere = take.length <= SEND_FROM_APP;
        let sent = 0; const failed: string[] = [];
        for (const g of take) {
          try {
            const hex = await completeCommitmentWith({ words, record: g.record, chain });
            await postCommitment(c.crowdlock, { type: "completed", proposal: p.hash, tx: hex });
            if (sendHere) await chain.broadcast(hex);
            sent++;
          } catch (e: any) { failed.push(String(e.message ?? e)); }
        }
        setWords("");
        setMsg(failed.length
          ? { ok: sent > 0, text: `${sendHere ? "Sent" : "Completed"} ${sent} of ${take.length}. ${failed[0]}` }
          : sendHere ? { ok: true, text: `Completed and sent all ${sent}. They'll confirm over the next blocks.` }
          : { ok: true, text: `Completed all ${sent} and published them. The Crowdlock's repository sends them ${SEND_PER_PASS_NOTE}, so they reach the network paced rather than all at once.` });
        setBusy(false); onDone();
      }
  };
  return (
    <View>
      {!open ? <Button label="For the co-signer" kind="plain" onPress={() => setOpen(true)} /> : <View style={s.panel}>
        <Text style={s.label}>Co-sign this proposal</Text>
        <Text style={s.note}>Only once the target is met, and only if the proposal and its destination are genuine. Type the co-signer key's words, ideally on a phone that is otherwise offline. They are used once and not saved.</Text>
        {!met && <Text style={s.error}>The target isn't met yet: {btc(BigInt(pile.sats))} of {btc(BigInt(p.target.sats))}. Nothing should be completed.</Text>}
        <WordsInput value={words} onChange={setWords} placeholder="The co-signer key's 12 words" />
        {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
        {asking ? <Confirm title={askSend[0]} text={askSend[1]} yes="Complete and send" onYes={sendGo} onCancel={() => setAsking(false)} /> : <Button label={busy ? "Completing…" : `Complete ${take.length} and send`} disabled={busy || !met || !wordsAreValid(tidyWords(words)) || take.length === 0} onPress={() => setAsking(true)} />}
      </View>}
    </View>
  );
}

// For founders and maintainers: approve a destination, and publish a proposal.

function isAddressOn(address: string, network: string) {
  try { bitcoinAddress.toOutputScript(address, NETWORKS[network === "mainnet" ? "mainnet" : "testnet4"].network); return true; } catch { return false; }
}

function repoPathOf(c: Extract<Loaded, { ok: true }>, path: string) {
  return pathInRepo(resolvePath(path, baseFor(c.url)));
}

function Destinations({ c, account, owner, repo, onChange }: { c: Extract<Loaded, { ok: true }>; account: any; owner: string; repo: string; onChange: () => void }) {
  const [step, setStep] = useState("");
  const { withSignIn, codeView } = useGitHub(setStep);
  const [address, setAddress] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = c.destinations ?? { entries: [], attestors: [] };
  const hrp = c.crowdlock.network === "mainnet" ? "bc" : "tb";
  const isAttestor = (d.attestors ?? []).includes(account.address);
  const path = repoPathOf(c, c.crowdlock.register.destinations);
  const add = async () => {
    setBusy(true); setMsg(null);
    try {
      await withSignIn(async (token) => {
        setStep("Checking you can change this Crowdlock…");
        if (!(await canWrite(token, owner, repo))) throw new Error("Only this Crowdlock's founder and its maintainers can change it, and the GitHub account you signed in with isn't one of them.");
        setStep("Reading its destinations list…");
        await addDestination({
          token, owner, repo, path,
          makeEntry: (file: any) => nextDestination(file, { address, text }),
          attest: async (entry: any) => {
            setStep(account.kind === "ledger" ? `Waiting for your Ledger — unlock it, open ${ledgerAppFor(NETWORK)}, and approve the message it shows.` : "Signing…");
            const signature = await signStatementWith(account, attestationStatement(entry));
            setStep("Saving it to the Crowdlock on GitHub…");
            return { address: account.address, signature };
          },
          check: (file: any) => {
            const ch = chainIsIntact(file.entries);
            const last = file.entries[file.entries.length - 1];
            const att = attestationsAreValid(last, { attestors: file.attestors, threshold: file.threshold, hrp });
            return { ok: ch.ok && att.ok, problems: [ch.reason, att.reason].filter(Boolean) };
          },
        });
        setAddress(""); setText("");
        setMsg({ ok: true, text: `Added and attested. ${c.crowdlock.destination_wait_days ? `A proposal can use it after ${c.crowdlock.destination_wait_days} days.` : "A proposal can use it straight away (this Crowdlock has no waiting period)."} Its website updates in a minute or two.` });
        setTimeout(onChange, 90000);
      });
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setBusy(false); setStep("");
  };
  return <>
    <Text style={s.label}>Destinations</Text>
    {(d.entries ?? []).length === 0 ? <Text style={s.note}>None yet. A proposal can only pay an address on this list, attested by this Crowdlock's attestors.</Text>
      : d.entries.map((e: any) => <Text key={e.index} style={s.note}>{e.index}. {e.op === "revoke" ? "Revoked: " : ""}{e.text} — {e.address.slice(0, 14)}…{e.address.slice(-6)}, public since {String(e.firstSeen ?? "?").slice(0, 10)}</Text>)}
    {!isAttestor ? <Text style={s.note}>This wallet isn't one of its attestors, so it can't approve a destination.</Text> : <>
      <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={address} onChangeText={(t) => { setAddress(t); setMsg(null); }} placeholder="The address a purchase would pay" />
      <Input style={s.input} value={text} onChangeText={(t) => { setText(t); setMsg(null); }} placeholder="Who it belongs to and what it's for" />
      <Text style={s.note}>Your wallet signs to say you attest it{account.kind === "ledger" ? " — approve the message on your Ledger" : ""}. Anyone can check that signature.</Text>
      {codeView}
      {busy && !!step && <Text style={s.note}>{step}</Text>}
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      {!!address.trim() && !isAddressOn(address.trim(), c.crowdlock.network) && <Text style={s.error}>That isn't a {c.crowdlock.network === "mainnet" ? "bitcoin" : "test-network"} address. Paste the seller's whole address.</Text>}
      <Button label={busy ? "Adding…" : "Add and attest this destination"} disabled={busy || !isAddressOn(address.trim(), c.crowdlock.network) || !text.trim() || /[|\n]/.test(text) || !path} onPress={add} />
    </>}
  </>;
}

function WriteProposal({ c, owner, repo, onChange }: { c: Extract<Loaded, { ok: true }>; owner: string; repo: string; onChange: () => void }) {
  const { withSignIn, codeView } = useGitHub();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [dest, setDest] = useState<string>("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("");
  const [days, setDays] = useState(String(Math.min(14, c.crowdlock.gathering_window_max_days)));
  const [settle, setSettle] = useState(String(Math.min(7, c.crowdlock.settlement_window_max_days)));
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = c.destinations ?? { entries: [] };
  const hrp = c.crowdlock.network === "mainnet" ? "bc" : "tb";
  const nowIso = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const usable = (d.entries ?? []).filter((e: any) => e.op === "add").filter((e: any) => destinationIsPermitted({
    address: e.address, entries: d.entries, opensAt: nowIso(), minimumAgeDays: c.crowdlock.destination_wait_days,
    attestors: d.attestors, threshold: d.threshold, hrp,
  }).permitted);
  const draft = (): { p?: any; problem?: string } => {
    const cur = currency.trim();
    if (!title.trim()) return { problem: "Give it a title." };
    if (!text.trim()) return { problem: "Say what is being bought, from whom, and why." };
    if (!dest) return { problem: "Choose a destination." };
    if (!/^[A-Z]{3}$/.test(cur)) return { problem: "Type the currency's three-letter code, like GBP, EUR or USD." };
    const digits = minorDigits(cur);
    const t = price.trim().replace(",", ".");
    if (!new RegExp(`^\\d+(\\.\\d{0,${digits}})?$`).test(t)) return { problem: `Write the price in ${cur}, with at most ${digits} decimal places.` };
    const [w, f = ""] = t.split(".");
    const minor = Number(w) * 10 ** digits + Number((f + "0".repeat(digits)).slice(0, digits) || "0");
    const g = Number(days), st = Number(settle);
    if (!Number.isInteger(g) || g < 1 || g > c.crowdlock.gathering_window_max_days) return { problem: `Gathering is 1 to ${c.crowdlock.gathering_window_max_days} days.` };
    if (!Number.isInteger(st) || st < 0 || st > c.crowdlock.settlement_window_max_days) return { problem: `Settling is 0 to ${c.crowdlock.settlement_window_max_days} days.` };
    const sats = parseBtc(target);
    if (!sats || sats <= 0n) return { problem: "Give the target in BTC — what the price is in bitcoin today." };
    const opens = nowIso();
    const closes = new Date(Date.parse(opens) + g * 86400000).toISOString().replace(".000Z", "Z");
    const settlesBy = new Date(Date.parse(closes) + st * 86400000).toISOString().replace(".000Z", "Z");
    const p: any = { title: title.trim(), text: text.trim(), destination: dest, requires: minor, currency: cur, opens, closes, settles_by: settlesBy };
    // Published under the current version of the declaration; only members who
    // signed it may commit. Version 1 is left unsaid, as it always was.
    const v = currentVersion(c.crowdlock).version;
    if (v !== c.crowdlock.declaration.version) p.declaration_version = v;
    try { p.hash = proposalHash(fieldsOf(p, c.crowdlock.declaration.sha256)); } catch (e: any) { return { problem: e.message }; }
    const rate = Number(sats) > 0 ? (minor / 10 ** digits) / (Number(sats) / 1e8) : 0;
    p.target = { sats: Number(sats), rate: `1 BTC = ${rate.toFixed(digits)} ${cur}`, at: opens };
    return { p };
  };
  const { p: preview, problem } = draft();
  const proposalsPath = c.crowdlock.register.proposals ?? c.crowdlock.register.destinations.replace(/[^/]*$/, "proposals.json");
  const [asking, setAsking] = useState(false);
  const publish = async () => {
    const now = draft();
    if (!now.p) return;
    setAsking(false);
    {
        setBusy(true); setMsg(null);
        try {
          await withSignIn(async (token) => {
            if (!(await canWrite(token, owner, repo))) throw new Error("Only this Crowdlock's founder and its maintainers can publish a proposal for it.");
            await publishProposal({
              token, owner, repo, crowdlockPath: pathInRepo(c.url), proposalsPath, proposal: now.p,
              check: ({ crowdlock, file }: any) => checkProposals(file, crowdlock),
            });
            setTitle(""); setText(""); setPrice(""); setTarget("");
            setMsg({ ok: true, text: "Published. Its website updates in a minute or two — then pull down on the Crowdlock to check again and it appears under Proposals." });
            setTimeout(onChange, 90000);
          });
        } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
        setBusy(false);
    }
  };
  return <>
    <Text style={s.label}>Write a proposal</Text>
    {usable.length === 0 ? <Text style={s.note}>No destination is ready yet. Add and attest one above{c.crowdlock.destination_wait_days ? `, then wait ${c.crowdlock.destination_wait_days} days` : ""}.</Text> : <>
      <Input style={s.input} value={title} onChangeText={setTitle} placeholder="Title" />
      <Input style={[s.input, { minHeight: 120, textAlignVertical: "top" }]} multiline value={text} onChangeText={setText} placeholder="What is being bought, from whom, and why" />
      <Text style={s.label}>Pays (tap one)</Text>
      {usable.map((e: any) => <Pressable key={e.index} onPress={() => setDest(e.address)} style={[s.btn, dest !== e.address && s.btnPlain, { alignItems: "flex-start" }]}><Text style={[s.btnText, dest !== e.address && s.btnTextPlain, { fontSize: 15 }]}>{dest === e.address ? "✓ " : ""}{e.text} — {e.address.slice(0, 14)}…{e.address.slice(-6)}</Text></Pressable>)}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Input style={[s.input, { flex: 2 }]} keyboardType="decimal-pad" value={price} onChangeText={setPrice} placeholder="Price" />
        <Input style={[s.input, { flex: 1 }]} autoCapitalize="characters" value={currency} onChangeText={(t) => setCurrency(t.toUpperCase())} placeholder="Currency" maxLength={3} />
      </View>
      <Input style={s.input} keyboardType="decimal-pad" value={target} onChangeText={setTarget} placeholder="Target in BTC (the price in bitcoin today)" />
      <Text style={s.note}>Gathers for (days, at most {c.crowdlock.gathering_window_max_days}) and settles for (days, at most {c.crowdlock.settlement_window_max_days}):</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Input style={[s.input, { flex: 1 }]} keyboardType="number-pad" value={days} onChangeText={setDays} />
        <Input style={[s.input, { flex: 1 }]} keyboardType="number-pad" value={settle} onChangeText={setSettle} />
      </View>
      {problem ? <Text style={s.note}>{problem}</Text> : <Text style={s.note}>Opens now, closes {preview.closes.slice(0, 10)}, settles by {preview.settles_by.slice(0, 10)}. Fingerprint {preview.hash.slice(0, 12)}…</Text>}
      {codeView}
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      {asking && preview
        ? <Confirm
            title="Publish this proposal?"
            text={`"${preview.title}": ${money(preview.requires, preview.currency)} to ${preview.destination}, gathering until ${preview.closes.slice(0, 10)}. Once published it can't be changed: its wording and price are fixed by its fingerprint.`}
            yes="Publish this proposal" onYes={publish} onCancel={() => setAsking(false)} />
        : <Button label={busy ? "Publishing…" : "Publish this proposal"} disabled={busy || !!problem} onPress={() => setAsking(true)} />}
    </>}
  </>;
}

/**
 * Publish a new version of the declaration. The Crowdlock keeps its identity,
 * its register and every lock; members are shown the reason and the changed
 * lines and asked whether they wish to sign it (spec/registration-format.md,
 * "Versioning"). Starts from the current text, so the founder edits rather
 * than retypes.
 */
function NewDeclarationVersion({ c, owner, repo, onChange }: { c: Extract<Loaded, { ok: true }>; owner: string; repo: string; onChange: () => void }) {
  const { withSignIn, codeView } = useGitHub();
  const cur = c.versions[c.versions.length - 1];
  const [text, setText] = useState<string>(cur.text ?? "");
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canonical = canonicalise(text);
  const sha = declarationHash(text);
  const changes = lineChanges(cur.text ?? "", canonical);
  const problem =
    !text.trim() ? "Write the new version." :
    sha === cur.sha256 || c.versions.some((v: any) => v.sha256 === sha) ? "Change the words first: this is the same as a version already published." :
    !reason.trim() ? "Say in one line why it is changing. Every member reads this first." :
    /\n/.test(reason) || reason.trim().length > 300 ? "Keep the reason to one line, up to 300 characters." :
    cur.text?.includes(NO_RETURNS) && !canonical.includes(NO_RETURNS) ? "The line saying nobody receives anything financial must stay, word for word." :
    null;
  const publish = async () => {
    setAsking(false); setBusy(true); setMsg(null);
    try {
      await withSignIn(async (token) => {
        if (!(await canWrite(token, owner, repo))) throw new Error("Only this Crowdlock's founder and its maintainers can publish a new version of its declaration.");
        const today = new Date().toISOString().slice(0, 10);
        const r = await publishDeclarationVersion({
          token, owner, repo, crowdlockPath: pathInRepo(c.url), text: canonical, sha256: sha, reason: reason.trim(), today,
          check: (file: any, t: string) => checkCrowdlock(file, { versionTexts: { [file.declaration_versions.at(-1).version]: t } }),
        });
        setMsg({ ok: true, text: `Published as version ${r.version}. Its website updates in a minute or two; then every member sees it on this Crowdlock's page and is asked whether they wish to sign it.` });
        setReason("");
        setTimeout(onChange, 90000);
      });
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setBusy(false);
  };
  return <>
    <Text style={s.h2}>Publish a new version of the declaration</Text>
    <Text style={s.p}>Do this only if the words really must change, for example because a solicitor found a problem. It is version {cur.version} now; this would be version {cur.version + 1}.</Text>
    <Text style={s.note}>What stays the same: the Crowdlock, its fingerprint, every member's number, every signature (it still stands for the version it signed) and every lock, which keeps counting. New members sign the new version. Existing members are shown your reason and the changed lines and asked whether they wish to sign it; only members who have signed it can back purchases proposed after this.</Text>
    <Text style={s.label}>The new version</Text>
    <Input style={[s.input, { minHeight: 220, textAlignVertical: "top" }]} multiline value={text} onChangeText={setText} />
    <Text style={s.label}>Why it is changing (one line)</Text>
    <Input style={s.input} value={reason} onChangeText={setReason} placeholder="For example: a solicitor asked for clause 4 to be clearer" maxLength={300} />
    <Text style={s.label}>What changes</Text>
    <Changes changes={changes} />
    {problem ? <Text style={s.note}>{problem}</Text> : <Text style={s.note}>Its fingerprint will be {sha.slice(0, 12)}…</Text>}
    {codeView}
    {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
    {asking && !problem
      ? <Confirm
          title={`Publish version ${cur.version + 1}?`}
          text="This can't be undone. The new text and your reason become part of this Crowdlock's public history, and every member is asked whether they wish to sign it."
          yes={`Publish version ${cur.version + 1}`} onYes={publish} onCancel={() => setAsking(false)} />
      : <Button label={busy ? "Publishing…" : `Publish version ${cur.version + 1}`} kind="danger" disabled={busy || !!problem} onPress={() => setAsking(true)} />}
  </>;
}

// ---------------------------------------------------------------------------
// Finding Crowdlocks
//
// Read from announcements on public relays — no directory, nobody to approve
// a listing. Every Crowdlock found is loaded and checked like any other before
// it is shown, and the list is ranked by committed bitcoin, which nobody can
// fake by announcing.
// ---------------------------------------------------------------------------

type Found = { url: string; name: string; about: string; sats: bigint; members: number };

function FindCrowdlocks({ words, go }: { words: string; go: Go }) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [mine, setMine] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Asking the relays…");
  const [tick, setTick] = useState(0);
  useRefresh(() => setTick((n) => n + 1));

  useEffect(() => {
    let live = true;
    (async () => {
      setMine(await allLinks());
      const announced = (await fetchAnnouncements(DEFAULT_RELAYS)).filter((a: any) => a.network === NETWORK).slice(0, 40);
      if (!live) return;
      setStatus(announced.length ? `Checking ${announced.length} announced Crowdlock${announced.length === 1 ? "" : "s"}…` : "");
      const results: Found[] = [];
      await Promise.all(announced.map(async (a: any) => {
        const c: Loaded = await loadCrowdlock(a.url);
        if (!c.ok || c.crowdlock.network !== NETWORK) return;   // fails its checks: never shown
        let t = { sats: 0n, members: 0 };
        try { t = await committedTotal(c); } catch {}
        results.push({ url: c.url, name: c.crowdlock.name, about: c.crowdlock.about ?? "", sats: t.sats, members: t.members });
      }));
      if (live) { setFound(rankFound(results)); setStatus(""); }
    })().catch(() => { if (live) { setFound([]); setStatus("Couldn't reach the relays — check your connection, or turn off any VPN."); } });
    return () => { live = false; };
  }, [tick]);

  const open = async (url: string) => {
    const added = await loadAddedCrowdlocks();
    if (!added.includes(url) && !STARTING_LIST.includes(url)) await saveAddedCrowdlocks([...added, url]);
    go({ name: "crowdlock", words, url });
  };

  const shown = (found ?? []).filter((f) => matchesSearch(f, query));
  return (
    <View>
      <Text style={s.h1}>Find Crowdlocks</Text>
      <Text style={s.p}>Crowdlocks that have announced themselves, ranked by the bitcoin actually locked in them. Anyone can announce one; nobody can fake the money, and anything that fails its checks isn't shown.</Text>
      <Input style={s.input} placeholder="Search by name or purpose" value={query} onChangeText={setQuery} autoCorrect={false} />
      {status ? <Text style={s.note}>{status}</Text> : null}
      {found === null && <ActivityIndicator style={{ marginVertical: 16 }} />}
      {found !== null && shown.length === 0 && !status && <Text style={s.note}>{query ? "Nothing matches that." : "None found yet."}</Text>}
      {shown.map((f) => (
        <Pressable key={f.url} style={s.card} onPress={() => open(f.url)}>
          <Text style={s.cardTitle}>{f.name}</Text>
          {f.about ? <Text style={s.p}>{f.about}</Text> : null}
          <Text style={s.note}>{btc(f.sats)} locked · {f.members} member{f.members === 1 ? "" : "s"} with a lock that counts</Text>
          <Text style={mine.includes(f.url) ? s.good : s.link}>{mine.includes(f.url) ? "In your list" : "Have a look →"}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Starting a Crowdlock
// ---------------------------------------------------------------------------

// What has been typed into Start a Crowdlock so far, kept while the app is
// open so that leaving the form (to make a co-signer key) loses nothing.
// It holds no secret: every field here ends up published.
let startDraft: Record<string, any> | null = null;

function StartCrowdlock({ words, go }: { words: string; go: Go }) {
  const d = startDraft ?? {};
  const [network, setNetwork] = useState<"testnet4" | "mainnet">(d.network ?? "testnet4");
  const [name, setName] = useState<string>(d.name ?? "");
  const [about, setAbout] = useState<string>(d.about ?? "");
  const [title, setTitle] = useState<string>(d.title ?? "OUR DECLARATION");
  const [text, setText] = useState<string>(d.text ?? declarationSkeleton("OUR DECLARATION"));
  const [minimum, setMinimum] = useState<string>(d.minimum ?? "0.002");
  const [waitDays, setWaitDays] = useState<string>(d.waitDays ?? "7");
  const [gatherDays, setGatherDays] = useState<string>(d.gatherDays ?? "28");
  const [settleDays, setSettleDays] = useState<string>(d.settleDays ?? "14");
  const [cosigner, setCosigner] = useState<string>(d.cosigner ?? "");
  const [testPasted, setTestPasted] = useState<string>(d.testPasted ?? "");
  const [problems, setProblems] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<any>(null);
  const [stage, setStage] = useState<"form" | "signin" | "creating" | "done">("form");
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ links: { label: string; url: string }[]; repoUrl: string; inboxStarted: boolean; owner: string; repo: string } | null>(null);
  const [at, setAt] = useState<number>(d.at ?? 0);   // which page of the form
  useEffect(() => { startDraft = { network, name, about, title, text, minimum, waitDays, gatherDays, settleDays, cosigner, testPasted, at }; },
    [network, name, about, title, text, minimum, waitDays, gatherDays, settleDays, cosigner, testPasted, at]);
  useBack(() => { if (stage === "form" && at > 0) { setAt(at - 1); return true; } return false; });

  // The test copy's co-signer key is made here, from the founder's own words,
  // on a path of its own. The real one is pasted in from wherever it lives.
  // A Ledger wallet has no words here to make the test copy's co-signer from,
  // so its founder pastes one (made with "Make a co-signer key").
  const testCoKey = useMemo(() => (isLedgerWallet(words) ? { publicKey: "", xpub: "" } : cosignerFromWords(words, "testnet4")), [words]);
  const testCo = testCoKey.publicKey;

  const input = (siteBase: string) => {
    const t = minimum.trim().replace(",", ".");
    const [w, f = ""] = t.split(".");
    const minimumSats = /^\d*\.?\d{0,8}$/.test(t) && t !== "" ? Number(BigInt(w || "0") * 100000000n + BigInt((f + "00000000").slice(0, 8))) : NaN;
    return {
      name, about, title, declarationText: text, network, minimumSats, waitDays: /^\d{1,3}$/.test(waitDays.trim()) ? Number(waitDays.trim()) : NaN,
      gatherDays: /^\d{1,3}$/.test(gatherDays.trim()) ? Number(gatherDays.trim()) : NaN,
      settleDays: /^\d{1,3}$/.test(settleDays.trim()) ? Number(settleDays.trim()) : NaN,
      cosignerPubkey: keyFromXpub(cosigner) ? cosigner.trim() : cosigner.trim().toLowerCase(), testCosignerPubkey: testPasted.trim() || testCoKey.xpub,
      siteBase, today: new Date().toISOString().slice(0, 10),
    };
  };

  const check = () => {
    const r = build(input("https://example.github.io/check/"));
    setProblems(r.ok ? null : r.problems);
    setChecked(r.ok ? r : null);
  };

  const create = async () => {
    setError(null); setStage("signin"); setSteps([]);
    try {
      const c = await startSignIn();
      setCode({ userCode: c.userCode, verificationUri: c.verificationUri });
      const token = await waitForSignIn(c);
      rememberSignIn(token);
      setStage("creating");
      // A free repository name: the Crowdlock's own, or with a number after it.
      let repoName = slugify(name), n = 1;
      while ((await whoAmI(token, repoName)).taken) repoName = `${slugify(name).slice(0, 36)}-${++n}`;
      const me = await whoAmI(token, repoName);
      const built = build(input(`https://${me.login.toLowerCase()}.github.io/${repoName}/`));
      if (!built.ok) throw new Error(built.problems.join(" "));
      const made = await createRepo({ token, repoName, description: about.trim(), files: built.files, progress: (st: string) => setSteps((x) => [...x, st]) });
      // Add it to this phone's list, the same as a Crowdlock added by link.
      const added = await loadAddedCrowdlocks();
      await saveAddedCrowdlocks([...added, ...built.links.map((l: any) => l.url).filter((u: string) => !added.includes(u))]);
      // Announce it on the relays straight away, so others can find it now;
      // its own inbox repeats this weekly. Best effort: not finding a relay
      // just means it shows up after the inbox's first announcement.
      setSteps((x) => [...x, "Announcing it so people can find it"]);
      for (const f of built.fingerprints) {
        const link = built.links.find((l: any) => l.url.endsWith(`/crowdlocks/${f.slug}.json`));
        if (link) await announce(DEFAULT_RELAYS, { url: link.url, name: f.network === "mainnet" ? name.trim() : `${name.trim()} — TEST`, about: about.trim(), network: f.network }).catch(() => 0);
      }
      setDone({ links: built.links, repoUrl: made.repoUrl, inboxStarted: made.inboxStarted, owner: made.owner, repo: made.repo });
      startDraft = null;   // it exists now; the next one starts blank
      setStage("done");
    } catch (e: any) { setError(String(e.message ?? e)); setStage("form"); setCode(null); }
  };

  if (stage === "signin" || stage === "creating") return (
    <View>
      <Text style={s.h1}>{stage === "signin" ? "Sign in to GitHub" : "Setting it up"}</Text>
      {stage === "signin" && !code && <ActivityIndicator style={{ marginVertical: 20 }} />}
      {stage === "signin" && code && <>
        <Text style={s.p}>Your Crowdlock is set up in your own GitHub account, so you own it. Open GitHub, sign in, and type this code:</Text>
        <Text style={[s.big, { textAlign: "center", letterSpacing: 2, marginVertical: 12 }]} selectable>{code.userCode}</Text>
        <Button label="Copy the code" kind="plain" onPress={() => Clipboard.setStringAsync(code.userCode)} />
        <Button label="Open GitHub" onPress={() => Linking.openURL(code.verificationUri)} />
        <Text style={s.note}>GitHub will ask whether to allow "Crowdlock" to create a public repository in your account. Come back here once you've allowed it — this screen carries on by itself. No account? Sign up on GitHub first; it's free.</Text>
      </>}
      {stage === "creating" && <>
        {steps.map((st, i) => <Text key={i} style={i === steps.length - 1 ? s.p : s.good}>{i === steps.length - 1 ? "…" : "✓"} {st}</Text>)}
        <ActivityIndicator style={{ marginVertical: 12 }} />
      </>}
    </View>
  );

  if (stage === "done" && done) return (
    <View>
      <Text style={s.h1}>It's started</Text>
      <Text style={s.p}>Your Crowdlock is in your own GitHub account. Its website goes live in about two minutes; it's already in your Crowdlocks list and will open once it is.</Text>
      {done.links.map((l) => (
        <View key={l.url} style={s.card}>
          <Text style={s.cardTitle}>{l.label}</Text>
          <Text style={s.note}>Anyone joins by adding this link in the app:</Text>
          <Text style={s.mono} selectable>{l.url}</Text>
          <Button label="Copy the link" kind="plain" onPress={() => Clipboard.setStringAsync(l.url)} />
        </View>
      ))}
      <Text style={s.note}>Your repository: {done.repoUrl}</Text>
      {!done.inboxStarted && <Text style={s.note}>Its relay inbox will start by itself within the hour.</Text>}
      <Text style={s.note}>Next: open it from your Crowdlocks list and sign your own declaration, so you're its member 1.</Text>

      <Text style={s.h2}>Add a maintainer</Text>
      <MaintainerAdvice />
      <MaintainerForm owner={done.owner} repo={done.repo} />
      <Text style={s.note}>You can do this any time from the Crowdlock's page, under "Look after it".</Text>
      <Button label="Back to Home" onPress={() => go({ name: "home", words })} />
    </View>
  );

  // The form, one question to a page. Which pages there are depends on the money.
  const pages = network === "mainnet"
    ? ["money", "name", "declaration", "minimum", "cosigner", "lengths", "testkey", "check"] as const
    : ["money", "name", "declaration", "lengths", "testkey", "check"] as const;
  const here = pages[Math.min(at, pages.length - 1)];
  const next = () => { setChecked(null); setProblems(null); setAt(Math.min(at + 1, pages.length - 1)); };
  const badKey = (v: string) => !!v.trim() && !isPublicKey(v) && !keyFromXpub(v);
  const days = (v: string) => /^\d{1,3}$/.test(v.trim());
  const stuck =
    here === "name" ? !name.trim() || !about.trim()
    : here === "declaration" ? !title.trim() || !text.trim()
    : here === "minimum" ? !days(waitDays) || !minimum.trim()
    : here === "cosigner" ? !cosigner.trim() || badKey(cosigner)
    : here === "lengths" ? !days(gatherDays) || !days(settleDays)
    : here === "testkey" ? badKey(testPasted) || (!testCo && !testPasted.trim())
    : false;

  return (
    <View>
      <Text style={s.kick}>Start a Crowdlock · {at + 1} of {pages.length}</Text>

      {here === "money" && <>
        <Text style={s.h1}>Start a Crowdlock</Text>
        <Text style={s.p}>A Crowdlock lets a crowd commit money to buying something together, without anyone pooling it or holding anyone else's. You write what it's for; the app sets it up in your own GitHub account.</Text>
        <Text style={s.label}>Which money?</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
          {([["testnet4", "Test bitcoin only"], ["mainnet", "Real bitcoin, with a test copy"]] as const).map(([k, label]) => (
            <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: network === k }} onPress={() => { setNetwork(k); setChecked(null); }} style={[s.chip, network === k && s.chipOn]}>
              <Text style={[s.chipText, network === k && s.chipTextOn]}>{network === k ? "✓ " : ""}{label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.note}>{network === "mainnet"
          ? "A real-bitcoin Crowdlock comes with a test copy, so you and your members can practise first."
          : "Test bitcoin has no value: practise everything (joining, locking, taking a lock home) before anything is real."}</Text>
      </>}

      {here === "name" && <>
        <Text style={s.h1}>What is it called, and what is it for?</Text>
        <Text style={s.label}>Name</Text>
        <Input style={s.input} value={name} onChangeText={(t) => { setName(t); setChecked(null); }} placeholder="The Pub Fund" />
        <Text style={s.label}>What it's for, in one sentence</Text>
        <Input style={s.input} value={about} onChangeText={(t) => { setAbout(t); setChecked(null); }} placeholder="Regulars buying the Red Lion so it stays a pub for good." />
      </>}

      {here === "declaration" && <>
        <Text style={s.h1}>The declaration</Text>
        <Text style={s.p}>These are the words every member signs. Replace the bracketed part with what you're raising money for.</Text>
        <Text style={s.label}>Its title</Text>
        <Input style={s.input} value={title} autoCapitalize="characters" onChangeText={(t) => {
          // Keep the declaration's first line in step with its title while it still matches.
          setText((old) => old.startsWith(title.toUpperCase() + "\n") ? t.toUpperCase() + old.slice(title.length) : old);
          setTitle(t); setChecked(null);
        }} />
        <Text style={s.label}>What people sign</Text>
        <Input style={[s.input, { minHeight: 240, textAlignVertical: "top" }]} multiline value={text} onChangeText={(t) => { setText(t); setChecked(null); }} />
        <Text style={s.note}>Leave the line about returns as it is. It's what makes this a Crowdlock. Investments that pay returns have legal rules to follow, and Crowdlock follows none of them.</Text>
        <Warning level="stop" title="Once anyone signs, these words can't be edited">
          Each member signs these exact words, so they can't be quietly changed. If something has to be fixed later, you publish a new version with the reason, and every member is asked to sign again. Nobody's signature carries over to words they haven't read. Read it twice.
        </Warning>
      </>}

      {here === "minimum" && <>
        <Text style={s.h1}>The rules for real bitcoin</Text>
        <Text style={s.label}>Smallest lock that counts, in BTC</Text>
        <Input style={s.input} keyboardType="decimal-pad" value={minimum} onChangeText={(t) => { setMinimum(t); setChecked(null); }} />
        <Text style={s.note}>A smaller lock is still its owner's and still locked. It just isn't added to the total.</Text>
        <Text style={s.label}>Days a new destination must be public before a proposal can use it</Text>
        <Input style={s.input} keyboardType="number-pad" value={waitDays} onChangeText={(t) => { setWaitDays(t); setChecked(null); }} />
        <Text style={s.note}>A destination is an address a purchase is allowed to pay. We recommend at least 7 days. It's the time members have to notice a destination nobody should be paying before money can go to it. Your test copy uses none, so you can practise.</Text>
      </>}

      {here === "cosigner" && <>
        <Text style={s.h1}>The co-signer's key</Text>
        <Text style={s.p}>The co-signer adds the second signature that completes a purchase. They can't take or keep anyone's money, only refuse to complete.</Text>
        <Text style={s.label}>Co-signer's public key</Text>
        <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={cosigner} onChangeText={(t) => { setCosigner(t); setChecked(null); }} placeholder="Its xpub, or its key: 02… or 03…" />
        {badKey(cosigner) && <Text style={s.error}>That isn't a public key or an xpub. Copy it whole from where the key was made.</Text>}
        {!!keyFromXpub(cosigner) && <Text style={s.note}>That xpub stands for {keyFromXpub(cosigner)!.slice(0, 10)}…, and is published beside it so hardware wallets can lock.</Text>}
        <Btn kind="second" label="Make a co-signer key now" onPress={() => go({ name: "cosignerKey", words, forStart: "cosigner" })} />
        <Btn kind="link" label="Paste what I copied" onPress={async () => { const t = (await Clipboard.getStringAsync()).trim(); if (t) { setCosigner(t); setChecked(null); } }} />
        <Text style={s.note}>Making one here gives you 12 words to write on paper, and brings the key back to this page. Your typing is kept. You can also make it elsewhere (Sparrow, Electrum, or the method's own script) and paste its xpub. An xpub is the public half of a key in a form hardware wallets can use. Its plain key works too, but then hardware wallets can't lock until the xpub is added.</Text>
      </>}

      {here === "lengths" && <>
        <Text style={s.h1}>How long a proposal may run</Text>
        <Text style={s.p}>A proposal is a purchase put to the members. It gathers commitments, then settles.</Text>
        <Text style={s.label}>Longest it may gather commitments, in days</Text>
        <Input style={s.input} keyboardType="number-pad" value={gatherDays} onChangeText={(t) => { setGatherDays(t); setChecked(null); }} />
        <Text style={s.note}>We recommend 28: long enough to reach supporters who only look now and then. Each proposal picks its own length up to this, and gathering ends as soon as the target is met. A small group with a short deadline can use less.</Text>
        <Text style={s.label}>Longest settling may take after that, in days</Text>
        <Input style={s.input} keyboardType="number-pad" value={settleDays} onChangeText={(t) => { setSettleDays(t); setChecked(null); }} />
        <Text style={s.note}>We recommend 14: room for the co-signer to complete and send everything at a sensible pace. A small Crowdlock can settle in hours. Members are bound to a proposal for at most these two together.</Text>
      </>}

      {here === "testkey" && <>
        <Text style={s.h1}>{network === "mainnet" ? "The test copy's co-signer key" : "The co-signer key"}</Text>
        <Text style={s.p}>{testPasted.trim() ? "Using the key you pasted." : !testCo ? "This wallet is on a Ledger, so this Crowdlock needs a co-signer key of its own. Make one now with the button below, or paste one you already have (its xpub, ideally)." : `One has been made on this phone from your recovery words: ${testCo.slice(0, 10)}…${testCo.slice(-8)}. Tap Next to use it, or paste a practice key you made instead.`}</Text>
        <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={testPasted} onChangeText={(t) => { setTestPasted(t); setChecked(null); }} placeholder={testCo ? "Optional: an xpub, or a key 02… or 03…" : "An xpub, or a key 02… or 03…"} />
        {badKey(testPasted) && <Text style={s.error}>That isn't a public key or an xpub. Copy it whole from where the key was made.</Text>}
        <Btn kind="second" label="Make a co-signer key now" onPress={() => go({ name: "cosignerKey", words, forStart: "testPasted" })} />
        <Btn kind="link" label="Paste what I copied" onPress={async () => { const t = (await Clipboard.getStringAsync()).trim(); if (t) { setTestPasted(t); setChecked(null); } }} />
        <Text style={s.note}>Making one here gives you 12 words to write on paper, and brings the key back to this page. Your typing is kept. You can add more co-signer keys later, from the Crowdlock's page under "Look after it".</Text>
      </>}

      {here === "check" && <>
        <Text style={s.h1}>Check and create</Text>
        <SumRow label="Name" value={name.trim()} />
        <SumRow label="Money" value={network === "mainnet" ? "Real bitcoin, with a test copy" : "Test bitcoin only"} />
        <SumRow label="Declaration" value={title.trim()} />
        {network === "mainnet" && <SumRow label="Smallest lock that counts" value={`${minimum.trim()} BTC`} />}
        <SumRow label="A proposal may run" value={`${gatherDays.trim()} days gathering, ${settleDays.trim()} settling`} />
        <Text style={s.note}>{about.trim()}</Text>
        {problems && <>
          <Text style={s.error}>Something needs fixing. Go back to the page it is on:</Text>
          {problems.map((x, i) => <Text key={i} style={s.error}>• {x}</Text>)}
        </>}
        {error && <Text style={s.error}>{error}</Text>}
        {!checked && <Btn label="Check it" onPress={check} />}
        {checked && <>
          <Text style={s.good}>It checks out: the same checks every Crowdlock passes.</Text>
          {checked.fingerprints.map((f: any) => <Text key={f.slug} style={s.note}>{f.network === "mainnet" ? "Real" : "Test copy"} · fingerprint {f.sha256.slice(0, 12)}…</Text>)}
          <Text style={s.p}>It is created in your own GitHub account, so you own it. That makes it public straight away.</Text>
          <Btn label="Sign in to GitHub and create it" onPress={create} />
        </>}
      </>}

      {here !== "check" && <Btn label="Next" disabled={stuck} onPress={next} />}
      {at > 0 && <Btn kind="second" label="Back a page" onPress={() => setAt(at - 1)} />}
    </View>
  );
}

// ---------------------------------------------------------------------------

function btc(sats: bigint) {
  const neg = sats < 0n; const v = neg ? -sats : sats;
  const whole = v / 100000000n; const frac = (v % 100000000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${whole}.${frac} BTC`;
}

// How fast transactions should confirm. Kept here, and saved, so every screen
// that sends something uses the same choice.
let feeSpeed: FeeSpeed = "normal";
const SPEED_LABEL: Record<FeeSpeed, string> = { slow: "Slow", normal: "Normal", fast: "Fast" };
const SPEED_WHEN: Record<FeeSpeed, string> = { slow: "about an hour", normal: "about half an hour", fast: "the next block or two" };

/** Slow / Normal / Fast, with the network fee rate each means right now. */
function FeeChoice({ onChange }: { onChange?: () => void } = {}) {
  const [speed, setSpeed] = useState<FeeSpeed>(feeSpeed);
  const [rates, setRates] = useState<{ slow: number; normal: number; fast: number } | null>(null);
  useEffect(() => { chain.feeRates().then(setRates).catch(() => {}); loadFeeSpeed().then((v) => { feeSpeed = v; setSpeed(v); }); }, []);
  const pick = (v: FeeSpeed) => { feeSpeed = v; setSpeed(v); saveFeeSpeed(v); onChange?.(); };
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

function Button({ label, onPress, kind = "main", disabled }: { label: string; onPress: () => void; kind?: "main" | "plain" | "danger"; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [s.btn, kind === "plain" && s.btnPlain, kind === "danger" && s.btnDanger, (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={[s.btnText, kind !== "main" && s.btnTextPlain, kind === "danger" && s.btnTextDanger]}>{label}</Text>
    </Pressable>
  );
}

// The older screens' styles, drawn from the one theme (src/ui/theme.ts) so
// they follow the phone's light or dark setting with everything else. Screens
// move over to the shared parts in src/ui/parts.tsx as each is rebuilt.
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
    btnDanger: { backgroundColor: "transparent", marginTop: 40, minHeight: 48 },
    btnText: { color: t.onBrand, fontSize: size.body, fontFamily: font.bold, textAlign: "center" },
    btnTextPlain: { color: t.ink },
    btnTextDanger: { color: t.stop },
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

let s = makeStyles(themeFor(null));
