// Proposals: a purchase put to a Crowdlock's members. Reading them and their
// commitments, committing to one (step 5 of the six), and the co-signer's two
// actions on one: completing it once its target is met, or declaring it dead.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
// @ts-ignore — plain module shared with the chain tests
import {
  wordsAreValid, tidyWords, xpubForKey, buildCommitment, checkCommitment, completeCommitmentWith, commitmentPaid, commitmentTxid, signNoticeWith, commitmentsToComplete, commitmentCoin, commitmentPayment,
} from "../wallet/core.mjs";
import { phaseOf, pilePath, checkPileShape, noticeStatement, proposalVersion, settleMargin } from "../../../method/js/proposals.mjs";
// @ts-ignore — plain module shared with the website
import { readPile as readPileShared, settleOrder, planFor } from "../../../method/js/pile.mjs";
// @ts-ignore — plain module shared with the chain tests
import {
  loadCrowdlock, membershipOf, shortBtc, locksOnRegister, baseFor, resolvePath, mayCommitTo, rulesOf, rulesChanges,
} from "../crowdlocks.mjs";
import { loadSeenRules, saveSeenRules } from "../storage";
// @ts-ignore — plain module
import { postCommitment, fetchCommitments } from "../relays.mjs";
import { NETWORK, chain } from "../config";
// The look (one theme file) and the shared parts every screen is built from.
import { Btn, NavRow, Warning } from "../ui/parts";
import {
  whileOpen, useBack, useRefresh, CheckedLine, Input, walletAccount, LedgerHint, btc, when, money, parseBtc, atUtc, VB_COMMIT, VB_COMMIT_PART, useFeeRate, aboutFee,
  FeeChoice, SumRow, Confirm, s, signingAccount,
} from "./shared";
import type { Go, Loaded } from "./shared";
import { useCosignerWords } from "./cosigner";

// ---------------------------------------------------------------------------
// Reading proposals and their commitments
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

// `sent`: completed by the co-signer and on the network, waiting for a block.
// It counts toward the target, with what is waiting and what is paid, so a
// payment in flight is never added up as missing.
type Pile = { sent: number; sentCount: number; count: number; sats: number; mine: { sats: number; record: any; paid?: boolean; sent?: boolean }[]; good: { record: any; at: number; seq?: number; sats: number }[]; completed: number; refused: string[]; paid: number; paidCount: number; notice: any | null; noticeContradicted?: boolean;
  // What couldn't be read: payments whose state is unknown, and the
  // repository's pile itself. Either stops the co-signer.
  uncertain: number; unreadable: string | null };

/** A proposal's pile, added up by the shared module the website uses too (method/js/pile.mjs). */
function readPile(c: Extract<Loaded, { ok: true }>, p: any, account: any): Promise<Pile> {
  return readPileShared({
    crowdlock: c.crowdlock, register: c.register, destinations: c.destinations, proposal: p,
    fetchPile: () => fetch(resolvePath(pilePath(c.crowdlock.register.proposals, p.hash), baseFor(c.url)), { cache: "no-store" }),
    relayItems: () => fetchCommitments(c.crowdlock, p.hash),
    check: (record: any) => checkCommitment({ record, crowdlock: c.crowdlock, proposal: p, destinations: c.destinations, chain, network: NETWORK }),
    payment: (record: any) => commitmentPayment({ record, chain, crowdlock: c.crowdlock }),
    txidOf: commitmentTxid,
    ownerPubkey: account?.publicKey ?? null,
  }) as Promise<Pile>;
}

/** Has this wallet already committed to this proposal? Read from the Crowdlock's own published pile. */
export async function inPile(c: Extract<Loaded, { ok: true }>, p: any, publicKey: string): Promise<boolean> {
  try {
    if (!c.crowdlock.register?.proposals) return false;
    const r = await fetch(resolvePath(pilePath(c.crowdlock.register.proposals, p.hash), baseFor(c.url)), { cache: "no-store" });
    if (!r.ok) return false;
    const file = await r.json();
    return checkPileShape(file, p.hash).ok && file.commitments.some((x: any) => x.record?.lock?.owner_pubkey === publicKey);
  } catch { return false; }
}

