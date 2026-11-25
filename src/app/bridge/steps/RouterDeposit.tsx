"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ethers } from "ethers"
import * as GreenWeb from "greenwebjs"
import { toast } from "sonner"
import { encodeFunctionData } from "viem"
import { useAccount, useReadContracts, useWriteContract } from "wagmi"
import { readContracts, signTypedData, waitForTransactionReceipt } from "wagmi/actions"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Network, Token, wagmiConfig } from "../config"
import { BridgeToChiaABI, formatMultiplier, PermitTokenABI, StockBridgeRouterABI, StockTokenABI } from "../drivers/wrappedStock"
import { getStepTwoURL } from "./urls"

const BUTTON_CLASS = "w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
const LINK_CLASS = "text-sm font-light opacity-80 underline hover:opacity-100 text-left"

// Base -> Chia through the StockBridgeRouter: after approving the stock, one
// ordinary transaction wraps it and deposits it into the bridge.
//
// The encoded bridgeToChia call is handed to the router unchanged, so it sits
// word for word in the transaction input, where the validators look for it.
export default function RouterDeposit({
  token,
  wrapper,
  stock,
  routerAddress,
  sourceChain,
  destinationChain,
  recipient,
  amountMojo,
  required,
  decimals,
  multiplier,
  onStepByStep,
}: {
  token: Token,
  wrapper: `0x${string}`,
  stock: `0x${string}`,
  routerAddress: `0x${string}`,
  sourceChain: Network,
  destinationChain: Network,
  recipient: string,
  amountMojo: bigint,
  // Raw stock units the deposit takes: amountMojo scaled to the token's decimals.
  required: bigint,
  decimals: number,
  multiplier: bigint,
  onStepByStep: () => void,
}) {
  const router = useRouter()
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)

  const chainId = sourceChain.chainId!
  const account = address as `0x${string}`
  const bridge = sourceChain.erc20BridgeAddress as `0x${string}`

  const { data, refetch } = useReadContracts({
    allowFailure: false,
    query: { enabled: address !== undefined, refetchInterval: 5000, gcTime: 0 },
    contracts: [
      { address: stock, abi: StockTokenABI, functionName: "allowance", args: [account, routerAddress], chainId },
      { address: routerAddress, abi: StockBridgeRouterABI, functionName: "bridge", chainId },
    ],
  })

  const stepByStepLink = (
    <button type="button" className={LINK_CLASS} onClick={onStepByStep}>Go step by step instead</button>
  )

  if (data === undefined) {
    return <Button disabled className={BUTTON_CLASS}><span className="animate-pulse">Loading router details</span></Button>
  }
  const [allowance, routerBridge] = data

  // A router wired to some other bridge would deposit somewhere this site cannot follow.
  if (routerBridge.toLowerCase() !== bridge.toLowerCase()) {
    return (
      <div className="flex flex-col gap-3">
        <Button disabled className="w-full h-14 bg-destructive text-primary text-xl">Router misconfigured</Button>
        {stepByStepLink}
      </div>
    )
  }

  const approved = allowance >= required
  const amountText = `${ethers.formatUnits(required, decimals)} ${token.symbol}`
  const bridgeCall = () => encodeFunctionData({
    abi: BridgeToChiaABI,
    functionName: "bridgeToChia",
    args: [wrapper, ("0x" + GreenWeb.util.address.addressToPuzzleHash(recipient)) as `0x${string}`, amountMojo],
  })

  const guarded = async (label: string, action: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await action()
    } catch (error: any) {
      toast.error(`${label} failed`, { description: error?.shortMessage ?? error?.message ?? "Unknown error", duration: 10000 })
      setBusy(null)
    } finally {
      inFlight.current = false
    }
  }

  const goToStepTwo = (hash: `0x${string}`) => router.push(getStepTwoURL({
    sourceNetworkId: sourceChain.id,
    destinationNetworkId: destinationChain.id,
    txHash: hash,
  }))

  const approve = () => guarded("Approval", async () => {
    setBusy("Confirm in wallet")
    const hash = await writeContractAsync({
      address: stock, abi: StockTokenABI, functionName: "approve", args: [routerAddress, required], chainId,
    })
    setBusy("Approval: waiting for confirmation")
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
    if (receipt.status !== "success") {
      throw new Error("The transaction reverted.")
    }
    await refetch()
    setBusy(null)
  })

  const wrapAndBridge = () => guarded("Wrap and bridge", async () => {
    setBusy("Confirm in wallet")
    const hash = await writeContractAsync({
      address: routerAddress,
      abi: StockBridgeRouterABI,
      functionName: "wrapAndBridge",
      args: [bridgeCall()],
      chainId,
      value: sourceChain.messageToll,
    })
    goToStepTwo(hash)
  })

  // A signed approval for exactly this amount, used inside the same transaction.
  const signAndBridge = () => guarded("Wrap and bridge", async () => {
    setBusy("Preparing")
    const [nonce, domain] = await readContracts(wagmiConfig, {
      allowFailure: false,
      contracts: [
        { address: stock, abi: PermitTokenABI, functionName: "nonces", args: [account], chainId },
        { address: stock, abi: PermitTokenABI, functionName: "eip712Domain", chainId },
      ],
    })
    const [, name, version, domainChainId, verifyingContract] = domain
    if (Number(domainChainId) !== chainId || verifyingContract.toLowerCase() !== stock.toLowerCase()) {
      throw new Error("This token's signing details do not match it. Use an approval transaction instead.")
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

    setBusy("Sign the approval in your wallet")
    const signature = await signTypedData(wagmiConfig, {
      account,
      domain: { name, version, chainId, verifyingContract },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: { owner: account, spender: routerAddress, value: required, nonce, deadline },
    })
    const { r, s, v } = ethers.Signature.from(signature)

    setBusy("Confirm in wallet")
    const hash = await writeContractAsync({
      address: routerAddress,
      abi: StockBridgeRouterABI,
      functionName: "wrapAndBridgeWithPermit",
      args: [bridgeCall(), deadline, v, r as `0x${string}`, s as `0x${string}`],
      chainId,
      value: sourceChain.messageToll,
    })
    goToStepTwo(hash)
  })

  const steps: [string, boolean][] = [
    [`Approve ${amountText} for the bridge router`, approved],
    [`Wrap and bridge to ${destinationChain.displayName} in one transaction`, false],
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm font-light opacity-80">
        <p>
          {token.symbol} is wrapped 1:1 and bridged in a single transaction. One token currently represents {formatMultiplier(multiplier)} shares.
        </p>
        <ol className="mt-3 flex flex-col gap-1">
          {steps.map(([label, done]) => (
            <li key={label} className={cn("flex items-center gap-2", done && "line-through opacity-60")}>
              <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                {done ? <Check className="w-4 h-4" /> : <span className="w-1.5 h-1.5 rounded-full bg-current" />}
              </span>
              {label}
            </li>
          ))}
        </ol>
      </div>

      {busy !== null ? (
        <Button disabled className={BUTTON_CLASS}><span className="animate-pulse whitespace-normal">{busy}</span></Button>
      ) : approved ? (
        <Button className={BUTTON_CLASS} onClick={wrapAndBridge}>Wrap and bridge</Button>
      ) : (
        <>
          <Button className={BUTTON_CLASS} onClick={approve}>Approve {amountText}</Button>
          <button type="button" className={LINK_CLASS} onClick={signAndBridge}>
            Or sign the approval instead, and send only one transaction
          </button>
        </>
      )}
      {busy === null && stepByStepLink}
    </div>
  )
}
