# Changelog

Semantic versioning. While the LUD-25 draft is unmerged, `0.x` minor bumps
may carry breaking changes; pin an exact version.

## 0.2.0 - unreleased

### Deterministic note secrets and restore from a seed

- `deriveNoteRoot(seed)`, `deriveNoteSecret(root, host, index)` and
  `derivedSecretSource(root, host, start)` in `secrets.ts`, plus
  `restoreNotes(baseUrl, root, host, {gap, start}, opts)` in a new
  `restore.ts`. All additive; nothing existing changes shape.
- The scheme, in full, so this entry alone is enough to reimplement it:

  ```
  root = HMAC-SHA256(key = utf8("lnurlcash-note-v1"), msg = seed)
  k1_i = HMAC-SHA256(key = root,                      msg = utf8(host + ":" + index))
  ```

  `seed` is raw bytes of any length. A 64-byte BIP39 seed (12 words,
  English wordlist, no passphrase) is what wallets use in practice, but the
  kit is seed-format agnostic and depends on no wordlist. `host` is the
  mint host exactly as `serverOf` produces it: lowercase, port included
  where there is one, so `127.0.0.1:8899` and `mint.example` derive
  different secrets. `index` is decimal ASCII counting from 0, and the
  separator is a single colon. The HMAC output is 32 bytes, rendered
  lowercase hex, which is the size of a payment preimage and therefore
  indistinguishable from a randomly drawn `k1` on the wire. `hashK1`
  applies unchanged, so the mint only ever receives `sha256(k1)` and sees
  nothing different from before.

  Worked example. The BIP39 mnemonic `abandon abandon abandon abandon
  abandon abandon abandon abandon abandon abandon abandon about` with an
  empty passphrase gives the seed
  `5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4`.
  Its root is
  `948f8f49347549cf2726e8b53f673a4185379344d2d7ba8877d3ded45d34d127`, and
  index 0 at host `mint.example` is
  `1f6016c80339b45dfdd1b3877c1a97d74b063cad54c4ccb866be39ed25ee2ab0`.
- Why it is in the kit rather than in a wallet: because the derivation is
  written down once, the same words restore the same notes in a different
  wallet, and the Kotlin, Python and Go ports agree with this one. That
  cross-wallet portability is the point, and it is the reason the scheme
  ships with a conformance vector.
- Counters are the wallet's, one per mint host. `derivedSecretSource` is a
  `RandomSecret`, so it drops straight into
  `LnurlcashOptions.randomSecret` and rotate, split and merge draw derived
  secrets without knowing anything about derivation; `source.index()` reads
  back the next unused index afterwards. A rotate consumes one index, a
  split consumes two. Persist that counter in the SAME write that stages
  the new records, and do it BEFORE the hash goes on the wire: a crash
  between the bump and the request wastes an index, which costs nothing,
  while a crash the other way round re-derives a secret the mint has
  already seen and the second note minted at it collides with the first.
- `restoreNotes` walks indices from `start`, asking the mint what each
  derived secret is worth. A live note is recorded; a note the mint reports
  as spent still counts the index as used, since re-deriving it would mint
  a duplicate id; a note the mint reports as pending is recorded with a
  null amount for the caller to reconcile later; an unknown note counts
  towards the gap. The walk stops after `gap` consecutive unknowns,
  defaulting to 20, and `next` is one past the highest index the mint
  recognised. It reads only, so an interrupted restore has changed nothing.
  Any other failure is thrown rather than swallowed, because a short walk
  reported as a finished one would leave the wallet re-deriving live
  secrets.
- A restored note carries no signature and its `k1` has just been on the
  wire, so rotate each one straight after restoring. That closes the
  exposure and gets the signature in the same call.
- The seed is bearer material for every note the wallet will ever hold.
  Store it the way the notes are stored, and never log it.
- `classifyNoteError` now returns `PendingNoteError` for the exact reason
  string `pending`, which LUD-25 fixes verbatim. Previously only the
  mutating callback classified it, so an informational GET on a note with a
  melt in flight raised a bare `ServiceRejectedError` that callers had to
  re-parse. `PendingNoteError` extends `ServiceRejectedError`, so anything
  catching the parent is unaffected.

