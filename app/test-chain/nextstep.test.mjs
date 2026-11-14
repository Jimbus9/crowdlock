// The Home screen's "your next step" card: which of the six steps it offers.
import { nextStep } from "../src/nextStep.mjs";

let failed = 0;
const check = (what, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

const MIN = 200000n;
const cl = (over = {}) => ({ url: "https://x.example/crowdlocks/a.json", name: "A", member: true, canLock: true, minimum: MIN, locks: [], openProposal: null, committed: false, ...over });
const lock = (state, confirmed, locktime = 2000000000, arriving = 0n) => ({ state, confirmed, arriving, locktime });

let s = nextStep({ waiting: 0n, crowdlocks: [] });
check("No Crowdlock at all: step 1, find one", s.step === 1 && s.kind === "find");

s = nextStep({ waiting: 500000n, crowdlocks: [cl({ member: false }), cl({ member: false, url: "b", name: "B" })] });
check("Not joined anywhere: step 1, read the first Crowdlock, even with money waiting", s.step === 1 && s.kind === "understand" && s.name === "A");

s = nextStep({ waiting: 0n, crowdlocks: [cl()] });
check("Joined, nothing waiting: step 3, and it says how much is needed", s.step === 3 && s.kind === "getBitcoin" && s.need === MIN);

s = nextStep({ waiting: 150000n, crowdlocks: [cl()] });
check("Joined, under the minimum: still step 3, needing the difference", s.step === 3 && s.need === 50000n);

s = nextStep({ waiting: MIN, crowdlocks: [cl()] });
check("Joined, exactly the minimum waiting: step 4, lock", s.step === 4 && s.kind === "lock" && s.sats === MIN);

s = nextStep({ waiting: 900000n, crowdlocks: [cl({ canLock: false })] });
check("Enough waiting but the Crowdlock can't take a lock: sent to its page, not offered a lock", s.kind === "blocked");

s = nextStep({ waiting: 0n, crowdlocks: [cl({ locks: [lock("locked", 300000n, 1900000000), lock("locked", 300000n, 1800000000)] })] });
check("Locked, nothing else to do: rest, with the earliest date", s.kind === "rest" && s.step === 0 && s.opens === 1800000000);

s = nextStep({ waiting: 0n, crowdlocks: [cl({ locks: [lock("arriving", 0n, 1900000000, 250000n)] })] });
check("A lock still arriving counts as holding: rest, not 'get bitcoin'", s.kind === "rest");

s = nextStep({ waiting: 900000n, crowdlocks: [cl({ locks: [lock("locked", 300000n)] })] });
check("Locked, and more waiting: step 4 again", s.kind === "lock");

s = nextStep({ waiting: 0n, crowdlocks: [cl({ locks: [lock("locked", 300000n)], openProposal: { title: "Buy it" } })] });
check("A proposal is open and there is a lock to commit: step 5", s.step === 5 && s.kind === "commit" && s.title === "Buy it");

s = nextStep({ waiting: 0n, crowdlocks: [cl({ locks: [lock("locked", 300000n)], openProposal: { title: "Buy it" }, committed: true })] });
check("Already committed to it: not asked again", s.kind === "rest");

s = nextStep({ waiting: 0n, crowdlocks: [cl({ locks: [lock("lapsed", 300000n)], openProposal: { title: "Buy it" } })] });
check("A proposal is open but the only lock has passed its date: step 6, not step 5", s.step === 6 && s.kind === "takeHome");

s = nextStep({ waiting: 900000n, crowdlocks: [cl({ locks: [lock("lapsed", 300000n), lock("lapsed", 100000n), lock("locked", 500000n)], openProposal: { title: "P" } })] });
check("Taking home comes before committing and locking, and adds up every lock past its date", s.step === 6 && s.sats === 400000n);

s = nextStep({ waiting: 0n, crowdlocks: [cl({ locks: [lock("withdrawn", 0n), lock("empty", 0n)] })] });
check("Locks already taken home or never funded don't count: back to step 3", s.step === 3);

s = nextStep({ waiting: 0n, crowdlocks: [cl({ locks: [lock("locked", 300000n)] }), cl({ url: "b", name: "B", locks: [lock("lapsed", 300000n)] })] });
check("Several Crowdlocks: the most pressing step wins, and names its Crowdlock", s.step === 6 && s.name === "B");

s = nextStep({ waiting: 0n, crowdlocks: [cl({ member: false }), cl({ url: "b", name: "B" })] });
check("Joined one of two: the step is for the one joined", s.step === 3 && s.name === "B");

s = nextStep({ waiting: 900000n, crowdlocks: [cl(), cl({ url: "b", name: "B" })] });
check("Two joined Crowdlocks could both take the lock: Home names neither and offers the choice", s.kind === "lock" && !s.url && !s.name && s.options.length === 2 && s.options[1].name === "B");

s = nextStep({ waiting: 900000n, crowdlocks: [cl(), cl({ url: "b", name: "B", canLock: false })] });
check("Two joined, only one can take a lock: it is named, with no choice to make", s.kind === "lock" && s.name === "A" && !s.options);

s = nextStep({ waiting: 900000n, crowdlocks: [cl(), cl({ url: "b", name: "B", member: false })] });
check("One joined, one not: the lock is for the one joined", s.kind === "lock" && s.name === "A" && !s.options);

if (failed) { console.error(`\n${failed} check(s) failed.`); process.exit(1); }
console.log("\nHome offers the right step for where someone is.");
