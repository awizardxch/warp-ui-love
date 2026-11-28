// The wallet balance under the bridge's amount field, and the 25/50/75/MAX pills
// above it. Ported from the Forge's swap form (forge.awizard.dev, "You Pay":
// chia-cfmm src/lib/amountBalance.ts), with the same rules:
//   - amounts are integers in the field's smallest unit; a share of a balance
//     rounds DOWN, so a pill can never ask for a unit the wallet does not hold;
//   - the native asset (XCH on Chia, ETH on an EVM chain) pays the network fee and
//     the bridge toll as well as the amount, so the pills share out what is left
//     after the reserve the form keeps back. A token's fee and toll are paid in the
//     native asset, so a token's MAX is the whole balance;
//   - an unknown balance (no wallet, read not done) is null and shows nothing. A
//     zero is shown only when a read said zero.
//
// The site targets ES2015, so there are no bigint literals here.

const ZERO = BigInt(0)
const TEN = BigInt(10)
const HUNDRED = BigInt(100)
const TWO = BigInt(2)

export const PERCENT_PRESETS = [25, 50, 75, 100] as const
export type PercentPreset = (typeof PERCENT_PRESETS)[number]

function pow10(places: number): bigint {
  let result = BigInt(1)
  for (let i = 0; i < places; i += 1) result *= TEN
  return result
}

/** A held balance as a decimal string of units, or null when unknown. */
export function parseHeld(value: string | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === "bigint") return value >= ZERO ? value : null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return BigInt(trimmed)
}

/**
 * What the pills may share out: the whole balance for a token, the balance less
 * `reserve` (the network fee and the bridge toll) for the native asset.
 */
export function spendableBalance(held: bigint, native: boolean, reserve: bigint): bigint {
  if (held <= ZERO) return ZERO
  if (!native) return held
  const kept = reserve > ZERO ? reserve : ZERO
  return held > kept ? held - kept : ZERO
}

/** `percent` of the spendable balance, rounded down. */
export function percentOfBalance(held: bigint, percent: number, native: boolean, reserve: bigint): bigint {
  const pct = BigInt(Math.max(0, Math.min(100, Math.floor(percent))))
  return (spendableBalance(held, native, reserve) * pct) / HUNDRED
}

/**
 * `raw` units of a `fromDecimals` asset in `toDecimals` units, rounded down: an EVM
 * balance (18 decimals) as the field counts it (6 for ETH, 3 for a wrapped CAT).
 */
export function rescaleDown(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals >= fromDecimals) return raw * pow10(toDecimals - fromDecimals)
  return raw / pow10(fromDecimals - toDecimals)
}

/** Units as the exact decimal an input takes: no rounding, no trailing zeros, no grouping. */
export function formatUnits(units: bigint, decimals: number): string {
  const places = Math.max(0, Math.floor(decimals))
  const negative = units < ZERO
  const abs = negative ? -units : units
  const base = pow10(places)
  const whole = abs / base
  const fraction = places > 0 ? (abs % base).toString().padStart(places, "0").replace(/0+$/, "") : ""
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`
}

/** A balance for reading: grouped, at most `maxFraction` places, rounded down. */
export function formatBalance(units: bigint, decimals: number, maxFraction = 6): string {
  const places = Math.max(0, Math.floor(decimals))
  const keep = Math.min(places, Math.max(0, maxFraction))
  const base = pow10(places)
  const whole = units / base
  const fraction = places > 0 ? (units % base).toString().padStart(places, "0").slice(0, keep).replace(/0+$/, "") : ""
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return fraction ? `${grouped}.${fraction}` : grouped
}

/**
 * What a form keeps back from a native MAX: twice the network fee it will pay, plus
 * anything else it pays in the native asset (the bridge toll). Twice, as on the
 * Forge: the fee can land above the estimate the form shows, and the second fee is
 * a fraction of a cent where a refused transaction is not.
 */
export function reserveFor(networkFee: bigint, extra: bigint = ZERO): bigint {
  const fee = networkFee > ZERO ? networkFee : ZERO
  const more = extra > ZERO ? extra : ZERO
  return fee * TWO + more
}

/**
 * A typed amount in units: the exact decimal, places past `decimals` dropped (rounded
 * down, never up). Null for an empty or malformed field; "0" is zero.
 */
export function parseUnits(text: string | null | undefined, decimals: number): bigint | null {
  const trimmed = String(text ?? "").trim()
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed)
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return null
  const places = Math.max(0, Math.floor(decimals))
  const whole = BigInt(match[1] || "0")
  const fraction = (match[2] ?? "").slice(0, places).padEnd(places, "0")
  return whole * pow10(places) + (places > 0 ? BigInt(fraction || "0") : ZERO)
}

/**
 * The typed amount asks for more than the wallet can spend, on MAX's terms: a token's
 * whole balance, the native asset's balance less the reserve. An unknown balance
 * never blocks, and an empty field never exceeds.
 */
export function exceedsSpendable(amount: bigint | null, held: bigint | null, native: boolean, reserve: bigint): boolean {
  if (amount === null || held === null || amount <= ZERO) return false
  return amount > spendableBalance(held, native, reserve)
}
