// Client-side helpers for WrappedStock wrappers (contracts/src/WrappedStock.sol).

export const WrappedStockABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

// The Base-native stock itself: only the ERC-20 calls the UI needs.
export const StockTokenABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export const BridgeTipABI = [
  { type: "function", name: "tip", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);

function pow10(exponent: number): bigint {
  let result = ONE;
  for (let i = 0; i < exponent; i++) {
    result = result * TEN;
  }
  return result;
}

// A wrapped CAT has 3 decimals; the bridge scales by 10^(decimals - 3).
export function mojoToRaw(mojoAmount: bigint, decimals: number): bigint {
  return mojoAmount * pow10(decimals - 3);
}

// What the bridge pays the receiver for a Chia -> Base message of `mojoAmount`,
// mirroring ERC20Bridge.receiveMessage: the tip is taken in raw units, minimum 1.
export function releasedRawAmount(mojoAmount: bigint, decimals: number, tipBps: bigint): bigint {
  const raw = mojoToRaw(mojoAmount, decimals);
  let tip = raw * tipBps / BigInt(10000);
  if (tip === ZERO) {
    tip = ONE;
  }
  return raw > tip ? raw - tip : ZERO;
}

// Shares represented by one whole token, as a display string ("1.000538").
export function formatMultiplier(multiplierWad: bigint): string {
  const scale = pow10(18);
  const whole = multiplierWad / scale;
  const micro = (multiplierWad % scale) / pow10(12);
  return `${whole.toString()}.${micro.toString().padStart(6, "0")}`;
}
