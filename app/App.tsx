// A wallet a fan who has never held bitcoin can use, and the Crowdlocks they
// can join with it.
//
//   Welcome    →  New: show the 12 words → check three of them → Home
//              →  Restore: type the backup words → Home
//   Home       →  the waiting balance, Add money (QR + copy), Send out,
//                 and the Crowdlocks: each one checked before it is shown
//   Crowdlock  →  its declaration, and Sign and join in one tap; then, for a
//                 member, Your locks: progress to the minimum, Lock it,
//                 each lock's state, and Take it home after its date
//   Add        →  any other Crowdlock, by link, checked the same way
//   Start      →  a new Crowdlock: write its declaration, sign in to GitHub
//                 with a short code, and it is set up in the founder's own
//                 account, with a test copy beside it
//
// Every screen here is presentation. Anything touching keys or money goes
// through src/wallet/core.mjs, and nothing else may.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
// @ts-ignore — plain module shared with the chain tests
import {
  newWords, wordsAreValid, tidyWords, accountFromWords, suggestWords, waitingBalance, buildSend, signStatement,
  lockFor, lockDate, buildLock, lockState, takeHome, relock, checkLedgerKey, cosignerFromWords, newCosignerWords, cosignerKeyFromWords, COSIGNER_PATH,
  isPublicKey, keyFromXpub, xpubForKey, ledgerAccountFrom, readLedgerAccount, signStatementWith,
  buildCommitment, checkCommitment, completeCommitmentWith, commitmentPaid, NETWORKS,
} from "./src/wallet/core.mjs";
import { address as bitcoinAddress } from "bitcoinjs-lib";
import {
  phaseOf, proposalHash, fieldsOf, nextDestination, attestationStatement, destinationIsPermitted, checkProposals, chainIsIntact, attestationsAreValid,
} from "../method/js/proposals.mjs";
import {
  isLedgerWallet, readLedgerWallet, ledgerWalletText, ledgerUser, withLedger, lookForLedgers, askForBluetooth, ledgerAppFor,
} from "./src/ledgerDevice";
// @ts-ignore — plain modules shared with the tests
import { buildCrowdlock, declarationSkeleton, slugify, DEFAULT_RELAYS, checkWithNewKey } from "./src/start.mjs";
// @ts-ignore
import {
  startSignIn, waitForSignIn, whoAmI, createCrowdlockRepo, canWrite, updateCrowdlockRepo, addMaintainer, rememberSignIn, currentSignIn, addCosignerKey,
  addDestination, publishProposal,
} from "./src/github.mjs";
// @ts-ignore
import template from "./src/template.mjs";
// Plain JavaScript modules: their results are used as loosely typed here.
const build = buildCrowdlock as (x: any) => any;
const createRepo = createCrowdlockRepo as (x: any) => Promise<any>;
// @ts-ignore — plain module shared with the chain tests
import {
  STARTING_LIST, loadCrowdlock, membershipOf, committedTotal, submitJoin, COUNTING_RULE_URL, poundsPerBtc, shortBtc,
  locksOnRegister, submitLock, newestCosigner, pathInRepo, keyChanges, historyLinkFor, coSignerRecord, openLinkFor, fileUrlFromOpenLink, shareLinkFor, rankFound, matchesSearch,
  repoFromFileUrl, versionStatus, changesSince, baseFor, resolvePath,
} from "./src/crowdlocks.mjs";
// @ts-ignore — plain module
import { postToRelays, announce, fetchAnnouncements, postCommitment, fetchCommitments } from "./src/relays.mjs";
import {
  loadWords, saveWords, forgetWords, loadAddedCrowdlocks, saveAddedCrowdlocks, forgetAddedCrowdlocks,
  loadSavedLocks, saveLock, forgetSavedLocks, forgetLedgerStore, loadSeenKeys, saveSeenKeys, loadExpectedKeys, saveExpectedKeys, loadFeeSpeed, saveFeeSpeed } from "./src/storage";
import type { FeeSpeed } from "./src/storage";
import { NETWORK, IS_TEST_MONEY, chain, EXPLORER_WEB } from "./src/config";

type Screen =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "showWords"; words: string }
  | { name: "checkWords"; words: string }
  | { name: "restore" }
  | { name: "home"; words: string }
  | { name: "send"; words: string }
  | { name: "crowdlock"; words: string; url: string }
  | { name: "addCrowdlock"; words: string; link?: string }
  | { name: "startCrowdlock"; words: string }
  | { name: "findCrowdlocks"; words: string }
  | { name: "cosignerKey"; words: string }
  | { name: "ledgerSetup"; from?: string };

