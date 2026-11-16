# Crowdlock — the method, and the app

This repository holds the **method** (rules, reference code and tests) and the **Crowdlock app**. **The Kop Fund no longer lives here**: since 8 November 2026 it has its own repository, https://github.com/Jimbus9/the-kop-fund (site https://thekopfund.org/), so that its maintainers can be given access to the fund alone.

1. **Crowdlock** — the method. A set of published rules for a fund that nobody pools money into: fans lock their own bitcoin, and a purchase is funded by each fan signing their own locked money into it. Anyone can copy it.
2. **The Crowdlock app** — a phone wallet that follows the method. It works with any Crowdlock, and any founder can start one.
3. **A test Crowdlock** on testnet4, kept here for testing the app and the method.

If you are new, read `spec/running-your-own.md` (what the method is), and for the fund itself `spec/declaration-v1.txt`.

## 1. Crowdlock (the method)

General to any Crowdlock. Nothing in these files names Liverpool.

| What | Where |
| --- | --- |
| The six general documents: membership record, counting rule, lock, proposal and settlement, commitment, destinations | `spec/` (all files except `declaration-v1.txt` and `index.html`) |
| How to run your own Crowdlock, and how to make a co-signer key | `spec/running-your-own.md` |
| Checking a membership signature, and reading a Crowdlock's file | `method/js/verify.mjs`, `method/js/crowdlock.mjs` |
| Accepting a registration or a lock, and deciding whether it counts | `method/js/append.mjs`, `method/js/lockrecord.mjs`, `method/js/inbox.mjs`, `method/js/relayhealth.mjs` |
| The lock script, commitments and taproot (taproot is built but not in use) | `method/lock/` |
| Making a co-signer key, offline | `method/cosigner/` |
| Anchoring the declaration in Bitcoin | `method/anchor/` |
| The relay inbox: collecting records from Nostr relays | `method/relay/` (copied into every founder's repository as `relay/`) |
| The licence: code MIT, documents CC BY 4.0 | `LICENSE`, `spec/LICENSE` |

## 2. The test Crowdlock and the tests' copy of The Kop Fund

| What | Where |
| --- | --- |
| The test Crowdlock on testnet4, with its own throwaway declaration | `crowdlocks/kop-fund-testnet4.json`, `crowdlocks/test/` (listed in `crowdlocks/index.json`) |
| The relay inbox that serves it, run by GitHub | `.github/workflows/relay-inbox.yml` |
| The relay inbox's own state | `method/relay/health.json`, `method/relay/announced.json`, `method/relay/VERSION` |
| A **frozen** copy of The Kop Fund's Crowdlock file, register, destinations and declaration, used by the tests as a real mainnet Crowdlock. Not the live register | `method/fixtures/the-kop-fund/` |
| The declaration The Kop Fund's members sign, with its Bitcoin timestamp | `spec/declaration-v1.txt`, `spec/declaration-v1.txt.ots` |

The live fund — its Crowdlock file, register, pages, anchoring and maintainers — is in https://github.com/Jimbus9/the-kop-fund.

## 4. The Crowdlock app

Everything under `app/`. One codebase builds two Android apps that install side by side and never share a wallet:

| App | Money | Built by |
| --- | --- | --- |
| **Crowdlock** (green icon) | Real bitcoin | `.github/workflows/app-mainnet.yml`, run by hand |
| **Crowdlock Test** (yellow icon) | Test bitcoin (testnet4) | `.github/workflows/app.yml`, on every change under `app/` |

Each app lists, opens and starts only Crowdlocks on its own network. Which one a build is comes from `EXPO_PUBLIC_NETWORK` (`mainnet`, or anything else for the test app); `app/app.config.js` sets the name, icon and package from it.

| What | Where |
| --- | --- |
| Every screen, and moving between them | `app/App.tsx` |
| The look: colours, type and sizes; buttons, cards, warnings and the bars | `app/src/ui/theme.ts`, `app/src/ui/parts.tsx` |
| Wallet and keys: words, addresses, locks, payments, commitments. **The only code that touches keys or builds a payment** | `app/src/wallet/core.mjs` |
| Reading the chain and sending payments, through a block explorer and its backup | `app/src/wallet/esplora.mjs` |
| Talking to a Ledger (an adapter that carries messages; it never sees a key) | `app/src/ledgerLink.mjs`, `app/src/ledgerDevice.ts`, `app/plugins/` |
| Loading and checking a Crowdlock, counting its total, joining, sharing | `app/src/crowdlocks.mjs` |
| Which of the six steps Home offers next | `app/src/nextStep.mjs` |
| Finding Crowdlocks and posting records, through public relays | `app/src/relays.mjs` |
| Starting a Crowdlock and looking after one, in the founder's own GitHub account | `app/src/start.mjs`, `app/src/github.mjs` |
| What the phone keeps (in the system keystore), and refiling it when a Crowdlock's address moves | `app/src/storage.ts`, `app/src/moves.mjs` |
| Which money this build uses and where it reads the chain | `app/src/config.ts` |
| This build's own settings: the Crowdlocks it starts with, addresses that have moved | `app/src/build.mjs` (the one file that differs between builds) |
| "Check the connection" | `app/src/connection.mjs` |
| The inbox copied into every new Crowdlock, packed by a script | `app/template/`, `app/src/template.mjs` (generated; `app/scripts/make-template.mjs`) |
| Tests, including a private test chain and a pretend Ledger | `app/test-chain/` |

## Where things moved (2 November 2026 regroup)

The code moved under `method/` so the layers are visible from the top.

| Old path | New path | Public URL changed? |
| --- | --- | --- |
| `js/` | `method/js/` | Yes: `.../crowdlock/js/...` is now `.../crowdlock/method/js/...` |
| `lock/` | `method/lock/` | Yes (and still not published by Pages) |
| `cosigner/` | `method/cosigner/` | Yes |
| `anchor/` | `method/anchor/` | Yes |
| `relay/` | `method/relay/` | Yes (and still not published by Pages) |

Not moved, so their URLs did not change: `crowdlocks/`, `spec/`, and the founder template's own paths (`relay/`, `js/` in a founder's repository are unchanged).

