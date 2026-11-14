// Which of the six steps comes next, for the Home screen's one card.
//
//   1 understand · 2 sign · 3 get bitcoin · 4 lock · 5 commit to a purchase · 6 take it home
//
// A plain function of what the app already knows (who has joined, what is
// waiting, each lock's state, any open proposal), so it can be tested without
// a phone. It decides nothing about money: it only picks which button Home
// offers first.

const RANK = { takeHome: 5, commit: 4, lock: 3, blocked: 2, getBitcoin: 2, rest: 0 };

/**
 * @param {{
 *   waiting: bigint,
 *   crowdlocks: Array<{
 *     url: string, name: string, member: boolean, canLock: boolean, minimum: bigint,
 *     locks: Array<{ state: string, confirmed: bigint, arriving: bigint, locktime: number }>,
 *     openProposal: null | { title: string, hash?: string }, committed: boolean,
 *   }>,
 * }} state  Crowdlocks on this app's network that passed their checks, in list order.
 * @returns {{ step: number, kind: string, url?: string, name?: string, sats?: bigint, need?: bigint, title?: string, opens?: number, options?: Array<{ url: string, name: string }> }}
 */
export function nextStep({ waiting, crowdlocks }) {
  if (crowdlocks.length === 0) return { step: 1, kind: "find" };
  const joined = crowdlocks.filter((c) => c.member);
  if (joined.length === 0) return { step: 1, kind: "understand", url: crowdlocks[0].url, name: crowdlocks[0].name };

  let best = null;
  for (const c of joined) {
    const one = forCrowdlock(c, waiting);
    if (!best || RANK[one.kind] > RANK[best.kind]) best = one;
  }
  // Waiting money belongs to no Crowdlock until its owner picks one. If more
  // than one joined Crowdlock could take the lock, Home must ask, never choose.
  if (best.kind === "lock") {
    const options = joined.filter((c) => forCrowdlock(c, waiting).kind === "lock").map((c) => ({ url: c.url, name: c.name }));
    if (options.length > 1) return { step: 4, kind: "lock", sats: best.sats, options };
  }
  return best;
}

function forCrowdlock(c, waiting) {
  const at = { url: c.url, name: c.name };
  // A lock past its date is the one thing that is only ever the owner's to do.
  const home = c.locks.filter((l) => l.state === "lapsed" && l.confirmed > 0n);
  if (home.length) return { step: 6, kind: "takeHome", ...at, sats: home.reduce((n, l) => n + l.confirmed, 0n) };

  const locked = c.locks.filter((l) => l.state === "locked" && l.confirmed > 0n);
  if (c.openProposal && !c.committed && locked.length) return { step: 5, kind: "commit", ...at, title: c.openProposal.title, hash: c.openProposal.hash };

  const enough = waiting > 0n && waiting >= c.minimum;
  if (enough && c.canLock) return { step: 4, kind: "lock", ...at, sats: waiting };

  const holding = c.locks.some((l) => (l.state === "locked" || l.state === "arriving") && (l.confirmed > 0n || l.arriving > 0n));
  if (holding) {
    const dates = locked.map((l) => l.locktime).sort((a, b) => a - b);
    return { step: 0, kind: "rest", ...at, opens: dates[0] };
  }
  // Enough is waiting, but this Crowdlock can't take a lock just now (no
  // co-signer key yet, or its keys changed and need a look): its page says why.
  if (enough) return { step: 4, kind: "blocked", ...at };
  return { step: 3, kind: "getBitcoin", ...at, need: c.minimum - waiting };
}
