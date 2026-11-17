// The four places along the bottom (Home, My bitcoin, Crowdlocks, More),
// with Help and About. Home shows one thing to do next, worked out from the
// six steps by src/nextStep.mjs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
// @ts-ignore — plain module shared with the chain tests
import { waitingBalance, lockState, xpubForKey } from "../wallet/core.mjs";
import { phaseOf } from "../../../method/js/proposals.mjs";
// @ts-ignore — plain module shared with the chain tests
import {
  loadCrowdlock, membershipOf, locksOnRegister, newestCosigner, keyChanges, newVersionToSign,
} from "../crowdlocks.mjs";
import { loadSavedLocks, rememberLocks, loadSeenKeys, loadExpectedKeys, saveLook } from "../storage";
import { NETWORK, IS_TEST_MONEY, chain, EXPLORER_WEB, EXPLORER_BACKUP_WEB, CONNECTION_TARGETS } from "../config";
import { checkConnection, describeResult, sumUp } from "../connection.mjs";
// The look (one theme file) and the shared parts every screen is built from.
import { setLook, useLook } from "../ui/theme";
import type { Look } from "../ui/theme";
import { Btn, Card, NavRow, StepBar, Warning } from "../ui/parts";
import type { TabName } from "../ui/parts";
// @ts-ignore — plain module, tested in test-chain
import { nextStep } from "../nextStep.mjs";
import { whileOpen, finishedLocks, signedJustNow, allLinks, useRefresh, CheckedLine, walletAccount, btc, when, SPEED_LABEL, s } from "./shared";
import type { Go, Loaded, MyLock, HomeAlert, OverviewData, Overview } from "./shared";
import { inPile } from "./proposals";
import { CrowdlockList } from "./crowdlock";

const OVERVIEW_FRESH_MS = 20000;

// ---------------------------------------------------------------------------
// The four places: Home, My bitcoin, Crowdlocks, More
//
// Home shows one thing to do next, worked out from the six steps (understand,
// sign, get bitcoin, lock, commit to a purchase, take it home), then what is
// waiting and what is locked. Everything read here is read the same way the
// Crowdlock's own page reads it; nothing is decided here about money.
// ---------------------------------------------------------------------------

function useOverview(account: any): Overview {
  const held = whileOpen.overview && whileOpen.overview.address === account.address ? whileOpen.overview : null;
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
      if (!signedJustNow(c, account.address) && newVersionToSign(c, account.address)) notes.push({ url: c.url, name: c.crowdlock.name, kind: "version" });
      const mine: MyLock[] = [];
      if (member) {
        const terms: { address: string; locktime: number; cosignerPubkey: string }[] = [...locksOnRegister(c.register, account.address)];
        for (const l of saved.filter((x) => x.crowdlock === c.url)) if (!terms.some((x) => x.address === l.address)) terms.push(l);
        // Keep every one of them on this phone, with what a Ledger needs, so
        // that taking a lock home never depends on this Crowdlock's site.
        await rememberLocks(terms.map((l) => ({ crowdlock: c.url, address: l.address, locktime: l.locktime, cosignerPubkey: l.cosignerPubkey,
          cosignerXpub: xpubForKey(c.crowdlock, l.cosignerPubkey) ?? undefined, name: c.crowdlock.name })));
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
    // Locks whose Crowdlock couldn't be loaded just now (its site is down, or
    // its file failed its checks). They are still this wallet's: shown from
    // the terms the phone kept, and they can be taken home from here.
    for (const l of saved.filter((x) => !here.some((c) => c.url === x.crowdlock))) {
      if (!alive.current) return;
      try {
        const st = await lockState({ chain, lock: l, medianTime, quick: true, finished: finishedLocks });
        if (st.confirmed > 0n || st.arriving > 0n) all.push({ crowdlock: l.crowdlock, name: `${l.name ?? "A Crowdlock"} (couldn't be loaded)`, address: l.address, locktime: l.locktime, ...st, offline: true });
      } catch { missed++; }
    }
    if (!alive.current) return;
    all.sort((a, b) => a.locktime - b.locktime);
    const next: OverviewData = { balance: waiting, locks: all, step: nextStep({ waiting: waiting.confirmed, crowdlocks: forStep }), alerts: notes };
    setData(next);
    if (missed) setError(`${missed} of your locks couldn't be read just now`);
    else whileOpen.overview = { address: account.address, at: Date.now(), data: next };
  }, [account.address]);

  // Read on arriving, unless it was read moments ago.
  useEffect(() => { if (!held || Date.now() - held.at > OVERVIEW_FRESH_MS) load(); }, [load]);
  useRefresh(load);
  return { ...data, error };
}

export function Tabs({ words, tab, setTab, go }: { words: string; tab: TabName; setTab: (t: TabName) => void; go: Go }) {
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
      {w && !!o.error && <>
        <Text style={s.error}>Couldn't check just now: {o.error}. This is what was last read.</Text>
        <Btn kind="link" label="Check the connection" onPress={() => go({ name: "about", words })} />
      </>}
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
        {o.error && <>
          <Text style={s.error}>Couldn't check just now: {o.error}.{o.balance ? " This is what was last read." : ""}</Text>
          <Btn kind="link" label="Check the connection" onPress={() => go({ name: "about", words })} />
        </>}
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
      <NavRow title="Fee speed" sub={SPEED_LABEL[whileOpen.feeSpeed]} onPress={() => go({ name: "feeSpeed", words })} />
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

export function Help({ from }: { from?: string }) {
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

export function About() {
  // "Check the connection": one small question to each place the app depends
  // on, timed, so a page that won't load can be told apart from a phone that
  // is offline or an explorer that is down (see src/connection.mjs).
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<any[] | null>(null);
  const check = async () => {
    setChecking(true); setChecked(null);
    try { setChecked(await checkConnection(CONNECTION_TARGETS)); } catch { setChecked([]); }
    setChecking(false);
  };
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
      <Text style={s.label}>Something not loading?</Text>
      <Btn kind="second" label={checking ? "Checking… up to 20 seconds" : "Check the connection"} disabled={checking} onPress={check} />
      {checked && <>
        {checked.map((r) => <Text key={r.url} style={r.ok ? s.good : s.error}>{r.name}: {describeResult(r)}</Text>)}
        <Text style={s.p}>{sumUp(checked)}</Text>
      </>}
      <Text style={s.note}>Asks each place the app depends on one small question and times the answer. Nothing about you or your money is sent.</Text>
    </View>
  );
}
