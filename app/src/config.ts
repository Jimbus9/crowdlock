// Which money this build uses, and where it reads the chain.
//
// One codebase builds two apps: "Crowdlock" (real bitcoin) and "Crowdlock
// Test" (testnet4: free test money, the same rules). Each is labelled on every
// screen, and each only ever opens Crowdlocks on its own network.
// @ts-ignore — plain module shared with the chain tests
import { esploraChain, EXPLORERS, BACKUP_EXPLORERS } from "./wallet/esplora.mjs";
// @ts-ignore — plain module
import { STARTING_LIST } from "./build.mjs";

// The real-bitcoin build sets EXPO_PUBLIC_NETWORK=mainnet when it is built (see
// .github/workflows/app-mainnet.yml); every other build is the test app.
export const NETWORK: "testnet4" | "mainnet" = process.env.EXPO_PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet4";
export const IS_TEST_MONEY = NETWORK !== "mainnet";
// Test coins are free, and testnet4's blocks are bursty: at 1 sat/vB a send can
// wait hours. Real bitcoin follows the network's own estimate.
// A second explorer to fall back on when the first doesn't answer: real
// bitcoin since 14 November 2026 (James), the test network since 16 November.
const BACKUP: string = BACKUP_EXPLORERS[EXPLORERS[NETWORK]] ?? "";
export const chain = esploraChain(EXPLORERS[NETWORK], undefined, undefined, { minFee: IS_TEST_MONEY ? 5 : 1, backup: BACKUP });
export const EXPLORER_WEB = NETWORK === "mainnet" ? "https://mempool.space" : "https://mempool.space/testnet4";
/** The backup explorer's website, where there is one, for the About page. */
export const EXPLORER_BACKUP_WEB: string | null = BACKUP ? BACKUP.replace(/\/api$/, "") : null;

// What "Check the connection" asks (see ./connection.mjs): the block
// explorer, its backup where there is one, and the site the first Crowdlock on
// the starting list is read from, which shows whether the phone is online at all.
const host = (url: string) => url.replace(/^https?:\/\//, "").split("/")[0];
export const CONNECTION_TARGETS: { name: string; url: string; explorer?: boolean }[] = [
  { name: host(EXPLORERS[NETWORK]), url: `${EXPLORERS[NETWORK]}/blocks/tip/height`, explorer: true },
  ...(BACKUP ? [{ name: host(BACKUP), url: `${BACKUP}/blocks/tip/height`, explorer: true }] : []),
  { name: host(STARTING_LIST[0]), url: STARTING_LIST[0] },
];
