// "Check the connection": time one small question to each place the app
// depends on, and say plainly what answered.
//
// When a balance won't load, the fan (and whoever they ask for help) needs to
// know which of three things it is: the phone has no working connection, the
// block explorer is down or slow, or everything answers and the fault is
// somewhere else. Guessing from an error line has been wrong before. This asks
// each place once, at the same moment, with nothing remembered and no second
// try, so the times are what this phone really got.

/** How long each place is given before it counts as silent. */
export const CHECK_MS = 20000;

/**
 * Ask each of `targets` ({ name, url, explorer? }) one question at the same
 * moment. Returns, for each: how long it took and whether it answered (`ok`),
 * answered with an error (`status`), stayed silent, or couldn't be reached.
 */
export function checkConnection(targets, { fetchImpl = globalThis.fetch, timeoutMs = CHECK_MS, now = Date.now } = {}) {
  return Promise.all(targets.map(async (t) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = now();
    try {
      // Really ask: an answer kept from earlier would look instant.
      const res = await fetchImpl(t.url, { signal: ctrl.signal, cache: "no-store", headers: { "Cache-Control": "no-cache" } });
      try { await res.text(); } catch {}
      return { ...t, ms: now() - t0, ok: !!res.ok, status: res.status };
    } catch {
      return { ...t, ms: now() - t0, ok: false, silent: ctrl.signal.aborted, unreachable: !ctrl.signal.aborted };
    } finally { clearTimeout(timer); }
  }));
}

const secs = (ms) => {
  const n = ms < 950 ? `${Math.max(0.1, Math.round(ms / 100) / 10)}` : `${Math.round(ms / 1000)}`;
  return `${n} second${n === "1" ? "" : "s"}`;
};

/** One result in words: "answered in 0.4 seconds". */
export function describeResult(r, timeoutMs = CHECK_MS) {
  if (r.ok) return `answered in ${secs(r.ms)}`;
  if (r.silent) return `no answer in ${Math.round(timeoutMs / 1000) || timeoutMs / 1000} seconds`;
  if (r.unreachable) return "couldn't be reached at all";
  if (r.status === 429 || r.status === 503) return `answered in ${secs(r.ms)}, but said it is too busy (${r.status})`;
  return `answered in ${secs(r.ms)}, but with an error (${r.status})`;
}

/** Slower than this and a page that asks several questions will feel stuck. */
export const SLOW_MS = 5000;

/** What the results add up to, in one or two plain sentences. */
export function sumUp(results) {
  const explorers = results.filter((r) => r.explorer);
  const others = results.filter((r) => !r.explorer);
  const anyExplorer = explorers.some((r) => r.ok);
  const anyOther = others.some((r) => r.ok);
  if (!anyExplorer && !anyOther) return "Nothing answered. The phone's own connection is the likely cause: check Wi-Fi or mobile data, turn off any VPN, and try again.";
  if (!anyExplorer) return "The phone is online, but the block explorer isn't answering it. Balances and payments wait on the explorer; your money is not affected. Try again in a few minutes, or on a different connection.";
  if (explorers.some((r) => !r.ok)) return "One block explorer isn't answering, and the app is using the other.";
  if (results.some((r) => r.ok && r.ms > SLOW_MS)) return "Everything answered, but slowly. On a connection this slow, pages take a while and may give up.";
  return "Everything the app needs is answering.";
}
