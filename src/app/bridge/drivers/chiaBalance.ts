// The connected Chia wallet's balance of XCH or a CAT, for the bridge form's amount
// field. Goby answers for its whole wallet. Sage and WalletConnect expose no balance
// method in the session this site asks for, so for them the balance is read from
// the chain at the address the wallet gave: the unspent coins there. A wallet spreads
// its coins over many addresses, so that figure is a lower bound ("at least").
import * as GreenWeb from "greenwebjs"
import { concat, getBytes, sha256 } from "ethers"
import { CAT_MOD_HASH } from "./cat"
import { getCoinRecordsByPuzzleHash } from "./rpc"

export const XCH_ASSET_ID = "00".repeat(32)

export type ChiaBalance = {
  /** Mojos (XCH) or CAT mojos (1/1000 of a CAT). */
  units: bigint
  /** Only part of the wallet was read: the true balance may be higher. */
  atLeast: boolean
}

const hex = (bytes: string) => bytes.replace(/^0x/, "").toLowerCase()
const atomHash = (atom: Uint8Array) => sha256(concat([new Uint8Array([1]), atom]))
const pairHash = (left: string, right: string) => sha256(concat([new Uint8Array([2]), getBytes(left), getBytes(right)]))

const Q = atomHash(new Uint8Array([1]))     // (q . x) and the atom 1
const A = atomHash(new Uint8Array([2]))     // apply
const C = atomHash(new Uint8Array([4]))     // cons
const NIL = atomHash(new Uint8Array([]))

const quoted = (treeHash: string) => pairHash(Q, treeHash)

/**
 * The tree hash of `mod` curried with arguments given by their tree hashes:
 * (a (q . mod) (c (q . arg1) (c (q . arg2) ... 1))). The same hash as
 * sha256tree(curry(mod, args)), without needing the arguments' programs.
 */
export function curryTreeHash(modHash: string, argHashes: string[]): string {
  let env = Q // the atom 1: the environment
  for (const arg of [...argHashes].reverse()) {
    env = pairHash(C, pairHash(quoted(arg), pairHash(env, NIL)))
  }
  return pairHash(A, pairHash(quoted(modHash), pairHash(env, NIL)))
}

/** The puzzle hash of a CAT with `assetId` (its TAIL hash) around `innerPuzzleHash`. */
export function catPuzzleHash(assetId: string, innerPuzzleHash: string): string {
  return curryTreeHash("0x" + hex(CAT_MOD_HASH), [
    atomHash(getBytes("0x" + hex(CAT_MOD_HASH))),
    atomHash(getBytes("0x" + hex(assetId))),
    "0x" + hex(innerPuzzleHash),
  ])
}

/** Unspent coins at `puzzleHash`, summed. */
async function unspentAt(rpcUrl: string, puzzleHash: string): Promise<bigint> {
  const records: any[] = (await getCoinRecordsByPuzzleHash(rpcUrl, "0x" + hex(puzzleHash))) ?? []
  let total = BigInt(0)
  for (const record of records) {
    if (record?.spent) continue
    total += BigInt(String(record.coin.amount))
  }
  return total
}

/** Goby's own figure for its whole wallet, or null when it does not answer. */
async function gobyBalance(assetId: string): Promise<bigint | null> {
  const chia = typeof window !== "undefined" ? (window as any).chia : undefined
  if (!chia?.request) return null
  try {
    const native = assetId === XCH_ASSET_ID
    const result = await chia.request({
      method: "getAssetBalance",
      params: { type: native ? null : "cat", assetId: native ? null : assetId },
    })
    const spendable = result?.spendable ?? result?.confirmed
    if (spendable === undefined || spendable === null || !/^\d+$/.test(String(spendable))) return null
    return BigInt(String(spendable))
  } catch {
    return null
  }
}

export async function readChiaBalance(params: {
  walletId: string | null
  address: string
  assetId: string
  rpcUrl: string
}): Promise<ChiaBalance> {
  const assetId = hex(params.assetId)
  if (params.walletId === "goby") {
    const units = await gobyBalance(assetId)
    if (units !== null) return { units, atLeast: false }
  }
  const inner = hex(GreenWeb.util.address.addressToPuzzleHash(params.address))
  const puzzleHash = assetId === XCH_ASSET_ID ? inner : catPuzzleHash(assetId, inner)
  return { units: await unspentAt(params.rpcUrl, puzzleHash), atLeast: true }
}
