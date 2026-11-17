// Talking to a Ledger, over Bluetooth or a USB cable, through Ledger's
// maintained Device Management Kit. Only this file knows about the phone's
// radios and ports: the key module asks for a connection through `useLedger`,
// and gets one here.
//
// A Ledger wallet is saved on the phone where backup words would be, as
// "ledger:" followed by what identifies it: how it was found (its id and
// whether by Bluetooth or cable), its name, and the account it gave (its key
// expression — public, no secret). The key itself never leaves the device.
import { PermissionsAndroid, Platform } from "react-native";
import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit";
import { RNBleTransportFactory, rnBleTransportIdentifier } from "@ledgerhq/device-transport-kit-react-native-ble";
import { RNHidTransportFactory, rnHidTransportIdentifier } from "@ledgerhq/device-transport-kit-react-native-hid";
import * as ledgerApi from "@bitcoinerlab/descriptors/ledger";
import * as bitcoinApi from "@ledgerhq/ledger-bitcoin";
import TransportBase from "@ledgerhq/hw-transport";
// @ts-ignore — plain modules shared with the tests
import { NETWORKS } from "./wallet/core.mjs";
// @ts-ignore
import { transportFor, findLedger, withTimeout } from "./ledgerLink.mjs";
import { loadLedgerStore, saveLedgerStore } from "./storage";

export const LEDGER_PREFIX = "ledger:";
export type LedgerWallet = { deviceId: string; name: string; keyExpression: string; via?: "bluetooth" | "cable" };
export type FoundLedger = { id: string; name: string; via: "bluetooth" | "cable"; device: any };

export const isLedgerWallet = (w: string) => typeof w === "string" && w.startsWith(LEDGER_PREFIX);
export const ledgerWalletText = (w: LedgerWallet) => LEDGER_PREFIX + JSON.stringify(w);
export const readLedgerWallet = (w: string): LedgerWallet => JSON.parse(w.slice(LEDGER_PREFIX.length));

/** The Ledger app a network needs: test money is signed by "Bitcoin Test". */
export const ledgerAppFor = (network: string) => (network === "mainnet" ? "Bitcoin" : "Bitcoin Test");
// Miniscript wallet policies arrived in the Ledger Bitcoin app 2.1.0.
const MIN_APP = "2.1.0";

// One kit for the app, with both ways in.
let kit: any = null;
function dmk() {
  kit ??= new DeviceManagementKitBuilder().addTransport(RNBleTransportFactory).addTransport(RNHidTransportFactory).build();
  return kit;
}
// Start the kit afresh next time: after a connection that never answered, its
// old state is not to be trusted.
function resetKit() {
  try { kit?.close?.(); } catch {}
  kit = null;
}
// Finding and opening the Ledger, including the time a person takes to tap
// Allow on the phone's USB prompt. Signing is not limited: it waits for the
// person to read and approve on the device.
const CONNECT_LIMIT_MS = 60000;
const viaOf = (d: any): "bluetooth" | "cable" => (d.transport === rnHidTransportIdentifier ? "cable" : "bluetooth");

/** Ask Android for Bluetooth. Android 12 and later name it; older ones file it under location. A cable needs neither. */
export async function askForBluetooth(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const P = PermissionsAndroid.PERMISSIONS as any;
  const wanted: string[] = Number(Platform.Version) >= 31
    ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT]
    : [P.ACCESS_FINE_LOCATION];
  const got = await PermissionsAndroid.requestMultiple(wanted as any);
  return wanted.every((p) => (got as any)[p] === PermissionsAndroid.RESULTS.GRANTED);
}

/** Look for Ledgers nearby or plugged in. Calls `found` for each; returns a function that stops looking. */
export function lookForLedgers(found: (d: FoundLedger) => void, failed: (e: Error, via: "bluetooth" | "cable") => void): () => void {
  // The kit's Bluetooth transport scans only through listenToAvailableDevices
  // (its startDiscovering is empty), and each way is listened to on its own so
  // a problem with one (Bluetooth off, not allowed) doesn't hide the other.
  const subs = [rnHidTransportIdentifier, rnBleTransportIdentifier].map((transport) =>
    dmk().listenToAvailableDevices({ transport }).subscribe({
      next: (list: any) => (Array.isArray(list) ? list : [list]).forEach((d: any) =>
        found({ id: d.id, name: d.name || d.deviceModel?.name || "Ledger", via: viaOf(d), device: d })),
      error: (e: any) => failed(new Error(plain(e)), transport === rnHidTransportIdentifier ? "cable" : "bluetooth"),
    }));
  return () => { for (const s of subs) { try { s.unsubscribe(); } catch {} } dmk().stopDiscovering().catch(() => {}); };
}

/**
 * Connect to this Ledger, check the right Bitcoin app is open and that it is
 * the same Ledger as before (its fingerprint), run fn, and disconnect.
 * Whatever the device approved (each lock's rules, once) is kept on the phone
 * so it is not asked twice. `device` is one just found; otherwise the saved
 * Ledger is looked for again.
 */
