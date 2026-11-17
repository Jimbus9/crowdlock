// Proposals: a purchase put to a Crowdlock's members. Reading them and their
// commitments, committing to one (step 5 of the six), and the co-signer's two
// actions on one: completing it once its target is met, or declaring it dead.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
// @ts-ignore — plain module shared with the chain tests
import {
  wordsAreValid, tidyWords, xpubForKey, buildCommitment, checkCommitment, completeCommitmentWith, commitmentPaid, commitmentTxid, signNoticeWith,
} from "../wallet/core.mjs";
import { memberAddressForOwnerKey } from "../../../method/js/verify.mjs";
import { phaseOf, pilePath, checkPileShape, noticeStatement, noticeIsGenuine, proposalVersion, stillTakingCommitments } from "../../../method/js/proposals.mjs";
// @ts-ignore — plain module shared with the chain tests
import {
  loadCrowdlock, membershipOf, shortBtc, locksOnRegister, baseFor, resolvePath, mayCommitTo, rulesOf, rulesChanges, relayOnlyCommitments,
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
import { WordsInput } from "./wallet";

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

type Pile = { count: number; sats: number; mine: { sats: number; record: any; paid?: boolean }[]; good: { record: any; at: number; sats: number }[]; completed: number; refused: string[]; paid: number; paidCount: number; notice: any | null; noticeContradicted?: boolean };

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
  // Commitments only on the relays count until an hour after closing. After
  // that only the repository's record does: a late one could carry any date.
  const relaysCount = stillTakingCommitments(p, Date.now() / 1000);
  // And only from a real lock on the register, a few per lock: what the
  // repository's inbox could take. Anything else is a stranger's, and is not
  // worth a question to the block explorer (security loop, 17 November 2026).
  for (const it of relayOnlyCommitments(await fetchCommitments(c.crowdlock, p.hash), { crowdlock: c.crowdlock, register: c.register, inPile })) {
    if (it.type === "commitment" && !relaysCount) continue;
    // Not yet in the repository: ordered after everything that is.
    items.push(it.type === "commitment" ? { ...it, at: Math.max(it.at, ...items.map((x) => x.at ?? 0)) + 1 } : it);
  }
  const pile: Pile = { count: 0, sats: 0, mine: [], good: [], completed: 0, refused: [], paid: 0, paidCount: 0, notice };
  // One coin, one commitment, per proposal: a second commitment spending the
  // same coin is ignored and the earlier one stands (spec/commitment-format.md,
  // "Counting the pile"). Only one of them could ever be paid, so counting
  // both showed a proposal nearer its target than it was.
  const counted = new Set<string>();
  // One payment counts once, however many copies of its commitment were
  // posted: a payment's id leaves out the signatures, so every copy shares it
  // (OpenAI review, H-05).
  const paidIds = new Set<string>();
  for (const it of items) {
    if (it.type === "completed") { pile.completed++; continue; }
    if (it.type === "notice") { if (!pile.notice && genuine(it.notice)) pile.notice = { ...it.notice, published: new Date(it.at * 1000).toISOString() }; continue; }
    let v: any;
    try { v = await checkCommitment({ record: it.record, crowdlock: c.crowdlock, proposal: p, destinations: c.destinations, chain, network: NETWORK }); }
    catch (e) {
      // The repository's own pile must be read in full or not at all. One
      // that is only on the relays is left out if it can't be checked now.
      if (!it.relayOnly) throw e;
      pile.refused.push("a commitment that is only on the relays couldn't be checked just now"); continue;
    }
    if (!v.valid) {
      // A commitment whose coin is gone may be one the co-signer completed:
      // then it was paid, not refused.
      if (/already been spent/.test(v.reason)) {
        const id = commitmentTxid(it.record);
        if (id && paidIds.has(id)) continue;
        const paid = await commitmentPaid({ record: it.record, chain });
        if (paid > 0) {
          if (id) paidIds.add(id);
          pile.paid += paid; pile.paidCount++;
          if (it.record.lock?.owner_pubkey === account.publicKey) pile.mine.push({ sats: paid, record: it.record, paid: true });
          continue;
        }
      }
      pile.refused.push(v.reason); continue;
    }
    if (v.coin && counted.has(v.coin)) { pile.refused.push("an earlier commitment already spends the same coin, and only one can be paid"); continue; }
    if (v.coin) counted.add(v.coin);
    pile.count++; pile.sats += v.committedSats;
    pile.good.push({ record: it.record, at: it.at, sats: v.committedSats });
    if (v.ownerPubkey === account.publicKey) pile.mine.push({ sats: v.committedSats, record: it.record });
  }
  // A notice says the proposal failed. While it is still gathering it can't
  // have, so a notice then is ignored (OpenAI review H-04). One against a
  // pile that reaches its target is shown for what it is: contradicted.
  if (pile.notice && (phaseOf(p) === "soon" || phaseOf(p) === "gathering")) pile.notice = null;
  if (pile.notice && pile.sats + pile.paid >= p.target.sats) pile.noticeContradicted = true;
  return pile;
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
  const [dead, setDead] = useState(false);
  useEffect(() => { readPile(c, p, account).then((x) => { setPaid(x.paid); setDead(!!x.notice); }).catch(() => setPaid(null)); }, [c, p]);
  if (paid !== null && paid >= p.target.sats) return <Text style={s.good}>Funded and paid · {btc(BigInt(paid))} sent to the seller · closed</Text>;
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
          <Text style={s.error}>{pile.noticeContradicted
            ? `Declared dead by the co-signer${pile.notice.published ? ` on ${String(pile.notice.published).slice(0, 10)}` : ""}, although the commitments checked on this phone add up to its target. The co-signer has said it will complete none of them. Your money stays locked and comes home on its date as usual.`
            : `Declared dead by the co-signer${pile.notice.published ? ` on ${String(pile.notice.published).slice(0, 10)}` : ""}: it didn't reach its target, and none of its commitments will be completed. Your money stays locked and comes home on its date as usual.`}</Text>
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

  useEffect(() => {
    if (!c || !c.ok || !p) return;
    (async () => {
      const out: { lock: any; coin: any }[] = [];
      const now = Math.floor(Date.now() / 1000);
      for (const l of locksOnRegister(c.register, account.address, c.crowdlock)) {
        // A lock that opens before this proposal's settling ends can't back it:
        // its owner could take the money home first.
        if (l.locktime <= now || l.locktime <= Date.parse(p.settles_by) / 1000) continue;
        for (const coin of (await chain.utxos(l.address)).filter((u: any) => u.confirmed)) {
          out.push({ lock: { ...l, cosignerXpub: xpubForKey(c.crowdlock, l.cosignerPubkey) }, coin });
        }
      }
      out.sort((a, b) => b.coin.value - a.coin.value);
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
  return !open ? <Btn label="For the co-signer: declare it dead" kind="second" onPress={() => setOpen(true)} /> : (
    <View style={s.panel}>
      <Text style={s.label}>It closed short of its target</Text>
      <Text style={s.note}>Nothing has to happen: without your signature no commitment can ever move. Publishing a signed notice tells every member so, publicly, and promises you won't complete any of them. Type the co-signer key's words; they're used once and not saved.</Text>
      <WordsInput value={words} onChange={setWords} placeholder="The co-signer key's 12 words" />
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      {asking ? <Confirm title={askDead[0]} text={askDead[1]} yes="Sign and publish" onYes={deadGo} onCancel={() => setAsking(false)} /> : <Btn label={busy ? "Signing…" : "Sign and publish the notice"} disabled={busy || !wordsAreValid(tidyWords(words))} onPress={() => setAsking(true)} />}
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
        // Every commitment is checked again now, and the total added up again
        // from those that still pass. If they no longer reach the target,
        // nothing is completed: one coin that has gone, or never confirmed,
        // must not leave the others paying for a purchase that is short.
        const still: typeof take = [];
        let total = pile.paid;
        for (const g of take) {
          try {
            const v = await checkCommitment({ record: g.record, crowdlock: c.crowdlock, proposal: p, destinations: c.destinations, chain, network: NETWORK });
            if (v.valid) { still.push(g); total += v.committedSats; } else failed.push(`A commitment no longer passes its check: ${v.reason}`);
          } catch (e: any) { failed.push(String(e.message ?? e)); }
        }
        if (total < p.target.sats) {
          setWords(""); setBusy(false);
          setMsg({ ok: false, text: `Nothing was completed. Checked again just now, the commitments add up to ${btc(BigInt(total))}, short of the ${btc(BigInt(p.target.sats))} target.${failed[0] ? ` ${failed[0]}` : ""}` });
          onDone();
          return;
        }
        for (const g of still) {
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
      {!open ? <Btn label="For the co-signer" kind="second" onPress={() => setOpen(true)} /> : <View style={s.panel}>
        <Text style={s.label}>Co-sign this proposal</Text>
        <Text style={s.note}>Only once the target is met, and only if the proposal and its destination are genuine. Type the co-signer key's words, ideally on a phone that is otherwise offline. They are used once and not saved.</Text>
        {!met && <Text style={s.error}>The target isn't met yet: {btc(BigInt(pile.sats))} of {btc(BigInt(p.target.sats))}. Nothing should be completed.</Text>}
        <WordsInput value={words} onChange={setWords} placeholder="The co-signer key's 12 words" />
        {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
        {asking ? <Confirm title={askSend[0]} text={askSend[1]} yes="Complete and send" onYes={sendGo} onCancel={() => setAsking(false)} /> : <Btn label={busy ? "Completing…" : `Complete ${take.length} and send`} disabled={busy || !met || !wordsAreValid(tidyWords(words)) || take.length === 0} onPress={() => setAsking(true)} />}
      </View>}
    </View>
  );
}
