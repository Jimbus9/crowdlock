# Reviewing Crowdlock

Crowdlock is a method for a fund that nobody pools money into: each fan locks their own bitcoin in a script only they and a co-signer can spend, and a purchase is funded by each fan signing their own locked coins into it. The Kop Fund is the first instance of it. One real lock exists so far: the founder's own, made on 10 November 2026, before any outside review, by his own choice. This page is for anyone who wants to try to break it before anyone else's money goes in.

**Please review it.** Finding a flaw is the most useful thing you can do here. Being wrong about something in the code is no embarrassment to us; saying nothing is.

## If you have an hour, read these, in this order

1. **The commitment's witness, which is laid out by hand.** A commitment is half a transaction: the owner signs, and the co-signer's place is left empty until settlement. The Bitcoin library we use will not finish half a transaction, so the witness stack is assembled in our own code: `[co-signer's signature, empty, owner's signature, script]`. It is built, checked and completed in `method/lock/commitment.mjs` (`buildCommitment`, `verifyCommitment`, `completeCommitment`) and again in the app in `app/src/wallet/core.mjs` (`buildCommitment`, `checkCommitment`, `completeCommitmentWith`). The signatures themselves are the libraries'. This is the code most likely to hold a mistake that costs money.
2. **The lock script.** 79 bytes, two exits, in `method/lock/lock.mjs`. Everything else rests on it.
3. **Where the app keeps recovery words.** `app/src/storage.ts` and `signingAccount` in `app/src/screens/shared.tsx`. The words sit in the phone's keystore and are read only at the moment of signing, behind the phone's fingerprint or face check. This code is new (16 November 2026).
4. **What the repository's inbox accepts without being asked.** `method/js/inbox.mjs`, `method/js/proposals.mjs` and `method/relay/inbox.mjs`. Anyone can post a record to the relays; this code decides what reaches the register and each proposal's pile.
5. **The specification, as a reader who is not British.** `spec/`. Nobody outside the United Kingdom has read it. A document meant to be copied should state what is true everywhere, or say plainly that the detail depends on where the reader is.

## What is in scope

1. **The lock script.** Two exits only: the owner alone after a date, or owner plus co-signer at any time. Built as `and_v(v:pk(owner), or_i(after(t), pk(cosigner)))`, a 79-byte P2WSH witness script.
2. **Commitments and settlement.** Each fan pre-signs a spend of their lock to an attested destination with nLockTime 0. The co-signer completes them when a proposal is funded. There is no vote.
3. **The lock record checker.** Rebuilds a lock's address from its terms without bitcoinjs, and must match the proven code byte for byte.
4. **The app's wallet module and key handling.** Builds, signs and refuses spends using bitcoinjs-lib and @bitcoinerlab/descriptors; makes new recovery words; keeps them in the phone's keystore.
5. **The Ledger adapter.** The join between Ledger's Device Management Kit and the Bitcoin library, in the app and in the browser.
6. **The relay inbox.** Records posted to public Nostr relays are judged by the shared checking code in `method/js/`, then committed by a job GitHub runs.
7. **The co-signer.** What the key can and cannot do, how it is made, and what its holder is trusted for.

**Not in scope:** the wording of the declaration, the legal and tax position, the governance design, and the website's visual design. Comments on those are welcome but are not what we need most.

## Where each piece lives

