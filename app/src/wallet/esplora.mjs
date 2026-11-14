// The chain, as seen through an Esplora-style block explorer API (the kind
// mempool.space and Blockstream run). Network code only: nothing here sees a
// key. The key module asks its questions through the object this returns, so
// it can be pointed at any explorer — including one the fan runs themselves.

// A request the explorer never answers would leave the app spinning forever,
// so every question gives up after this long, in all, and says why.
export const TIMEOUT_MS = 20000;
// A question is asked twice within that time before giving up: a short first
// try, then a longer second one. Most unanswered questions are a hiccup (a
// phone that has just moved between Wi-Fi and mobile data, one dropped
// request), and asking again gets the answer in a few seconds where waiting
// out the full time got an error. Only questions are asked twice; a payment
// is sent once.
export const FIRST_TRY = 0.4;
// When the explorer has just gone unanswered, the questions queued behind
// that one would each wait the full time too, and a page that asks about
// twenty locks would spin for minutes. For this long after a give-up, further
// questions fail at once with the same reason. Checking again after it asks afresh.
export const DOWN_MS = 5000;

const UNANSWERED = (ms) => `the block explorer didn't answer within ${Math.round(ms / 1000) || ms / 1000} seconds — check your connection, or turn off any VPN, and try again`;
const UNREACHABLE = "couldn't reach the block explorer — check your connection, or turn off any VPN, and try again";

function withTimeout(fetchImpl, ms, saidMs = ms) {
  return async (url, init = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fetchImpl(url, { ...init, signal: ctrl.signal }); }
    catch (e) {
      const err = new Error(ctrl.signal.aborted ? UNANSWERED(saidMs) : UNREACHABLE);
      err.unanswered = true;
      throw err;
    } finally { clearTimeout(timer); }
  };
}

// Free explorers turn away anyone who asks too much too fast (HTTP 429). A
// Crowdlock page asks a lot at once, so three things keep the app under the
// limit: the same question asked within a short while gets the answer already
// in hand (and one already on its way is waited for, not asked twice); a
// "too many" is waited out and tried again; and if it still fails, the fan is
// told plainly what's going on.
export const REMEMBER_MS = 20000;
export const RETRIES = 2;
export const BUSY = "the block explorer is busy — wait a minute and try again";
// One memory per way of fetching, so every screen shares it but tests don't.
const memories = new WeakMap();
const busy = (status) => status === 429 || status === 503;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Forget every answer in hand, for every explorer, so the next questions are
 * really asked: what "check again" means when the fan asks for it by hand.
 */
export function askAfresh(rawFetch = globalThis.fetch) {
  const memory = memories.get(rawFetch);
  if (memory) for (const k of [...memory.keys()]) if (!k.startsWith("kept ")) memory.delete(k);
}

