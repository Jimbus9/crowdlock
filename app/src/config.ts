// Milestone 1 runs on testnet4: free test money, the same rules as the real
// network. It is labelled on every screen so nobody mistakes it for real
// bitcoin. Switching to mainnet is one line here, and happens only after the
// outside review at milestone 7.
// @ts-ignore — plain module shared with the chain tests
import { esploraChain, EXPLORERS } from "./wallet/esplora.mjs";

// The real-bitcoin build sets EXPO_PUBLIC_NETWORK=mainnet when it is built (see
// .github/workflows/app-mainnet.yml); every other build is the test app.
export const NETWORK: "testnet4" | "mainnet" = process.env.EXPO_PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet4";
export const IS_TEST_MONEY = NETWORK !== "mainnet";
// Test coins are free, and testnet4's blocks are bursty: at 1 sat/vB a send can
// wait hours. Real bitcoin follows the network's own estimate.
export const chain = esploraChain(EXPLORERS[NETWORK], undefined, undefined, { minFee: IS_TEST_MONEY ? 5 : 1 });
export const EXPLORER_WEB = NETWORK === "mainnet" ? "https://mempool.space" : "https://mempool.space/testnet4";
