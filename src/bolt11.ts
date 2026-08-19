// Only what a caller needs to bind a SERVICE's response to the payment it
// asked for. No full TLV decode: the amount lives in the human-readable
// part, and equality is a normalised string compare.

// A raw BOLT-11 invoice - a loose shape check, anchored to actual bolt11
// prefixes rather than a bare "ln", which a bech32 LNURL would also match.
export const isBolt11Invoice = (value: string): boolean =>
  /^ln(bc|tb|bcrt|tbs|sb)[0-9]*[munp]?1[a-z0-9]+$/.test(
    value.trim().toLowerCase()
  )

// bolt11 is bech32, so case-insensitive: invoice equality is a normalised
// string compare. Used to bind a verify response, or a melt proof, to the
// exact invoice it claims to report on - a settled result for some OTHER
// invoice must never confirm this payment.
export const sameInvoice = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

// per unit of the amount digits, relative to whole BTC (10^-3, 10^-6,
// 10^-9, 10^-12), converted to msat (1 BTC = 10^11 msat)
const BOLT11_AMOUNT_MSAT_PER_UNIT: Record<string, number> = {
  '': 100_000_000_000,
  m: 100_000_000,
  u: 100_000,
  n: 100,
  p: 0.1
}

// The amount out of an invoice's human-readable part. The bech32 separator
// is the LAST '1' in the string, since data characters can be '1' too;
// everything before it is "ln" + network + optional digits + optional
// multiplier. Null for an amountless invoice, for anything that does not
// parse as one, and for a pico amount that is not a whole number of msat.
export const decodeBolt11AmountMsat = (pr: string): number | null => {
  const trimmed = pr.trim().toLowerCase()
  const sep = trimmed.lastIndexOf('1')
  if (sep < 2) return null
  const hrp = trimmed.slice(0, sep)
  const match = hrp.match(/^ln(?:bc|tb|bcrt|tbs|sb)(\d+)?([munp])?$/)
  if (!match) return null
  const [, digits, multiplier] = match
  if (!digits) return null
  const msat = Number(digits) * BOLT11_AMOUNT_MSAT_PER_UNIT[multiplier || '']!
  return Number.isInteger(msat) ? msat : null
}
