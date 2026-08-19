# Changelog

Semantic versioning. While the LUD-25 draft is unmerged, `0.x` minor bumps
may carry breaking changes; pin an exact version.

## 0.1.0 — unreleased

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
