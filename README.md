# Crowdlock — the method, and the app

This repository holds the **method** (rules, reference code and tests) and the **Crowdlock app**. **The Kop Fund no longer lives here**: since 8 November 2026 it has its own repository, https://github.com/Jimbus9/the-kop-fund (site https://jimbus9.github.io/the-kop-fund/), so that its maintainers can be given access to the fund alone.

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

Everything under `app/`, built by `.github/workflows/app.yml`.

| What | Where |
| --- | --- |
| The screens | `app/App.tsx` |
| Wallet and keys | `app/src/wallet/` |
| Loading, checking and joining Crowdlocks, finding and starting them | `app/src/crowdlocks.mjs`, `app/src/start.mjs`, `app/src/github.mjs`, `app/src/relays.mjs` |
| This build's own settings: the Crowdlocks it starts with | `app/src/build.mjs` (the one file that differs between builds) |
| The inbox copied into every new Crowdlock, packed by a script | `app/template/`, `app/src/template.mjs` (generated; `app/scripts/make-template.mjs`) |
| Tests against a private test chain | `app/test-chain/` |

## Where things moved (2 November 2026 regroup)

The code moved under `method/` so the layers are visible from the top.

| Old path | New path | Public URL changed? |
| --- | --- | --- |
| `js/` | `method/js/` | Yes: `.../fanfund/js/...` is now `.../fanfund/method/js/...` |
| `lock/` | `method/lock/` | Yes (and still not published by Pages) |
| `cosigner/` | `method/cosigner/` | Yes |
| `anchor/` | `method/anchor/` | Yes |
| `relay/` | `method/relay/` | Yes (and still not published by Pages) |

Not moved, so their URLs did not change: `crowdlocks/`, `spec/`, and the founder template's own paths (`relay/`, `js/` in a founder's repository are unchanged).

What might be broken from the move, and where to look:

- Any tool or bookmark that uses an old `js/`, `lock/`, `relay/`, `cosigner/` or `anchor/` path in this repository. Use the table above.
- Founders' repositories keep the old layout. The app's version and inbox checks try both `relay/` and `method/relay/`, so both kinds of site are recognised.
- The template is versioned `2026-11-02b` (the inbox code moved). Crowdlocks on the older version show "behind" in the app until they update.

## Tests

Each part has its own tests. Install a part's dependencies first, with `npm ci` in that folder.

- Method: `method/js/*.test.mjs`, `method/lock/*.test.mjs`, `method/cosigner/cosigner.test.mjs`, `method/anchor/anchor.test.mjs`, `method/relay/inbox.test.mjs`
- App: `app/test-chain/*.test.mjs`, and `node app/scripts/make-template.mjs --check`

## Rules for changes

- Shared code and the six general documents must not name The Kop Fund, except as an example marked as one.
- Nobody but The Kop Fund's maintainers gets write access to https://github.com/Jimbus9/the-kop-fund, and nobody from it gets access to this repository.
- Values for one Crowdlock go in its own file, not in code.
- The declaration can never change. A change would be a new version.