export async function withLedger<T>(w: { deviceId: string; device?: any }, network: string, fn: (session: any) => Promise<T>): Promise<T> {
  const store = await loadLedgerStore();
  let session: any;
  // Where it was when it stopped, so "timed out" can say which step stalled.
  let stage = "looking for the Ledger";
  try {
    session = await withTimeout((async () => {
      const device = w.device ?? await findLedger(dmk(), { deviceId: w.deviceId, usb: rnHidTransportIdentifier, ble: rnBleTransportIdentifier } as any);
      stage = `talking to the Ledger over ${(device as any)?.transport === rnBleTransportIdentifier ? "Bluetooth" : "the cable"} (checking its app and key)`;
      return ledgerApi.connect({
        driver: {
          transport: Promise.resolve({ default: transportFor(dmk(), TransportBase) }),
          bitcoinApi: Promise.resolve(bitcoinApi),
          device,
          app: { name: ledgerAppFor(network), minVersion: MIN_APP },
        } as any,
        network: (NETWORKS as any)[network].network,
        store,
      } as any);
    })(), CONNECT_LIMIT_MS, "timed out", resetKit);
  } catch (e: any) { throw new Error(plain(e, network) + (/timed out|timeout/i.test(String(e?.message ?? e)) ? ` (It stopped while ${stage}.${/Bluetooth/.test(stage) ? " If your phone is asking to pair with the Ledger, accept that first." : ""})` : "")); }
  try { return await fn(session); }
  catch (e: any) {
    const said = plain(e, network);
    // Say where it was, so a dropped link after connecting isn't mistaken for never finding the Ledger.
    throw new Error(/^Couldn't reach the Ledger/.test(said) ? `${said} (It had connected; the link was lost while the Ledger was being asked to sign.)` : said);
  }
  finally {
    await saveLedgerStore(store).catch(() => {});
    await session.close().catch(() => {});
  }
}

/**
 * What the Ledger's own code reported, for the small print under "Couldn't
 * reach the Ledger": that sentence covers several different faults, and this
 * is the only way to tell them apart from a screenshot. Wording only.
 */
function detail(e: any): string {
  const parts = [e?._tag, e?.name, e?.message, e?.originalError?._tag, e?.originalError?.message]
    .map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x && x !== "Error");
  const said = [...new Set(parts)].join(" · ").slice(0, 240);
  return said ? ` (What the Ledger connection reported: ${said})` : "";
}

/** Ledger, Bluetooth and cable errors, in words a fan can act on. */
export function plain(e: any, network = "testnet4"): string {
  const m = String(e?.message ?? e?._tag ?? e);
  const app = ledgerAppFor(network);
  if (/denied|rejected|0x6985|Condition of use/i.test(m)) return "You declined it on the Ledger, so nothing was signed.";
  if (/does not match store fingerprint/i.test(m)) return "That's a different Ledger from the one this wallet uses. Connect the original, or remove this wallet and set up the new one.";
  if (/Open the .* app|0x6e01|0x6d02|0x6511|0x6e00|CLA_NOT_SUPPORTED|app.*not open/i.test(m)) return `Open the ${app} app on your Ledger and try again.`;
  if (/upgrade/i.test(m)) return `Update the ${app} app on your Ledger (in Ledger Live), then try again.`;
  if (/locked|0x5515|0x6b0c|DeviceLocked/i.test(m)) return "Unlock your Ledger with its PIN and try again.";
  if (/PeerRemovedPairing|pairing.*removed|bond/i.test(m)) return "Your phone and Ledger have lost their Bluetooth pairing (this can happen after the Ledger restarts). In the phone's Settings → Bluetooth, forget the Ledger, then try again and accept the pairing code on both. Or plug the Ledger in with a USB cable.";
  if (/Permissions not granted|BlePermissionsNotGranted|Unauthorized/i.test(m)) return "Allow Crowdlock's Nearby devices permission in your phone's settings (Apps → Crowdlock → Permissions), then try again — or plug the Ledger in with a USB cable.";
  if (/BluetoothRequired|PoweredOff|bluetooth.*off|BleNotSupported/i.test(m)) return "Turn on Bluetooth and try again — or plug the Ledger in with a USB cable.";
  if (/Couldn't find your Ledger/i.test(m)) return m;
  if (/timeout|timed out|disconnected|Disconnected|not found|no device|NoAccessibleDevice|OpeningConnection/i.test(m)) return `Couldn't reach the Ledger. Keep it unlocked and close to the phone (or plugged in), then try again.${detail(e)}`;
  return m;
}

/** A Ledger account the key module can use, for the wallet saved on the phone. */
export function ledgerUser(w: LedgerWallet, network: string) {
  return (fn: (session: any) => Promise<any>) => withLedger({ deviceId: w.deviceId }, network, fn);
}
