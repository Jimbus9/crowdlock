// Three of the six steps, each a short flow of its own that ends in a check
// page: sign to join (step 2), lock (step 4), and take it home or lock it
// again (step 6). Step 3, getting bitcoin, is in wallet.tsx; step 5,
// committing to a purchase, is in proposals.tsx.
//
// Every screen here is presentation. The signing, saving and sending are
// calls into src/wallet/core.mjs and src/crowdlocks.mjs.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
// @ts-ignore — plain module shared with the chain tests
import {
  waitingBalance, lockFor, lockDate, buildLock, lockState, takeHome, relock, xpubForKey, signStatementWith,
  lockRecordFor,
} from "../wallet/core.mjs";
// @ts-ignore — plain module shared with the chain tests
import {
  loadCrowdlock, membershipOf, submitJoin, shortBtc, locksOnRegister, newestCosigner, keyChanges, newVersionToSign,
} from "../crowdlocks.mjs";
// @ts-ignore — plain module
import { postToRelays } from "../relays.mjs";
import { loadSavedLocks, saveLock, loadSeenKeys, loadExpectedKeys } from "../storage";
import { NETWORK, chain } from "../config";
// The look (one theme file) and the shared parts every screen is built from.
import { Btn, NavRow, Warning } from "../ui/parts";
import {
  whileOpen, finishedLocks, signedHere, markSignedJustNow, useBack, Input, walletAccount, LedgerHint, btc, when, lengthLabel, SPEED_LABEL, VB_HOME, VB_AGAIN,
  VB_WAITING, useFeeRate, aboutFee, FeeChoice, SumRow, Changes, s, signingAccount,
} from "./shared";
import type { Go, Loaded, LockTerms, LockRow } from "./shared";

// ---------------------------------------------------------------------------
// Step 2: sign to join. Its own page, with its two warnings above the button.
// The wallet signs the Crowdlock's statement (signStatementWith) and the
// signature is posted to its relays or its join address.
// ---------------------------------------------------------------------------

