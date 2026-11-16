// Crowdlocks: the list, one Crowdlock's own page with your locks in it,
// adding one by link, finding the ones that have announced themselves, and
// sharing one.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Share, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
// @ts-ignore — plain module shared with the chain tests
import { waitingBalance, lockState, xpubForKey } from "../wallet/core.mjs";
// @ts-ignore — plain modules shared with the tests
import { DEFAULT_RELAYS } from "../start.mjs";
// @ts-ignore — plain module shared with the chain tests
import {
  STARTING_LIST, loadCrowdlock, membershipOf, committedTotal, COUNTING_RULE_URL, poundsPerBtc, shortBtc, locksOnRegister, submitLock, newestCosigner, keyChanges,
  historyLinkFor, coSignerRecord, openLinkFor, shareLinkFor, rankFound, matchesSearch, repoFromFileUrl, newVersionToSign, versionSignedBy,
} from "../crowdlocks.mjs";
// @ts-ignore — plain module
import { TEST_APP_URL } from "../build.mjs";
// @ts-ignore — plain module
import { postToRelays, announce, fetchAnnouncements } from "../relays.mjs";
import { loadAddedCrowdlocks, saveAddedCrowdlocks, loadSavedLocks, loadSeenKeys, saveSeenKeys, loadExpectedKeys, saveExpectedKeys } from "../storage";
import { NETWORK, IS_TEST_MONEY, chain } from "../config";
// The look (one theme file) and the shared parts every screen is built from.
import { Btn, NavRow, Warning } from "../ui/parts";
import { finishedLocks, signedHere, SIGNED_WAIT_MS, signedJustNow, allLinks, useRefresh, CheckedLine, Input, walletAccount, LedgerHint, btc, when, s } from "./shared";
import type { Go, Loaded, LockTerms, LockRow } from "./shared";
import { Proposals } from "./proposals";

// ---------------------------------------------------------------------------
// Crowdlocks
// ---------------------------------------------------------------------------

export function CrowdlockList({ words, address, go }: { words: string; address: string; go: Go }) {
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
  // A Crowdlock on the other kind of money (test in the real app, real in the
  // test app) isn't listed at all: each app shows only its own kind.
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
      {broken.map((c) => (
        <View key={c.url} style={s.card}>
          <Text style={s.error}>This Crowdlock failed its checks: {c.url}</Text>
          <Text style={s.note}>{c.problems[0]}</Text>
        </View>
      ))}
    </View>
  );
}

