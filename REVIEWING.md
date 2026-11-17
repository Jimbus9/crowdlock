# Reviewing Crowdlock

Crowdlock is a method for a fund that nobody pools money into: each fan locks their own bitcoin in a script only they and a co-signer can spend, and a purchase is funded by each fan signing their own locked coins into it. The Kop Fund is the first instance of it. One real lock exists so far: the founder's own, made on 10 November 2026, before any outside review, by his own choice. This page is for anyone who wants to try to break it before anyone else's money goes in.

**Please review it.** Finding a flaw is the most useful thing you can do here. Being wrong about something in the code is no embarrassment to us; saying nothing is.

## If you have an hour, read these, in this order

1. **The commitment, which is laid out by hand.** A commitment is half a transaction: the owner signs, and the co-signer's place is left empty until settlement. Its last output names the proposal it is for, so the owner's signature covers that too (`spec/commitment-format.md`, version 2). The Bitcoin library we use will not finish half a transaction, so the witness stack is assembled in our own code: `[co-signer's signature, empty, owner's signature, script]`. It is built, checked and completed in `method/lock/commitment.mjs` (`buildCommitment`, `verifyCommitment`, `completeCommitment`) and again in the app in `app/src/wallet/core.mjs` (`buildCommitment`, `checkCommitment`, `completeCommitmentWith`). The signatures themselves are the libraries'. This is the code most likely to hold a mistake that costs money.
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
| Proposals, destinations, the pile, the co-signer's notice, which relay-only commitments a reader looks at (browser-safe) | `method/js/proposals.mjs` |
| The co-signer's public record of early releases, and the locks a reader remembers | `method/js/release.mjs` |
| The build workflows, held to "no job that runs libraries can write or see a secret" | `method/js/workflows.test.mjs` |
| Relay inbox judgement and job | `method/js/inbox.mjs`, `method/relay/inbox.mjs`, `method/relay/nostr.mjs` |
| What the inbox checks about a commitment's signatures, and how it sends a completed payment | `method/relay/signed.mjs` |
| Whether a record on a register really is a lock | `lockIsGenuine` in `method/js/lockrecord.mjs` |
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
- **Not reviewed by anyone outside this project.** That is why we are asking. The project has read its own code line by line, with an AI assistant, on 16 November 2026: the app's wallet module, its explorer code and its Ledger adapter, and the method's code under `method/lock`, `method/js`, `method/relay` and `method/cosigner`. A second AI tool reviewed both repositories separately on 17 November. That is the author checking its own work, not a review. What the two found is listed next, because it shows the kind of mistake this code has had in it.

## What our own reviews found, and what changed (17 November 2026)

Every one of these was reproduced before it was fixed, and each fix has a test that fails on the old code.

- **A commitment could be relabelled for another proposal.** The proposal was named beside the payment, not inside what the owner signed. The payment now carries the proposal's hash in its last output (commitment format, version 2).
- **A commitment could pass every check and never be payable:** an unusual transaction version, a sequence number that sets a waiting period, a high-S signature, an output or a fee too small for the network to pass on. All are refused now.
- **Two commitments spending the same coin both counted** toward a proposal. The earlier now stands, as the spec always said.
- **A register's total believed the register.** Any address a record named was counted. A record now counts only if its address is the lock its own terms make, co-signed by this Crowdlock (`lockIsGenuine`).
- **A destinations list could name its own attestors,** and an entry attested for another Crowdlock was accepted. The attestors are now the ones the Crowdlock's file names, and every entry must carry its fingerprint.
- **The relay inbox never sent a completed payment.** It asked the explorer a question that is answered "yes" for any payment, and marked every one sent. It also took unsigned records: five were enough to shut a member out of a proposal, and a fake completion posted first blocked the real one. It now sends, and checks the owner's signature on a commitment and both signatures on a completion.
- **The website's lock planner used the oldest co-signer key,** not the newest. **Its Commit page believed any "declared dead" notice.** **Its "Check it" button did nothing.** All fixed in The Kop Fund's repository.
- **The app's Take it home needed the Crowdlock's website.** A lock's terms are now kept on the phone, and a lock can be taken home from them when the Crowdlock cannot be loaded.
- **The anchor checker called any proof that named a block finished.** It now checks the block.
- **A commitment's fee was sized for a smaller payment** than the one sent, and came out about a tenth under the rate asked for.
- **An early release could be hidden from the co-signer's record.** The record looked only at a spend's first output, so 330 sats to a listed destination and the rest to the member's own wallet read as a purchase; and it read only the newest page of a lock's history, so 25 small payments to the lock's address pushed an older release out of sight. Now every output must be a listed destination, money staying in a lock of the same owner, or an `OP_RETURN` holding nothing, and the whole history is read (or the record says it couldn't be).
- **A destination's waiting period counted from a date written in the file** (`firstSeen`), which whoever could write the file could backdate. It now counts from the block of a stamp payment carrying the entry and its attestations (`spec/destinations-format.md`, "The waiting period").