| Piece | File |
| --- | --- |
| Lock script and spends (P2WSH) | `method/lock/lock.mjs` |
| Commitments, attestations, proposal line | `method/lock/commitment.mjs` |
| Taproot variant (built, **not in use**) | `method/lock/taproot.mjs` |
| The live run against testnet4 | `method/lock/run-testnet.mjs` |
| What the libraries do with the lock, on a private chain | `method/lock/library-check/` |
| Lock record checker (no bitcoinjs) | `method/js/lockrecord.mjs` |
| Join checker, and later versions of a declaration | `method/js/append.mjs`, `method/js/crowdlock.mjs` |
| Membership signature check | `method/js/verify.mjs` |
| The lock a web page offers a member | `method/js/lockplan.mjs` |
| Proposals, destinations, the pile, the co-signer's notice (browser-safe) | `method/js/proposals.mjs` |
| The co-signer's public record of early releases | `method/js/release.mjs` |
| Relay inbox judgement and job | `method/js/inbox.mjs`, `method/relay/inbox.mjs`, `method/relay/nostr.mjs` |
| Making and restoring a co-signer key on a computer | `method/cosigner/generate.mjs`, `method/cosigner/restore.mjs` |
| App wallet (keys, spends, relock, commitments, co-signing) | `app/src/wallet/core.mjs` |
| App: where recovery words are kept and read | `app/src/storage.ts`, `signingAccount` in `app/src/screens/shared.tsx` |
| App: the source of randomness for new words | `app/src/polyfills.ts` (`crypto.getRandomValues` from expo-crypto) |
| App: block explorers, and which one is believed | `app/src/wallet/esplora.mjs`, `explorerFor` in `app/src/crowdlocks.mjs` |
| App: the co-signer's screen | `CoSign` in `app/src/screens/proposals.tsx` |
| App tests on a private chain | `app/test-chain/` |
| Ledger adapter (app and website) | `app/src/ledgerLink.mjs`, `app/src/ledgerDevice.ts`, `method/ledger-web/` |
| The written specification | `spec/lock-format.md`, `spec/commitment-format.md`, `spec/registration-format.md`, `spec/counting-rule.md`, `spec/proposal-and-settlement.md`, `spec/destinations-format.md` |
| Method overview | `spec/running-your-own.md`, `README.md` |

The real fund's own repository, `Jimbus9/the-kop-fund`, carries a byte-for-byte copy of the checking code in `method/js/` and of the relay inbox in `method/relay/` (the list is in `method/check-kop-fund-copy.mjs`), beside its own web pages. A flaw in those files here is a flaw there.

## How to run the tests

**The list of checks that must pass is `.github/workflows/checks.yml`**, which runs on every push. The table below is a guide to it. Install dependencies in each folder first, with `npm ci`. Run from the folder shown.

| Suite | Folder | Command | Needs |
| --- | --- | --- | --- |
| Lock script | `method/lock` | `node selftest.mjs`, `node commitment.test.mjs`, `node taproot.test.mjs` | Node 22 |
| Method checks | the repository root, after `npm ci` in `method/lock` | `for t in method/js/*.test.mjs; do node "$t" \|\| break; done` | Node 22 |
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
- **Proven on a private regtest chain:** the app's wallet can create, fund, restore, send, lock, take a lock home after its date, and relock in one transaction, using bitcoinjs-lib and descriptors. A commitment built in the app is accepted by the method's own checker, completed by the co-signer and mined; one nobody completes leaves the money where it was. The app's commitment checker gives the reference checker's verdict on good and tampered commitments.
- **Tested only against a pretend keystore, not on a phone:** an older install's recovery words being moved into the locked store, and what happens when the phone discards the locked words because its fingerprints changed.
- **Built and tested, but never run on a live network:** the taproot variant. It is not used.
- **Tried by hand on testnet4 (November 2026), not by an automated test:** a proposal funded and settled end to end through the app; a proposal that fell short, declared dead by the co-signer; a Ledger Nano X locking, committing and taking a lock home, in the app and on The Kop Fund's website; a new version of a declaration published and signed again by a member.
- **Real bitcoin: one lock.** The founder locked 0.00250863 BTC on 10 November 2026, until 11 November 2027, from the app with a Ledger. Nothing else has been done with real money: no lock has been taken home, and nothing has been committed or settled. Nobody else should lock real bitcoin until this review is done.
- **Not reviewed by anyone outside this project.** That is why we are asking. The project has read its own code line by line, with an AI assistant, on 16 November 2026: the app's wallet module, its explorer code and its Ledger adapter, and the method's code under `method/lock`, `method/js`, `method/relay` and `method/cosigner`. That is the author checking its own work, not a review.

