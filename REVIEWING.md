# Reviewing Crowdlock

Crowdlock is a method for a fund that nobody pools money into: each fan locks their own bitcoin in a script only they and a co-signer can spend, and a purchase is funded by each fan signing their own locked coins into it. The Kop Fund is the first instance of it. One real lock exists so far: the founder's own, made on 10 November 2026, before any outside review, by his own choice. This page is for anyone who wants to try to break it before anyone else's money goes in.

**Please review it.** Finding a flaw is the most useful thing you can do here. Being wrong about something in the code is no embarrassment to us; saying nothing is.

## What is in scope

1. **The lock script.** Two exits only: the owner alone after a date, or owner plus co-signer at any time. Built as `and_v(v:pk(owner), or_i(after(t), pk(cosigner)))`, a 79-byte P2WSH witness script.
2. **Commitments and settlement.** Each fan pre-signs a spend of their lock to an attested destination with nLockTime 0. The co-signer completes them when a proposal is funded. There is no vote.
3. **The lock record checker.** Rebuilds a lock's address from its terms without bitcoinjs, and must match the proven code byte for byte.
4. **The app's wallet module.** Builds, signs and refuses spends using bitcoinjs-lib and @bitcoinerlab/descriptors.
5. **The relay inbox.** Records posted to public Nostr relays are judged by the shared checking code in `method/js/`, then committed by a job GitHub runs.

**Not in scope:** the wording of the declaration, the legal and tax position, the governance design, and the website's visual design. Comments on those are welcome but are not what we need most.

## Where each piece lives

| Piece | File |
| --- | --- |
| Lock script and spends (P2WSH) | `method/lock/lock.mjs` |
| Commitments, attestations, proposal line | `method/lock/commitment.mjs` |
| Taproot variant (built, **not in use**) | `method/lock/taproot.mjs` |
| The live run against testnet4 | `method/lock/run-testnet.mjs` |
| Lock record checker (no bitcoinjs) | `method/js/lockrecord.mjs` |
| Join checker | `method/js/append.mjs` |
| Membership signature check | `method/js/verify.mjs` |
| Relay inbox judgement and job | `method/js/inbox.mjs`, `method/relay/inbox.mjs` |
| App wallet (keys, spends, relock) | `app/src/wallet/core.mjs` |
| App tests on a private chain | `app/test-chain/` |
| Ledger adapter (app and website) | `app/src/ledgerLink.mjs`, `app/src/ledgerDevice.ts`, `method/ledger-web/` |
| The written specification | `spec/lock-format.md`, `spec/commitment-format.md`, `spec/registration-format.md`, `spec/counting-rule.md`, `spec/proposal-and-settlement.md`, `spec/destinations-format.md` |
| Method overview | `spec/running-your-own.md`, `README.md` |

## How to run the tests

Install dependencies in each folder first, with `npm ci`. Run from the folder shown.

| Suite | Folder | Command | Needs |
| --- | --- | --- | --- |
| Lock script | `method/lock` | `node selftest.mjs`, `node commitment.test.mjs`, `node taproot.test.mjs` | Node 22 |
| Method checks | `method/js` | `node verify.test.mjs`, `node lockrecord.test.mjs`, `node append.test.mjs`, `node crowdlock.test.mjs`, and the others `*.test.mjs` | Node 22 |
| Relay inbox | `method/relay` | `npm test` | Node 22 |
| Co-signer key | `method/cosigner` | `node cosigner.test.mjs` | Node 22 |
| Anchor proofs | `method/anchor` | `node anchor.test.mjs` | Node 22 |
| App wallet | `app/` then `app/test-chain` | `npm ci --ignore-scripts` in `app/`, then `npm ci --ignore-scripts` and `npm test` in `app/test-chain` | Node 22 |
| Live lock on testnet4 | `method/lock` | `node run-testnet.mjs` (resumable; needs free testnet4 coins) | Internet |

Notes:
- Use `--ignore-scripts` for `app/` and `app/test-chain`. The private chain's native database module cannot build in some sandboxes; the test uses a stub instead.
- The app suite runs bcoin, a full node, on a private regtest chain. It does not touch any public network.
- The live testnet run uses mempool.space by default. Set `CROWDLOCK_API` to use another explorer.

## What is proven, and what is not

Be careful not to overstate any of this.

- **Proven on testnet4 (26 October 2026):** the owner alone is refused before the date; the co-signer alone is refused; owner plus co-signer is accepted; the owner alone is accepted after the date. Run with `method/lock/run-testnet.mjs`, against the real network.
- **Proven on a private regtest chain:** the app's wallet can create, fund, restore, send, lock, take a lock home after its date, and relock in one transaction, using bitcoinjs-lib and descriptors.
- **Built and tested, but never run on a live network:** the taproot variant. It is not used.
- **Not reviewed by anyone outside this project.** That is why we are asking.
- **Tried by hand on testnet4 (November 2026), not by an automated test:** a proposal funded and settled end to end through the app; a proposal that fell short, declared dead by the co-signer; a Ledger Nano X locking and taking a lock home, in the app and on The Kop Fund's website.
- **Real bitcoin: one lock.** The founder locked 0.00250863 BTC on 10 November 2026, until 11 November 2027, from the app with a Ledger. Nothing else has been done with real money: no lock has been taken home, and nothing has been committed or settled. Nobody else should lock real bitcoin until this review is done.
- **Known gap:** the register counts a lock when a block explorer reports confirmed coins at its address. A lying explorer could therefore make a lock count without the money being there. No mitigation is built yet. Checking against more than one explorer, or against a node, would close it.

## Things we would most like checked

- Does the lock script behave as described on a real network? In particular, does the date (median time past) branch behave as we say?
- Is the commitment scheme sound: pre-signed spends with nLockTime 0, a fee fixed at signing, and the residual risk where a dishonest co-signer completes a commitment from an unfunded proposal while the coin is unspent?
- Does `app/src/wallet/core.mjs` refuse what it should: dust outputs, fees larger than the coin, spends before the date?
- Does `method/js/lockrecord.mjs` really agree with the lock script byte for byte, on edge cases such as script numbers and keys with the same x-coordinate?
- Is the one-key-does-both-jobs choice (the key that signs the declaration also owns the locks) safe?

## How to report a problem

Please **do not open a public issue** for anything that could move money or reveal a key.

Send it privately to: **hello@crowdlock.org**

If GitHub's private security advisory feature is enabled on `Jimbus9/crowdlock`, that is also fine.

For anything else (a bug in a test, a wrong comment, a documentation gap), an ordinary issue on the repository is welcome.

Please say what you tried, what you expected, and what happened. A failing test is the best possible report.

## Licence

Code is MIT. Documents are CC BY 4.0. See `LICENSE` and `spec/LICENSE`.