## What the second review found, and what changed (17 November 2026, later)

Each was reproduced first, and each fix has a test that fails on the old code.

- **The early-release record could still be dodged four ways.** A spend whose branch selector was the byte `00` (valid in a block, though not relayed) was not read as co-signed; a spend paying everything as fee had nothing to flag; any `add` line in `destinations.json`, attested or not, made a payment read as a purchase; and money could hop to the same owner's lock under a second co-signer key, which nobody watched. Now every spend before a lock's date counts as co-signed whatever its witness, the fee may be no more than a commitment's, a destination counts only if attested, stamped and past its wait at the time of the payment, and money "stays locked" only in the same lock or a lock on the register.
- **A proposal's total counted money that wasn't committed:** coins that hadn't confirmed, and locks that open before the proposal finishes settling. Both are refused by every checker, the inbox and the spec now, and the co-signer's screen adds the total up again before completing anything.
- **A stranger could still use up a member's five places,** with copies of the member's own commitment carrying junk in the co-signer's place, and **could block a completion** with a copy written so the network won't take it. Commitments must leave the co-signer's place empty; copies are told apart by transaction id; payments are kept and sent in their standard encoding.
- **The app believed the register about which locks are yours.** A record labelled with your address showed as your money, and your own lock with another date couldn't be taken home. Only a genuine lock of your own key counts now, in the app and on the website.
- **The phone didn't notice the destination rules changing.** It now remembers the attestors, their number, the waiting period and the destinations list, and pauses committing and co-signing when any of them changes, or the list gets shorter or is rewritten.
- **The real-bitcoin build could be signed from any branch,** in the same job as every npm and Gradle library. Signing is now a separate job running only Android's own tools, in a protected environment, and the certificate must match the one committed in `app/signing-certificate.sha256`.
- **A large enough flood on the relays hid older records for good.** Each pass now carries on from where the last stopped.

## What OpenAI's second review found, and what changed (17 November 2026, evening)

Read against the same commits as the review above; four of its findings were already fixed by it. The other five, each reproduced and each with a test that fails on the old code:

- **The record judged "early" by the spending block's own timestamp,** which its miner chooses, not by the network's clock (the median time of the blocks before). A co-signed early exit in a block stamped just after the date was hidden. It now reads the network's clock for those blocks, and a lock whose clock can't be read is "not checked", never clean.
- **More than one relay page of records in the same second** hid the rest of that second, and the read said it had finished. It now says it hasn't, and the inbox's log says why.
- **A commitment could be backdated into a closed proposal** by its poster. One the repository first sees more than an hour after closing is refused, and readers stop counting commitments that are only on the relays.
- **The committed-member count believed the register's member list.** A member counts only if their signature verifies.
- **A genuine "declared dead" notice was taken while a proposal was still gathering,** and then stopped completions being recorded. It is taken only after closing; a completion after it is recorded as a breach; and one against a pile that met its target is shown as contradicted.

## What OpenAI's follow-up found, and what changed (17 November 2026, night)

Each reproduced on the code then on `main`, each with a test that fails on the old code:

- **A paid total could be inflated by anyone.** Once a commitment was paid, the app skipped the owner's signature on copies of it, and counted each copy as paid again: one 5,000-sat payment showed as 15,000. The signature is now checked whatever state the coin is in, and a payment counts once per transaction id, in the app and on the website.
- **The anchor checker believed the first explorer to answer.** It now asks every explorer, and calls a proof finished only when at least two answer and all agree.
- **The 200-question limit per proposal was 200 per check, so 400.** One budget is now shared by both checks.
- **A destination address in capitals was a second destination** that no payment could match. Bech32 addresses are now kept and compared in their one spelling.
- **The phone could fail to keep a website-made lock's terms without saying so.** It now reads them back and warns on Home when it couldn't.

## What the security loop found, and what changed (17 November 2026, round 1)

A fresh AI reviewer read both repositories at commit `c4eda44`. Each finding was reproduced first, and each fix has a test that fails on the old code.

- **A stranger could make a proposal read "The target is met" with money they could take straight back.** A lock dated by a block height was never compared with the proposal's settling date, on any network. A "lock" dated by a height already passed, which its owner can open alone, counted toward the target in the app and on the website; the co-signer's button went live, and completing would have paid members' money to the seller for a purchase that was never funded. A height-dated lock is now refused on every network but a private test chain, by all three commitment checkers, by the inbox, and by `lockIsGenuine` (so it is not counted in a register's total either).
- **A stranger could shut a member out of a proposal by re-posting the member's own commitment.** The owner's signature covers the payment, not the lock terms and remainder lock written beside it, nor the time on the post. Three ways worked: a copy naming another remainder lock was taken in the real one's place, and every reader then refused it; a copy with its lock's terms changed was refused, and the inbox then passed over the real one, because it remembered the refusal by the payment alone; and an exact copy dated before the proposal opened did the same. The inbox now checks the remainder lock, keeps only the parts a commitment has, and remembers a refusal by the whole record and never by the time on a post. The app and the website tell copies apart the same way.
- **An early release could be taken off the co-signer's record by editing the register.** The record was read for the locks the register lists, and the register is a file the founder, who is the co-signer, can write. Deleting a lock's record, or changing one digit of its date, took its early release off the record. The app and the register page now remember the terms of every lock they have seen, go on checking them, and say when one has gone from the register. (Somebody looking for the first time has nothing to remember: see the limits.)
- **Any Crowdlock could show another's locked bitcoin as its own** by naming its co-signer key or its declaration, and ranked level with it in Find. Find now marks such a Crowdlock as a copy and shows none of the money, when the other is one the app ships with or the person already has; where neither is, both carry a warning. (The root of it is not fixed: see the limits.)
- **The test build ran every library it installed with a token that could write to the repository,** and so could have replaced the real-bitcoin release with another app. It is now two jobs, like the real build: the one that runs libraries can only read. The inbox installs its libraries without running their install scripts.
- **Junk on the relays could stop a phone reading a pile.** Every posted commitment cost the phone questions to the block explorer before anything was checked. A reader now looks only at commitments from real locks on the register, a few per lock.
- **Smaller things.** The two lock-script builders now agree, or both refuse, for every locktime (they differed for 1 to 16 and from 2^32 up, and one accepted nought); and nothing posted to the relays can start a line of its own in the inbox's log.

## What the security loop found, and what changed (17 November 2026, round 2)

A second fresh AI reviewer read both repositories after round 1's fixes. Both findings were reproduced first, and each fix has a test that fails on the old code.

- **A payment that never left a lock was counted as paid.** A payment's id leaves out its signatures. Someone could pay the seller from an ordinary wallet, with the proposal's marker on the payment, and post a "commitment" written around the same payment that claimed to spend their lock. The app and the website read the spent coin's value from the chain without asking whether that coin was ever the lock's, found the payment in a block, and counted it as paid. A seller paying themselves could make a proposal read "funded and paid", and the co-signer's own re-check, which starts from the paid total, agreed and would have completed members' real commitments. A commitment now counts as paid only if the coin it spent was a coin of its own lock (`checkCommitment`, `commitmentPaid` in `app/src/wallet/core.mjs`).
- **A stranger could still shut a member out with a one-byte copy.** The owner's signature does not cover the input's own script (scriptSig). A copy of a member's commitment with one byte there has another transaction id, still carries the owner's signature, passed every checker, and can never be paid. Posted first, it took the coin's place in the pile and the member's real commitment was refused; it also counted toward the target. Every checker, the inbox and the co-signer's completion now refuse a commitment whose input carries a script.