export function CrowdlockScreen({ words, url, go }: { words: string; url: string; go: Go }) {
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

  // While a signature is waiting for the register, look again every 45 seconds.
  useEffect(() => {
    if (!signedHere[url] || Date.now() - signedHere[url] > SIGNED_WAIT_MS) return;
    if (c && c.ok && membershipOf(c.register, account.address)) return;
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, [url, c, load, account.address]);

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
  // Signed on this phone a short while ago, and the register hasn't caught up.
  const waitingToJoin = !me && !!signedHere[url] && Date.now() - signedHere[url] < SIGNED_WAIT_MS;
  const toSign = here && !signedJustNow(c, account.address) ? newVersionToSign(c, account.address) : null;
  const mine = me ? versionSignedBy(c, me) : null;

  return (
    <View>
      {!me && here && !waitingToJoin && <Text style={s.kick}>Step 1 of 6: Understand</Text>}
      <Text style={s.h1}>{c.crowdlock.name}</Text>
      {c.crowdlock.about && <Text style={s.p}>{c.crowdlock.about}</Text>}
      {c.crowdlock.disclaimer && <Text style={s.note}>{c.crowdlock.disclaimer}</Text>}

      {keyChange && <View style={s.panel}>
        <Text style={s.error}>This Crowdlock's co-signer keys have changed since you last looked.</Text>
        {keyChange.added.map((k) => <Text key={k} style={s.note}>Added: {k.slice(0, 10)}…{k.slice(-8)}{k === newestCosigner(c.crowdlock) ? " — new locks would use this one" : ""}</Text>)}
        {keyChange.removed.map((k) => <Text key={k} style={s.note}>Removed: {k.slice(0, 10)}…{k.slice(-8)} — locks naming it no longer count</Text>)}
        <Text style={s.note}>Founders add keys for good reasons, but a co-signer decides which purchases go ahead, so a key you don't recognise matters. Check with the founder that it was them. Every change is public, with the name of the account that made it.</Text>
        {historyLinkFor(c.url) && <Btn label="See who changed it" kind="second" onPress={() => Linking.openURL(historyLinkFor(c.url)!)} />}
        <Text style={s.note}>New locks are paused on this phone until you've looked. Taking money home isn't affected.</Text>
        <Btn label="I've checked — carry on" onPress={async () => { await saveSeenKeys(url, c.crowdlock.cosigner_keys ?? []).catch(() => {}); setKeyChange(null); }} />
      </View>}

      {toSign && <Warning level="know" title="This Crowdlock's declaration has a new version">
        <Text style={s.p}>Why: {toSign.current.reason}</Text>
        <Text style={s.note}>Doing nothing changes nothing about your money: your locks still count, and your signature still stands for the version you signed. Signing the new version lets you back purchases proposed under it.</Text>
        <Btn label="Read what changed" onPress={() => go({ name: "sign", words, url })} />
      </Warning>}

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
      {waitingToJoin && <View style={s.panel}>
        <Text style={[s.p, s.bold]}>You've signed. Waiting for the register.</Text>
        <Text style={s.note}>Your signature has been sent. The register adds new members every few minutes (up to an hour for a Crowdlock that has only just been started). This page checks again by itself; you can also pull down. You don't need to sign again.</Text>
        <ActivityIndicator style={{ marginTop: 8 }} />
      </View>}
      {!me && here && !waitingToJoin && <>
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

      {me && here && <MyLocks account={account} c={c} paused={!!keyChange} onLock={() => go({ name: "lock", words, url })} onHome={(address, again) => go({ name: "takeHome", words, url, address, again })} onAll={() => go({ name: "allLocks", words, url })} />}

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

function MyLocks({ account, c, onLock, onHome, onAll, all = false, paused = false }: { account: any; c: Extract<Loaded, { ok: true }>; onLock: () => void; onHome: (address: string, again?: boolean) => void; onAll?: () => void; all?: boolean; paused?: boolean }) {
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
          <Btn label="Lock my bitcoin" disabled={paused || noLedgerXpub} onPress={onLock} />
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
            <Btn label="Take it home" onPress={() => onHome(r.address)} />
            <Btn label="Lock it again" kind="second" disabled={paused || noLedgerXpub} onPress={() => onHome(r.address, true)} />
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

/** Every lock, or every proposal, of one Crowdlock: the full list its page keeps short. */
export function AllOf({ what, words, url, go }: { what: "locks" | "proposals"; words: string; url: string; go: Go }) {
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
        ? <MyLocks all account={account} c={c} onLock={() => go({ name: "lock", words, url })} onHome={(address, again) => go({ name: "takeHome", words, url, address, again })} />
        : <Proposals all c={c} account={account} onOpen={(hash) => go({ name: "proposal", words, url, hash })} />}
    </View>
  );
}

export function ShareScreen({ url }: { url: string }) {
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

/** In the app for real bitcoin: where to get the test app, for practising. */
export function TestApp() {
  const [copied, setCopied] = useState(false);
  return (
    <View>
      <Text style={s.note}>The test app is a separate app with its own wallet. It uses test bitcoin, which has no value, so nothing in it can touch real money.</Text>
      <Btn kind="second" label={copied ? "Copied. Paste it into your browser" : "Copy the test app's download link"} onPress={async () => { await Clipboard.setStringAsync(TEST_APP_URL); setCopied(true); }} />
    </View>
  );
}

export function AddCrowdlock({ words, go, link: given }: { words: string; go: Go; link?: string }) {
  const [link, setLink] = useState(given ?? "");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [other, setOther] = useState<string | null>(null);   // it belongs to the other app

  // Opened from a QR code or a web page: check it straight away.
  useEffect(() => { if (given) add(given); }, [given]);

  const add = async (which: string = link) => {
    setBusy(true); setProblems(null); setOther(null);
    const loaded: Loaded = await loadCrowdlock(which);
    setBusy(false);
    if (!loaded.ok) { setProblems(loaded.problems); return; }
    if (loaded.crowdlock.network !== NETWORK) {
      setOther(IS_TEST_MONEY
        ? `${loaded.crowdlock.name} uses real bitcoin. It opens in the Crowdlock app for real bitcoin, not in this test app.`
        : `${loaded.crowdlock.name} is a test Crowdlock, for practising with test money. It opens in the Crowdlock test app, not in this one. Nothing is wrong with the link.`);
      return;
    }
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
      {other && <View style={s.panel}>
        <Text style={[s.p, s.bold]}>This one opens in the other Crowdlock app</Text>
        <Text style={s.p}>{other}</Text>
        {!IS_TEST_MONEY && <TestApp />}
      </View>}
      <Btn label={busy ? "Checking…" : "Check and add"} disabled={busy || !link} onPress={() => add()} />
      <Text style={s.note}>Someone showing you a Crowdlock's QR code? Point your phone's own camera at it — it opens here by itself.</Text>
    </View>
  );
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

export function FindCrowdlocks({ words, go }: { words: string; go: Go }) {
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
