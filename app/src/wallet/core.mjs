// The key module. The only part of the app that touches keys or money.
//
// THE RULE, with no exceptions: we never write key handling, signing or
// transaction building ourselves. Every one of those is a library call here:
//
//   backup words      @scure/bip39            generate and check 12 words
//   keys              BIP32 (via descriptors)  derive the key from the words
//   addresses         @bitcoinerlab/descriptors  wpkh(...) and addr(...)
//   transactions      descriptors' Psbt + Output  inputs, outputs, weights
//   signing           descriptors' signers     sign every input
//   finishing         descriptors' finalisers  (bitcoinjs's own, for waiting coins
//                                              spent beside a lock in relock)
//   signing a message @bitcoinerlab/secp256k1  signRecoverable, over the
//                                              register's own message hash
//
// What is ours is only the arithmetic around them (how much fee to leave) and
// the refusals that stop a transaction destroying somebody's money. This file
// should stay small enough to read in one sitting: it is the one part worth
// paying somebody outside the project to review.
//
// ONE KEY DOES EVERY JOB. The key derived here owns the waiting balance, signs
// the declaration, and will own the fan's locks. That is the project's settled
// design (spec/registration-format.md): the member's address is simply the
// address of this key, so there is nothing extra to register or back up.
//
// Nothing in here reads the network directly. Every blockchain question goes
// through a `chain` object handed in by the caller, so the same code runs
// against a public block explorer on the phone and a private test chain in the
// tests.
//
// The module is in five parts, by job; this file gathers them so the rest
// of the app imports from one place:
//
//   base.mjs         networks, coin selection, byte helpers
//   keys.mjs         words, accounts, co-signer keys, xpubs, signing, Ledger
//   sending.mjs      the waiting balance, an ordinary send, a stamp
//   locks.mjs        locks: making, dating, taking home, locking again
//   commitments.mjs  commitments: building, checking, completing, paid

export * from "./base.mjs";
export * from "./keys.mjs";
export * from "./sending.mjs";
export * from "./locks.mjs";
export * from "./commitments.mjs";