## What the security loop found, and what changed (17 November 2026, round 3)

A third fresh AI reviewer read both repositories after round 2's fixes. Each was reproduced first, and each fix has a test that fails on the old code.

- **Round 1's memory of locks could be flushed.** A reader kept the terms of the newest 500 locks. Once 500 newer records were on a register, an older lock fell out of memory while still listed, and could then be removed unseen. A reader now also keeps a count and a running fingerprint of every lock it has seen, in order: any earlier record removed or changed shows as "the register has been rewritten", and the record is not called clean, however long the register is.
- **501 tiny coins sent to a lock's address made the lock unreadable.** Public explorers refuse to list the coins at an address holding more than 500. The owner could not see the lock or take it home in the app, the Crowdlock's total could not be worked out, a pile holding the lock's commitment could not be read by anyone, and the inbox could never take a commitment from it. The app and the inbox now work the coins out from the address's history when the explorer refuses.
- **Tiny coins also made the app refuse to send, lock or take a lock home,** or build a payment too large for the network, because it spent every coin at an address at once. Coins that cost more to spend than they hold are now left where they are, and one payment spends at most 200 coins.
- **The co-signer's screen counted commitments it could not complete.** With two co-signer keys listed, commitments under the other key counted toward the target, were skipped at signing, and the rest were completed and sent: members' money to a purchase that stayed short. Only what the typed words can complete is now added up, before anything is signed. A lock naming the mirror image of a co-signer key no longer counts as the Crowdlock's at all.
- **A lock could be emptied before its date as fees, a slice at a time,** each slice going "back into the same lock" and each fee within the limit, and none showed. A purchase's fee is now limited by what it pays its destination, as a commitment's is, and the fees of moves that pay no destination are added together.
- **A proposal's target, and the fee limit, could be changed by whoever writes the files, unseen.** The phone now remembers both. A target cut to under half of the highest it has seen, or a changed fee limit, pauses committing and co-signing until the person has looked. (This is a tripwire, not a rule: see the limits.)
- **"Commit more" offered a coin already committed** to the same proposal; the second commitment was signed, posted, shown as committed, and never counted. Such coins are no longer offered.
- **The co-signer's screen said "published" when no relay had taken a completed payment.** It now says so.

## Limits we already know about

- **A proposal's target is one number in a file.** It is outside the proposal's hash on purpose, because it moves with the price. A phone that has seen the proposal notices a target cut to under half. A phone that has not, or a smaller cut, does not. Nothing checks a target against the price it states. A rule for who may restate a target, and by how much, would close this.
- **A Crowdlock's file sets its own fee limit** (`max_commitment_fee`), with no upper bound. A file that sets it near 100% lets a commitment, or a co-signed early move, leave almost everything as fee. A phone that saw the earlier figure notices the change; a new reader does not.
- **A lock naming an older co-signer key can still be added to the register.** The file keeps older keys listed so their locks go on counting, and the register cannot tell a lock made before a key was replaced from one made after.
- **An address with more than 1,000 payments in its history cannot be read in full.** The app reads 40 pages. Beyond that a lock's coins cannot be listed when the explorer also refuses its coin list.
- **Tiny coins left at an address stay there.** The app leaves out coins that cost more to spend than they hold. Sending part of a balance at a very low fee rate can still be refused when hundreds of small coins are present; sending all of it, or a higher fee rate, works.
- **A lock dated from 19 January 2038 cannot be taken home by the app.** Its key module cannot build one. The register refuses a lock longer than the Crowdlock offers, so none can be made today; a five-year lock would reach that date from late 2032.
- **The website's Commit page still offers a coin already committed** to the same proposal. The inbox refuses the second commitment.

