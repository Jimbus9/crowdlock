// This build's own settings: the one file that differs between builds of the
// Crowdlock app. Everything else in the app is the Crowdlock method and is the
// same for every build.
//
// This is The Kop Fund's build.

/** The Crowdlocks this build starts with. Anything else, the fan adds. */
export const STARTING_LIST = [
  "https://thekopfund.org/crowdlocks/kop-fund.json",
  "https://crowdlock.org/crowdlocks/kop-fund-testnet4.json",
];

/**
 * Addresses that have moved, old → new. On every start the app refiles what
 * the phone saved under an old address (lock terms, co-signer keys seen) to
 * the new one; see ./moves.mjs. Never remove a line: a phone that skipped
 * every update in between still needs it.
 */
export const MOVED_ADDRESSES = [
  // 13 November 2026: the method repository was renamed from fanfund.
  ["https://jimbus9.github.io/fanfund/", "https://jimbus9.github.io/crowdlock/"],
  // 13 November 2026: The Kop Fund moved to its own domain.
  ["https://jimbus9.github.io/the-kop-fund/", "https://thekopfund.org/"],
  // 14 November 2026: the method's site moved to its own domain.
  ["https://jimbus9.github.io/crowdlock/", "https://crowdlock.org/"],
];

/**
 * Sites on a domain of their own, and the GitHub repository behind each. A
 * github.io address names its repository; a domain doesn't, and the app needs
 * the repository to show a file's history and to publish to it.
 */
export const OWN_DOMAINS = {
  "https://thekopfund.org/": { owner: "Jimbus9", repo: "the-kop-fund" },
  "https://crowdlock.org/": { owner: "Jimbus9", repo: "crowdlock" },
};

/** Where the app links the counting rule: the method's published spec. */
export const COUNTING_RULE_URL = "https://github.com/Jimbus9/crowdlock/blob/main/spec/counting-rule.md#the-minimum";

/**
 * Where the test app is downloaded from. The app for real bitcoin shows this
 * only to founders, maintainers and co-signers, for practising with test money.
 */
// Each test build is a release of its own (app.yml), so this lists the newest.
export const TEST_APP_URL = "https://github.com/Jimbus9/crowdlock/releases?q=app-test";
