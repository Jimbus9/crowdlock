# Security loop report

17 November 2026. Branch `security-loop` in both repositories. Nothing was merged.

## 1. In five lines

- **Four rounds were run, not five. The run hit its usage limit after round 4, so round 5 never started.**
- **The loop did not reach a clean round.** Round 4 still found two HIGH problems. They are fixed, but no fresh reviewer has looked since.
- Nothing known to be CRITICAL is left open in the code. Two things that could be critical need GitHub settings or a design choice (section 4).
- 21 findings at MEDIUM or above were reproduced. 16 are fixed, 3 are partly fixed, 2 need a design decision.
- Every fix has a test that fails on the old code. All 12 test steps pass on the final commits.

## 2. Each round

Every finding below was reproduced before it was touched. None was dropped.

### Round 1: crowdlock `cdf1f7e`, the-kop-fund `a4631d1`

| Finding | Severity | Result |
| --- | --- | --- |
| A lock dated by block height counted as committed money. A stranger could fake "target met". | CRITICAL | Fixed |
| A stranger could shut a member out of a proposal with an altered copy of their commitment. I found two more ways while reproducing it. | HIGH | Fixed, all three |
| An early release could be hidden by editing the register. | CRITICAL by the rubric | Fixed for readers who saw the lock before |
| A copy of a Crowdlock could show the real one's locked bitcoin. | HIGH | Partly: Find marks copies |
| The test build ran library code with a token that could replace the real-bitcoin release. | CRITICAL by the rubric | Token fixed. Workflow not run. |
| Junk on the relays could stop a phone reading a pile. | MEDIUM | Fixed |
| The register takes locks of any length and number. | MEDIUM | Not fixed: design |

Low, fixed: the two lock-script builders disagreed on edge cases; posted text could start its own line in the inbox log.

### Round 2: crowdlock `2ee252c`, the-kop-fund `709b781`

| Finding | Severity | Result |
| --- | --- | --- |
| A payment that never left a lock was counted as paid. A seller paying themselves made a proposal read "funded and paid". | HIGH | Fixed |
| One byte added to a copy of a commitment made it unpayable, and it blocked the member's real one. | HIGH | Fixed |

### Round 3: crowdlock `faf5b70`, the-kop-fund `2938060`

| Finding | Severity | Result |
| --- | --- | --- |
| My round 1 memory of locks held only 500, so an older lock could be removed unseen. | CRITICAL by the rubric | Fixed |
| 501 tiny coins sent to a lock's address made it unreadable. | HIGH | Fixed |
| A proposal's target could be cut by whoever writes the file. | HIGH | Partly: phone pauses on a cut to under half |
| The co-signer's screen counted commitments its key could not complete. | MEDIUM | Fixed |
| A lock could be drained as fees, a slice at a time, unseen. | MEDIUM | Fixed |
| Tiny coins made the app refuse to send or take a lock home. | MEDIUM | Fixed |
| "Commit more" offered a coin already committed. | MEDIUM | Fixed in the app, not the website |

### Round 4: crowdlock `d9b3d83`, the-kop-fund `04ee41c`

| Finding | Severity | Result |
| --- | --- | --- |
| Junk lock records could stop the inbox altogether. | HIGH | Fixed, with a limit left (section 4) |
| A payment sent but not yet in a block was forgotten. The seller could be paid twice the target. | HIGH | Fixed |
| When the network refused one payment, the co-signer's screen sent the rest. | MEDIUM | Partly: it now stops |
| Junk commitments used up the questions a completed payment needs. | MEDIUM | Fixed |
| The fund's pages wrote file text into the page as HTML. | MEDIUM | Fixed |

### Round 5

Not run.

## 3. Files changed

**crowdlock**

