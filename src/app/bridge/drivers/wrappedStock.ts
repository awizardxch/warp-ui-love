// Client-side helpers for WrappedStock wrappers (contracts/src/WrappedStock.sol).

import { ethers } from "ethers";
import { UNWRAP_FORWARDER_INIT_CODE_HASH } from "./wrappedStockBytecode";

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

// StockBridgeRouter (contracts/src/StockBridgeRouter.sol).
export const StockBridgeRouterABI = [
  { type: "function", name: "wrapAndBridge", stateMutability: "payable", inputs: [{ name: "bridgeCall", type: "bytes" }], outputs: [] },
  {
    type: "function", name: "wrapAndBridgeWithPermit", stateMutability: "payable",
    inputs: [
      { name: "bridgeCall", type: "bytes" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "function", name: "forwarderOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "", type: "address" }] },
  {
    type: "function", name: "claimAndUnwrap", stateMutability: "nonpayable",
    inputs: [{ name: "user", type: "address" }, { name: "wrapper", type: "address" }, { name: "portalCall", type: "bytes" }],
    outputs: [],
  },
  { type: "function", name: "sweep", stateMutability: "nonpayable", inputs: [{ name: "user", type: "address" }, { name: "wrapper", type: "address" }], outputs: [] },
  { type: "function", name: "sweepWrapped", stateMutability: "nonpayable", inputs: [{ name: "user", type: "address" }, { name: "wrapper", type: "address" }], outputs: [] },
  { type: "function", name: "bridge", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "portal", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

// The one bridge function the router forwards. Encoded on the client and passed
// through unchanged, so it appears word for word in the transaction input.
export const BridgeToChiaABI = [
  {
    type: "function", name: "bridgeToChia", stateMutability: "payable",
    inputs: [{ name: "_assetContract", type: "address" }, { name: "_receiver", type: "bytes32" }, { name: "_mojoAmount", type: "uint256" }],
    outputs: [],
  },
] as const;

// What a signed approval (EIP-2612 permit) needs from the stock token.
export const PermitTokenABI = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "eip712Domain", stateMutability: "view", inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

// The forwarder address the router deploys for `user`, derived here from the
// compiled forwarder code (CREATE2, salt = the user's address).
export function expectedForwarder(router: string, user: string): string {
  return ethers.getCreate2Address(router, ethers.zeroPadValue(user, 32), UNWRAP_FORWARDER_INIT_CODE_HASH);
}

// A forwarder address is used only when the router's own answer and the local
// derivation agree. A payout sent to a wrong address could never be collected.
export function agreedForwarder(router: string, user: string, routerAnswer: unknown): `0x${string}` | null {
  if (typeof routerAnswer !== "string" || !ethers.isAddress(routerAnswer) || !ethers.isAddress(user)) {
    return null;
  }
  const local = expectedForwarder(router, user);
  return local.toLowerCase() === routerAnswer.toLowerCase() ? (local as `0x${string}`) : null;
}
