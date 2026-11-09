// Two builds of the same app: the test app (testnet4, free coins) and the real
// one (mainnet). They get different package names so both can be installed on
// one phone and never share a wallet, and different names on the home screen.
const base = require("./app.json").expo;
const real = process.env.EXPO_PUBLIC_NETWORK === "mainnet";

module.exports = {
  expo: {
    ...base,
    name: real ? "Crowdlock (real bitcoin)" : base.name,
    android: { ...base.android, package: real ? `${base.android.package}.mainnet` : base.android.package },
  },
};
