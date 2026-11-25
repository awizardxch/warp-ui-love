"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ethers } from "ethers"
import * as GreenWeb from "greenwebjs"
import { toast } from "sonner"
import { useAccount, useChainId, useReadContracts, useSwitchChain, useWriteContract } from "wagmi"
import { waitForTransactionReceipt } from "wagmi/actions"
import { useWeb3Modal } from "@web3modal/wagmi/react"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Network, Token, TokenInfo, wagmiConfig } from "../config"
import { ERC20BridgeABI } from "../drivers/abis"
import { formatMultiplier, mojoToRaw, StockTokenABI, WrappedStockABI } from "../drivers/wrappedStock"
import { getStepTwoURL } from "./urls"

const BUTTON_CLASS = "w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"

type Action = "approveWrap" | "wrap" | "approveBridge" | "bridge"

// Base -> Chia for a wrapped stock. The stock is wrapped first if the wallet
// does not already hold enough of the wrapper, then the wrapper is bridged.
//
// The bridge call is always sent straight from the wallet to the ERC20Bridge.
// The validators read the deposit amount from that transaction's own input, so
// routing it through a helper contract would leave the deposit unsigned.
export default function WrapThenBridgeButton({
  token,
  tokenInfo,
  sourceChain,
  destinationChain,
  recipient,
  amountMojo,
}: {
  token: Token,
  tokenInfo: TokenInfo & { underlyingAddress: `0x${string}` },
  sourceChain: Network,
  destinationChain: Network,
  recipient: string,
  amountMojo: bigint,
}) {
  const router = useRouter()
  const { address } = useAccount()
  const wagmiChainId = useChainId()
  const { switchChainAsync, status: switchStatus } = useSwitchChain({ config: wagmiConfig })
  const { open } = useWeb3Modal()
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy] = useState<string | null>(null)
  // State updates land a frame late; the ref stops a double click sending twice.
  const inFlight = useRef(false)

  const wrapper = tokenInfo.contractAddress
  const stock = tokenInfo.underlyingAddress
  const bridge = sourceChain.erc20BridgeAddress as `0x${string}`
  const chainId = sourceChain.chainId!
  const account = address as `0x${string}`

  const { data, refetch } = useReadContracts({
    allowFailure: false,
    query: { enabled: address !== undefined, refetchInterval: 5000, gcTime: 0 },
    contracts: [
      { address: wrapper, abi: WrappedStockABI, functionName: "decimals", chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "balanceOf", args: [account], chainId },
      { address: stock, abi: StockTokenABI, functionName: "balanceOf", args: [account], chainId },
      { address: stock, abi: StockTokenABI, functionName: "allowance", args: [account, wrapper], chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "allowance", args: [account, bridge], chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "uiMultiplier", chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "underlying", chainId },
    ],
  })

  if (address === undefined) {
    return <Button className={BUTTON_CLASS} onClick={() => open()}>Connect Wallet</Button>
  }

  if (wagmiChainId !== chainId) {
    return (
      <Button disabled={switchStatus === "pending"} className={BUTTON_CLASS} onClick={() => switchChainAsync({ chainId })}>
        <span className={cn(switchStatus === "pending" && "animate-pulse")}>Switch Chain</span>
      </Button>
    )
  }

  // Never guess decimals: an amount scaled wrong would wrap or approve the wrong quantity.
  if (data === undefined) {
    return <Button disabled className={BUTTON_CLASS}><span className="animate-pulse">Loading token details</span></Button>
  }

  const [decimals, wrappedBalance, stockBalance, stockAllowance, bridgeAllowance, multiplier, wrapperUnderlying] = data

  // A wrapper address configured against the wrong stock would bridge under the wrong name.
  if (wrapperUnderlying.toLowerCase() !== stock.toLowerCase()) {
    return <Button disabled className="w-full h-14 bg-destructive text-primary text-xl">Wrapper misconfigured</Button>
  }

  const required = mojoToRaw(amountMojo, decimals)
  const shortfall = required > wrappedBalance ? required - wrappedBalance : BigInt(0)
  const needsWrap = shortfall > BigInt(0)

  const done: Record<Action, boolean> = {
    approveWrap: !needsWrap || stockAllowance >= shortfall,
    wrap: !needsWrap,
    approveBridge: bridgeAllowance >= required,
    bridge: false,
  }
  const order: Action[] = ["approveWrap", "wrap", "approveBridge", "bridge"]
  const current = order.find((action) => !done[action])!

  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals)
  const labels: Record<Action, string> = {
    approveWrap: `Approve ${token.symbol} for wrapping`,
    wrap: `Wrap ${fmt(shortfall)} ${token.symbol}`,
    approveBridge: `Approve wrapped ${token.symbol} for the bridge`,
    bridge: "Initiate Bridging",
  }
  const checklist: Record<Action, string> = {
    approveWrap: `Approve ${token.symbol} for wrapping`,
    wrap: `Wrap ${token.symbol} 1:1`,
    approveBridge: `Approve wrapped ${token.symbol} for the bridge`,
    bridge: `Bridge to ${destinationChain.displayName}`,
  }

  const sendAndWait = async (label: string, send: () => Promise<`0x${string}`>) => {
    setBusy("Confirm in wallet")
    try {
      const hash = await send()
      setBusy(`${label}: waiting for confirmation`)
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
      if (receipt.status !== "success") {
        throw new Error("The transaction reverted.")
      }
      await refetch()
      return hash
    } catch (error: any) {
      toast.error(`${label} failed`, { description: error?.shortMessage ?? error?.message ?? "Unknown error", duration: 10000 })
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const run = async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await runCurrent()
    } finally {
      inFlight.current = false
    }
  }

  const runCurrent = async () => {
    if (current === "approveWrap") {
      await sendAndWait("Approval", () => writeContractAsync({
        address: stock, abi: StockTokenABI, functionName: "approve", args: [wrapper, shortfall], chainId,
      }))
    } else if (current === "wrap") {
      await sendAndWait("Wrap", () => writeContractAsync({
        address: wrapper, abi: WrappedStockABI, functionName: "deposit", args: [shortfall], chainId,
      }))
    } else if (current === "approveBridge") {
      await sendAndWait("Approval", () => writeContractAsync({
        address: wrapper, abi: WrappedStockABI, functionName: "approve", args: [bridge, required], chainId,
      }))
    } else {
      const receiver = GreenWeb.util.address.addressToPuzzleHash(recipient)
      setBusy("Confirm in wallet")
      try {
        const hash = await writeContractAsync({
          address: bridge,
          abi: ERC20BridgeABI,
          functionName: "bridgeToChia",
          args: [wrapper, ("0x" + receiver) as `0x${string}`, amountMojo],
          chainId,
          value: sourceChain.messageToll,
        })
        router.push(getStepTwoURL({
          sourceNetworkId: sourceChain.id,
          destinationNetworkId: destinationChain.id,
          txHash: hash,
        }))
      } catch (error: any) {
        toast.error("Bridging failed", { description: error?.shortMessage ?? error?.message ?? "Unknown error", duration: 10000 })
        setBusy(null)
      }
    }
  }

  const insufficient = shortfall > stockBalance

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm font-light opacity-80">
        <p>
          {token.symbol} is wrapped 1:1 before it is bridged. You hold {fmt(stockBalance)} {token.symbol} and {fmt(wrappedBalance)} wrapped {token.symbol}.
          One token currently represents {formatMultiplier(multiplier)} shares.
        </p>
        <ol className="mt-3 flex flex-col gap-1">
          {order.map((action) => (
            <li key={action} className={cn("flex items-center gap-2", action === current && !insufficient && "opacity-100 font-normal", done[action] && "line-through opacity-60")}>
              <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                {done[action] ? <Check className="w-4 h-4" /> : <span className="w-1.5 h-1.5 rounded-full bg-current" />}
              </span>
              {checklist[action]}
            </li>
          ))}
        </ol>
      </div>

      {insufficient ? (
        <Button disabled className="w-full h-14 bg-destructive text-primary text-xl">Insufficient Balance</Button>
      ) : busy !== null ? (
        <Button disabled className={BUTTON_CLASS}><span className="animate-pulse whitespace-normal">{busy}</span></Button>
      ) : (
        <Button className={BUTTON_CLASS} onClick={run}>{labels[current]}</Button>
      )}
    </div>
  )
}