export function Proposals({ c, account, onOpen, onAll, all = false }: { c: Extract<Loaded, { ok: true }>; account: any; onOpen: (hash: string) => void; onAll?: () => void; all?: boolean }) {
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
  const [moved, setMoved] = useState(0);
  const [dead, setDead] = useState(false);
  useEffect(() => { readPile(c, p, account).then((x) => { setPaid(x.paid); setMoved(x.paid + x.sent); setDead(!!x.notice); }).catch(() => setPaid(null)); }, [c, p]);
  if (paid !== null && paid >= p.target.sats) return <Text style={s.good}>Funded and paid · {btc(BigInt(paid))} sent to the seller · closed</Text>;
  // Money that moved after the co-signer declared it dead is a broken promise, and says so.
  if (dead && moved > 0) return <Text style={s.error}>Declared dead, yet {btc(BigInt(moved))} of its commitments has been sent · the co-signer broke its notice</Text>;
  if (dead) return <Text style={s.note}>Declared dead · didn't reach its target · closed · nothing will move</Text>;
  return <Text style={s.note}>{PHASE_TEXT[phaseOf(p)]} · needs {money(p.requires, p.currency)} · target about {shortBtc(p.target.sats)}{paid ? ` · ${btc(BigInt(paid))} paid so far` : ""}</Text>;
}