- `.github/workflows/app.yml`, `.github/workflows/relay-inbox.yml`
- `REVIEWING.md`, `SECURITY-LOOP-REPORT.md`
- `spec/commitment-format.md`, `counting-rule.md`, `lock-format.md`, `proposal-and-settlement.md`
- `method/js/crowdlock.mjs`, `inbox.mjs`, `lockrecord.mjs`, `proposals.mjs`, `release.mjs`
- `method/js/lockrecord.test.mjs`, `release.test.mjs`, `workflows.test.mjs` (new)
- `method/lock/commitment.mjs`, `lock.mjs`, `commitment.test.mjs`
- `method/relay/inbox.mjs`, `signed.mjs`, `inbox.test.mjs`
- `method/cosigner/cosigner.test.mjs`, `method/ledger-web/entry.mjs`
- `app/scripts/make-template.mjs`, `app/template/relay-inbox.yml`, `app/src/template.mjs`
- `app/src/crowdlocks.mjs`, `relays.mjs`, `storage.ts`, `wallet/core.mjs`, `wallet/esplora.mjs`
- `app/src/screens/crowdlock.tsx`, `proposals.tsx`
- `app/test-chain/crowdlocks.test.mjs`, `start.test.mjs`, `storage.test.mjs`, `wallet.test.mjs`

**the-kop-fund**

- `.github/workflows/relay-inbox.yml`
- `commit/index.html`, `join/index.html`, `register/index.html`
- `js/crowdlock.mjs`, `inbox.mjs`, `lockrecord.mjs`, `proposals.mjs`, `release.mjs`
- `js/vendor/crowdlock-ledger-web.bundle.js` and its `.sha256`
- `relay/inbox.mjs`, `signed.mjs`, `VERSION` (now `2026-11-17k`)
- `spec/lock-format.md`

## 4. Needs James

These are design decisions or GitHub settings. I did not make them.

1. **Protect the `app-mainnet` release.** Anyone who can write to the repository can still replace it with another file. This is a GitHub setting.
2. **Run the new test build once and watch it.** I split `app.yml` into two jobs but was not allowed to run it.
3. **Make the register append-only.** Someone opening a Crowdlock for the first time still cannot see a lock removed before they looked.
4. **Tie a co-signer key to one Crowdlock.** A copy opened by link still shows the real one's total.
5. **A rule for restating a proposal's target.** Today it is one number in a file.
6. **An upper bound on a Crowdlock's fee limit.**
7. **A minimum lock length, and a cap on locks per member.**
8. **Sign lock records.** Without that, a flood can delay one member's next lock.
9. **A margin between the end of settling and a lock's date,** or a fee check at settlement.
10. **Whether a new lock may name an older co-signer key.**
11. **Pin the signing job's actions by commit,** and review the app's GitHub sign-in scope.

## 5. What I was unsure about, and what I did not look at

- **The app's screens were only type-checked.** Nothing was run on a phone.
- **The website pages have no automated tests.** I loaded Join, Register and Commit locally against the live files, with no errors.
- **The 500-coin explorer limit** was confirmed by a reviewer's two read-only requests, not by me.
- **One existing app test is sensitive to timing on this PC.** It failed in one run of three with no change to the code it covers. I did not alter it.
- **Three test fixtures were changed, none weakened.** One used a height-dated lock, which is now refused. Two left a 2% fee, more than a real commitment may.
- **The fund's `spec/` folder was already out of step** with the method's in five files before I started. I carried across `lock-format.md` only.
- **Not looked at by any reviewer:** the Ledger device code, the taproot variant, the founder flows, the anchor scripts in depth, and GitHub's own settings.
- **Listed as known limits in `REVIEWING.md`, not fixed:** a signature re-posted as a second member; twenty junk commitments hiding a member's own from phones for a few minutes; five commitments per lock; locks dated from 2038.

## 6. Final test results

Run on crowdlock `d9b3d83` and the-kop-fund `04ee41c`.

| Step | Result |
| --- | --- |
| Lock: selftest, taproot, commitment | Pass |
| `method/js/*.test.mjs` | Pass |
| Declaration fingerprint | Pass |
| `method/relay/check.mjs` | Pass |
| Co-signer key script | Pass |
| Relay inbox | Pass |
| App suite on the private chain, and template up to date | Pass |
| App type check | Pass |
| `method/anchor/anchor.test.mjs` | Pass |
| `check-kop-fund-copy.mjs` | Pass |
| the-kop-fund `tests/publishable.test.mjs` | Pass |
| the-kop-fund `relay/check.mjs` | Pass |

## 7. Branches

- `Jimbus9/crowdlock`, branch `security-loop`
- `Jimbus9/the-kop-fund`, branch `security-loop`

The GitHub CLI is not installed, so no pull requests were opened.