export function SignScreen({ words, url, go }: { words: string; url: string; go: Go }) {
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
    try { signature = await signStatementWith(await signingAccount(account), c.statement); }
    catch (e: any) { setResult({ ok: false, text: String(e.message ?? e) }); setBusy(false); return; }
    // A Crowdlock that names relays takes its members from there: posted
    // publicly, collected by its own repository within a few minutes.
    if (Array.isArray(c.crowdlock.relays)) {
      const p = await postToRelays(c.crowdlock, { type: "join", address: account.address, signature });
      setResult(p.ok
        ? (signedHere[url] = Date.now(), { ok: true, text: "Signed and sent. You'll be on the register within a few minutes." })
        : { ok: false, text: "It couldn't be sent just now. Your signature is fine. Check your connection, or turn off any VPN, and try again." });
      setBusy(false);
      return;
    }
    const r = await submitJoin(c.crowdlock, { address: account.address, signature });
    if (r.ok) signedHere[url] = Date.now();
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
    try { signature = await signStatementWith(await signingAccount(account), toSign.current.statement); }
    catch (e: any) { setResult({ ok: false, text: String(e.message ?? e) }); setBusy(false); return; }
    if (!Array.isArray(c.crowdlock.relays)) {
      setResult({ ok: false, text: "This Crowdlock doesn't collect signatures from relays, so the app can't send this one. Ask its founder how to sign the new version." });
      setBusy(false); return;
    }
    const p = await postToRelays(c.crowdlock, { type: "join", address: account.address, signature });
    if (p.ok) markSignedJustNow(c, account.address);
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
      {!me && <Text style={s.p}>The register takes a few minutes to add you, and up to an hour for a Crowdlock that has only just been started. {name}'s page will say "waiting" until then. You don't need to sign again.</Text>}
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

// ---------------------------------------------------------------------------
// Step 4: lock
//
// Three short pages, one question each: how long, how much, then a check page
// that shows the amount, the date and the fee above the one button. The check
// page is the confirmation: nothing is signed or sent before that button.
// Then, in this order: the lock's terms are saved on the phone, the payment
// is built and signed (buildLock), it is sent, and the lock is published.
// ---------------------------------------------------------------------------

export function LockFlow({ words, url, go }: { words: string; url: string; go: Go }) {
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

  const readRate = useCallback(() => { chain.feeRate(whileOpen.feeSpeed).then(setRate).catch(() => setRate(null)); }, []);
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
      const feeRate = await chain.feeRate(whileOpen.feeSpeed);
      const signer = await signingAccount(account);
      const tx = await buildLock({ account: signer, chain, lock, feeRate, amount: chosen.amount });
      // Signed now, with the same unlocked wallet, before any money moves.
      const record = lockRecordFor(signer, c.crowdlock, { cosigner_pubkey: cosigner!, locktime, address: lock.address });
      // The terms are saved before the money moves, and checked saved.
      await saveLock({ crowdlock: c.url, address: lock.address, locktime, cosignerPubkey: cosigner!, cosignerXpub: lock.cosignerXpub ?? undefined, name: c.crowdlock.name });
      await chain.broadcast(tx.hex);
      if (viaRelays) await postToRelays(c.crowdlock, record).catch(() => {});
      whileOpen.overview = null;   // Home reads afresh
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
      <SumRow label="Network fee" value={rate ? `about ${Math.ceil(rate * 141)} sats (${SPEED_LABEL[whileOpen.feeSpeed]})` : "being worked out"} />
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
// instead" as the smaller choice, each with its own check page. Taking it
// home is takeHome; locking again is relock, one payment straight from the
// old lock into the new one, whose terms are saved before it is sent.
// ---------------------------------------------------------------------------

export function HomeFlow({ words, url, address, again, go }: { words: string; url: string; address?: string; again?: boolean; go: Go }) {
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
  const [rate, readRate] = useFeeRate();

  useEffect(() => {
    (async () => {
      const loaded: Loaded = await loadCrowdlock(url);
      setC(loaded);
      // A lock is taken home with its own terms and the wallet's key, nothing
      // else. If the Crowdlock can't be loaded (its site is down, or its file
      // fails its checks) the page carries on from the terms this phone kept;
      // only locking again needs the Crowdlock.
      if (loaded.ok) {
        setYears(loaded.crowdlock.lock_lengths_years[0]);
        setPaused(keyChanges(await loadSeenKeys(url), loaded.crowdlock.cosigner_keys ?? [], await loadExpectedKeys(url)).changed);
      } else { setYears(0); setPage("home"); }
      try {
        setWaiting(await waitingBalance(chain, account.address));
        const medianTime = await chain.medianTime();
        const onReg = (loaded.ok ? locksOnRegister(loaded.register, account.address, loaded.crowdlock) : []) as LockTerms[];
        const saved = (await loadSavedLocks()).filter((l) => l.crowdlock === loaded.url || l.crowdlock === url);
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
  const cl: any = c.ok ? c.crowdlock : null;   // null: the Crowdlock couldn't be loaded
  if (!cl && !loadError && !rows) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!cl && !loadError && rows && rows.length === 0) return (
    <View>
      <Text style={s.h1}>This Crowdlock couldn't be loaded</Text>
      {(c as any).problems.map((p: string, i: number) => <Text key={i} style={s.error}>{p}</Text>)}
      <Text style={s.p}>This phone holds no lock of yours for it that is ready to take home.</Text>
    </View>
  );
  const name: string = cl?.name ?? rows?.find((r) => r.name)?.name ?? "this Crowdlock";
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

  const cosigner: string | undefined = cl ? newestCosigner(cl) : undefined;
  const noLedgerXpub = account.kind === "ledger" && !!cosigner && !xpubForKey(cl, cosigner);
  const lengths: number[] = cl?.lock_lengths_years ?? [];
  const viaRelays = Array.isArray(cl?.relays);
  // The co-signer's xpub is only needed by a Ledger. It comes from the
  // Crowdlock's file, or from what the phone kept when that can't be loaded.
  const oldLock = { ...row, cosignerXpub: (cl ? xpubForKey(cl, row.cosignerPubkey) : null) ?? row.cosignerXpub ?? null };
  const ledgerStuck = !cl && account.kind === "ledger" && !oldLock.cosignerXpub;
  const feeNote = (vb: number) => (
    <>
      <SumRow label="Network fee" value={aboutFee(rate, vb)} />
      <Text style={s.note}>The fee comes out of this amount. The exact fee is shown as soon as it is sent; a lock that was paid into more than once costs a little more. If the fee would be too large a share, nothing is sent.</Text>
      {!showSpeeds
        ? <Btn kind="link" label="Change the fee speed" onPress={() => setShowSpeeds(true)} />
        : <FeeChoice onChange={readRate} />}
    </>
  );

  const takeIt = async () => {
    setBusy(true); setError(null);
    try {
      const tx = await takeHome({ account: await signingAccount(account), chain, lock: oldLock, feeRate: await chain.feeRate(whileOpen.feeSpeed), medianTime: await chain.medianTime() });
      await chain.broadcast(tx.hex);
      whileOpen.overview = null;
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
      {!cl && (
        <Warning level="know" title="This Crowdlock's own site couldn't be loaded">
          Your lock doesn't depend on it. This phone kept the lock's terms, and taking it home needs only those and your own key. Locking again does need the Crowdlock, so that choice is off until it can be loaded.
        </Warning>
      )}
      {ledgerStuck && <Text style={s.error}>A Ledger also needs the co-signer's xpub to take a lock home, and this phone didn't keep one for this lock. It is in the Crowdlock's file: open this page again once the Crowdlock loads. The money is safe in the lock meanwhile.</Text>}
      {feeNote(VB_HOME)}
      <Warning level="know" title="The network's clock runs about an hour behind">
        The date is judged by the bitcoin network's own clock, which runs about an hour behind real time on real bitcoin. If this is refused for its date, wait an hour and try again.
      </Warning>
      <LedgerHint account={account} />
      {error && <Text style={s.error}>{error}</Text>}
      <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Sending…") : "Take it home"} disabled={busy || ledgerStuck} onPress={takeIt} />
      {!!cl && <Btn kind="second" label="Lock it again instead" disabled={busy} onPress={() => { setError(null); setPage("again"); }} />}
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
      const newLock = { ...lockFor({ account, cosignerPubkey: cosigner, locktime }), cosignerXpub: xpubForKey(cl, cosigner!) };
      const signer = await signingAccount(account);
      const record = lockRecordFor(signer, cl, { cosigner_pubkey: cosigner!, locktime, address: newLock.address });
      const tx = await relock({
        account: signer, chain, lock: oldLock, newLock, addWaiting: extra > 0n,
        feeRate: await chain.feeRate(whileOpen.feeSpeed), medianTime: await chain.medianTime(),
      });
      // The new terms are saved before the money moves.
      await saveLock({ crowdlock: c.url, address: newLock.address, locktime, cosignerPubkey: cosigner!, cosignerXpub: newLock.cosignerXpub ?? undefined, name });
      await chain.broadcast(tx.hex);
      if (viaRelays) await postToRelays(cl, record).catch(() => {});
      whileOpen.overview = null;
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
      {feeNote(VB_AGAIN + (extra > 0n ? VB_WAITING : 0))}
      <Warning level="stop" title="Until your date, you can't touch it">
        If bitcoin's price halves, you cannot sell. Only lock what you can leave alone for the whole time. A longer lock counts for longer, and leaves you exposed for longer.
      </Warning>
      <LedgerHint account={account} />
      {error && <Text style={s.error}>{error}</Text>}
      <Btn label={busy ? (account.kind === "ledger" ? "Approve it on your Ledger…" : "Locking…") : "Lock it again"} disabled={busy} onPress={lockAgain} />
    </View>
  );
}