function ProposalDetail({ c, p, account, member, onCommit, paused = false }: { c: Extract<Loaded, { ok: true }>; p: any; account: any; member: boolean; onCommit: () => void; paused?: boolean }) {
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
  const met = pile ? pile.paid + pile.sent + pile.sats >= p.target.sats : false;
  return (
    <View>
      <Text style={s.declaration}>{p.text}</Text>
      <Text style={s.label}>Pays</Text>
      <Text style={s.mono}>{p.destination}</Text>
      <Text style={s.note}>Needs {money(p.requires, p.currency)}. Target {btc(BigInt(p.target.sats))} at {p.target.rate} ({p.target.at.slice(0, 10)}); the target is restated as the price moves.</Text>
      <Text style={s.note}>Gathers from {atUtc(p.opens)} to {atUtc(p.closes)}. Settles by {atUtc(p.settles_by)}.</Text>
      <Text style={s.label}>Committed so far</Text>
      {err ? <Text style={s.error}>{err}</Text> : !pile ? <ActivityIndicator /> : <>
        {dead && pile.paid + pile.sent > 0 ? <>
          <Text style={s.error}>{`Declared dead by the co-signer${pile.notice.published ? ` on ${String(pile.notice.published).slice(0, 10)}` : ""}, yet ${btc(BigInt(pile.paid + pile.sent))} of its commitments has been sent to the seller (${pile.paidCount} paid${pile.sentCount ? `, ${pile.sentCount} waiting for a block` : ""}). The co-signer said it would complete none of them: this breaks that notice. Any commitment not yet sent stays locked and comes home on its date.`}</Text>
          <Text style={s.note}>The notice is signed by the co-signer's key, and the payments are read from the chain, both on this phone. Together they are the evidence.</Text>
        </> : dead ? <>
          <Text style={s.error}>{pile.noticeContradicted
            ? `Declared dead by the co-signer${pile.notice.published ? ` on ${String(pile.notice.published).slice(0, 10)}` : ""}, although the commitments checked on this phone add up to its target. The co-signer has said it will complete none of them. Your money stays locked and comes home on its date as usual.`
            : `Declared dead by the co-signer${pile.notice.published ? ` on ${String(pile.notice.published).slice(0, 10)}` : ""}: it didn't reach its target, and none of its commitments will be completed. Your money stays locked and comes home on its date as usual.`}</Text>
          <Text style={s.note}>The notice is signed by the co-signer's key and checked on this phone.</Text>
        </> : funded ? <>
          <Text style={s.good}>Funded and paid. {btc(BigInt(pile.paid))} went to the seller in {pile.paidCount} payment{pile.paidCount === 1 ? "" : "s"}, completed by the co-signer and sent. This proposal is closed.</Text>
        </> : <>
          <Text style={s.big}>{btc(BigInt(pile.sats + pile.paid + pile.sent))}</Text>
          <Text style={s.note}>{pile.count} waiting{pile.sentCount ? ` · ${pile.sentCount} sent by the co-signer and waiting for a block (${btc(BigInt(pile.sent))})` : ""}{pile.paidCount ? ` · ${pile.paidCount} paid (${btc(BigInt(pile.paid))})` : ""}, each checked on this phone{pile.refused.length ? ` · ${pile.refused.length} refused` : ""}. {met ? "The target is met." : `${btc(BigInt(Math.max(0, p.target.sats - pile.sats - pile.paid)))} to go.`}</Text>
          {met && !funded ? <Text style={s.good}>Target met. Commitments past it are held in reserve: they are used only if the price moves or one ahead of them no longer counts, and otherwise their bitcoin simply stays locked.</Text> : null}
        </>}
        {(pile.unreadable || pile.uncertain > 0) && <Text style={s.error}>{pile.unreadable ? `These figures may be incomplete: ${pile.unreadable}.` : `These figures may be incomplete: whether ${pile.uncertain} payment${pile.uncertain === 1 ? " has" : "s have"} gone couldn't be checked just now.`} Pull down to try again.</Text>}
        {pile.refused.slice(0, 3).map((r, i) => <Text key={i} style={s.note}>Refused: {r}</Text>)}
        {pile.mine.length > 0 && <Text style={s.good}>{pile.mine.some((m) => m.paid) ? "Your commitment was paid: " : pile.mine.some((m) => m.sent) ? "Your commitment was completed and sent, and is waiting for a block: " : "You've committed "}{btc(BigInt(pile.mine.reduce((n, m) => n + m.sats, 0)))}.</Text>}
      </>}
      {member && phase === "gathering" && !paused && <Btn label={pile && pile.mine.length > 0 ? "Commit more to this purchase" : "Commit to this purchase"} onPress={onCommit} />}
      {!member && phase === "gathering" && <Text style={s.note}>Only members can commit. Join this Crowdlock and lock bitcoin first.</Text>}
      {member && phase === "soon" && <Text style={s.note}>You can commit once it opens.</Text>}
      {pile && !paused && (phase === "gathering" || phase === "settling") && <CoSign c={c} p={p} pile={pile} onDone={() => setTimeout(refresh, 3000)} />}
      {pile && (phase === "settling" || phase === "over") && !met && <DeclareDead c={c} p={p} onDone={() => setTimeout(refresh, 3000)} />}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 5: commit to a purchase
//
// A proposal has its own page, with one button: Commit to this purchase.
// Committing is two short pages (which lock and how much, then a check page
// with the warning above the one button). Each lock ticked becomes its own
// commitment: built and signed (buildCommitment), checked on this phone
// exactly as the co-signer will check it (checkCommitment), then posted.
// ---------------------------------------------------------------------------

/** Load a Crowdlock and pick one proposal out of it by its fingerprint. */
function useProposal(url: string, hash: string) {
  const [c, setC] = useState<Loaded | null>(null);
  // Whether the Crowdlock's destination rules have changed since this phone
  // last looked (rulesChanges): committing and co-signing wait until it has.
  const [rulesMoved, setRulesMoved] = useState(false);
  const load = useCallback(async () => {
    const loaded: Loaded = await loadCrowdlock(url);
    if (loaded.ok) {
      const seen = await loadSeenRules(url);
      if (seen === null) await saveSeenRules(url, rulesOf(loaded)).catch(() => {});
      setRulesMoved(rulesChanges(seen, rulesOf(loaded)).changed);
    }
    setC(loaded);
  }, [url]);
  useEffect(() => { load(); }, [load]);
  const p = c && c.ok ? (c.proposals ?? []).find((x: any) => x.hash === hash) ?? null : null;
  return { c, p, load, rulesMoved };
}

export function ProposalScreen({ words, url, hash, go }: { words: string; url: string; hash: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const { c, p, load, rulesMoved } = useProposal(url, hash);
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
      {rulesMoved && <Text style={s.error}>Who approves where {c.crowdlock.name}'s money may go has changed since you last looked. Committing and co-signing are paused on this phone until you've checked it on {c.crowdlock.name}'s page.</Text>}
      <ProposalDetail c={c} p={p} account={account} member={member} paused={rulesMoved} onCommit={() => go({ name: "commit", words, url, hash })} />
      <CheckedLine />
    </View>
  );
}

export function CommitFlow({ words, url, hash, go }: { words: string; url: string; hash: string; go: Go }) {
  const account = useMemo(() => walletAccount(words), [words]);
  const { c, p, rulesMoved } = useProposal(url, hash);
  const [coins, setCoins] = useState<{ lock: any; coin: any }[] | null>(null);
  // Which locks are ticked, by their place in the list. The biggest starts ticked.
  const [picks, setPicks] = useState<number[]>([0]);
  const [amount, setAmount] = useState("");
  const [page, setPage] = useState(1);
  const [progress, setProgress] = useState<string | null>(null);
  const [rate, readRate] = useFeeRate();
  const [showSpeeds, setShowSpeeds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [already, setAlready] = useState(0);

  useEffect(() => {
    if (!c || !c.ok || !p) return;
    (async () => {
      const out: { lock: any; coin: any }[] = [];
      const now = Math.floor(Date.now() / 1000);
      // A coin already committed to this proposal can't be committed to it
      // again: one coin counts once, and the earlier commitment stands. It
      // used to be offered again under "Commit more", and the second
      // commitment was signed, posted, shown as committed, and never counted.
      const committed = new Set<string>();
      try { for (const m of (await readPile(c, p, account)).mine) { const k = commitmentCoin(m.record); if (k) committed.add(k); } } catch {}
      let skipped = 0;
      for (const l of locksOnRegister(c.register, account.address, c.crowdlock)) {
        // A lock that opens before this proposal's settling ends, or within a
        // week after, can't back it: its owner could take the money home first.
        if (l.locktime <= now || l.locktime <= Date.parse(p.settles_by) / 1000 + settleMargin(c.crowdlock.network)) continue;
        for (const coin of (await chain.utxos(l.address)).filter((u: any) => u.confirmed)) {
          if (committed.has(`${coin.txid}:${coin.vout}`)) { skipped++; continue; }
          out.push({ lock: { ...l, cosignerXpub: xpubForKey(c.crowdlock, l.cosignerPubkey) }, coin });
        }
      }
      out.sort((a, b) => b.coin.value - a.coin.value);
      setAlready(skipped);
      setCoins(out);
    })().catch(() => setCoins([]));
  }, [c, p, account.address]);

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
    : rulesMoved ? `Who approves where ${c.crowdlock.name}'s money may go has changed since you last looked. Check it on ${c.crowdlock.name}'s page first.`
    : !mayCommitTo(c, meNow, p) ? `This proposal was published under version ${proposalVersion(p, c.crowdlock)} of the declaration, and you haven't signed that version. Sign it from ${c.crowdlock.name}'s page first; it can take a few minutes to reach the register.`
    : phaseOf(p) !== "gathering" ? "This proposal isn't gathering commitments just now."
    : coins && coins.length === 0 && already > 0 ? "Everything you could commit to this proposal is already committed to it. A coin counts once for a proposal, so there is nothing more to commit unless you lock more."
    : coins && coins.length === 0 ? `You have no locked bitcoin on this Crowdlock's register that stays locked until this proposal finishes settling (${atUtc(p.settles_by)}). Lock some for longer first.`
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
      // The rules read again now: if who approves destinations, the list
      // itself, the fee limit or the target changed while this screen was
      // open, nothing is signed.
      const fresh = await loadCrowdlock(c.url);
      if (!fresh.ok) throw new Error(`this Crowdlock couldn't be read again just now, so nothing was signed (${fresh.problems?.[0] ?? "it didn't load"})`);
      const moved = rulesChanges(rulesOf(c), rulesOf(fresh));
      if (moved.changed) throw new Error(`its rules changed while this screen was open, so nothing was signed: ${moved.notes[0]} Go back and look again.`);
      const feeRate = await chain.feeRate(whileOpen.feeSpeed);
      // Unlocked once, for every commitment in this go.
      const signer = await signingAccount(account);
      for (const x of chosen) {
        if (several) setProgress(`Signing ${made + 1} of ${chosen.length}…`);
        const r = await buildCommitment({ account: signer, chain, lock: x.lock, coin: x.coin, proposalHash: p.hash, destination: p.destination, amount: sats === null ? "all" : sats, feeRate, maxFee: c.crowdlock.max_commitment_fee });
        const v = await checkCommitment({ record: r.record, crowdlock: c.crowdlock, proposal: p, destinations: c.destinations, chain, network: NETWORK });
        if (!v.valid) throw new Error(`the commitment didn't pass its own check: ${v.reason}`);
        const posted = await postCommitment(c.crowdlock, { type: "commitment", proposal: p.hash, record: r.record });
        if (!posted.ok) throw new Error("Signed, but it couldn't be sent just now. Check your connection or VPN and try again.");
        committed += r.committed; fee += r.fee; remainder += r.remainder; made++;
      }
      whileOpen.overview = null;
      setDone(`You committed ${btc(committed)} to "${p.title}"${several ? `, from ${made} locks` : ""}. The network fee would be ${btc(fee)}, paid only if it settles.${remainder > 0n ? ` The other ${btc(remainder)} would stay locked to the same date.` : ""}`);
      setPage(3);
    } catch (e: any) {
      if (made > 0) whileOpen.overview = null;
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
      <SumRow label="Network fee" value={aboutFee(rate, sats === null ? VB_COMMIT * chosen.length : VB_COMMIT_PART)} />
      <Text style={s.note}>The fee comes out of what you commit, and is paid only if it settles. The exact fee is shown as soon as you have signed. If the fee would be too large a share, nothing is signed.</Text>
      {!showSpeeds
        ? <Btn kind="link" label="Change the fee speed" onPress={() => setShowSpeeds(true)} />
        : <FeeChoice onChange={readRate} />}
      <Warning level="stop" title="A commitment can't be withdrawn">
        A commitment holds until the proposal closes, and can't be withdrawn. Nothing moves unless the proposal reaches its target and the co-signer completes it. If it doesn't, your money stays locked and comes home on its date. One catch: until your lock opens, your signed commitment stays valid, even after the proposal closes or fails, so a dishonest co-signer could still complete it, but only to that same listed seller and only for the amount you signed.
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

const SEND_FROM_APP = 25;

const SEND_PER_PASS_NOTE = "up to 25 every few minutes";

function DeclareDead({ c, p, onDone }: { c: Extract<Loaded, { ok: true }>; p: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const co = useCosignerWords(c.crowdlock.cosigner_keys ?? []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const askDead: [string, string] = ["Declare this proposal dead?",
    "This publishes a notice, signed with the co-signer key, that the proposal didn't reach its target and that you will complete none of its commitments. Anyone can check it. It can't be taken back."];
  const deadGo = async () => { setAsking(false); {
      setBusy(true); setMsg(null);
      try {
        const words = await co.words("Confirm it's you, to sign the notice");
        const notice = signNoticeWith({ words, crowdlock: c.crowdlock, statement: noticeStatement(p.hash), network: NETWORK });
        const posted = await postCommitment(c.crowdlock, { type: "notice", proposal: p.hash, notice });
        await co.done(words);
        setMsg(posted.ok ? { ok: true, text: `Published to ${posted.accepted} of ${posted.total} relays. The Crowdlock's repository records it on its next pass.` }
          : { ok: false, text: "Signed, but no relay took it just now. Check your connection and try again." });
        onDone();
      } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
      setBusy(false);
    } };
  return !open ? <Btn label="For the co-signer: declare it dead" kind="second" onPress={() => setOpen(true)} /> : (
    <View style={s.panel}>
      <Text style={s.label}>It closed short of its target</Text>
      <Text style={s.note}>Nothing has to happen: without your signature no commitment can ever move. Publishing a signed notice tells every member so, publicly, and promises you won't complete any of them. It's signed with the co-signer key.</Text>
      {co.view}
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      {asking ? <Confirm title={askDead[0]} text={askDead[1]} yes="Sign and publish" onYes={deadGo} onCancel={() => setAsking(false)} /> : <Btn label={busy ? "Signing…" : "Sign and publish the notice"} disabled={busy || !co.ready} onPress={() => setAsking(true)} />}
    </View>
  );
}

/** The order commitments are settled in: as the repository received them (oldest first, then its own order). */
function CoSign({ c, p, pile, onDone }: { c: Extract<Loaded, { ok: true }>; p: any; pile: Pile; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const co = useCosignerWords(c.crowdlock.cosigner_keys ?? []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // What is already paid, or sent and waiting for a block, counts first; then
  // commitments in the order the repository received them, until the target
  // is met and no further. The rest are the reserve.
  const { settled: settledSoFar, take, sum } = planFor(pile, p.target.sats);
  const met = pile.sats + settledSoFar >= p.target.sats;
  // Nothing is completed while anything about the pile is unknown: a payment
  // that may already have gone, or the repository's own record unread.
  const blocked = pile.unreadable ? `Nothing can be completed: ${pile.unreadable}.`
    : pile.uncertain ? `Nothing can be completed: whether ${pile.uncertain} earlier payment${pile.uncertain === 1 ? " has" : "s have"} already gone couldn't be checked. Try again in a few minutes.`
    : null;
  const [asking, setAsking] = useState(false);
  const askSend: [string, string] = ["Complete and send?",
      `This completes ${take.length} commitment${take.length === 1 ? "" : "s"} (${btc(BigInt(sum - settledSoFar))}) and sends them to ${p.destination.slice(0, 14)}…. It can't be undone. Do this only if the proposal is genuine and its target is met.`];
  const stop = (text: string) => { setBusy(false); setMsg({ ok: false, text }); onDone(); };
  const sendGo = async () => {
    setAsking(false);
    setBusy(true); setMsg(null);
    // Everything is read again now, not taken from the screen: the Crowdlock's
    // file, its proposals and destinations, the pile, any failure notice and
    // the clock. If any of it changed what would be done, nothing is done and
    // the new plan is shown to confirm afresh.
    let fresh: any, fp: any, fpile: Pile;
    try {
      fresh = await loadCrowdlock(c.url);
      if (!fresh.ok) return stop(`Nothing was completed: this Crowdlock couldn't be read again just now (${fresh.problems?.[0] ?? "it didn't load"}).`);
      fp = (fresh.proposals ?? []).find((x: any) => x.hash === p.hash);
      if (!fp) return stop("Nothing was completed: this proposal is no longer published.");
      fpile = await readPile(fresh, fp, { publicKey: null });
    } catch (e: any) { return stop(`Nothing was completed: ${String(e.message ?? e)}`); }
    const late = () => Date.now() > Date.parse(fp.settles_by);
    if (late()) return stop("Nothing was completed: its settling time has ended.");
    if (fpile.notice) return stop("Nothing was completed: the co-signer's failure notice for it has been published.");
    if (fpile.unreadable) return stop(`Nothing was completed: ${fpile.unreadable}.`);
    if (fpile.uncertain) return stop("Nothing was completed: whether an earlier payment has already gone couldn't be checked just now. Try again in a few minutes.");
    const plan = planFor(fpile, fp.target.sats);
    // The words now, once, for every signature below.
    let words: string;
    try { words = await co.words("Confirm it's you, to co-sign"); } catch (e: any) { return stop(String(e.message ?? e)); }
    // Every commitment checked again, with these words, from the fresh pile in
    // order; the total added up again. Short of the target, nothing is done.
    let recheck: { ok: boolean; still: any[]; total: number; problems: string[] };
    try {
      recheck = await commitmentsToComplete({ words, records: settleOrder(fpile.good).map((g: any) => g.record), crowdlock: fresh.crowdlock, register: fresh.register, proposal: fp, destinations: fresh.destinations, chain, network: NETWORK, alreadyPaid: plan.settled });
    } catch (e: any) { recheck = { ok: false, still: [], total: plan.settled, problems: [String(e.message ?? e)] }; }
    if (!recheck.ok) return stop(`Nothing was completed. Checked again just now, the commitments add up to ${btc(BigInt(recheck.total))}, short of the ${btc(BigInt(fp.target.sats))} target.${recheck.problems[0] ? ` ${recheck.problems[0]}` : ""}`);
    // The plan must be the one confirmed: the same commitments, nothing swapped in.
    const confirmed = new Set(take.map((g) => g.record.tx));
    if (recheck.still.length !== take.length || recheck.still.some((r: any) => !confirmed.has(r.tx)) || fp.target.sats !== p.target.sats || fp.destination !== p.destination) {
      return stop(`Nothing was completed: what would be completed has changed since you confirmed (now ${recheck.still.length} commitment${recheck.still.length === 1 ? "" : "s"}). The screen shows the new plan; look at it and confirm again.`);
    }
    // A handful are sent from here at once. More than that are published
    // only, for the Crowdlock's repository to send a few at a time
    // (pacing: thousands at once would push up fees for everyone).
    const sendHere = recheck.still.length <= SEND_FROM_APP;
    let sent = 0; const failed: string[] = [];
    for (const record of recheck.still) {
      // The clock again before every signature, in a long batch.
      if (late()) { failed.push("Stopped there: its settling time ended part way."); break; }
      try {
        const hex = await completeCommitmentWith({ words, record, chain });
        // Sent from here: to the network first. If it refuses one, stop:
        // that payment will not arrive, so the purchase is now short, and
        // every further one sent would be money paid toward it for nothing.
        // The ones already sent cannot be recalled.
        if (sendHere) await chain.broadcast(hex);
        const posted = await postCommitment(c.crowdlock, { type: "completed", proposal: p.hash, tx: hex });
        // Published only: if no relay took it, it has gone nowhere, and saying
        // "published" would be false. (Sent from here, the network has it.)
        if (!sendHere && !posted.ok) throw new Error("A completed payment could not be published: no relay took it. Check the connection and try again; nothing is lost.");
        sent++;
      } catch (e: any) {
        // Either way, stop at the first that fails: a later payment must not
        // go while an earlier one hasn't.
        failed.push(`Stopped there, and did no more: ${String(e.message ?? e)}`);
        break;
      }
    }
    if (sent > 0) await co.done(words);
    setMsg(failed.length
      ? { ok: sent > 0, text: `${sendHere ? "Sent" : "Completed"} ${sent} of ${recheck.still.length}. ${failed[0]}` }
      : sendHere ? { ok: true, text: `Completed and sent all ${sent}. They'll confirm over the next blocks.` }
      : { ok: true, text: `Completed all ${sent} and published them. The Crowdlock's repository sends them ${SEND_PER_PASS_NOTE}, so they reach the network paced rather than all at once.` });
    setBusy(false); onDone();
  };
  return (
    <View>
      {!open ? <Btn label="For the co-signer" kind="second" onPress={() => setOpen(true)} /> : <View style={s.panel}>
        <Text style={s.label}>Co-sign this proposal</Text>
        <Text style={s.note}>Only once the target is met, and only if the proposal and its destination are genuine. It's signed with the co-signer key.</Text>
        {!met && <Text style={s.error}>The target isn't met yet: {btc(BigInt(pile.sats))} of {btc(BigInt(p.target.sats))}. Nothing should be completed.</Text>}
        {blocked && <Text style={s.error}>{blocked}</Text>}
        {met && take.length > 0 && <Text style={s.note}>The plan: {take.length} commitment{take.length === 1 ? "" : "s"}, oldest first, coming to {btc(BigInt(sum - settledSoFar))}{sum > p.target.sats ? `, ${btc(BigInt(sum - p.target.sats))} over the target because the last can't be split` : ""}. {pile.good.length - take.length} more held in reserve.</Text>}
        {co.view}
        {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
        {asking ? <Confirm title={askSend[0]} text={askSend[1]} yes="Complete and send" onYes={sendGo} onCancel={() => setAsking(false)} /> : <Btn label={busy ? "Completing…" : `Complete ${take.length} and send`} disabled={busy || !met || !!blocked || !co.ready || take.length === 0} onPress={() => setAsking(true)} />}
      </View>}
    </View>
  );
}
