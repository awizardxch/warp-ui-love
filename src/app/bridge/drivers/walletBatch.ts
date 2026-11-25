// Atomic call batching through the wallet (EIP-5792): several contract calls
// confirmed once and executed as one transaction.
//
// The wallet library bundled with this app implements an early draft of the
// standard that current wallets reject, so these helpers talk to the wallet
// directly and accept both the final and the draft response shapes.

import { getConnectorClient } from "wagmi/actions"
import type { Config } from "wagmi"

export type BatchCall = {
  to: `0x${string}`,
  data: `0x${string}`,
  value?: bigint,
}

const toHex = (value: number | bigint) => "0x" + value.toString(16)

async function request(config: Config, chainId: number, method: string, params: unknown[]): Promise<any> {
  const client = await getConnectorClient(config, { chainId })
  return await (client as any).request({ method, params })
}

// True only when the wallet says it can run a batch atomically on this chain:
// all calls in one transaction, or none of them.
export async function supportsAtomicBatch(config: Config, chainId: number, account: `0x${string}`): Promise<boolean> {
  const chainHex = toHex(chainId)
  let capabilities: any
  try {
    capabilities = await request(config, chainId, "wallet_getCapabilities", [account, [chainHex]])
  } catch (_) {
    try {
      capabilities = await request(config, chainId, "wallet_getCapabilities", [account])
    } catch (_) {
      return false
    }
  }
  if (capabilities === null || typeof capabilities !== "object") {
    return false
  }
  const key = Object.keys(capabilities).find((k) => k.toLowerCase() === chainHex)
  const forChain = key !== undefined ? capabilities[key] : undefined
  if (forChain === undefined || forChain === null) {
    return false
  }
  // Final standard: atomic.status is "supported" or "ready" (the wallet can upgrade on request).
  const status = forChain.atomic?.status
  if (status === "supported" || status === "ready") {
    return true
  }
  // Early draft.
  return forChain.atomicBatch?.supported === true
}

// Asks the wallet to run the calls as one atomic batch. Returns the wallet's batch id.
export async function sendAtomicBatch(config: Config, chainId: number, account: `0x${string}`, calls: BatchCall[]): Promise<string> {
  const result = await request(config, chainId, "wallet_sendCalls", [{
    version: "2.0.0",
    from: account,
    chainId: toHex(chainId),
    atomicRequired: true,
    calls: calls.map((call) => ({
      to: call.to,
      data: call.data,
      value: toHex(call.value ?? BigInt(0)),
    })),
  }])
  const id = typeof result === "string" ? result : result?.id
  if (typeof id !== "string" || id === "") {
    throw new Error("The wallet did not return a batch id.")
  }
  return id
}

// Waits for the batch to land and returns the hash of its single transaction.
// Throws if it failed, reverted, was split across transactions, or timed out.
export async function waitForAtomicBatch(config: Config, chainId: number, id: string, timeoutMs = 5 * 60 * 1000): Promise<`0x${string}`> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let result: any
    try {
      result = await request(config, chainId, "wallet_getCallsStatus", [id])
    } catch (_) {
      result = undefined
    }
    const status = result?.status
    // Final standard: 1xx pending, 2xx confirmed, 4xx-6xx failed. Early draft: strings.
    const failed = typeof status === "number" && status >= 400
    const confirmed = status === "CONFIRMED" || (typeof status === "number" && status >= 200 && status < 300)
    if (failed) {
      throw new Error("The wallet reports that the batch failed. Nothing was bridged.")
    }
    if (confirmed) {
      const receipts: any[] = result.receipts ?? []
      if (receipts.length !== 1) {
        throw new Error("The wallet did not run the batch as a single transaction. Check your wallet's activity before trying again.")
      }
      const receipt = receipts[0]
      const ok = receipt.status === "0x1" || receipt.status === "success" || receipt.status === 1
      if (!ok || typeof receipt.transactionHash !== "string") {
        throw new Error("The batch transaction reverted. Nothing was bridged.")
      }
      return receipt.transactionHash as `0x${string}`
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error("Timed out waiting for the batch. Check your wallet's activity before trying again.")
}
