// Two builds of the same app: the one everybody uses (mainnet, real bitcoin)
// and the test app (testnet4, free coins) for founders and co-signers who want
// to practise. They get different package names so both can be installed on
// one phone and never share a wallet, and different names and icons on the
// home screen: the real one is plain "Crowdlock" in bottle green; the test one
// is "Crowdlock Test" on the yellow of its "TEST MONEY" banner.
const base = require("./app.json").expo;
const real = process.env.EXPO_PUBLIC_NETWORK === "mainnet";

module.exports = {
  expo: {
    ...base,
    name: real ? "Crowdlock" : "Crowdlock Test",
    icon: real ? base.icon : "./assets/test-icon.png",
    android: {
      ...base.android,
      package: real ? `${base.android.package}.mainnet` : base.android.package,
      adaptiveIcon: real ? base.android.adaptiveIcon : {
        backgroundColor: "#FFD84D",
        foregroundImage: "./assets/test-android-icon-foreground.png",
        backgroundImage: "./assets/test-android-icon-background.png",
        monochromeImage: base.android.adaptiveIcon.monochromeImage,
      },
    },
  },
};
