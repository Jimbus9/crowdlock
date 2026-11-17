// For founders, maintainers and co-signers: starting a Crowdlock, making a
// co-signer key, and looking after a Crowdlock that exists (updates,
// co-signer keys, destinations, proposals, maintainers, a new version of its
// declaration). Everything a founder does is written to their own GitHub
// repository through src/github.mjs.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
// @ts-ignore — plain module shared with the chain tests
import {
  tidyWords, newCosignerWords, cosignerKeyFromWords, COSIGNER_PATH, isPublicKey, keyFromXpub, xpubForKey, signStatementWith, NETWORKS, buildStamp,
} from "../wallet/core.mjs";
import { address as bitcoinAddress } from "bitcoinjs-lib";
import {
  proposalHash, fieldsOf, nextDestination, attestationStatement, destinationIsPermitted, checkProposals, chainIsIntact, attestationsAreValid,
  attestorsOf, stampScript, stampsFor, stampedAt,
} from "../../../method/js/proposals.mjs";
import { ledgerAppFor } from "../ledgerDevice";
// @ts-ignore — plain modules shared with the tests
import { buildCrowdlock, declarationSkeleton, slugify, DEFAULT_RELAYS, checkWithNewKey, NO_RETURNS } from "../start.mjs";
// @ts-ignore
import {
  startSignIn, waitForSignIn, whoAmI, createCrowdlockRepo, canWrite, updateCrowdlockRepo, addMaintainer, rememberSignIn, currentSignIn, addCosignerKey,
  addDestination, publishProposal, publishDeclarationVersion,
} from "../github.mjs";
// @ts-ignore — plain module shared with the tests
import { canonicalise, declarationHash, checkCrowdlock, currentVersion } from "../../../method/js/crowdlock.mjs";
// @ts-ignore
import template from "../template.mjs";
// @ts-ignore — plain module shared with the chain tests
import {
  loadCrowdlock, pathInRepo, repoFromFileUrl, versionStatus, changesSince, baseFor, resolvePath, lineChanges,
} from "../crowdlocks.mjs";
// @ts-ignore — plain module
import { announce } from "../relays.mjs";
import { loadAddedCrowdlocks, saveAddedCrowdlocks, loadExpectedKeys, saveExpectedKeys } from "../storage";
import { NETWORK, IS_TEST_MONEY, chain } from "../config";
// The look (one theme file) and the shared parts every screen is built from.
import { Btn, NavRow, NoScreenshots, Warning } from "../ui/parts";
import { whileOpen, allLinks, useBack, Input, walletAccount, minorDigits, money, parseBtc, SumRow, Confirm, Changes, s, signingAccount } from "./shared";
import type { Go, Loaded } from "./shared";
import { CheckEveryWord, WordsInput } from "./wallet";
import { TestApp } from "./crowdlock";