export default function App() {
  const [screen, setScreenRaw] = useState<Screen>({ name: "loading" });
  // A Crowdlock link the app was opened with (crowdlock://add?url=…, from a
  // QR code or a web page's button). Held until there is a wallet to add it
  // to, then opened in Add a Crowdlock, where it is checked like any other.
  const pending = useRef<string | null>(null);

  const setScreen = useCallback((next: Screen) => {
    if (next.name === "home" && pending.current) {
      const link = pending.current; pending.current = null;
      setScreenRaw({ name: "addCrowdlock", words: next.words, link });
      return;
    }
    setScreenRaw(next);
  }, []);

  useEffect(() => {
    // Opened by a link: note it, then show the first screen once; "home" picks
    // the link up. A link arriving while the app is open is opened at once if
    // there is a wallet, or waits for one.
    loadFeeSpeed().then((v) => { feeSpeed = v; });
    Linking.getInitialURL().then((u) => {
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

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.page}>
        <StatusBar style="dark" />
        {IS_TEST_MONEY && <Text style={s.banner}>TEST MONEY · {NETWORK} · not real bitcoin</Text>}
        {!IS_TEST_MONEY && <Text style={s.bannerReal}>REAL BITCOIN · early build, not yet independently reviewed</Text>}
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {screen.name === "loading" && <ActivityIndicator style={{ marginTop: 80 }} />}
          {screen.name === "welcome" && <Welcome go={setScreen} />}
          {screen.name === "showWords" && <ShowWords words={screen.words} go={setScreen} />}
          {screen.name === "checkWords" && <CheckWords words={screen.words} go={setScreen} />}
          {screen.name === "restore" && <Restore go={setScreen} />}
          {screen.name === "home" && <Home words={screen.words} go={setScreen} />}
          {screen.name === "send" && <Send words={screen.words} go={setScreen} />}
          {screen.name === "crowdlock" && <CrowdlockScreen words={screen.words} url={screen.url} go={setScreen} />}
          {screen.name === "addCrowdlock" && <AddCrowdlock key={screen.link ?? "add"} words={screen.words} link={screen.link} go={setScreen} />}
          {screen.name === "startCrowdlock" && <StartCrowdlock words={screen.words} go={setScreen} />}
          {screen.name === "findCrowdlocks" && <FindCrowdlocks words={screen.words} go={setScreen} />}
          {screen.name === "cosignerKey" && <CosignerKey words={screen.words} go={setScreen} />}
          {screen.name === "ledgerSetup" && <LedgerSetup from={screen.from} go={setScreen} />}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

type Go = (s: Screen) => void;

// ---------------------------------------------------------------------------

// The wallet on this phone: backup words, or a Ledger that holds the key.
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
      <Text style={s.h1}>Crowdlock</Text>
      <Text style={s.p}>Your own bitcoin wallet. Nobody else holds your money — not us, not anyone.</Text>
      <Button label="Create a new wallet" onPress={() => go({ name: "showWords", words: newWords() })} />
      <Button label="I already have backup words" kind="plain" onPress={() => go({ name: "restore" })} />
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
 * Check a paper copy of backup words, every word, one at a time — the way a
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
      <TextInput
        style={s.input} autoCapitalize="none" autoCorrect={false} autoFocus value={typed}
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
 * Typing backup words in: the same box everywhere — restoring a wallet,
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
    <TextInput
      style={[s.input, { minHeight: 100, textAlignVertical: "top" }]} multiline
      autoCapitalize="none" autoCorrect={false} value={value} onChangeText={onChange} placeholder={placeholder}
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
      <Text style={s.p}>Type your backup words, in order, with spaces between them. Usually 12 or 24.</Text>
      <WordsInput value={text} onChange={setText} />
      <Button label="Restore" disabled={!valid} onPress={finish} />
      <Button label="Back" kind="plain" onPress={() => go({ name: "welcome" })} />
    </View>
  );
}

// ---------------------------------------------------------------------------

function Home({ words, go }: { words: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const [balance, setBalance] = useState<{ confirmed: bigint; arriving: bigint } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  const refresh = useCallback(async () => {
    setError(null);
    try { setBalance(await waitingBalance(chain, account.address)); }
    catch (e: any) { setError(String(e.message ?? e)); }
  }, [account.address]);
  useEffect(() => { refresh(); }, [refresh]);

  const remove = () => Alert.alert(
    "Remove this wallet from the phone?",
    account.kind === "ledger"
      ? "Your Ledger keeps the key — this only forgets it on this phone. You can connect it again any time."
      : "Only do this if your 12 words are written down. Without them the money cannot be recovered.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await forgetWords(); await forgetAddedCrowdlocks(); await forgetSavedLocks(); await forgetLedgerStore(); go({ name: "welcome" }); } },
    ],
  );

  return (
    <View>
      <Text style={s.h1}>Waiting to lock</Text>
      <Text style={s.big}>{balance ? btc(balance.confirmed) : "…"}</Text>
      {balance && balance.arriving > 0n && <Text style={s.note}>+ {btc(balance.arriving)} arriving (not yet confirmed)</Text>}
      {error && <Text style={s.error}>Could not read the balance: {error}</Text>}
      <Button label="Refresh" kind="plain" onPress={refresh} />

      <Text style={s.h2}>Add money</Text>
      <Text style={s.p}>Send bitcoin to this address. It is yours alone.</Text>
      <View style={s.qr}><QRCode value={account.address} size={200} /></View>
      <Text style={s.mono} selectable>{account.address}</Text>
      <Button
        label={copied ? "Copied" : "Copy address"} kind="plain"
        onPress={async () => { await Clipboard.setStringAsync(account.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      />
      <Text style={s.note}>
        Want it automatic? Set up a standing order with a service that sends bitcoin to your own wallet, and give it this address.
      </Text>

      <FeeChoice />
      <Button label="Send money out" onPress={() => go({ name: "send", words })} />

      <Text style={s.h2}>Crowdlocks</Text>
      <CrowdlockList words={words} address={account.address} go={go} />
      <Button label="Find Crowdlocks" onPress={() => go({ name: "findCrowdlocks", words })} />
      <Button label="Add a Crowdlock" kind="plain" onPress={() => go({ name: "addCrowdlock", words })} />
      <Button label="Start a Crowdlock" kind="plain" onPress={() => go({ name: "startCrowdlock", words })} />
      <Button label="Make a co-signer key" kind="plain" onPress={() => go({ name: "cosignerKey", words })} />
      {account.kind === "ledger" && <>
        <Button label={checking ? "Look at your Ledger…" : "Check my Ledger"} kind="plain" disabled={checking} onPress={checkKey} />
        {keyCheck && <Text style={keyCheck.ok ? s.good : s.error}>{keyCheck.text}</Text>}
        <Text style={s.note}>Checks it's the same Ledger, gives the same address, and can still sign. It signs a harmless dated message you approve on its screen; nothing is sent.</Text>
      </>}
      {account.kind !== "ledger" && <Button label="Use a Ledger instead" kind="plain" onPress={() => go({ name: "ledgerSetup", from: words })} />}
      <Button label="Remove wallet from this phone" kind="danger" onPress={remove} />
    </View>
  );
}

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
      <Text style={s.p}>It will confirm in the next block or so.</Text>
      <Text style={s.mono} selectable>{EXPLORER_WEB}/tx/{done}</Text>
      <Button label="Back to wallet" onPress={() => go({ name: "home", words })} />
    </View>
  );

  return (
    <View>
      <Text style={s.h1}>Send money out</Text>
      <Text style={s.label}>To address</Text>
      <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} value={to} onChangeText={(t) => { setTo(t); setReview(null); }} />
      <Text style={s.label}>Amount in BTC</Text>
      <TextInput
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

type Loaded = { ok: true; url: string; crowdlock: any; declarationText: string; statement: string; register: any; destinations: any; proposals: any[]; proposalProblems: string[] }
  | { ok: false; url: string; problems: string[] };

async function allLinks(): Promise<string[]> {
  const added = await loadAddedCrowdlocks();
  return [...STARTING_LIST, ...added.filter((u) => !STARTING_LIST.includes(u))];
}

function CrowdlockList({ words, address, go }: { words: string; address: string; go: Go }) {
  const [items, setItems] = useState<Loaded[] | null>(null);
  const [totals, setTotals] = useState<Record<string, { sats: bigint; members: number }>>({});
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
  }, []);

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
              ? `${btc(totals[c.url].sats)} locked · ${totals[c.url].members} committed member${totals[c.url].members === 1 ? "" : "s"}`
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
          <Text style={s.error}>Refused: {c.url}</Text>
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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
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
      committedTotal(loaded).then(setTotal).catch(() => setTotal(null));
      coSignerRecord(loaded).then(setRecord).catch(() => setRecord(null));
      poundsPerBtc(loaded.crowdlock).then(setGbp);
    }
  }, [url]);
  useEffect(() => { load(); }, [load]);

  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return (
    <View>
      <Text style={s.h1}>Refused</Text>
      <Text style={s.p}>This Crowdlock failed its checks, so the app will not show it or let you sign anything for it.</Text>
      {c.problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}
      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
    </View>
  );

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
        ? { ok: true, text: `Signed and posted to ${p.accepted} of ${p.total} relays. You'll be on the register within a few minutes — open this page again then.` }
        : { ok: false, text: "No relay took it just now — your signature is fine. Check your connection, or turn off any VPN, and try again." });
      setBusy(false);
      return;
    }
    const r = await submitJoin(c.crowdlock, { address: account.address, signature });
    setResult(r.ok ? { ok: true, text: `You are member ${r.n}.` } : { ok: false, text: r.error + (r.alternative ? ` You can still ${r.alternative}.` : "") });
    setBusy(false);
    if (r.ok) setTimeout(load, 4000);
  };

  return (
    <View>
      <Text style={s.h1}>{c.crowdlock.name}</Text>
      {c.crowdlock.about && <Text style={s.p}>{c.crowdlock.about}</Text>}
      {c.crowdlock.disclaimer && <Text style={s.note}>{c.crowdlock.disclaimer}</Text>}

      <View style={s.panel}>
        <Text style={s.big}>{total ? btc(total.sats) : "…"}</Text>
        <Text style={s.note}>locked and counted{total ? ` · ${total.members} committed member${total.members === 1 ? "" : "s"}` : ""}</Text>
        <Text style={s.good}>Checked on this phone: the declaration matches its fingerprint and the register agrees.</Text>
      </View>

      <Text style={s.p}>
        A lock counts from <Text style={{ fontWeight: "700" }}>{shortBtc(c.crowdlock.minimum_counted_lock_sats)}</Text>
        {gbp ? ` (about £${Math.round(Number(c.crowdlock.minimum_counted_lock_sats) / 1e8 * gbp)} today)` : ""}.
        {" "}A smaller lock is still yours and still locked — it just isn't added to the total.
      </Text>
      <Pressable onPress={() => Linking.openURL(COUNTING_RULE_URL)}>
        <Text style={s.link}>Why there is a minimum →</Text>
      </Pressable>

      <Text style={s.h2}>The declaration</Text>
      {showText
        ? <Text style={s.declaration}>{c.declarationText}</Text>
        : <Button label="Read it in full" kind="plain" onPress={() => setShowText(true)} />}
      <Text style={s.label}>What you sign</Text>
      <Text style={s.mono}>{c.statement}</Text>

      {me
        ? <Text style={[s.good, { fontSize: 18, marginTop: 16 }]}>You are member {me.n}. Signed {me.signed}.</Text>
        : c.crowdlock.network !== NETWORK
          ? <Text style={s.note}>This Crowdlock uses a different network from this app.</Text>
          : <>
              <Text style={s.note}>Signing is free and moves no money. It proves this wallet agrees to the declaration, and the register checks it before adding you.</Text>
              <LedgerHint account={account} />
              <Button label={busy ? "Signing and sending…" : "Sign and join"} disabled={busy} onPress={join} />
            </>}
      {result && <Text style={result.ok ? s.good : s.error}>{result.text}</Text>}

      {record && record.releases.length > 0 && <View style={s.panel}>
        <Text style={s.error}>The co-signer has released {record.releases.length === 1 ? "a lock" : `${record.releases.length} locks`} early.</Text>
        <Text style={s.note}>A lock can only open before its date with the co-signer's signature, and the co-signer is meant to sign only for a purchase. {record.releases.length === 1 ? "This one wasn't" : "These weren't"} — the money went somewhere other than a listed destination. The chain records it, so it can't be hidden.</Text>
        {record.releases.map((r) => <Text key={r.txid + r.address} style={s.note}>• {btc(BigInt(r.sats))} on {new Date(r.at * 1000).toISOString().slice(0, 10)}{r.confirmed ? "" : " (not yet in a block)"}, co-signer {String(r.cosigner ?? "?").slice(0, 10)}…, paid to {String(r.paidTo ?? "?").slice(0, 12)}…</Text>)}
        <Text style={s.note}>Ask the founder why. A co-signer who signs early releases makes the committed total untrustworthy.</Text>
      </View>}
      {record && record.releases.length === 0 && (c.register.locks ?? []).length > 0 && <Text style={s.note}>Co-signer: no early releases{record.unreadable ? ` (${record.unreadable} lock${record.unreadable === 1 ? "" : "s"} couldn't be checked just now)` : ""}.</Text>}

      {keyChange && <View style={s.panel}>
        <Text style={s.error}>This Crowdlock's co-signer keys have changed since you last looked.</Text>
        {keyChange.added.map((k) => <Text key={k} style={s.note}>Added: {k.slice(0, 10)}…{k.slice(-8)}{k === newestCosigner(c.crowdlock) ? " — new locks would use this one" : ""}</Text>)}
        {keyChange.removed.map((k) => <Text key={k} style={s.note}>Removed: {k.slice(0, 10)}…{k.slice(-8)} — locks naming it no longer count</Text>)}
        <Text style={s.note}>Founders add keys for good reasons, but a co-signer decides which purchases go ahead, so a key you don't recognise matters. Check with the founder that it was them. Every change is public, with the name of the account that made it.</Text>
        {historyLinkFor(c.url) && <Button label="See who changed it" kind="plain" onPress={() => Linking.openURL(historyLinkFor(c.url)!)} />}
        <Text style={s.note}>New locks are paused on this phone until you've looked. Taking money home isn't affected.</Text>
        <Button label="I've checked — carry on" onPress={async () => { await saveSeenKeys(url, c.crowdlock.cosigner_keys ?? []).catch(() => {}); setKeyChange(null); }} />
      </View>}

      {me && c.crowdlock.network === NETWORK && <MyLocks account={account} c={c} onChange={load} paused={!!keyChange} />}

      {c.crowdlock.network === NETWORK && <Proposals c={c} account={account} member={!!me} />}

      <LookAfter c={c} account={account} onChange={load} />

      <Text style={s.h2}>Share it</Text>
      <Text style={s.p}>Anyone with the app can point their phone's camera at this code to open it.</Text>
      <View style={s.qr}><QRCode value={openLinkFor(c.url)} size={200} /></View>
      <Button label="Share a link" kind="plain" onPress={() => Share.share({
        message: `${c.crowdlock.name} — a Crowdlock. Nobody pools money, and nobody gets anything financial back. Have a look: ${shareLinkFor(c)}`,
      })} />

      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
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

function MyLocks({ account, c, onChange, paused = false }: { account: any; c: Extract<Loaded, { ok: true }>; onChange: () => void; paused?: boolean }) {
  // New locks name the newest key; older ones stay listed for the locks that name them.
  const cosigner: string | undefined = newestCosigner(c.crowdlock);
  // A Ledger can't take home a lock whose co-signer xpub it was never given.
  const noLedgerXpub = account.kind === "ledger" && !!cosigner && !xpubForKey(c.crowdlock, cosigner);
  const minimum = BigInt(c.crowdlock.minimum_counted_lock_sats);
  const lengths: number[] = c.crowdlock.lock_lengths_years;
  const [waiting, setWaiting] = useState<{ confirmed: bigint; arriving: bigint } | null>(null);
  const [rows, setRows] = useState<LockRow[] | null>(null);
  const [years, setYears] = useState<number>(lengths[0]);
  // Empty means everything waiting; otherwise an amount in BTC.
  const [amountText, setAmountText] = useState("");
  // Which lapsed lock has its "Lock it again" choices open, and those choices.
  const [renewing, setRenewing] = useState<string | null>(null);
  const [renewYears, setRenewYears] = useState<number>(lengths[0]);
  const [addWaiting, setAddWaiting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const viaRelays = Array.isArray(c.crowdlock.relays);
  // Locks already posted to the relays while this page is open, so opening it
  // again does not post them again and again. The inbox ignores repeats anyway.
  const posted = useRef(new Set<string>());

  /** Put a lock on the register: through the relays if the Crowdlock names them, else its lock endpoint. */
  const publish = useCallback(async (l: LockTerms): Promise<{ ok: boolean; note: string }> => {
    const terms = { ownerPubkey: account.publicKey, ...l };
    if (viaRelays) {
      if (posted.current.has(l.address)) return { ok: true, note: "Posted to the relays — on the register within a few minutes." };
      const p = await postToRelays(c.crowdlock, { type: "lock", owner_pubkey: account.publicKey, cosigner_pubkey: l.cosignerPubkey, locktime: l.locktime, address: l.address });
      if (p.ok) posted.current.add(l.address);
      return p.ok
        ? { ok: true, note: `Posted to ${p.accepted} of ${p.total} relays — on the register within a few minutes.` }
        : { ok: false, note: "Not on the register yet: no relay answered. It will be tried again when you open this page." };
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
        const st = await lockState({ chain, lock: l, medianTime });
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

  // What the fan has asked to lock: everything, or an amount they typed.
  const chosen = ((): { amount: bigint | "all"; shown: bigint; problem?: string } => {
    const all = waiting?.confirmed ?? 0n;
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

  const lockIt = async () => {
    if (!waiting || chosen.problem) return;
    const locktime = lockDate(years);
    // The fee is shown before anything is approved: a lock is about 141 vbytes.
    let feeNote = "";
    try { const r = await chain.feeRate(feeSpeed); feeNote = ` Network fee: ${r} sat/vB (${SPEED_LABEL[feeSpeed]}), about ${Math.ceil(r * 141)} sats.`; } catch {}
    Alert.alert(
      `Lock ${chosen.amount === "all" ? `everything waiting (${btc(waiting.confirmed)})` : btc(chosen.shown)} until ${when(locktime)}?`,
      (chosen.amount === "all" ? "The network fee comes out of it. " : "The network fee is paid from what stays waiting. ")
        + feeNote
        + " Until that date it can only leave the lock into a purchase you sign for yourself. After it, you can take it home whenever you like. This cannot be undone."
        + (account.kind === "ledger" ? " Your Ledger will first ask you to approve the lock's rules, then the payment: if it refuses the rules, nothing is sent." : ""),
      [
        { text: "Cancel", style: "cancel" },
        { text: "Lock it", onPress: async () => {
          setBusy("lock"); setMessage(null);
          try {
            const lock = { ...lockFor({ account, cosignerPubkey: cosigner, locktime }), cosignerXpub: xpubForKey(c.crowdlock, cosigner) };
            const feeRate = await chain.feeRate(feeSpeed);
            const tx = await buildLock({ account, chain, lock, feeRate, amount: chosen.amount });
            // The terms are saved before the money moves, and checked saved.
            await saveLock({ crowdlock: c.url, address: lock.address, locktime, cosignerPubkey: cosigner });
            await chain.broadcast(tx.hex);
            if (viaRelays) await publish({ address: lock.address, locktime, cosignerPubkey: cosigner });
            setAmountText("");
            setMessage({ ok: true, text: `Locked ${btc(tx.sent)} (fee ${btc(tx.fee)}). Once it confirms — usually within the hour — it goes on the register by itself.` });
            await refresh(); onChange();
          } catch (e: any) { setMessage({ ok: false, text: String(e.message ?? e) }); }
          setBusy(null);
        } },
      ],
    );
  };

  const home = (row: LockRow) => {
    Alert.alert(
      `Take ${btc(row.confirmed)} home?`,
      "It goes back to your waiting balance, where you can lock it again or send it out. It stops counting towards this Crowdlock's total.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Take it home", onPress: async () => {
          setBusy(row.address); setMessage(null);
          try {
            const tx = await takeHome({ account, chain, lock: { ...row, cosignerXpub: xpubForKey(c.crowdlock, row.cosignerPubkey) }, feeRate: await chain.feeRate(feeSpeed), medianTime: await chain.medianTime() });
            await chain.broadcast(tx.hex);
            setMessage({ ok: true, text: `${btc(tx.sent)} is on its way back to your waiting balance (fee ${btc(tx.fee)}).` });
            await refresh(); onChange();
          } catch (e: any) { setMessage({ ok: false, text: String(e.message ?? e) }); }
          setBusy(null);
        } },
      ],
    );
  };

  const lockAgain = (row: LockRow) => {
    if (!cosigner) return;
    const locktime = lockDate(renewYears);
    const extra = addWaiting && waiting ? waiting.confirmed : 0n;
    Alert.alert(
      `Lock ${btc(row.confirmed + extra)} again until ${when(locktime)}?`,
      (extra > 0n ? `That is this lock plus the ${btc(extra)} waiting. ` : "")
        + "It moves straight into the new lock in one transaction; the network fee comes out of it. Until the new date it can only leave into a purchase you sign for yourself. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Lock it again", onPress: async () => {
          setBusy(row.address); setMessage(null);
          try {
            const newLock = { ...lockFor({ account, cosignerPubkey: cosigner, locktime }), cosignerXpub: xpubForKey(c.crowdlock, cosigner) };
            const tx = await relock({
              account, chain, lock: { ...row, cosignerXpub: xpubForKey(c.crowdlock, row.cosignerPubkey) }, newLock, addWaiting: extra > 0n,
              feeRate: await chain.feeRate(feeSpeed), medianTime: await chain.medianTime(),
            });
            await saveLock({ crowdlock: c.url, address: newLock.address, locktime, cosignerPubkey: cosigner });
            await chain.broadcast(tx.hex);
            if (viaRelays) await publish({ address: newLock.address, locktime, cosignerPubkey: cosigner });
            setRenewing(null); setAddWaiting(false);
            setMessage({ ok: true, text: `Locked ${btc(tx.sent)} again until ${when(locktime)} (fee ${btc(tx.fee)}). Once it confirms it goes on the register by itself.` });
            await refresh(); onChange();
          } catch (e: any) { setMessage({ ok: false, text: String(e.message ?? e) }); }
          setBusy(null);
        } },
      ],
    );
  };

  const ready = waiting !== null && waiting.confirmed >= minimum && waiting.confirmed > 0n;

  return (
    <View>
      <Text style={s.h2}>Your locks</Text>
      <LedgerHint account={account} />
      {account.kind === "ledger" && !xpubForKey(c.crowdlock, cosigner) && <Text style={s.error}>This Crowdlock's co-signer hasn't published the xpub a Ledger needs, so a Ledger can't lock here yet: it couldn't take the lock home. Ask its founder to add it.</Text>}

      {waiting === null ? <ActivityIndicator /> : (waiting as any).failed ? null : ready ? (
        <View style={s.panel}>
          <Text style={s.p}><Text style={s.bold}>{btc(waiting.confirmed)}</Text> is waiting, enough for a lock that counts.</Text>
          <Text style={s.label}>How much to lock</Text>
          <TextInput
            style={s.input} keyboardType="decimal-pad" placeholder="Everything waiting"
            value={amountText} onChangeText={setAmountText}
          />
          <Text style={chosen.problem ? s.error : s.note}>
            {chosen.problem ?? `In BTC. Leave it empty to lock everything. At least ${shortBtc(c.crowdlock.minimum_counted_lock_sats)}; whatever you don't lock stays waiting.`}
          </Text>
          <Text style={s.label}>Lock it for</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {lengths.map((y) => (
              <Pressable key={y} onPress={() => setYears(y)} style={[s.chip, years === y && s.chipOn]}>
                <Text style={[s.chipText, years === y && { color: "#fff" }]}>{lengthLabel(y)}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.note}>Unlocks {when(lockDate(years))}.</Text>
          <FeeChoice />
          {lengths.some((y) => y < 1) && <Text style={s.note}>The test network's clock can run ahead of real time, so a short test lock may unlock early. Real bitcoin's never does.</Text>}
          <Button
            label={busy === "lock" ? "Locking…" : chosen.amount === "all" ? "Lock everything waiting" : `Lock ${btc(chosen.shown)}`}
            disabled={busy !== null || !!chosen.problem || paused || noLedgerXpub} onPress={lockIt}
          />
        </View>
      ) : (
        <Text style={s.p}>
          {waiting.confirmed === 0n
            ? `Nothing waiting yet. Add money on the home screen; once ${shortBtc(c.crowdlock.minimum_counted_lock_sats)} is waiting, you can lock it here.`
            : `${btc(waiting.confirmed)} waiting. ${btc(minimum - waiting.confirmed)} more and you can lock it.`}
        </Text>
      )}
      {waiting && waiting.arriving > 0n && <Text style={s.note}>+ {btc(waiting.arriving)} arriving — it can be locked once it confirms.</Text>}
      {message && <Text style={message.ok ? s.good : s.error}>{message.text}</Text>}

      {rows === null ? null : rows.length === 0 ? null : rows.map((r) => (
        <View key={r.address} style={s.card}>
          <Text style={s.cardTitle}>{r.state === "withdrawn" || r.state === "empty" ? "" : `${btc(r.confirmed > 0n ? r.confirmed : r.arriving)} · `}{STATE[r.state] ?? r.state}</Text>
          <Text style={s.note}>
            {r.state === "lapsed" || r.state === "withdrawn" ? "Unlocked" : "Unlocks"} {when(r.locktime)}
            {r.state === "locked" && r.confirmed < minimum ? " · below the minimum, so not counted" : ""}
            {r.state === "locked" && r.locktime * 1000 < Date.now() ? " · date reached; the network's clock catches up within about an hour" : ""}
          </Text>
          {r.confirmed > 0n && <Text style={r.onRegister ? s.good : s.note}>{r.note ?? (r.onRegister ? "On the register" : "Goes on the register once it confirms")}</Text>}
          {r.state === "arriving" && <Text style={s.note}>{viaRelays ? "Posted to the relays; goes on the register once it confirms." : "Goes on the register once it confirms."}</Text>}
          <Text style={[s.mono, { fontSize: 12 }]} selectable>{r.address}</Text>
          {r.state === "lapsed" && renewing !== r.address && <>
            <Button label="Lock it again" disabled={busy !== null || paused || noLedgerXpub} onPress={() => { setRenewing(r.address); setAddWaiting(false); }} />
            <Button label={busy === r.address ? "Sending…" : "Take it home"} kind="plain" disabled={busy !== null} onPress={() => home(r)} />
          </>}
          {r.state === "lapsed" && renewing === r.address && <>
            <Text style={s.label}>Lock it again for</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {lengths.map((y) => (
                <Pressable key={y} onPress={() => setRenewYears(y)} style={[s.chip, renewYears === y && s.chipOn]}>
                  <Text style={[s.chipText, renewYears === y && { color: "#fff" }]}>{lengthLabel(y)}</Text>
                </Pressable>
              ))}
            </View>
            {waiting && waiting.confirmed > 0n && (
              <Pressable onPress={() => setAddWaiting(!addWaiting)} style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
                <View style={[s.box, addWaiting && s.boxOn]}>{addWaiting && <Text style={{ color: "#fff", fontWeight: "800" }}>✓</Text>}</View>
                <Text style={[s.p, { marginBottom: 0, flex: 1 }]}>Add the {btc(waiting.confirmed)} waiting too</Text>
              </Pressable>
            )}
            <Text style={s.note}>New date: {when(lockDate(renewYears))}.</Text>
            <Button
              label={busy === r.address ? "Locking…" : `Lock ${btc(r.confirmed + (addWaiting && waiting ? waiting.confirmed : 0n))} again`}
              disabled={busy !== null || paused} onPress={() => lockAgain(r)}
            />
            <Button label="Not now" kind="plain" disabled={busy !== null} onPress={() => setRenewing(null)} />
          </>}
        </View>
      ))}
      <Button label="Refresh" kind="plain" onPress={() => { setMessage(null); refresh(); }} />
    </View>
  );
}

const STATE: Record<string, string> = {
  empty: "waiting for money",
  arriving: "arriving",
  locked: "locked",
  lapsed: "date passed — yours to take home",
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
      <Text style={s.p}>Paste the link to a Crowdlock's file. It is checked on this phone, the same way the register page checks it, before it is added.</Text>
      <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} placeholder="https://…/crowdlocks/name.json" value={link} onChangeText={(t) => { setLink(t); setProblems(null); }} />
      {problems && <><Text style={s.error}>Refused:</Text>{problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}</>}
      <Button label={busy ? "Checking…" : "Check and add"} disabled={busy || !link} onPress={() => add()} />
      <Text style={s.note}>Someone showing you a Crowdlock's QR code? Point your phone's own camera at it — it opens here by itself.</Text>
      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
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

function CosignerKey({ words: walletWords, go }: { words: string; go: Go }) {
  const [stage, setStage] = useState<"intro" | "show" | "check" | "result" | "existing">("intro");
  const [coWords, setCoWords] = useState("");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pub, setPub] = useState<string | null>(null);
  const [xpub, setXpub] = useState<string | null>(null);
  const list = coWords.split(" ");
  // Leave this screen and the words are gone from memory with it.
  const leave = () => { setCoWords(""); setTyped(""); setPub(null); setXpub(null); go({ name: "home", words: walletWords }); };

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
      <Button label="Done" onPress={leave} />
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
    <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} value={name} onChangeText={setName} placeholder="e.g. janesmith" />
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
        setMsg({ ok: true, text: has ? "Added its xpub. Its website updates in a minute or two." : "Added. Its website updates in a minute or two — then tap Refresh and new locks will use it." });
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
    <Text style={s.note}>Adding a key never removes one, so every lock already made keeps counting. Don't have one? Make it from Home → "Make a co-signer key", ideally on a phone that holds no money{c.crowdlock.network === "mainnet" ? ", and keep its words on paper only" : ""}.</Text>
    <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} value={key} onChangeText={(t) => { setKey(t); setMsg(null); }} placeholder="Paste its xpub, or its key: 02… or 03…" />
    {!!pastedXpub && <Text style={s.note}>That xpub stands for {k.slice(0, 10)}…{k.slice(-8)}.{has ? " This Crowdlock already has that key, so only the xpub will be added." : ""}</Text>}
    {keys.length > 0 && keys.some((x) => !xpubForKey(c.crowdlock, x)) && <Text style={s.note}>Members with a hardware wallet can only lock with a key whose xpub is published. To add one for a key already here, paste its xpub.</Text>}
    {problem && <Text style={s.error}>{problem}</Text>}
    {!path && <Text style={s.error}>Can't tell where this Crowdlock's file sits in its repository.</Text>}
    {codeView}
    {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
    <Button label={busy ? "Adding…" : "Add this co-signer key"} disabled={busy || !k || !!problem || !path} onPress={add} />
  </>;
}

function LookAfter({ c, account, onChange }: { c: Extract<Loaded, { ok: true }>; account: any; onChange: () => void }) {
  const where = repoFromFileUrl(c.url);
  const [status, setStatus] = useState<string>("unknown");
  const [published, setPublished] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
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

  return (
    <View>
      <Text style={s.h2}>Look after this Crowdlock</Text>
      {status === "behind" && <Text style={s.note}>An update is available for this Crowdlock's inbox.</Text>}
      {!open ? <Button label="For its founder and maintainers" kind="plain" onPress={() => setOpen(true)} /> : <>
        {status === "behind" && <View style={s.panel}>
          <Text style={s.p}>What the update brings:</Text>
          {changesSince(published, template.changes).map((x: any) => <Text key={x.version} style={s.note}>• {x.change}</Text>)}
          <Text style={s.note}>It changes only the inbox's code, in one commit anyone can read. The declaration, register and settings are untouched.</Text>
          <Button label={busy ? "Updating…" : "Update it"} disabled={busy} onPress={update} />
        </View>}
        {status === "current" && <Text style={s.good}>Its inbox is up to date.</Text>}
        {codeView}
        {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
        <CosignerKeys c={c} account={account} owner={where.owner} repo={where.repo} onChange={onChange} />
        {c.crowdlock.network === NETWORK && <Destinations c={c} account={account} owner={where.owner} repo={where.repo} onChange={onChange} />}
        {c.crowdlock.network === NETWORK && <WriteProposal c={c} owner={where.owner} repo={where.repo} onChange={onChange} />}
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

type Pile = { count: number; sats: number; mine: { sats: number; record: any; paid?: boolean }[]; good: { record: any; at: number; sats: number }[]; completed: number; refused: string[]; paid: number; paidCount: number };

async function readPile(c: Extract<Loaded, { ok: true }>, p: any, account: any): Promise<Pile> {
  const items = await fetchCommitments(c.crowdlock, p.hash);
  const pile: Pile = { count: 0, sats: 0, mine: [], good: [], completed: 0, refused: [], paid: 0, paidCount: 0 };
  for (const it of items) {
    if (it.type === "completed") { pile.completed++; continue; }
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

function Proposals({ c, account, member }: { c: Extract<Loaded, { ok: true }>; account: any; member: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const list: any[] = c.proposals ?? [];
  if (!c.crowdlock.register.proposals && list.length === 0) return null;
  return (
    <View>
      <Text style={s.h2}>Proposals</Text>
      {(c.proposalProblems ?? []).map((x: string, i: number) => <Text key={i} style={s.error}>{x}</Text>)}
      {list.length === 0 && <Text style={s.note}>No proposals yet. When one is published, you can commit your locked money to it here. Nothing moves unless it reaches its target.</Text>}
      {list.slice().reverse().map((p) => (
        <View key={p.hash} style={s.card}>
          <Pressable onPress={() => setOpen(open === p.hash ? null : p.hash)}>
            <Text style={[s.p, { fontWeight: "700" }]}>{p.title}</Text>
            <ProposalStatus c={c} p={p} account={account} />
            <Text style={s.link}>{open === p.hash ? "Hide" : "Read it and see who's committed →"}</Text>
          </Pressable>
          {open === p.hash && <ProposalDetail c={c} p={p} account={account} member={member} />}
        </View>
      ))}
    </View>
  );
}

/** The one line under a proposal's title: its phase, or that it has been paid. */
function ProposalStatus({ c, p, account }: { c: Extract<Loaded, { ok: true }>; p: any; account: any }) {
  const [paid, setPaid] = useState<number | null>(null);
  useEffect(() => { readPile(c, p, account).then((x) => setPaid(x.paid)).catch(() => setPaid(null)); }, [c, p]);
  if (paid !== null && paid >= p.target.sats) return <Text style={s.good}>Funded and paid · {btc(BigInt(paid))} sent to the seller · closed</Text>;
  return <Text style={s.note}>{PHASE_TEXT[phaseOf(p)]} · needs {money(p.requires, p.currency)} · target about {shortBtc(p.target.sats)}{paid ? ` · ${btc(BigInt(paid))} paid so far` : ""}</Text>;
}

function ProposalDetail({ c, p, account, member }: { c: Extract<Loaded, { ok: true }>; p: any; account: any; member: boolean }) {
  const [pile, setPile] = useState<Pile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timePhase = phaseOf(p);
  const refresh = useCallback(() => { setErr(null); readPile(c, p, account).then(setPile).catch((e) => setErr(String(e?.message ?? e))); }, [c, p]);
  useEffect(() => { refresh(); }, [refresh]);
  // Once the co-signer has paid out the target, the proposal is finished:
  // nothing more can be committed or completed, whatever its dates say.
  const funded = !!pile && pile.paid >= p.target.sats;
  const phase = funded ? "funded" : timePhase;
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
        {funded ? <>
          <Text style={s.good}>Funded and paid. {btc(BigInt(pile.paid))} went to the seller in {pile.paidCount} payment{pile.paidCount === 1 ? "" : "s"}, completed by the co-signer and sent. This proposal is closed.</Text>
        </> : <>
          <Text style={s.big}>{btc(BigInt(pile.sats + pile.paid))}</Text>
          <Text style={s.note}>{pile.count} waiting{pile.paidCount ? ` · ${pile.paidCount} paid (${btc(BigInt(pile.paid))})` : ""}, each checked on this phone{pile.refused.length ? ` · ${pile.refused.length} refused` : ""}. {met ? "The target is met." : `${btc(BigInt(Math.max(0, p.target.sats - pile.sats - pile.paid)))} to go.`}</Text>
        </>}
        {pile.refused.slice(0, 3).map((r, i) => <Text key={i} style={s.note}>Refused: {r}</Text>)}
        {pile.mine.length > 0 && <Text style={s.good}>{pile.mine.some((m) => m.paid) ? "Your commitment was paid: " : "You've committed "}{btc(BigInt(pile.mine.reduce((n, m) => n + m.sats, 0)))}.</Text>}
      </>}
      <Button label="Refresh" kind="plain" onPress={refresh} />
      {member && phase === "gathering" && <CommitForm c={c} p={p} account={account} onDone={() => setTimeout(refresh, 3000)} />}
      {member && phase === "soon" && <Text style={s.note}>You can commit once it opens.</Text>}
      {pile && (phase === "gathering" || phase === "settling") && <CoSign c={c} p={p} pile={pile} onDone={() => setTimeout(refresh, 3000)} />}
    </View>
  );
}

function CommitForm({ c, p, account, onDone }: { c: Extract<Loaded, { ok: true }>; p: any; account: any; onDone: () => void }) {
  const [coins, setCoins] = useState<{ lock: any; coin: any }[] | null>(null);
  const [pick, setPick] = useState<number>(0);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    (async () => {
      const out: { lock: any; coin: any }[] = [];
      const now = Math.floor(Date.now() / 1000);
      for (const l of locksOnRegister(c.register, account.address)) {
        if (l.locktime <= now) continue; // lapsed: it goes home instead
        for (const coin of (await chain.utxos(l.address)).filter((u: any) => u.confirmed)) {
          out.push({ lock: { ...l, cosignerXpub: xpubForKey(c.crowdlock, l.cosignerPubkey) }, coin });
        }
      }
      out.sort((a, b) => b.coin.value - a.coin.value);
      setCoins(out);
    })().catch(() => setCoins([]));
  }, []);
  if (!coins) return <ActivityIndicator />;
  if (coins.length === 0) return <Text style={s.note}>You have no locked money on this Crowdlock's register to commit. Lock some first, above.</Text>;
  const chosen = coins[Math.min(pick, coins.length - 1)];
  const sats = amount.trim() ? parseBtc(amount) : null;
  const problem = amount.trim() && sats === null ? "Write the amount in BTC, like 0.001." : sats !== null && sats > BigInt(chosen.coin.value) ? "That's more than this lock holds." : null;
  const commit = () => {
    Alert.alert("Commit to this proposal?",
      `You'll sign a commitment of ${sats === null ? "all of this lock" : btc(sats)} to "${p.title}", paying ${p.destination.slice(0, 14)}…`
      + " It stays binding until the proposal closes on " + p.closes.slice(0, 10) + ", and can't be withdrawn."
      + " Nothing moves unless the proposal reaches its target and the co-signer completes it. If it doesn't, your money stays locked and comes home on its date as usual."
      + (account.kind === "ledger" ? " Your Ledger will ask you to approve the payment." : ""),
      [{ text: "Cancel", style: "cancel" }, { text: "Sign the commitment", onPress: async () => {
        setBusy(true); setMsg(null);
        try {
          const feeRate = await chain.feeRate(feeSpeed);
          const r = await buildCommitment({ account, chain, lock: chosen.lock, coin: chosen.coin, proposalHash: p.hash, destination: p.destination, amount: sats === null ? "all" : sats, feeRate, maxFee: c.crowdlock.max_commitment_fee });
          const v = await checkCommitment({ record: r.record, crowdlock: c.crowdlock, proposal: p, destinations: c.destinations, chain, network: NETWORK });
          if (!v.valid) throw new Error(`the commitment didn't pass its own check: ${v.reason}`);
          const posted = await postCommitment(c.crowdlock, { type: "commitment", proposal: p.hash, record: r.record });
          setMsg(posted.ok
            ? { ok: true, text: `Committed ${btc(r.committed)} (fee ${btc(r.fee)} if it settles). Posted to ${posted.accepted} of ${posted.total} relays.${r.remainder > 0n ? ` The other ${btc(r.remainder)} would stay locked to the same date.` : ""}` }
            : { ok: false, text: "Signed, but no relay took it just now. Check your connection or VPN and try again." });
          onDone();
        } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
        setBusy(false);
      } }]);
  };
  return (
    <View style={s.panel}>
      <Text style={s.label}>Commit your locked money</Text>
      {coins.map((x, i) => (
        <Pressable key={x.coin.txid + x.coin.vout} onPress={() => setPick(i)}>
          <Text style={i === pick ? s.good : s.note}>{i === pick ? "● " : "○ "}{btc(BigInt(x.coin.value))}, locked until {new Date(x.lock.locktime * 1000).toISOString().slice(0, 10)}</Text>
        </Pressable>
      ))}
      <TextInput style={s.input} keyboardType="decimal-pad" value={amount} onChangeText={(t) => { setAmount(t); setMsg(null); }} placeholder="Amount in BTC — leave empty for all of it" />
      {problem && <Text style={s.error}>{problem}</Text>}
      <FeeChoice />
      <LedgerHint account={account} />
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      <Button label={busy ? "Signing…" : "Commit"} disabled={busy || !!problem} onPress={commit} />
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
  const complete = () => {
    Alert.alert("Complete and send?",
      `This completes ${take.length} commitment${take.length === 1 ? "" : "s"} (${btc(BigInt(sum - pile.paid))}) and sends them to ${p.destination.slice(0, 14)}…. It can't be undone. Do this only if the proposal is genuine and its target is met.`,
      [{ text: "Cancel", style: "cancel" }, { text: "Complete and send", style: "destructive", onPress: async () => {
        setBusy(true); setMsg(null);
        let sent = 0; const failed: string[] = [];
        for (const g of take) {
          try {
            const hex = await completeCommitmentWith({ words, record: g.record, chain });
            await chain.broadcast(hex);
            await postCommitment(c.crowdlock, { type: "completed", proposal: p.hash, tx: hex });
            sent++;
          } catch (e: any) { failed.push(String(e.message ?? e)); }
        }
        setWords("");
        setMsg(failed.length
          ? { ok: sent > 0, text: `Sent ${sent} of ${take.length}. ${failed[0]}` }
          : { ok: true, text: `Completed and sent all ${sent}. They'll confirm over the next blocks.` });
        setBusy(false); onDone();
      } }]);
  };
  return (
    <View>
      {!open ? <Button label="For the co-signer" kind="plain" onPress={() => setOpen(true)} /> : <View style={s.panel}>
        <Text style={s.label}>Co-sign this proposal</Text>
        <Text style={s.note}>Only once the target is met, and only if the proposal and its destination are genuine. Type the co-signer key's words, ideally on a phone that is otherwise offline. They are used once and not saved.</Text>
        {!met && <Text style={s.error}>The target isn't met yet: {btc(BigInt(pile.sats))} of {btc(BigInt(p.target.sats))}. Nothing should be completed.</Text>}
        <WordsInput value={words} onChange={setWords} placeholder="The co-signer key's 12 words" />
        {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
        <Button label={busy ? "Completing…" : `Complete ${take.length} and send`} disabled={busy || !met || !wordsAreValid(tidyWords(words)) || take.length === 0} onPress={complete} />
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
            setStep(account.kind === "ledger" ? "Waiting for your Ledger — unlock it, open Bitcoin Test, and approve the message it shows." : "Signing…");
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
      <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} value={address} onChangeText={(t) => { setAddress(t); setMsg(null); }} placeholder="The address a purchase would pay" />
      <TextInput style={s.input} value={text} onChangeText={(t) => { setText(t); setMsg(null); }} placeholder="Who it belongs to and what it's for" />
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
    try { p.hash = proposalHash(fieldsOf(p, c.crowdlock.declaration.sha256)); } catch (e: any) { return { problem: e.message }; }
    const rate = Number(sats) > 0 ? (minor / 10 ** digits) / (Number(sats) / 1e8) : 0;
    p.target = { sats: Number(sats), rate: `1 BTC = ${rate.toFixed(digits)} ${cur}`, at: opens };
    return { p };
  };
  const { p: preview, problem } = draft();
  const proposalsPath = c.crowdlock.register.proposals ?? c.crowdlock.register.destinations.replace(/[^/]*$/, "proposals.json");
  const publish = () => {
    const now = draft();
    if (!now.p) return;
    Alert.alert("Publish this proposal?", `"${now.p.title}": ${money(now.p.requires, now.p.currency)} to ${now.p.destination.slice(0, 14)}…, gathering until ${now.p.closes.slice(0, 10)}. Once published it can't be changed: its wording and price are fixed by its fingerprint.`,
      [{ text: "Cancel", style: "cancel" }, { text: "Publish", onPress: async () => {
        setBusy(true); setMsg(null);
        try {
          await withSignIn(async (token) => {
            if (!(await canWrite(token, owner, repo))) throw new Error("Only this Crowdlock's founder and its maintainers can publish a proposal for it.");
            await publishProposal({
              token, owner, repo, crowdlockPath: pathInRepo(c.url), proposalsPath, proposal: now.p,
              check: ({ crowdlock, file }: any) => checkProposals(file, crowdlock),
            });
            setTitle(""); setText(""); setPrice(""); setTarget("");
            setMsg({ ok: true, text: "Published. Its website updates in a minute or two — then tap Refresh on the Crowdlock and it appears under Proposals." });
            setTimeout(onChange, 90000);
          });
        } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
        setBusy(false);
      } }]);
  };
  return <>
    <Text style={s.label}>Write a proposal</Text>
    {usable.length === 0 ? <Text style={s.note}>No destination is ready yet. Add and attest one above{c.crowdlock.destination_wait_days ? `, then wait ${c.crowdlock.destination_wait_days} days` : ""}.</Text> : <>
      <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="Title" />
      <TextInput style={[s.input, { minHeight: 120, textAlignVertical: "top" }]} multiline value={text} onChangeText={setText} placeholder="What is being bought, from whom, and why" />
      <Text style={s.label}>Pays (tap one)</Text>
      {usable.map((e: any) => <Pressable key={e.index} onPress={() => setDest(e.address)} style={[s.btn, dest !== e.address && s.btnPlain, { alignItems: "flex-start" }]}><Text style={[s.btnText, dest !== e.address && s.btnTextPlain, { fontSize: 15 }]}>{dest === e.address ? "✓ " : ""}{e.text} — {e.address.slice(0, 14)}…{e.address.slice(-6)}</Text></Pressable>)}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[s.input, { flex: 2 }]} keyboardType="decimal-pad" value={price} onChangeText={setPrice} placeholder="Price" />
        <TextInput style={[s.input, { flex: 1 }]} autoCapitalize="characters" value={currency} onChangeText={(t) => setCurrency(t.toUpperCase())} placeholder="Currency" maxLength={3} />
      </View>
      <TextInput style={s.input} keyboardType="decimal-pad" value={target} onChangeText={setTarget} placeholder="Target in BTC (the price in bitcoin today)" />
      <Text style={s.note}>Gathers for (days, at most {c.crowdlock.gathering_window_max_days}) and settles for (days, at most {c.crowdlock.settlement_window_max_days}):</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput style={[s.input, { flex: 1 }]} keyboardType="number-pad" value={days} onChangeText={setDays} />
        <TextInput style={[s.input, { flex: 1 }]} keyboardType="number-pad" value={settle} onChangeText={setSettle} />
      </View>
      {problem ? <Text style={s.note}>{problem}</Text> : <Text style={s.note}>Opens now, closes {preview.closes.slice(0, 10)}, settles by {preview.settles_by.slice(0, 10)}. Fingerprint {preview.hash.slice(0, 12)}…</Text>}
      {codeView}
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      <Button label={busy ? "Publishing…" : "Publish this proposal"} disabled={busy || !!problem} onPress={publish} />
    </>}
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
  }, []);

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
      <TextInput style={s.input} placeholder="Search by name or purpose" value={query} onChangeText={setQuery} autoCorrect={false} />
      {status ? <Text style={s.note}>{status}</Text> : null}
      {found === null && <ActivityIndicator style={{ marginVertical: 16 }} />}
      {found !== null && shown.length === 0 && !status && <Text style={s.note}>{query ? "Nothing matches that." : "None found yet."}</Text>}
      {shown.map((f) => (
        <Pressable key={f.url} style={s.card} onPress={() => open(f.url)}>
          <Text style={s.cardTitle}>{f.name}</Text>
          {f.about ? <Text style={s.p}>{f.about}</Text> : null}
          <Text style={s.note}>{btc(f.sats)} locked · {f.members} committed member{f.members === 1 ? "" : "s"}</Text>
          <Text style={mine.includes(f.url) ? s.good : s.link}>{mine.includes(f.url) ? "In your list" : "Have a look →"}</Text>
        </Pressable>
      ))}
      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Starting a Crowdlock
// ---------------------------------------------------------------------------

function StartCrowdlock({ words, go }: { words: string; go: Go }) {
  const [network, setNetwork] = useState<"testnet4" | "mainnet">("testnet4");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [title, setTitle] = useState("OUR DECLARATION");
  const [text, setText] = useState(declarationSkeleton("OUR DECLARATION"));
  const [minimum, setMinimum] = useState("0.002");
  const [waitDays, setWaitDays] = useState("7");
  const [gatherDays, setGatherDays] = useState("28");
  const [settleDays, setSettleDays] = useState("14");
  const [cosigner, setCosigner] = useState("");
  const [testPasted, setTestPasted] = useState("");
  const [problems, setProblems] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<any>(null);
  const [stage, setStage] = useState<"form" | "signin" | "creating" | "done">("form");
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ links: { label: string; url: string }[]; repoUrl: string; inboxStarted: boolean; owner: string; repo: string } | null>(null);

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
      <Text style={s.note}>You can do this any time from the Crowdlock's page, under "Look after this Crowdlock".</Text>
      <Button label="Back to wallet" onPress={() => go({ name: "home", words })} />
    </View>
  );

  return (
    <View>
      <Text style={s.h1}>Start a Crowdlock</Text>
      <Text style={s.p}>A Crowdlock lets a crowd commit money to buying something together, without anyone pooling it or holding anyone else's. You write what it's for; the app sets it up in your own GitHub account.</Text>

      <Text style={s.label}>Money</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {([["testnet4", "Test bitcoin only"], ["mainnet", "Real bitcoin, with a test copy"]] as const).map(([k, label]) => (
          <Pressable key={k} onPress={() => { setNetwork(k); setChecked(null); }} style={[s.chip, network === k && s.chipOn]}>
            <Text style={[s.chipText, network === k && { color: "#fff" }]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={s.label}>Name</Text>
      <TextInput style={s.input} value={name} onChangeText={(t) => { setName(t); setChecked(null); }} placeholder="The Pub Fund" />
      <Text style={s.label}>What it's for, in one sentence</Text>
      <TextInput style={s.input} value={about} onChangeText={(t) => { setAbout(t); setChecked(null); }} placeholder="Regulars buying the Red Lion so it stays a pub for good." />
      <Text style={s.label}>The declaration's title</Text>
      <TextInput style={s.input} value={title} autoCapitalize="characters" onChangeText={(t) => {
        // Keep the declaration's first line in step with its title while it still matches.
        setText((old) => old.startsWith(title.toUpperCase() + "\n") ? t.toUpperCase() + old.slice(title.length) : old);
        setTitle(t); setChecked(null);
      }} />
      <Text style={s.label}>The declaration — what people sign</Text>
      <Text style={s.note}>Replace the bracketed part with what you're raising money for. Keep the no-returns line exactly as it is: it's the one rule every Crowdlock shares. Once anyone signs, these words can never change.</Text>
      <TextInput style={[s.input, { minHeight: 240, textAlignVertical: "top" }]} multiline value={text} onChangeText={(t) => { setText(t); setChecked(null); }} />

      {network === "mainnet" ? <>
        <Text style={s.label}>Minimum lock that counts, in BTC</Text>
        <TextInput style={s.input} keyboardType="decimal-pad" value={minimum} onChangeText={(t) => { setMinimum(t); setChecked(null); }} />
        <Text style={s.label}>Days a new destination must be public before a proposal can use it</Text>
        <TextInput style={s.input} keyboardType="number-pad" value={waitDays} onChangeText={(t) => { setWaitDays(t); setChecked(null); }} />
        <Text style={s.note}>We recommend at least 7, The Kop Fund's choice. It's the time members have to notice a destination nobody should be paying before money can go to it. Your test copy uses none, so you can practise.</Text>
        <Text style={s.label}>Co-signer's public key</Text>
        <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} value={cosigner} onChangeText={(t) => { setCosigner(t); setChecked(null); }} placeholder="Its xpub, or its key: 02… or 03…" />
        <Text style={s.note}>The co-signer can't take or keep anyone's money — only refuse to complete a purchase. Make this key with "Make a co-signer key" on Home (or Sparrow, Electrum, or the method's own script), keep its words on paper, and paste its xpub here — or its plain key, though then hardware wallets can't lock until the xpub is added.</Text>
        {!!cosigner.trim() && !isPublicKey(cosigner) && !keyFromXpub(cosigner) && <Text style={s.error}>That isn't a public key or an xpub. Copy it whole from where the key was made.</Text>}
        {!!keyFromXpub(cosigner) && <Text style={s.note}>That xpub stands for {keyFromXpub(cosigner)!.slice(0, 10)}…, and is published beside it so hardware wallets can lock.</Text>}
      </> : <Text style={s.note}>Test bitcoin has no value: practise everything — joining, locking, taking a lock home — before anything is real.</Text>}

      <Text style={s.label}>Longest a proposal may gather commitments, in days</Text>
      <TextInput style={s.input} keyboardType="number-pad" value={gatherDays} onChangeText={(t) => { setGatherDays(t); setChecked(null); }} />
      <Text style={s.note}>We recommend 28, The Kop Fund's choice: long enough to reach supporters who only look now and then. Each proposal picks its own length up to this, and gathering ends as soon as the target is met. A small group with a short deadline can use less.</Text>
      <Text style={s.label}>Longest settling may take after that, in days</Text>
      <TextInput style={s.input} keyboardType="number-pad" value={settleDays} onChangeText={(t) => { setSettleDays(t); setChecked(null); }} />
      <Text style={s.note}>We recommend 14: room for the co-signer to complete and send everything at a sensible pace. A small Crowdlock can settle in hours. Members are bound to a proposal for at most these two together.</Text>

      <Text style={s.label}>{network === "mainnet" ? "The test copy's co-signer key" : "Co-signer key"}</Text>
      <Text style={s.note}>{testPasted.trim() ? "Using the key you pasted." : !testCo ? "This wallet is on a Ledger, so paste a practice co-signer key (made with \"Make a co-signer key\") — its xpub, ideally:" : `Made on this phone from your backup words: ${testCo.slice(0, 10)}…${testCo.slice(-8)}. Or paste a practice key you made instead:`}</Text>
      <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} value={testPasted} onChangeText={(t) => { setTestPasted(t); setChecked(null); }} placeholder="Optional: an xpub, or a key 02… or 03…" />
      {!!testPasted.trim() && !isPublicKey(testPasted) && !keyFromXpub(testPasted) && <Text style={s.error}>That isn't a public key or an xpub. Copy it whole from where the key was made.</Text>}
      <Text style={s.note}>You can add more co-signer keys later, under "Look after this Crowdlock".</Text>

      {problems && problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}
      {error && <Text style={s.error}>{error}</Text>}
      {!checked && <Button label="Check it" onPress={check} />}
      {checked && <View style={s.panel}>
        <Text style={s.good}>It checks out — the same checks every Crowdlock passes.</Text>
        {checked.fingerprints.map((f: any) => <Text key={f.slug} style={s.note}>{f.network === "mainnet" ? "Real" : "Test copy"} · fingerprint {f.sha256.slice(0, 12)}…</Text>)}
        <Button label="Sign in to GitHub and create it" onPress={create} />
      </View>}
      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
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
function FeeChoice() {
  const [speed, setSpeed] = useState<FeeSpeed>(feeSpeed);
  const [rates, setRates] = useState<{ slow: number; normal: number; fast: number } | null>(null);
  useEffect(() => { chain.feeRates().then(setRates).catch(() => {}); loadFeeSpeed().then((v) => { feeSpeed = v; setSpeed(v); }); }, []);
  const pick = (v: FeeSpeed) => { feeSpeed = v; setSpeed(v); saveFeeSpeed(v); };
  return (
    <View>
      <Text style={s.h2}>Fee speed</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["slow", "normal", "fast"] as FeeSpeed[]).map((v) => (
          <Pressable key={v} onPress={() => pick(v)} style={[s.btn, speed !== v && s.btnPlain, { flex: 1, paddingHorizontal: 4 }]}>
            <Text style={[s.btnText, speed !== v && s.btnTextPlain, { fontSize: 14 }]}>{SPEED_LABEL[v]}{rates ? `\n${rates[v]} sat/vB` : ""}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.note}>
        {SPEED_LABEL[speed]}: usually confirms in {SPEED_WHEN[speed]}. A higher rate costs more and is quicker; a low one can wait many hours when the network is busy. The fee is shown before you approve a lock or a payment.
      </Text>
    </View>
  );
}

function Button({ label, onPress, kind = "main", disabled }: { label: string; onPress: () => void; kind?: "main" | "plain" | "danger"; disabled?: boolean }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [s.btn, kind === "plain" && s.btnPlain, kind === "danger" && s.btnDanger, (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={[s.btnText, kind !== "main" && s.btnTextPlain, kind === "danger" && { color: "#a00" }]}>{label}</Text>
    </Pressable>
  );
}

const RED = "#C8102E";
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  bannerReal: { backgroundColor: "#c8102e", color: "#fff", textAlign: "center", paddingVertical: 6, fontWeight: "700", fontSize: 12 },
  banner: { backgroundColor: "#ffd84d", color: "#222", textAlign: "center", paddingVertical: 6, fontWeight: "700", fontSize: 12 },
  body: { padding: 20, paddingBottom: 60 },
  h1: { fontSize: 26, fontWeight: "800", marginTop: 12, marginBottom: 12, color: "#111" },
  h2: { fontSize: 20, fontWeight: "700", marginTop: 28, marginBottom: 8, color: "#111" },
  p: { fontSize: 16, lineHeight: 23, color: "#222", marginBottom: 10 },
  note: { fontSize: 14, lineHeight: 20, color: "#666", marginVertical: 8 },
  good: { fontSize: 14, color: "#18794e", marginVertical: 8 },
  error: { fontSize: 15, color: "#a00", marginVertical: 8 },
  big: { fontSize: 32, fontWeight: "800", color: "#111", marginBottom: 4 },
  bold: { fontWeight: "700" },
  label: { fontSize: 14, fontWeight: "600", color: "#333", marginTop: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16, color: "#111" },
  mono: { fontFamily: "monospace", fontSize: 14, color: "#111", marginVertical: 8 },
  words: { flexDirection: "row", flexWrap: "wrap", marginVertical: 12 },
  word: { width: "50%", fontSize: 18, paddingVertical: 6, color: "#111" },
  wordNum: { color: "#888" },
  qr: { alignItems: "center", padding: 16, backgroundColor: "#fff" },
  panel: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, padding: 14, marginTop: 14 },
  btn: { backgroundColor: RED, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  btnPlain: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#ccc" },
  btnDanger: { backgroundColor: "transparent", marginTop: 40 },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  btnTextPlain: { color: "#111" },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, padding: 14, marginTop: 10 },
  cardTitle: { fontSize: 17, fontWeight: "700", color: "#111" },
  link: { fontSize: 15, color: RED, fontWeight: "600", marginTop: 4 },
  declaration: { fontSize: 15, lineHeight: 22, color: "#222", marginVertical: 8 },
  box: { width: 24, height: 24, borderWidth: 2, borderColor: "#999", borderRadius: 4, marginRight: 10, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: RED, borderColor: RED },
  chip: { borderWidth: 1, borderColor: "#ccc", borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14 },
  chipOn: { backgroundColor: RED, borderColor: RED },
  chipText: { fontSize: 15, color: "#111", fontWeight: "600" },
});
