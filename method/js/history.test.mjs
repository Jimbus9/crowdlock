import { shrinkage, historyProblems } from "./history.mjs";

let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log("FAIL", name); } };

const m1 = { n: 1, address: "tb1qa", signature: "s1", signed: "2026-11-01" };
const m2 = { n: 2, address: "tb1qb", signature: "s2", signed: "2026-11-02" };
const l1 = { address: "tb1qlock1", owner_pubkey: "02aa", cosigner_pubkey: "03bb", locktime: 1900000000, submitted: "2026-11-02" };
const l2 = { address: "tb1qlock2", owner_pubkey: "02cc", cosigner_pubkey: "03bb", locktime: 1900000000, submitted: "2026-11-03" };
const v1 = { members: [m1], locks: [l1] };

check("Adding a member and a lock at the end is growth", shrinkage(v1, { members: [m1, m2], locks: [l1, l2] }).length === 0);
check("A member signing a later version is growth",
  shrinkage(v1, { members: [{ ...m1, also_signed: [{ version: 2, signature: "x", signed: "2026-11-05" }] }], locks: [l1] }).length === 0);
check("Removing a lock is caught", shrinkage({ members: [m1], locks: [l1, l2] }, { members: [m1], locks: [l2] }).length > 0);
check("Changing a lock's date is caught", shrinkage(v1, { members: [m1], locks: [{ ...l1, locktime: 1900000001 }] }).length > 0);
check("Adding a lock anywhere but the end is caught", shrinkage(v1, { members: [m1], locks: [l2, l1] }).length > 0);
check("Removing a member is caught", shrinkage({ members: [m1, m2], locks: [] }, { members: [m2], locks: [] }).length > 0);
check("Changing a member's signature is caught", shrinkage(v1, { members: [{ ...m1, signature: "other" }], locks: [l1] }).length > 0);
check("A member signing a version in between, which moves a later signature along, is growth",
  shrinkage({ members: [{ ...m1, also_signed: [{ version: 3, signature: "c" }] }], locks: [] }, { members: [{ ...m1, also_signed: [{ version: 2, signature: "b" }, { version: 3, signature: "c" }] }], locks: [] }).length === 0);
check("Removing a later signature is caught",
  shrinkage({ members: [{ ...m1, also_signed: [{ version: 2 }] }], locks: [] }, { members: [m1], locks: [] }).length > 0);
check("A history that only grew has no problems", historyProblems([{ members: [], locks: [] }, v1, { members: [m1, m2], locks: [l1, l2] }]).length === 0);
check("A lock removed and then put back is still caught",
  historyProblems([{ members: [m1], locks: [l1, l2] }, { members: [m1], locks: [l1] }, { members: [m1], locks: [l1, l2] }]).length === 1);
check("An unreadable version is reported", historyProblems([v1, null, v1]).length === 1);

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("A register's history is checked for anything but growth.");
