// The Crowdlock app: a wallet somebody who has never held bitcoin can use,
// and the Crowdlocks they can join with it.
//
// This file is the shell: which screen is showing, how Back, pull-down and the
// keyboard behave, and the bars at the top and bottom. The screens themselves
// are in src/screens/, by job:
//
//   wallet.tsx     setting up the wallet, getting bitcoin in, sending it out
//   home.tsx       the four places along the bottom, Help and About
//   steps.tsx      sign to join, lock, take it home or lock it again
//   proposals.tsx  proposals, committing to one, and the co-signer's part
//   crowdlock.tsx  the list, one Crowdlock's page, adding, finding, sharing
//   founders.tsx   starting a Crowdlock and looking after one
//   shared.tsx     what they all use: screen names, small parts, styles
//
// Every screen is presentation. Anything touching keys or money goes through
// src/wallet/core.mjs, and nothing else may.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Dimensions, Keyboard, Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import type { ComponentRef } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
// @ts-ignore — plain module shared with the chain tests
import { takeHome } from "./src/wallet/core.mjs";
// @ts-ignore — plain module shared with the chain tests
import { STARTING_LIST, MOVED_ADDRESSES, fileUrlFromOpenLink } from "./src/crowdlocks.mjs";
import { loadFeeSpeed, loadLook, moveSavedRecords } from "./src/storage";
import { NETWORK, IS_TEST_MONEY } from "./src/config";
import { askAfresh } from "./src/wallet/esplora.mjs";
// The look (one theme file) and the shared parts every screen is built from.
import { setLook, useTheme } from "./src/ui/theme";
import { NavRow, TabBar, TopBar } from "./src/ui/parts";
import type { TabName } from "./src/ui/parts";
import { whileOpen, finishedLocks, BackCtx, RefreshCtx, RevealCtx, s, setStyles, loadWallet } from "./src/screens/shared";
import type { Screen, Refresher, Box } from "./src/screens/shared";
import { Welcome, LedgerSetup, ShowWords, CheckWords, Restore, AddMoney, Send, WalletScreen, FeeSpeedScreen } from "./src/screens/wallet";
import { Tabs, Help, About } from "./src/screens/home";
import { SignScreen, LockFlow, HomeFlow } from "./src/screens/steps";
import { ProposalScreen, CommitFlow } from "./src/screens/proposals";
import { CrowdlockScreen, AllOf, ShareScreen, AddCrowdlock, FindCrowdlocks } from "./src/screens/crowdlock";
import { Founders, CosignerKey, StartCrowdlock, LookAfterScreen } from "./src/screens/founders";

// Screens where pulling down checks again. Forms and word screens are left
// out: nothing on them comes from outside the phone.
const REFRESHABLE = new Set(["home", "crowdlock", "findCrowdlocks", "proposal"]);

const TAB_TITLE: Record<TabName, string> = { home: "Crowdlock", bitcoin: "My bitcoin", crowdlocks: "Crowdlocks", more: "More" };

export default function App() {
  const t = useTheme();
  // Every screen reads the shared styles as it draws, so they are set first.
  setStyles(t);

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
    loadFeeSpeed().then((v) => { whileOpen.feeSpeed = v; });
    loadLook().then(setLook);
    // Refile anything saved under an address that has since moved, before
    // anything reads it (see src/moves.mjs).
    moveSavedRecords(MOVED_ADDRESSES, STARTING_LIST).catch(() => false).then(() => Linking.getInitialURL()).then((u) => {
      pending.current = fileUrlFromOpenLink(u ?? null);
      loadWallet().then((w) => setScreen(w ? { name: "home", words: w } : { name: "welcome" }));
    });
    const sub = Linking.addEventListener("url", (e) => {
      const file = fileUrlFromOpenLink(e.url);
      if (!file) return;
      pending.current = file;
      loadWallet().then((w) => { if (w) setScreen({ name: "home", words: w }); });
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
            {screen.name === "restore" && <Restore again={screen.again} go={setScreen} />}
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
            {screen.name === "lookAfter" && <LookAfterScreen words={screen.words} url={screen.url} job={screen.job} />}
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
