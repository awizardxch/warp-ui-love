"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { ethers } from "ethers"
import { toast } from "sonner"
import { useAccount, useChainId, useReadContracts, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi"
import { waitForTransactionReceipt } from "wagmi/actions"
import { Button } from "@/components/ui/button"
import { Network, TokenInfo, wagmiConfig } from "../config"
import { BridgeTipABI, releasedRawAmount, StockTokenABI, WrappedStockABI } from "../drivers/wrappedStock"

const BUTTON_CLASS = "w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"

// Shown after a Chia -> Base claim of a wrapped stock. The bridge pays out the
// wrapper token with no callback, so turning it back into the stock is a second
// transaction from the receiving wallet.
export default function UnwrapPrompt({
  symbol,
  tokenInfo,
  chain,
  claimTxId,
  receiver,
  amountMojo,
}: {
  symbol: string,
  tokenInfo: TokenInfo & { underlyingAddress: `0x${string}` },
  chain: Network,
  claimTxId: `0x${string}`,
  receiver: string,
  amountMojo: bigint,
}) {
  const { address } = useAccount()
  const wagmiChainId = useChainId()
  const { switchChainAsync } = useSwitchChain({ config: wagmiConfig })
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy] = useState<string | null>(null)
  const [unwrapTx, setUnwrapTx] = useState<string | null>(null)
  const inFlight = useRef(false)

  const wrapper = tokenInfo.contractAddress
  const chainId = chain.chainId!
  const account = address as `0x${string}`

  const { data: claimReceipt } = useWaitForTransactionReceipt({ hash: claimTxId, chainId })
  const claimed = claimReceipt?.status === "success"

  const { data } = useReadContracts({
    allowFailure: false,
    query: { enabled: address !== undefined && claimed, refetchInterval: 5000, gcTime: 0 },
    contracts: [
      { address: wrapper, abi: WrappedStockABI, functionName: "decimals", chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "balanceOf", args: [account], chainId },
      { address: chain.erc20BridgeAddress as `0x${string}`, abi: BridgeTipABI, functionName: "tip", chainId },
      { address: tokenInfo.underlyingAddress, abi: StockTokenABI, functionName: "decimals", chainId },
    ],
  })

  const wrapPageLink = <Link href="/bridge/wrap" className="underline hover:opacity-80">Wrap page</Link>

  let body
  if (unwrapTx !== null) {
    body = (
      <p>
        Unwrapped to {symbol}.{" "}
        <Link href={`${chain.explorerUrl}/tx/${unwrapTx}`} target="_blank" className="underline hover:opacity-80">View on Explorer</Link>
      </p>
    )
  } else if (claimReceipt?.status === "reverted") {
    body = <p>The claim transaction reverted, so there is nothing to unwrap yet.</p>
  } else if (!claimed) {
    body = <p className="animate-pulse">Waiting for the claim to confirm before unwrapping…</p>
  } else if (address === undefined || address.toLowerCase() !== receiver.toLowerCase()) {
    body = (
      <p>
        The wrapped {symbol} went to {receiver}. Connect that wallet to unwrap it here, or unwrap any time on the {wrapPageLink}.
      </p>
    )
  } else if (data === undefined) {
    body = <p className="animate-pulse">Loading your wrapped balance…</p>
  } else {
    const [decimals, balance, tipBps, stockDecimals] = data
    const released = releasedRawAmount(amountMojo, decimals, tipBps)
    const amount = released < balance ? released : balance

    const unwrap = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        if (wagmiChainId !== chainId) {
          await switchChainAsync({ chainId })
        }
        setBusy("Confirm in wallet")
        const hash = await writeContractAsync({
          address: wrapper, abi: WrappedStockABI, functionName: "withdraw", args: [amount], chainId,
        })
        setBusy("Waiting for confirmation")
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
        if (receipt.status !== "success") {
          throw new Error("The transaction reverted.")
        }
        setUnwrapTx(hash)
      } catch (error: any) {
        toast.error("Unwrap failed", { description: error?.shortMessage ?? error?.message ?? "Unknown error", duration: 10000 })
      } finally {
        setBusy(null)
        inFlight.current = false
      }
    }

    body = amount === BigInt(0) ? (
      <p>No wrapped {symbol} left in this wallet to unwrap.</p>
    ) : (
      <>
        <p>
          You received wrapped {symbol}. Unwrap it 1:1 to get {symbol} back, or keep it wrapped to bridge again later.
        </p>
        <Button disabled={busy !== null} className={BUTTON_CLASS} onClick={unwrap}>
          {busy !== null ? <span className="animate-pulse">{busy}</span> : `Unwrap ${ethers.formatUnits(amount, stockDecimals)} ${symbol}`}
        </Button>
      </>
    )
  }

  return (
    <div className="p-6 mt-2 bg-background flex flex-col gap-4 font-light rounded-md animate-in fade-in slide-in-from-bottom-2 duration-500">
      <p className="font-extralight opacity-80">Unwrap</p>
      {body}
    </div>
  )
}
