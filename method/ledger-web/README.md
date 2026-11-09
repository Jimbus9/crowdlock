# Ledger on the Lock page

Builds `js/vendor/crowdlock-ledger-web.bundle.js` for the Kop Fund's Lock page, so a Ledger can
lock bitcoin and take a lock home from the browser (WebHID: Chrome, Edge, Brave on a computer).

It adds no key handling of its own. `entry.mjs` joins the app's key module
(`app/src/wallet/core.mjs`), the app's Ledger adapter (`app/src/ledgerLink.mjs`) and Ledger's
WebHID transport (`@ledgerhq/device-transport-kit-web-hid`, pinned), with the Device Management Kit
pinned to the app's version.

Rebuild after changing `core.mjs`, `ledgerLink.mjs`, `esplora.mjs` or `entry.mjs`:

    cd app && npm ci && cd ../method/ledger-web && npm ci
    node build.mjs ../../../the-kop-fund      # path to a clone of Jimbus9/the-kop-fund

Then commit the bundle and its `.sha256` in `the-kop-fund`. The bundle is a build product: the
source of record is this folder plus the two app files above.