export function esploraChain(baseUrl, rawFetch = globalThis.fetch, timeoutMs = TIMEOUT_MS,
  { rememberMs = REMEMBER_MS, retries = RETRIES, wait = pause, minFee = 1, downMs = DOWN_MS, backup = "", preferMs = PREFER_MS } = {}) {
  const fetchImpl = withTimeout(rawFetch, timeoutMs);
  const firstTry = withTimeout(rawFetch, timeoutMs * FIRST_TRY, timeoutMs);
  const secondTry = withTimeout(rawFetch, timeoutMs * (1 - FIRST_TRY), timeoutMs);
  if (!memories.has(rawFetch)) memories.set(rawFetch, new Map());
  const memory = memories.get(rawFetch);
  // Whether this explorer has just gone unanswered, shared by every screen.
  const downKey = `down ${baseUrl}`;
  // With a backup explorer, which of the two answered last. While the first is
  // failing, questions go straight to the backup rather than waiting on it.
  const preferKey = `prefer ${baseUrl}`;
  const sources = backup ? [baseUrl, backup] : [baseUrl];
  const backupFirst = () => { const p = memory.get(preferKey); return !!p && Date.now() - p.at < preferMs; };
  const order = () => (sources.length === 2 && backupFirst() ? [1, 0] : sources.map((_, i) => i));
  const answered = (i) => { memory.delete(downKey); if (i === 1) memory.set(preferKey, { at: Date.now() }); else memory.delete(preferKey); };
  const read = (res, as) => (as === "json" ? res.json() : res.text());

  // One explorer: ask, and if it doesn't answer, ask once more.
  const askOne = async (path, as) => {
    const url = `${baseUrl}${path}`;
    let unanswered = 0;
    for (let attempt = 0; ; ) {
      let res;
      try { res = await (unanswered === 0 ? firstTry : secondTry)(url); }
      catch (e) {
        if (e.unanswered && unanswered++ === 0) continue;
        if (e.unanswered) memory.set(downKey, { at: Date.now(), why: e.message });
        throw e;
      }
      memory.delete(downKey);
      if (res.ok) return read(res, as);
      if (!busy(res.status)) throw new Error(`the block explorer answered ${res.status}`);
      if (attempt >= retries) throw new Error(BUSY);
      // Honour the explorer's own "try again in N seconds", within reason.
      const said = Number(res.headers?.get?.("retry-after"));
      await wait(Number.isFinite(said) && said > 0 ? Math.min(said, 10) * 1000 : 2000 * (attempt + 1));
      attempt++;
    }
  };

  // Two explorers: the second try goes to the other one. An explorer that is
  // silent, busy or broken (a 5xx) is passed over; any other answer, a "no
  // such transaction" included, is an answer, and the other would say the same.
  // `only` asks just one of them, for the few questions they word differently.
  const askEither = async (path, as, only) => {
    const turn = only === undefined ? order() : [only];
    let last = null;
    for (const [n, i] of turn.entries()) {
      let res;
      try { res = await (n === 0 ? firstTry : secondTry)(`${sources[i]}${path}`); }
      catch (e) { if (!e.unanswered) throw e; last = e; continue; }
      if (res.ok) { answered(i); return read(res, as); }
      if (busy(res.status)) { last = new Error(BUSY); continue; }
      if (res.status >= 500) { last = new Error(`the block explorer answered ${res.status}`); continue; }
      throw new Error(`the block explorer answered ${res.status}`);
    }
    if (last.unanswered && only === undefined) memory.set(downKey, { at: Date.now(), why: last.message });
    throw last;
  };

  const ask = async (path, as, only) => {
    const down = memory.get(downKey);
    if (down && Date.now() - down.at < downMs) throw new Error(down.why);
    return sources.length === 2 ? askEither(path, as, only) : askOne(path, as);
  };
  // `forGood`: an answer that can never change (a block by its hash) is asked once and kept for as long as the app is open.
  const get = (path, as = "json", forGood = false, only = undefined) => {
    const url = `${baseUrl}${path}`;
    const key = `${forGood ? "kept " : ""}${as} ${url}`;
    const held = memory.get(key);
    if (held && (forGood || Date.now() - held.at < rememberMs)) return held.answer;
    const answer = ask(path, as, only);
    memory.set(key, { at: Date.now(), answer });
    answer.catch(() => { if (memory.get(key)?.answer === answer) memory.delete(key); });
    return answer;
  };
  // Anything sent changes what the chain will say, so forget what it said.
  const forget = () => { for (const k of [...memory.keys()]) if (k.includes(baseUrl) && !k.startsWith("kept ")) memory.delete(k); };
  return {
    async utxos(address) {
      const list = await get(`/address/${address}/utxo`);
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
    },
    txHex: (txid) => get(`/tx/${txid}/hex`, "text"),
    /** Ask everything afresh: what "check again" means when the fan asks for it. */
    forget,
    /** The address's transactions, newest first, with each input's witness. */
    txs: (address) => get(`/address/${address}/txs`),
    /** Has anything ever been sent to this address, confirmed or not? */
    async everFunded(address) {
      const a = await get(`/address/${address}`);
      return (a.chain_stats?.funded_txo_count ?? 0) + (a.mempool_stats?.funded_txo_count ?? 0) > 0;
    },
    /**
     * The chain's own clock: the median time of the last eleven blocks. A
     * lock's date is judged against this, not against any phone's clock, and
     * it runs about an hour behind real time.
     */
    async medianTime() {
      const hash = await get("/blocks/tip/hash", "text");
      return (await get(`/block/${hash.trim()}`, "json", true)).mediantime;
    },
    /**
     * The explorer's three recommended rates, sats/vbyte, never below `minFee`
     * (test networks raise it: their blocks are bursty): slow (about an hour),
     * normal (about half an hour) and fast (the next block or two). They never
     * fall out of order.
     */
    async feeRates() {
      // The two explorers word this one differently: the first gives three
      // named rates, the backup a rate for each number of blocks to wait.
      const named = () => get("/v1/fees/recommended", "json", false, backup ? 0 : undefined);
      const byBlocks = async () => {
        const e = await get("/fee-estimates", "json", false, 1);
        return { fastestFee: e?.["1"] ?? e?.["2"], halfHourFee: e?.["3"], hourFee: e?.["6"] };
      };
      let f = null;
      for (const way of !backup ? [named] : backupFirst() ? [byBlocks, named] : [named, byBlocks]) {
        try { f = await way(); break; } catch {}
      }
      const at = (v, fallback) => Math.max(minFee, Math.ceil(Number(v) > 0 ? Number(v) : fallback));
      const slow = at(f?.hourFee, 1);
      const normal = Math.max(slow, at(f?.halfHourFee, 2));
      const fast = Math.max(normal, at(f?.fastestFee, 5));
      return { slow, normal, fast };
    },
    /** A fee rate for the chosen speed ("normal" by default: likely within about half an hour). */
    async feeRate(speed = "normal") {
      const r = await this.feeRates();
      return r[speed] ?? r.normal;
    },
    /**
     * Send a payment. With one explorer it is sent once. With a backup, a
     * payment the first explorer didn't take (silent, busy or broken) is
     * offered to the other: it is the same signed payment, so it can only ever
     * be paid once, whichever of them passes it on, or both.
     */
    async broadcast(hex) {
      let last = null;
      const turn = order();
      for (const [n, i] of turn.entries()) {
        let res;
        try { res = await fetchImpl(`${sources[i]}/tx`, { method: "POST", body: hex }); }
        catch (e) { forget(); if (!e.unanswered || n === turn.length - 1) throw e; last = e; continue; }
        forget();
        const text = await res.text();
        if (res.ok) { answered(i); return text.trim(); } // the txid
        // The other explorer already has it: the first one did pass it on.
        if (last && ALREADY_SENT.test(text)) return "";
        const more = n < turn.length - 1;
        if (busy(res.status)) { last = new Error(`${BUSY} — nothing was sent`); if (more) continue; throw last; }
        if (res.status >= 500 && more) { last = new Error(`the block explorer answered ${res.status}`); continue; }
        throw new Error(`the network refused it: ${text.slice(0, 160)}`);
      }
      throw last;
    },
  };
}

// What an explorer says when offered a payment the network already has.
const ALREADY_SENT = /already in (the )?(block ?chain|mempool|utxo set)|txn-already-(known|in-mempool)/i;

// How long the backup stays first in line after the main explorer fails.
export const PREFER_MS = 60000;

/**
 * A second explorer the app may ask when the first is silent, busy or broken,
 * by the first one's address. Real bitcoin only: nobody else runs a public
 * one for testnet4. Both speak the same language (mempool.space's is built on
 * Blockstream's). Neither can move money; each is believed about balances and
 * the chain's clock while it is the one answering. A caller opts in by passing
 * `backup`; nothing gets one by default.
 * @type {Record<string, string>}
 */
export const BACKUP_EXPLORERS = {
  "https://mempool.space/api": "https://blockstream.info/api",
};

/** Public explorers by network. A fan can swap in their own. */
export const EXPLORERS = {
  mainnet: "https://mempool.space/api",
  testnet4: "https://mempool.space/testnet4/api",
  signet: "https://mempool.space/signet/api",
};
