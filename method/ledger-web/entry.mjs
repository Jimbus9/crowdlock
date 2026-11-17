// The Lock, Commit and joining pages' Ledger support, as one browser bundle.
// (The joining page uses signStatementWith: the app's own Signed Message call.)
//
// WHAT THIS IS. A thin join between three things that already exist and are
// already proved on a real Nano X in the app: the app's key module
// (app/src/wallet/core.mjs — lock, take home, the Ledger account), the app's
// adapter from Ledger's Device Management Kit to the Bitcoin library
// (app/src/ledgerLink.mjs), and Ledger's own WebHID transport. It writes no key
// handling, signing or transaction building: every one of those is the app's
// library call, unchanged. What is new here is only how a browser finds the
// Ledger (the browser's own device chooser) and where the device's memory of
// approved locks is kept (this browser's localStorage, a public hash, no secret).
//
// The page never sees a key. The Ledger signs on the device, after showing the
// person what it is signing.

import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit";
import { webHidTransportFactory, webHidIdentifier } from "@ledgerhq/device-transport-kit-web-hid";
import * as ledgerApi from "@bitcoinerlab/descriptors/ledger";
import * as bitcoinApi from "@ledgerhq/ledger-bitcoin";
import TransportBase from "@ledgerhq/hw-transport";
import {
  NETWORKS, readLedgerAccount, ledgerAccountFrom, lockFor, buildLock, takeHome, lockState,
  xpubForKey, checkLedgerKey, buildCommitment, checkCommitment, commitmentPaid, commitmentPayment, commitmentTxid, signStatementWith,
} from "../../app/src/wallet/core.mjs";
import { esploraChain } from "../../app/src/wallet/esplora.mjs";
import { transportFor, withTimeout } from "../../app/src/ledgerLink.mjs";

const MIN_APP = "2.1.0";
const STORE_KEY = "crowdlock.ledgerstore.v1";
const CONNECT_LIMIT_MS = 60000;
const CHOOSE_LIMIT_MS = 120000;

export const ledgerAppFor = (network) => (network === "mainnet" ? "Bitcoin" : "Bitcoin Test");

export const supported = () => typeof navigator !== "undefined" && !!navigator.hid;

let kit = null;
function dmk() {
  kit ??= new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build();
  return kit;
}
function resetKit() {
  try { kit?.close?.(); } catch {}
  kit = null;
}

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}"); } catch { return {}; }
}
function saveStore(store) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store ?? {})); } catch {}
}

/** Ledger and browser errors, in words a person can act on. */
export function plain(e, network = "testnet4") {
  const m = String(e?.message ?? e?._tag ?? e);
  const app = ledgerAppFor(network);
  if (/denied|rejected|0x6985|Condition of use/i.test(m)) return "You declined it on the Ledger, so nothing was signed.";
  if (/does not match store fingerprint/i.test(m)) return "That is a different Ledger from the one first used in this browser.";
  if (/Open the .* app|0x6e01|0x6d02|0x6511|0x6e00|CLA_NOT_SUPPORTED|app.*not open/i.test(m)) return `Open the ${app} app on your Ledger and try again.`;
  if (/upgrade/i.test(m)) return `Update the ${app} app on your Ledger (in Ledger Live), then try again.`;
  if (/locked|0x5515|0x6b0c|DeviceLocked/i.test(m)) return "Unlock your Ledger with its PIN and try again.";
  if (/NotAllowed|SecurityError|No device selected|no device|NoAccessibleDevice|cancel/i.test(m)) return "No Ledger was chosen. Plug it in, unlock it, open the Bitcoin app, and choose it when the browser asks.";
  if (/busy|already|in use|claimInterface|Access denied/i.test(m)) return "Another program is using the Ledger. Close Ledger Live and any other wallet that is open, then try again.";
  if (/timeout|timed out|disconnected|not found/i.test(m)) return "Couldn't reach the Ledger. Keep it unlocked and plugged in, then try again.";
  return m;
}

/** Ask the browser to let the person choose a Ledger. Must be called from a click. */
function chooseLedger() {
  return new Promise((resolve, reject) => {
    let done = false;
    const sub = dmk().startDiscovering({ transport: webHidIdentifier }).subscribe({
      next: (device) => { if (done) return; done = true; setTimeout(() => { try { sub.unsubscribe(); } catch {} }, 0); resolve(device); },
      error: (e) => { if (done) return; done = true; reject(e instanceof Error ? e : new Error(String(e?.message ?? e?._tag ?? e))); },
    });
    setTimeout(() => { if (!done) { done = true; try { sub.unsubscribe(); } catch {} reject(new Error("timed out choosing a Ledger")); } }, CHOOSE_LIMIT_MS);
  });
}

/** Open a session with the chosen device, run fn, close. Policies the device approved are remembered. */
async function withSession(device, network, fn) {
  const store = loadStore();
  let session;
  try {
    session = await withTimeout(ledgerApi.connect({
      driver: {
        transport: Promise.resolve({ default: transportFor(dmk(), TransportBase) }),
        bitcoinApi: Promise.resolve(bitcoinApi),
        device,
        app: { name: ledgerAppFor(network), minVersion: MIN_APP },
      },
      network: NETWORKS[network].network,
      store,
    }), CONNECT_LIMIT_MS, "timed out", resetKit);
  } catch (e) { throw new Error(plain(e, network)); }
  try { return await fn(session); }
  catch (e) { throw new Error(plain(e, network)); }
  finally {
    saveStore(store);
    await session.close().catch(() => {});
  }
}

/**
 * Connect: choose a Ledger, read its account, and return an account the key
 * module can use. Must be called from a click (the browser insists).
 */
export async function connectLedger(network) {
  if (!supported()) throw new Error("This browser can't talk to a Ledger. Use Chrome, Edge or Brave on a computer.");
  try {
    const device = await chooseLedger();
    const keyExpression = await withSession(device, network, (session) => readLedgerAccount(session, network));
    const account = ledgerAccountFrom({
      keyExpression, network,
      useLedger: (fn) => withSession(device, network, fn),
    });
    return account;
  } catch (e) { throw new Error(plain(e, network)); }
}

export { lockFor, buildLock, takeHome, lockState, xpubForKey, checkLedgerKey, esploraChain, buildCommitment, checkCommitment, commitmentPaid, commitmentPayment, commitmentTxid, signStatementWith };