export function Founders({ words, go }: { words: string; go: Go }) {
  return (
    <View>
      <Text style={s.h1}>For founders and co-signers</Text>
      <Text style={s.p}>Most people never need this page. It is for someone starting a Crowdlock of their own, or helping to run one.</Text>
      <NavRow title="Start a Crowdlock" sub="Write what it is for; the app sets it up in your own GitHub account" onPress={() => go({ name: "startCrowdlock", words })} />
      <NavRow title="Make a co-signer key" sub="The key that adds the second signature to a funded purchase" onPress={() => go({ name: "cosignerKey", words })} />
      <Text style={s.h2}>Look after a Crowdlock</Text>
      <Text style={s.p}>Update it, add co-signer keys and destinations, publish a proposal, add maintainers. Pick the Crowdlock:</Text>
      <LookAfterList words={words} go={go} />
      {!IS_TEST_MONEY && <>
        <Text style={s.h2}>Practise first, if you want to</Text>
        <Text style={s.p}>Starting a Crowdlock, co-signing and declaring a proposal dead can all be tried with test money before you do them for real. You don't have to.</Text>
        <TestApp />
      </>}
      <Text style={s.p}>Co-signing a purchase, and declaring a proposal dead, are on the proposal itself, under "For the co-signer".</Text>
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

export function CosignerKey({ words: walletWords, forStart, go }: { words: string; forStart?: "cosigner" | "testPasted"; go: Go }) {
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
    if (forStart && whileOpen.startDraft && (xpub || pub)) whileOpen.startDraft[forStart] = xpub ?? pub;
    setCoWords(""); setTyped(""); setPub(null); setXpub(null);
    go(forStart ? { name: "startCrowdlock", words: walletWords } : { name: "home", words: walletWords });
  };

  if (stage === "intro") return (
    <View>
      <Text style={s.h1}>Make a co-signer key</Text>
      <Text style={s.p}>A Crowdlock's co-signer adds the second signature that lets a funded purchase go through. The key can't take or keep anyone's money — it can only complete what members already signed for, or refuse.</Text>
      <Text style={[s.p, s.bold]}>Switch on airplane mode before you start, and leave it on until you've finished.</Text>
      <Text style={s.note}>You'll get 12 words to write on paper, twice — one copy kept outside your house. Those words are the key. They're never saved on this phone, and the same words work in other wallets (Sparrow, Electrum) or the project's own script, so you never depend on this app. Never use your wallet's own words for this.</Text>
      <Btn label="Make a new co-signer key" onPress={() => { setCoWords(newCosignerWords()); setStage("show"); }} />
      <Btn label="Check words I already have" kind="second" onPress={() => setStage("existing")} />
      <Btn label="Back" kind="second" onPress={leave} />
    </View>
  );

  if (stage === "show") return (
    <View>
      <NoScreenshots />
      <Text style={s.h1}>Write these down</Text>
      <Text style={s.p}>On paper, in order, twice. Label each copy so whoever finds it in five years knows what it is:</Text>
      <Text style={s.mono}>Co-signer key · {new Date().toISOString().slice(0, 10)} · {COSIGNER_PATH}</Text>
      <View style={s.words}>
        {list.map((w, i) => <Text key={i} style={s.word}><Text style={s.wordNum}>{i + 1}. </Text>{w}</Text>)}
      </View>
      <Text style={s.note}>This screen can't be screenshotted. No photos, notes, email or cloud. Once you leave this screen, these words are gone from the phone.</Text>
      <Btn label="I've written them down twice" onPress={() => setStage("check")} />
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
      <Btn label="Show the key" onPress={() => {
        if (tidyWords(typed) === tidyWords(walletWords)) { setProblem("Those are this wallet's own words. A co-signer key must have words of its own — otherwise it would be the same key as your member key."); return; }
        try { const k = cosignerKeyFromWords(typed); setPub(k.publicKey); setXpub(k.xpub); setTyped(""); setStage("result"); }
        catch (e: any) { setProblem(String(e.message ?? e)); }
      }} />
      <Btn label="Back" kind="second" onPress={() => setStage("intro")} />
    </View>
  );

  return (
    <View>
      <Text style={s.h1}>The public half</Text>
      <Text style={s.p}>This is safe to share. It goes in the Crowdlock's file as its co-signer key. Copy it, or scan it from another device — never retype it by hand: one wrong character makes every lock built from it unable to go into a purchase.</Text>
      <View style={s.qr}><QRCode value={pub ?? ""} size={220} /></View>
      <Text style={s.mono} selectable>{pub}</Text>
      <Text style={s.note}>Check what's scanned starts {pub?.slice(0, 6)} and ends {pub?.slice(-6)}.</Text>
      <Btn label="Copy it" onPress={() => pub && Clipboard.setStringAsync(pub)} />
      <Text style={s.h2}>Its xpub, for hardware wallets</Text>
      <Text style={s.p}>Also public. It's the same key in the longer form a Ledger needs before it will lock with it. Paste this one into "Add this co-signer key" instead of the key above and the app adds both.</Text>
      <Text style={s.mono} selectable>{xpub}</Text>
      <Btn label="Copy the xpub" kind="second" onPress={() => xpub && Clipboard.setStringAsync(xpub)} />
      <Text style={s.note}>You can switch airplane mode off now. Keep the two paper copies apart.</Text>
      <Btn label={forStart ? "Use this key and go back to my Crowdlock" : "Done"} onPress={leave} />
    </View>
  );
}

// Plain JavaScript modules: their results are used as loosely typed here.
const build = buildCrowdlock as (x: any) => any;
const createRepo = createCrowdlockRepo as (x: any) => Promise<any>;

// ---------------------------------------------------------------------------
// Starting a Crowdlock
// ---------------------------------------------------------------------------

export function StartCrowdlock({ words, go }: { words: string; go: Go }) {
  const d = whileOpen.startDraft ?? {};
  // The app decides the money: the test app starts test Crowdlocks, the real one starts real ones.
  const network: "testnet4" | "mainnet" = IS_TEST_MONEY ? "testnet4" : "mainnet";
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
  // A real Crowdlock gets a test copy only if its founder asks for one.
  const [wantTest, setWantTest] = useState<boolean>(d.wantTest ?? false);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<any>(null);
  const [stage, setStage] = useState<"form" | "signin" | "creating" | "done">("form");
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ links: { label: string; url: string }[]; repoUrl: string; inboxStarted: boolean; owner: string; repo: string } | null>(null);
  const [at, setAt] = useState<number>(d.at ?? 0);   // which page of the form
  useEffect(() => { whileOpen.startDraft = { network, name, about, title, text, minimum, waitDays, gatherDays, settleDays, cosigner, testPasted, wantTest, at }; },
    [network, name, about, title, text, minimum, waitDays, gatherDays, settleDays, cosigner, testPasted, wantTest, at]);
  useBack(() => { if (stage === "form" && at > 0) { setAt(at - 1); return true; } return false; });

  // The test copy's co-signer key is made here, from the founder's own words,
  // on a path of its own. The real one is pasted in from wherever it lives.
  // A Ledger wallet has no words here to make the test copy's co-signer from,
  // so its founder pastes one (made with "Make a co-signer key").

  const input = (siteBase: string) => {
    const t = minimum.trim().replace(",", ".");
    const [w, f = ""] = t.split(".");
    const minimumSats = /^\d*\.?\d{0,8}$/.test(t) && t !== "" ? Number(BigInt(w || "0") * 100000000n + BigInt((f + "00000000").slice(0, 8))) : NaN;
    return {
      name, about, title, declarationText: text, network, minimumSats, waitDays: /^\d{1,3}$/.test(waitDays.trim()) ? Number(waitDays.trim()) : NaN,
      gatherDays: /^\d{1,3}$/.test(gatherDays.trim()) ? Number(gatherDays.trim()) : NaN,
      settleDays: /^\d{1,3}$/.test(settleDays.trim()) ? Number(settleDays.trim()) : NaN,
      cosignerPubkey: keyFromXpub(cosigner) ? cosigner.trim() : cosigner.trim().toLowerCase(), testCosignerPubkey: testPasted.trim(), testCopy: network !== "mainnet" || wantTest,
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
      whileOpen.startDraft = null;   // it exists now; the next one starts blank
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
        <Btn label="Copy the code" kind="second" onPress={() => Clipboard.setStringAsync(code.userCode)} />
        <Btn label="Open GitHub" onPress={() => Linking.openURL(code.verificationUri)} />
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
          <Btn label="Copy the link" kind="second" onPress={() => Clipboard.setStringAsync(l.url)} />
        </View>
      ))}
      {!IS_TEST_MONEY && done.links.length > 1 && <View style={s.panel}>
        <Text style={[s.p, s.bold]}>The test copy opens in the test app</Text>
        <Text style={s.p}>It won't show in this app's list. Use it only if you or your co-signer want to practise with test money first.</Text>
        <TestApp />
      </View>}
      <Text style={s.note}>Your repository: {done.repoUrl}</Text>
      {!done.inboxStarted && <Text style={s.note}>Its relay inbox will start by itself within the hour.</Text>}
      <Text style={s.note}>Next: open it from your Crowdlocks list and sign your own declaration, so you're its member 1.</Text>

      <Text style={s.h2}>Add a maintainer</Text>
      <MaintainerAdvice />
      <MaintainerForm owner={done.owner} repo={done.repo} />
      <Text style={s.note}>You can do this any time from the Crowdlock's page, under "Look after it".</Text>
      <Btn label="Back to Home" onPress={() => go({ name: "home", words })} />
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
    : here === "testkey" ? (network === "mainnet" && !wantTest ? false : badKey(testPasted) || !testPasted.trim())
    : false;

  return (
    <View>
      <Text style={s.kick}>Start a Crowdlock · {at + 1} of {pages.length}</Text>

      {here === "money" && <>
        <Text style={s.h1}>Start a Crowdlock</Text>
        <Text style={s.p}>A Crowdlock lets a crowd commit money to buying something together, without anyone pooling it or holding anyone else's. You write what it's for; the app sets it up in your own GitHub account.</Text>
        <Text style={s.label}>Which money?</Text>
        {network === "mainnet"
          ? <Text style={s.p}><Text style={s.bold}>Real bitcoin.</Text> A few pages on, you can choose to add a test copy, if you or your co-signer want to practise with test money first. You don't have to.</Text>
          : <Text style={s.p}><Text style={s.bold}>Test bitcoin.</Text> This is the test app, so what you start here uses test bitcoin, which has no value. Practise everything (joining, locking, committing, taking a lock home) before anything is real. To start one with real bitcoin, use the Crowdlock app for real bitcoin.</Text>}
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
        <Text style={s.note}>A destination is an address a purchase is allowed to pay. We recommend at least 7 days. It's the time members have to notice a destination nobody should be paying before money can go to it. A test copy, if you add one, uses none.</Text>
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
        <Text style={s.note}>Making one here gives you 12 words to write on paper, and brings the key back to this page. Your typing is kept.</Text>
        <Text style={s.note}>You can also make it elsewhere (Sparrow, Electrum, or the method's own script) and paste its xpub: the public half of a key, in the form hardware wallets need. A plain key works too, but hardware wallets can't lock until its xpub is added.</Text>
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
        <Text style={s.h1}>{network === "mainnet" ? "A test copy, if you want one" : "The co-signer key"}</Text>
        {network === "mainnet" && <>
          <Text style={s.p}>A test copy is the same Crowdlock on test bitcoin, which has no value. It lets you and your co-signer practise joining, locking, committing and co-signing before anything is real. It opens in the Crowdlock Test app, not in this one.</Text>
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: wantTest }} onPress={() => { setWantTest(!wantTest); setChecked(null); }} style={{ flexDirection: "row", alignItems: "center", minHeight: 48 }}>
            <View style={[s.box, wantTest && s.boxOn]}>{wantTest && <Text style={s.onBrand}>✓</Text>}</View>
            <Text style={[s.p, { marginBottom: 0, flex: 1 }]}>Add a test copy</Text>
          </Pressable>
          {!wantTest && <Text style={s.note}>Leave it unticked to skip. A test copy can't be added to this Crowdlock afterwards, but you can start a practice Crowdlock of its own from the Crowdlock Test app at any time.</Text>}
        </>}
        {(network !== "mainnet" || wantTest) && <>
        {network === "mainnet" && <Text style={s.h2}>Its practice key</Text>}
        {network === "mainnet" && <Text style={s.p}>This is a second key, on purpose. The test copy is where you practise co-signing, and co-signing means typing a key's 12 words into a phone. A separate practice key means the real key's words never get typed while you practise.</Text>}
        <Text style={s.p}>{testPasted.trim() ? "Using the key you pasted." : "Make one now with the button below, or paste one you already have (its xpub, ideally)."}</Text>
        <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={testPasted} onChangeText={(t) => { setTestPasted(t); setChecked(null); }} placeholder="An xpub, or a key 02… or 03…" />
        {badKey(testPasted) && <Text style={s.error}>That isn't a public key or an xpub. Copy it whole from where the key was made.</Text>}
        <Btn kind="second" label={network === "mainnet" ? "Make a practice key now" : "Make a co-signer key now"} onPress={() => go({ name: "cosignerKey", words, forStart: "testPasted" })} />
        <Btn kind="link" label="Paste what I copied" onPress={async () => { const t = (await Clipboard.getStringAsync()).trim(); if (t) { setTestPasted(t); setChecked(null); } }} />
        <Text style={s.note}>Making one here gives you 12 words to write on paper, and brings the key back to this page. Your typing is kept. You can add more co-signer keys later, from the Crowdlock's page under "Look after it".</Text>
        </>}
      </>}

      {here === "check" && <>
        <Text style={s.h1}>Check and create</Text>
        <SumRow label="Name" value={name.trim()} />
        <SumRow label="Money" value={network === "mainnet" ? (wantTest ? "Real bitcoin, with a test copy" : "Real bitcoin") : "Test bitcoin"} />
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
      <Btn label="Copy the code" kind="second" onPress={() => Clipboard.setStringAsync(code.userCode)} />
      <Btn label="Open GitHub" onPress={() => Linking.openURL(code.verificationUri)} />
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
    <Btn label={busy ? "Adding…" : "Add a maintainer"} disabled={busy || !name.trim()} onPress={add} />
  </>;
}

export function LookAfterScreen({ words, url }: { words: string; url: string }) {
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
  // Only this app's kind of Crowdlock: the other kind is looked after from the other app.
  const mine = items.filter((c) => c.ok && c.crowdlock.network === NETWORK && repoFromFileUrl(c.url)) as Extract<Loaded, { ok: true }>[];
  if (mine.length === 0) return <Text style={s.note}>None of the Crowdlocks in your list can be looked after from the app.</Text>;
  return <>{mine.map((c) => <NavRow key={c.url} title={c.crowdlock.name} sub="Updates, co-signer keys, destinations, proposals, maintainers" onPress={() => go({ name: "lookAfter", words, url: c.url })} />)}</>;
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
      <Btn label={busy ? "Updating…" : "Update it"} disabled={busy} onPress={update} />
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
      {!open ? <Btn label="For its founder and maintainers" kind="second" onPress={() => setOpen(true)} /> : <>
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
          <Btn label="Copy" kind="second" onPress={() => Clipboard.setStringAsync(x)} />
        </View>))}
    <Text style={s.note}>Adding a key never removes one, so every lock already made keeps counting. Don't have one? Make it from More → "For founders and co-signers", ideally on a phone that holds no money{c.crowdlock.network === "mainnet" ? ", and keep its words on paper only" : ""}.</Text>
    <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={key} onChangeText={(t) => { setKey(t); setMsg(null); }} placeholder="Paste its xpub, or its key: 02… or 03…" />
    {!!pastedXpub && <Text style={s.note}>That xpub stands for {k.slice(0, 10)}…{k.slice(-8)}.{has ? " This Crowdlock already has that key, so only the xpub will be added." : ""}</Text>}
    {keys.length > 0 && keys.some((x) => !xpubForKey(c.crowdlock, x)) && <Text style={s.note}>Members with a hardware wallet can only lock with a key whose xpub is published. To add one for a key already here, paste its xpub.</Text>}
    {problem && <Text style={s.error}>{problem}</Text>}
    {!path && <Text style={s.error}>Can't tell where this Crowdlock's file sits in its repository.</Text>}
    {codeView}
    {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
    <Btn label={busy ? "Adding…" : "Add this co-signer key"} disabled={busy || !k || !!problem || !path} onPress={add} />
  </>;
}

// For founders and maintainers: approve a destination, and publish a proposal.

function isAddressOn(address: string, network: string) {
  try { bitcoinAddress.toOutputScript(address, NETWORKS[network === "mainnet" ? "mainnet" : "testnet4"].network); return true; } catch { return false; }
}

function repoPathOf(c: Extract<Loaded, { ok: true }>, path: string) {
  return pathInRepo(resolvePath(path, baseFor(c.url)));
}

// A destination is dated by its stamp on the chain (spec/destinations-format.md),
// so the screens read each entry's stamp payment from the explorer.
function useStamps(entries: any[]) {
  const [stamps, setStamps] = useState<Record<string, any> | null>(null);
  const key = entries.map((e: any) => e.stamp ?? "").join(",");
  useEffect(() => {
    let live = true;
    const adds = entries.filter((e: any) => e.op === "add");
    // Every add entry's own stamp, not only the newest for each address.
    Promise.all(adds.map((e: any) => stampsFor([e], [e.address], (id: string) => chain.tx(id))))
      .then((all) => { if (live) setStamps(Object.assign({}, ...all)); })
      .catch(() => { if (live) setStamps({}); });
    return () => { live = false; };
  }, [key]);
  return stamps;
}

function stampNote(e: any, stamps: Record<string, any> | null) {
  if (e.op !== "add") return "";
  if (!e.stamp) return "not stamped, so no proposal can use it";
  if (!stamps) return "checking its stamp…";
  const st = stampedAt(e, stamps[e.stamp] ?? null);
  return st.ok ? `stamped ${new Date(st.at * 1000).toISOString().slice(0, 10)}` : st.reason.replace(/^entry \d+'s /, "");
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
  // Its attestors are the ones its own file names (attestor_keys), never
  // what the destinations list says of itself.
  const rules = attestorsOf(c.crowdlock, hrp);
  const isAttestor = rules.attestors.includes(account.address);
  const path = repoPathOf(c, c.crowdlock.register.destinations);
  const stamps = useStamps(d.entries ?? []);
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
            const signature = await signStatementWith(await signingAccount(account), attestationStatement(entry));
            return { address: account.address, signature };
          },
          stamp: async (entry: any) => {
            setStep(account.kind === "ledger" ? `Stamping it on the chain — approve the payment on your Ledger. It pays a small network fee and sends the rest back to this wallet.` : "Stamping it on the chain…");
            const feeRate = await chain.feeRate(whileOpen.feeSpeed);
            const tx = await buildStamp({ account: await signingAccount(account), chain, script: stampScript(entry), feeRate });
            await chain.broadcast(tx.hex);
            setStep("Saving it to the Crowdlock on GitHub…");
            return tx.txid;
          },
          check: (file: any) => {
            const ch = chainIsIntact(file.entries, rules.instance);
            const last = file.entries[file.entries.length - 1];
            const att = attestationsAreValid(last, { attestors: rules.attestors, threshold: rules.threshold, hrp });
            return { ok: ch.ok && att.ok, problems: [ch.reason, att.reason].filter(Boolean) };
          },
        });
        setAddress(""); setText("");
        setMsg({ ok: true, text: `Added, attested and stamped. ${c.crowdlock.destination_wait_days ? `A proposal can use it ${c.crowdlock.destination_wait_days} days after the stamp is in a block.` : "A proposal can use it as soon as the stamp is in a block, usually within half an hour (this Crowdlock has no waiting period)."} Its website updates in a minute or two.` });
        setTimeout(onChange, 90000);
      });
    } catch (e: any) { setMsg({ ok: false, text: String(e.message ?? e) }); }
    setBusy(false); setStep("");
  };
  return <>
    <Text style={s.label}>Destinations</Text>
    {(d.entries ?? []).length === 0 ? <Text style={s.note}>None yet. A proposal can only pay an address on this list, attested by this Crowdlock's attestors.</Text>
      : d.entries.map((e: any) => <Text key={e.index} style={s.note}>{e.index}. {e.op === "revoke" ? "Revoked: " : ""}{e.text} — {e.address.slice(0, 14)}…{e.address.slice(-6)}, {e.op === "add" ? `, ${stampNote(e, stamps)}` : ""}</Text>)}
    {!isAttestor ? <Text style={s.note}>This wallet isn't one of its attestors, so it can't approve a destination.</Text> : <>
      <Input style={s.input} autoCapitalize="none" autoCorrect={false} value={address} onChangeText={(t) => { setAddress(t); setMsg(null); }} placeholder="The address a purchase would pay" />
      <Input style={s.input} value={text} onChangeText={(t) => { setText(t); setMsg(null); }} placeholder="Who it belongs to and what it's for" />
      <Text style={s.note}>Your wallet signs to say you attest it{account.kind === "ledger" ? " — approve the message on your Ledger" : ""}. Anyone can check that signature. Then it stamps it on the chain: a small payment from this wallet back to itself, carrying the destination's fingerprint, so its date can't be faked. That needs a little bitcoin in this wallet for the network fee{account.kind === "ledger" ? ", and a second approval on your Ledger" : ""}.</Text>
      {codeView}
      {busy && !!step && <Text style={s.note}>{step}</Text>}
      {msg && <Text style={msg.ok ? s.good : s.error}>{msg.text}</Text>}
      {!!address.trim() && !isAddressOn(address.trim(), c.crowdlock.network) && <Text style={s.error}>That isn't a {c.crowdlock.network === "mainnet" ? "bitcoin" : "test-network"} address. Paste the seller's whole address.</Text>}
      <Btn label={busy ? "Adding…" : "Add and attest this destination"} disabled={busy || !isAddressOn(address.trim(), c.crowdlock.network) || !text.trim() || /[|\n]/.test(text) || !path} onPress={add} />
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
  const stamps = useStamps(d.entries ?? []);
  const usable = (d.entries ?? []).filter((e: any) => e.op === "add").filter((e: any) => destinationIsPermitted({
    address: e.address, entries: d.entries, opensAt: nowIso(), minimumAgeDays: c.crowdlock.destination_wait_days,
    ...attestorsOf(c.crowdlock, hrp), stamps: stamps ?? {},
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
    {stamps === null ? <Text style={s.note}>Checking the destinations' stamps on the chain…</Text> : usable.length === 0 ? <Text style={s.note}>No destination is ready yet. Add and attest one above, then wait for its stamp to reach a block{c.crowdlock.destination_wait_days ? ` and ${c.crowdlock.destination_wait_days} days more` : ""}.</Text> : <>
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
        : <Btn label={busy ? "Publishing…" : "Publish this proposal"} disabled={busy || !!problem} onPress={() => setAsking(true)} />}
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
      : <Btn label={busy ? "Publishing…" : `Publish version ${cur.version + 1}`} kind="danger" disabled={busy || !!problem} onPress={() => setAsking(true)} />}
  </>;
}
