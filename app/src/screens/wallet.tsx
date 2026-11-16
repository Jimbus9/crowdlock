// The wallet on this phone: setting it up (new words, a Ledger, or restoring
// from words), getting bitcoin in (step 3 of the six), sending it out, and
// the wallet's own settings.
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
// @ts-ignore — plain module shared with the chain tests
import {
  newWords, wordsAreValid, tidyWords, suggestWords, buildSend, checkLedgerKey, readLedgerAccount,
} from "../wallet/core.mjs";
import { ledgerWalletText, withLedger, lookForLedgers, askForBluetooth, ledgerAppFor } from "../ledgerDevice";
import { saveWords, forgetWords, forgetAddedCrowdlocks, forgetSavedLocks, forgetLedgerStore } from "../storage";
import { NETWORK, chain, EXPLORER_WEB } from "../config";
// The look (one theme file) and the shared parts every screen is built from.
import { Btn, NoScreenshots, Warning } from "../ui/parts";
import { whileOpen, SECRET_WORDS, Input, walletAccount, LedgerHint, btc, FeeChoice, Confirm, s } from "./shared";
import type { Go } from "./shared";

export function Welcome({ go }: { go: Go }) {
  return (
    <View>
      <Text style={s.p}>Your own bitcoin wallet. Nobody else holds your money — not us, not anyone.</Text>
      <Btn label="Create a new wallet" onPress={() => go({ name: "showWords", words: newWords() })} />
      <Btn label="I already have recovery words" kind="second" onPress={() => go({ name: "restore" })} />
      <Btn label="Use a Ledger" kind="second" onPress={() => go({ name: "ledgerSetup" })} />
    </View>
  );
}

// Setting up a Ledger as this phone's wallet. The key stays on the device;
// the phone keeps only the account's public part, to show balances without it.
export function LedgerSetup({ from, go }: { from?: string; go: Go }) {
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
        <Btn label="Find my Ledger" onPress={look} />
      </>}
      {stage === "looking" && <>
        <Text style={s.p}>Looking for Ledgers nearby…</Text>
        {devices.length === 0 && <ActivityIndicator style={{ marginVertical: 16 }} />}
        {devices.map((d) => <Btn key={d.id} label={`Use ${d.name} (${d.via === "cable" ? "cable" : "Bluetooth"})`} onPress={() => choose(d)} />)}
        <Text style={s.note}>By Bluetooth, the first time, the phone and the Ledger may ask to pair, each showing a code. Check they match, then accept on both. By cable, the phone asks whether Crowdlock may use the Ledger: allow it.</Text>
        <Btn label="Stop looking" kind="second" onPress={() => { stop.current?.(); setStage("start"); }} />
      </>}
      {stage === "reading" && <>
        <Text style={s.p}>Reading your account from the Ledger…</Text>
        <ActivityIndicator style={{ marginVertical: 16 }} />
      </>}
      {stage === "found" && account && <>
        <Text style={s.p}>This is your Ledger's wallet. It's the same address Ledger Live, Sparrow or any standard wallet shows for this Ledger's first native segwit account.</Text>
        <Text style={s.mono} selectable>{account.address}</Text>
        <Btn label="Copy address" kind="second" onPress={() => Clipboard.setStringAsync(account.address)} />
        {from && <Text style={s.note}>To move money onto it first, copy the address, go Back, and send it from this phone's wallet. Then come back here. Using this Ledger replaces that wallet on this phone — only do it once its 12 words are written down.</Text>}
        <Btn label="Use this Ledger" onPress={async () => {
          const text = ledgerWalletText(wallet!);
          // A different wallet: forget the old one's saved lock terms (they're
          // on the register, and restoring its words finds them again).
          if (from) { await forgetSavedLocks(); await forgetLedgerStore(); }
          await saveWords(text); go({ name: "home", words: text });
        }} />
        <Btn label="Try again" kind="second" onPress={() => { setWallet(null); setStage("start"); }} />
      </>}
      {error && <Text style={s.error}>{error}</Text>}
      <Btn label="Back" kind="second" onPress={() => { stop.current?.(); go(from ? { name: "home", words: from } : { name: "welcome" }); }} />
    </View>
  );
}

export function ShowWords({ words, go }: { words: string; go: Go }) {
  const list = words.split(" ");
  return (
    <View>
      <NoScreenshots />
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
      <Text style={s.note}>This screen can't be screenshotted. Don't photograph the words, or save them in notes, email or cloud storage.</Text>
      <Btn label="I have written them down" onPress={() => go({ name: "checkWords", words })} />
    </View>
  );
}

export function CheckWords({ words, go }: { words: string; go: Go }) {
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
export function CheckEveryWord({ words, onDone, onShowAgain }: { words: string; onDone: () => void; onShowAgain: () => void }) {
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
      <NoScreenshots />
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
      <Btn label="Next" disabled={!typed.trim()} onPress={() => accept(typed)} />
      <Btn label="Show the words again" kind="second" onPress={onShowAgain} />
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
export function WordsInput({ value, onChange, placeholder }: { value: string; onChange: (t: string) => void; placeholder?: string }) {
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
    <NoScreenshots />
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

export function Restore({ go }: { go: Go }) {
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
      <Btn label="Restore" disabled={!valid} onPress={finish} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 3: get bitcoin
// ---------------------------------------------------------------------------

export function AddMoney({ words }: { words: string }) {
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

export function Send({ words, go }: { words: string; go: Go }) {
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
      const feeRate = await chain.feeRate(whileOpen.feeSpeed);
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
      <Btn label="Back to wallet" onPress={() => go({ name: "home", words })} />
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
      <Btn label={all ? "Send a set amount instead" : "Send everything"} kind="second" onPress={() => { setAll(!all); setReview(null); }} />

      {!review && <FeeChoice />}
      {error && <Text style={s.error}>{error}</Text>}
      {!review && <LedgerHint account={account} />}
      {!review && <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Checking…") : "Review"} disabled={busy || !to} onPress={prepare} />}
      {review && (
        <View style={s.panel}>
          <Text style={s.p}>Sending <Text style={s.bold}>{btc(review.sent)}</Text></Text>
          <Text style={s.p}>Network fee {btc(review.fee)}</Text>
          <Text style={s.p}>To <Text style={s.mono}>{to}</Text></Text>
          <Btn label={busy ? "Sending…" : "Confirm and send"} disabled={busy} onPress={confirm} />
        </View>
      )}
      <Btn label="Cancel" kind="second" onPress={() => go({ name: "home", words })} />
    </View>
  );
}

export function WalletScreen({ words, go }: { words: string; go: Go }) {
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

export function FeeSpeedScreen() {
  return (
    <View>
      <FeeChoice />
      <Text style={s.p}>Every bitcoin payment pays a small fee to the network. A higher fee is quicker. Your choice is saved and used for every lock and payment.</Text>
    </View>
  );
}