## 0.1.2 - 2026-08-21

- `mintFeeBand` and `withinMintFeeBand`. LUD-25 states the mint fee as
  `base_fee_msat` plus a ppm cut and says nothing about rounding, and the
  two live implementations read that differently: dni's lnurl-mint - the
  reference, and what every public mint on the awesome list except moneyer
  runs - ceilings the fee to a whole sat on purpose so the mint is "never
  short a sat", while moneyer withholds the msat-exact amount.
- So `applyMintFee` is right about exactly one of them, and a wallet
  comparing a credited note against it warns spuriously against the other.
  Measured on real sats: 40,000 msat at a 1000 + 1000 ppm mint credited
  38,000, not the 38,960 the formula gives.
- `mintFeeBand` returns the range - the formula is the most a holder can be
  credited, the sat-ceilinged fee the least - and `withinMintFeeBand` is
  what a caller should compare against. `applyMintFee` is unchanged and
  still means the formula; it is now documented as the generous edge rather
  than the answer.
- Nothing here decides which reading is correct. That is a question for
  lnurl/luds#301.

## 0.1.1 - 2026-08-20

- `fetchMintAddress` now populates `nodeCapacityMsat`. The wire field is
  `nodeCapacity`, and the response was spread through unmapped, so the typed
  field was always `undefined` - inherited from lnurl-wallet, where the same
  bug hides the mint's channel capacity in the UI. `nodeNumChannels` and
  `nodeNumPeers` were never affected: those names match the wire.
- The conformance vectors now come from the published
  `lnurlcash-conformance` package rather than a git ref, so the suite runs
  against a released, attested set of vectors. Test-only; nothing consumers
  install changes.

## 0.1.0 - 2026-08-20

First release. The protocol layer of
[lnurl-wallet](https://github.com/dni/lnurl-wallet) (MIT, dni), extracted as
a standalone library.

### Changes made on extraction

**No globals.** The wallet's `offlineMode()` global became an `offline`
option, and `fetch`, `timeoutMs` and `randomSecret` joined it. Nothing reads
ambient state, so a caller can be certain what a call will and will not do.
`createClient(options)` binds one set for callers who would otherwise thread
the same object everywhere.

**No DOM or storage assumptions.** Only `fetch`, `URL` and `crypto` are
required, all substitutable.

### Behavioural fixes

Both were found by the conformance vectors, and both exist in the source
this was extracted from.

**A reasonless service error is no longer reported as an unknown note.**
`{"status":"ERROR"}` with no `reason` had a friendly default substituted
before classification, and that default — "Unknown service error" — matched
the rule for "unknown note". A service that said nothing was therefore
reported as denying the note exists, and through `probeBurnedNote` that
reads as "the burn landed": a conclusion about somebody's money drawn from a
blank. The reason is now carried through exactly as sent, empty included.

**`grossUpForMintFee` returns the true minimum, and cannot be stalled.** It
estimated linearly then walked one msat at a time, bounded by a guard. At a
99.9999% fee the walk is around a million steps, so the guard tripped and
the answer came back non-minimal — and the fee is chosen by the service, so
that input is reachable on purpose. It is now a binary search, which is
exact and bounded for every fee.

**The proportional fee term no longer overflows.** `gross * ppm / 1_000_000`
exceeds 64-bit unsigned at realistic amounts — 21M BTC is 2.1e15 msat, times
999_999 ppm is about 2.1e21 — and exceeds a double's exact range too. It is
computed split. This changes nothing in TypeScript at ordinary amounts, and
matters a great deal to the ports.

### Additions

**A mutation naming no note is refused** before it reaches the network,
rather than sent as a callback with no `k1` for a service to interpret
generously.

**`mint@localhost:8000` resolves.** A Lightning Address needs a dot to be a
domain, so a bare local host was rejected even though the resolution below
it already handled the port and the cleartext scheme such a host needs. The
strict `isLightningAddress` is unchanged; only the resolvers are more
generous, and only for hosts that are already treated as insecure.