- **The early-release record covers the locks a reader has seen.** The app and the register page remember every lock they have seen on a register, so one taken off it later is still checked. Somebody opening a Crowdlock for the first time sees only what the register lists that day. A lock released early and removed before they ever looked is not on their record. The register's git history and its weekly anchored snapshots hold the evidence, but nothing reads them automatically. An append-only register, like the destinations list, would close this.
- **Nothing ties a co-signer key to one Crowdlock.** A second Crowdlock's file can name the same key, and the same locks then count for both. Find marks the copy when it already knows the real one; opened by a link, a copy shows the real one's total with no warning. The co-signer key signing the Crowdlock's own fingerprint would close this.
- **The real-bitcoin release can be replaced by anyone who can write to the repository.** The signing key is protected; the place the app is downloaded from is an ordinary release that any write token can delete and re-create with another file. A phone that already has the genuine app refuses such a file as an update; a new install does not. Protecting the tag, or making releases unchangeable, is a GitHub setting and has not been checked.
- **A lock can be as short as its owner likes.** The register refuses a lock longer than the Crowdlock offers, not one shorter. A ten-minute lock counts in the locked total for ten minutes. A member can also register any number of small locks, and every reader then asks the block explorer about each.
- **The relay inbox's own job holds a token that can write to its repository** while it runs code from npm and reads what strangers post. It installs no library scripts, but a compromised library could still use the token.

- **One block explorer is believed at a time.** The register adds a lock when the explorer its Crowdlock's file names (`chain_api`) reports confirmed coins at the lock's address, so a lying explorer could make a lock count without the money being there. The app is in a better place than it was: it reads the chain for every Crowdlock from its own explorer for the network, never the one the Crowdlock names, and before signing anything it checks each coin's amount against the transaction the coin came from. Its backup explorer is only asked when the first is silent or broken. Nothing anywhere compares two explorers, or asks a node.
- **The co-signer is trusted not to complete a commitment early.** A dishonest co-signer can complete a commitment from a proposal that was never funded, while the coin is still unspent. The money can only go where the owner already signed for it to go, to a destination on the published list. It cannot go anywhere else, and the co-signer cannot move a coin alone.
- **The co-signer can let a member out early.** Owner and co-signer together can spend a lock at any time, to anywhere. Bitcoin does not stop it; the chain records it, and `method/js/release.mjs` reads that record.
- **Today the co-signer is one key held by the founder.** Two of three is the direction once there is a second person.
- **Every lock's public keys are published.** The register lists each lock's owner key and co-signer key so that anyone can rebuild its address. A lock therefore has none of the protection a hidden key gives: if quantum computers one day work a private key out from a public one, these locks are exposed sooner than most. Locks renew within five years, which is the route to a safer address type once Bitcoin has one. Nobody has planned that move.
- **A destination's stamp proves it existed, not that anyone saw it.** The waiting period counts from the block of the destination's stamp, which nobody can backdate. But someone holding a stolen attestor key and write access to the repository could stamp an entry without publishing it, wait out the period, then publish the entry and a proposal together. They can no longer do it in an afternoon; they must hold the stolen keys unnoticed for the whole period. Two or more attestors would raise the bar further.
- **A lock's date is worked out from the clock of the phone or computer that makes it.**
- **No test checks a specification against the code it describes.**
- **The real-bitcoin app is built from whatever the libraries produce.** Signing is kept apart from them, but a compromised npm or Gradle library could still change the app before it is signed.
- **The relay inbox remembers how far back it has read only for one run** (about 48 minutes, 24 passes). A flood larger than one run can read still delays records until it ends.
- **A payment the inbox sent is not checked again.** One dropped from the network's waiting list is not sent a second time.
- **A commitment posted within an hour after its proposal closes can still be dated into the window.** Nostr carries no time but the poster's; the inbox allows an hour for itself being briefly down.
- **Records beyond a relay's batch size in one second can't be read from that relay.** The read says so rather than claiming it finished; posting by pull request still works.
- **Reorganisations are not followed** when the record reads the network's clock.
- **A destination's age can be up to about an hour short,** because a block's time can be set behind the real time.

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