## Limits we already know about

- **One block explorer is believed at a time.** The register adds a lock when the explorer its Crowdlock's file names (`chain_api`) reports confirmed coins at the lock's address, so a lying explorer could make a lock count without the money being there. The app is in a better place than it was: it reads the chain for every Crowdlock from its own explorer for the network, never the one the Crowdlock names, and before signing anything it checks each coin's amount against the transaction the coin came from. Its backup explorer is only asked when the first is silent or broken. Nothing anywhere compares two explorers, or asks a node.
- **The co-signer is trusted not to complete a commitment early.** A dishonest co-signer can complete a commitment from a proposal that was never funded, while the coin is still unspent. The money can only go where the owner already signed for it to go, to a destination on the published list. It cannot go anywhere else, and the co-signer cannot move a coin alone.
- **The co-signer can let a member out early.** Owner and co-signer together can spend a lock at any time, to anywhere. Bitcoin does not stop it; the chain records it, and `method/js/release.mjs` reads that record.
- **Today the co-signer is one key held by the founder.** Two of three is the direction once there is a second person.
- **Every lock's public keys are published.** The register lists each lock's owner key and co-signer key so that anyone can rebuild its address. A lock therefore has none of the protection a hidden key gives: if quantum computers one day work a private key out from a public one, these locks are exposed sooner than most. Locks renew within five years, which is the route to a safer address type once Bitcoin has one. Nobody has planned that move.
- **A lock's date is worked out from the clock of the phone or computer that makes it.**
- **No test checks a specification against the code it describes.**

## Things we would most like checked

- Is the hand-built commitment witness right in every case, in both places it is written? Can a commitment pass every check and still be one the network will never accept, or will not accept in time?
- Does the lock script behave as described on a real network? In particular, does the date (median time past) branch behave as we say?
- Is the commitment scheme sound: pre-signed spends with nLockTime 0, a fee fixed at signing, and the residual risk where a dishonest co-signer completes a commitment from an unfunded proposal while the coin is unspent?
- Does `app/src/wallet/core.mjs` refuse what it should: dust outputs, fees larger than the coin, spends before the date, a coin whose amount the explorer misstated?
- Is the keystore code right? Can anything sign without passing through `signingAccount`? Do the recovery words ever outlive the signing they were read for?
- Is the randomness behind new recovery words sound, in the app (`@scure/bip39` over expo-crypto's `getRandomValues`) and in `method/cosigner/generate.mjs` (the same library over Node's)?
- Does `method/js/lockrecord.mjs` really agree with the lock script byte for byte, on edge cases such as script numbers and keys with the same x-coordinate?
- What can somebody who only posts to the relays do to a register, or to a proposal's pile? What can somebody who can write to the repository do?
- Is the destinations list as strong as its document says: the attestations, the hash chain, and above all the waiting period?
- Is the one-key-does-both-jobs choice (the key that signs the declaration also owns the locks) safe?
- Is publishing every lock's keys the right trade? Is there a design that keeps locks checkable by anyone without it?

## How to report a problem

Please **do not open a public issue** for anything that could move money or reveal a key.

Report it privately, either way:

- **On GitHub:** the repository's Security tab, then "Report a vulnerability". Private vulnerability reporting is switched on for `Jimbus9/crowdlock`.
- **By email:** **hello@crowdlock.org**

For anything else (a bug in a test, a wrong comment, a documentation gap), an ordinary issue on the repository is welcome.

Please say what you tried, what you expected, and what happened. A failing test is the best possible report.

## Licence

Code is MIT. Documents are CC BY 4.0. See `LICENSE` and `spec/LICENSE`.
