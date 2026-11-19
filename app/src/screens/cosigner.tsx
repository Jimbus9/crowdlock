// The co-signer's words, for every screen that signs with a co-signer key:
// completing commitments, declaring a proposal dead, saying where a
// Crowdlock lives, and adding a co-signer key.
//
// The key can be kept on this phone behind the fingerprint or face
// (storage.ts says why that protects as much as typing it each time). Where
// it is kept, signing asks for the fingerprint; where it isn't, the words are
// typed, and after the first signature that works the key is kept, unless
// the person says not to or the phone has no fingerprint or face set up.
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
// @ts-ignore — plain module shared with the chain tests
import { wordsAreValid, tidyWords, cosignerKeyFromWords } from "../wallet/core.mjs";
import { canLock, keptCosignerKeys, keepCosignerKey, readCosignerWords, forgetCosignerKey } from "../storage";
import { Btn } from "../ui/parts";
import { s } from "./shared";
import { WordsInput } from "./wallet";

/**
 * `keys`: the co-signer keys this signature may use, oldest first; a kept one
 * is offered, the newest first. Returns:
 *   ready      whether there is something to sign with
 *   words(p)   the words to sign with: the kept key's, after the fingerprint
 *              or face check showing `p`, or the typed ones. Throws, in words
 *              for the screen, if cancelled or the phone no longer has them.
 *   done(w)    call after a signature that worked: forgets the typed words,
 *              and keeps the key if it is one of `keys`
 *   view       what goes on the screen
 */
export function useCosignerWords(keys: string[], placeholder = "The co-signer key's 12 words") {
  const want = keys.map((k) => k.toLowerCase());
  const [kept, setKept] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [keep, setKeep] = useState(true);
  const [typeInstead, setTypeInstead] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(async () => setKept(await keptCosignerKeys()), []);
  useEffect(() => { reload(); }, [reload]);
  const saved = [...want].reverse().find((k) => kept.includes(k)) ?? null;
  const usingSaved = !!saved && !typeInstead;
  const lockable = canLock();
  const ready = usingSaved || wordsAreValid(tidyWords(typed));

  const words = async (prompt: string): Promise<string> => {
    if (!usingSaved) return typed;
    let w: string | null;
    try { w = await readCosignerWords(saved!, prompt); }
    catch (e: any) {
      const why = String(e?.message ?? e);
      throw new Error(/cancel/i.test(why) ? "You cancelled, so nothing was signed." : `The phone wouldn't unlock the co-signer key, so nothing was signed. (${why})`);
    }
    if (!w) {
      await reload();
      throw new Error("This phone no longer has the co-signer key, because its fingerprints or faces changed, so nothing was signed. Type its words below.");
    }
    return w;
  };

  const done = async (w: string) => {
    setTyped("");
    if (usingSaved || !keep || !lockable) return;
    try {
      const pub = cosignerKeyFromWords(w).publicKey.toLowerCase();
      if (!want.includes(pub)) return;
      await keepCosignerKey(pub, w);
      await reload();
      setTypeInstead(false);
      setNote("The co-signer key is now kept on this phone. Next time it signs after your fingerprint or face.");
    } catch (e: any) {
      setNote(`The co-signer key wasn't kept on this phone (${String(e?.message ?? e)}), so type its words next time.`);
    }
  };

  const view = usingSaved ? (
    <View>
      <Text style={s.note}>Signs with the co-signer key kept on this phone ({saved!.slice(0, 10)}…{saved!.slice(-8)}), after your fingerprint or face.</Text>
      <Btn label="Type the words instead" kind="link" onPress={() => { setTypeInstead(true); setNote(null); }} />
      <Btn label="Forget this co-signer key on this phone" kind="link" onPress={async () => { await forgetCosignerKey(saved!); await reload(); setNote("Forgotten on this phone. The paper still makes it."); }} />
      {note && <Text style={s.good}>{note}</Text>}
    </View>
  ) : (
    <View>
      <WordsInput value={typed} onChange={(t) => { setTyped(t); setNote(null); }} placeholder={placeholder} />
      {lockable
        ? <>
          <Text style={s.note}>{keep ? "Once it has signed, the key is kept on this phone behind your fingerprint or face, so you don't type it again. The paper stays your backup." : "The words are used once and not kept."}</Text>
          <Btn label={keep ? "Don't keep it on this phone" : "Keep it on this phone"} kind="link" onPress={() => setKeep(!keep)} />
        </>
        : <Text style={s.note}>The words are used once and not kept: this phone has no fingerprint or face unlock to keep a key behind.</Text>}
      {!!saved && <Btn label="Use the kept key instead" kind="link" onPress={() => { setTypeInstead(false); setTyped(""); }} />}
      {note && <Text style={note.startsWith("The co-signer key is now") ? s.good : s.error}>{note}</Text>}
    </View>
  );

  return { ready, words, done, view };
}