What might be broken from the move, and where to look:

- Any tool or bookmark that uses an old `js/`, `lock/`, `relay/`, `cosigner/` or `anchor/` path in this repository. Use the table above.
- Founders' repositories keep the old layout. The app's version and inbox checks try both `relay/` and `method/relay/`, so both kinds of site are recognised.
- The template is versioned `2026-11-02b` (the inbox code moved). Crowdlocks on the older version show "behind" in the app until they update.

## Running the checks

**The list of checks that must pass is `.github/workflows/checks.yml`.** It runs on every push; read it rather than a copy of it, because this section can fall behind.

To run them yourself, install each part's dependencies first with `npm ci` in that folder. A fresh clone has none installed, and a suite that fails with missing modules is not a real failure.

| Folder needing `npm ci` | Then run |
| --- | --- |
| `method/lock/` (first: other tests use its libraries) | `node selftest.mjs && node taproot.test.mjs && node commitment.test.mjs` |
| the repository root | `for t in method/js/*.test.mjs; do node "$t" || break; done` |
| `method/cosigner/` | `node cosigner.test.mjs` |
| `method/relay/` | `npm test` |
| `method/anchor/` | `node anchor.test.mjs` |
| `app/`, then `app/test-chain/` (use `npm ci --ignore-scripts` there) | in `app/test-chain/`: `npm test`; in `app/`: `npx tsc --noEmit -p .` |

The tests do not bundle the app. After moving or renaming any app file, also run `npx expo export --platform android --output-dir <a folder outside the repository>` in `app/`.

**Two things that turn the checks red when you change shared code:**

- The real fund's repository (`Jimbus9/the-kop-fund`) carries a copy of some of this code. `node method/check-kop-fund-copy.mjs <path to a clone of that repository>` compares the copies byte for byte and names any that differ. Carry the same change across by hand, or put new logic in a new file instead.
- The same files are packed into the app's founder template. After changing one, run `node app/scripts/make-template.mjs`, raise `TEMPLATE_VERSION` and add a line to `CHANGES`.

The method's tests read a frozen copy of the real fund at `method/fixtures/the-kop-fund/`, never its live files. Do not update the copy when the real register changes.

## Rules for changes

- Shared code and the six general documents must not name The Kop Fund, except as an example marked as one.
- Nobody but The Kop Fund's maintainers gets write access to https://github.com/Jimbus9/the-kop-fund, and nobody from it gets access to this repository.
- Values for one Crowdlock go in its own file, not in code.
- The declaration can never change. A change would be a new version.
