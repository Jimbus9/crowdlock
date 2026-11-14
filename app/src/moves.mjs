// When a Crowdlock's address changes, the phone's own records move with it.
//
// The app files a fan's saved locks, the co-signer keys it last saw, the keys
// it is waiting to see, and the Crowdlocks they added, under each Crowdlock
// file's address. A Crowdlock whose site moves (a repository renamed, a domain
// of its own) would otherwise lose them: its locks would still show from the
// register, but the app's own copy of their terms, and its warning when a
// co-signer key changes, would be filed under an address nothing uses.
//
// So build.mjs lists each move, old address → new, and every start rewrites
// what is filed under an old address to the new one. Running it again changes
// nothing, so it simply runs every time; nothing records that it has run.
// Nothing is ever deleted here: a record is only refiled.

/** The address `url` has moved to, or `url` itself if it hasn't moved. */
export function movedUrl(url, moves) {
  let u = String(url ?? "");
  // A move can land on an address that has moved again since (fanfund →
  // jimbus9.github.io/crowdlock → crowdlock.org), so follow them to the end.
  // Bounded by the length of the list, so a loop in it can't hang the app.
  const list = moves ?? [];
  for (let hop = 0; hop <= list.length; hop++) {
    const m = list.find(([from]) => u.startsWith(from));
    if (!m) break;
    u = m[1] + u.slice(m[0].length);
  }
  return u;
}

/**
 * The phone's records with every old address replaced by its new one.
 *   locks     [{crowdlock, address, ...}]       saved lock terms
 *   seen      {url: keys}                        co-signer keys last seen
 *   expected  {url: keys}                        keys added, not yet seen
 *   added     [url]                              Crowdlocks the fan added
 * `starting` is the build's starting list: an added Crowdlock that has moved
 * onto it is dropped from the added list rather than listed twice.
 * Returns the new records and whether anything changed.
 */
export function moveRecords({ locks = [], seen = {}, expected = {}, added = [] }, moves, starting = []) {
  let changed = false;
  const to = (u) => { const n = movedUrl(u, moves); if (n !== u) changed = true; return n; };

  const newLocks = locks.map((l) => (l && typeof l.crowdlock === "string" ? { ...l, crowdlock: to(l.crowdlock) } : l));

  // Two maps keyed by address. If both the old and the new address have keys
  // (the new build already ran once before this), keep both lists together:
  // for "seen" the newer one, under the new address, wins; for "expected",
  // a key waiting under either still waits.
  const remap = (map, merge) => {
    const out = {};
    for (const [u, v] of Object.entries(map ?? {})) if (movedUrl(u, moves) === u) out[u] = v;
    for (const [u, v] of Object.entries(map ?? {})) {
      const n = to(u);
      if (n === u) continue;
      out[n] = out[n] === undefined ? v : merge(out[n], v);
    }
    return out;
  };
  const newSeen = remap(seen, (atNew) => atNew);
  const newExpected = remap(expected, (atNew, atOld) => [...new Set([...(atNew ?? []), ...(atOld ?? [])])]);

  const newAdded = [];
  for (const u of added ?? []) {
    const n = movedUrl(u, moves);
    if (n === u) { newAdded.push(u); continue; }
    changed = true;
    if (!starting.includes(n) && !newAdded.includes(n)) newAdded.push(n);
  }

  return { locks: newLocks, seen: newSeen, expected: newExpected, added: newAdded, changed };
}
