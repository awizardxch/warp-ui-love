"use client"

import { useRef, useState } from "react"
import { ethers } from "ethers"
import { toast } from "sonner"
import { useAccount, useChainId, useReadContracts, useSwitchChain, useWriteContract } from "wagmi"
import { waitForTransactionReceipt } from "wagmi/actions"
import { useWeb3Modal } from "@web3modal/wagmi/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CopyableLongHexString } from "@/components/CopyableHexString"
import { getWrappedStockInfo, NETWORKS, Network, Token, TokenInfo, WRAPPED_STOCK_TOKENS, wagmiConfig } from "../config"
import { formatMultiplier, StockTokenABI, WrappedStockABI } from "../drivers/wrappedStock"

type StockEntry = {
  token: Token,
  tokenInfo: TokenInfo & { underlyingAddress: `0x${string}` },
  network: Network,
}

function getStockEntries(): StockEntry[] {
  const entries: StockEntry[] = []
  WRAPPED_STOCK_TOKENS.forEach((token) => {
    token.supported.forEach((supported) => {
      const tokenInfo = getWrappedStockInfo(token, supported.evmNetworkId)
      const network = NETWORKS.find((n) => n.id === supported.evmNetworkId)
      if (tokenInfo !== undefined && network !== undefined) {
        entries.push({ token, tokenInfo, network })
      }
    })
  })
  return entries
}

export default function WrapPage() {
  const entries = getStockEntries()
  const [selected, setSelected] = useState(0)
  const entry = entries[selected] ?? entries[0]

  return (
    <div className="max-w-xl mt-12 mx-auto w-full p-4 xl:p-0">
      <h2 className="mb-2 text-xl font-light">Wrap Stocks</h2>
      <p className="mb-6 font-light opacity-80">
        Tokenized stocks on Base are wrapped 1:1 before they can be bridged to Chia. The bridge does this for you;
        this page is for wrapping or unwrapping on Base directly. Wrapping never changes how many tokens you hold:
        one wrapped token always unwraps to exactly one token.
      </p>
      {entries.length === 0 ? (
        <p className="border rounded-md px-6 py-4 font-light">No wrapped stocks are available yet.</p>
      ) : (
        <StockCard
          key={`${entry.token.symbol}-${entry.network.id}`}
          {...entry}
          selector={
            <Select value={String(selected)} onValueChange={(value) => setSelected(Number(value))}>
              <SelectTrigger aria-label="Stock" className="text-xl w-[180px] h-11 border-0 bg-theme-purple hover:opacity-80 rounded-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entries.map((option, index) => (
                  <SelectItem key={`${option.token.symbol}-${option.network.id}`} value={String(index)} className="text-xl">
                    {option.token.symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      )}
    </div>
  )
}

function StockCard({ token, tokenInfo, network, selector }: StockEntry & { selector: React.ReactNode }) {
  const { address } = useAccount()
  const wagmiChainId = useChainId()
  const { switchChainAsync } = useSwitchChain({ config: wagmiConfig })
  const { open } = useWeb3Modal()
  const { writeContractAsync } = useWriteContract()
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)

  const wrapper = tokenInfo.contractAddress
  const stock = tokenInfo.underlyingAddress
  const chainId = network.chainId!
  const account = address as `0x${string}`

  const { data: info } = useReadContracts({
    allowFailure: false,
    query: { refetchInterval: 30000 },
    contracts: [
      { address: wrapper, abi: WrappedStockABI, functionName: "decimals", chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "uiMultiplier", chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "underlying", chainId },
    ],
  })
  // Until the wrapper is confirmed to wrap this stock, nothing can be sent.
  const pairingOk = info !== undefined && info[2].toLowerCase() === stock.toLowerCase()
  const { data: balances, refetch } = useReadContracts({
    allowFailure: false,
    query: { enabled: address !== undefined, refetchInterval: 5000, gcTime: 0 },
    contracts: [
      { address: stock, abi: StockTokenABI, functionName: "balanceOf", args: [account], chainId },
      { address: wrapper, abi: WrappedStockABI, functionName: "balanceOf", args: [account], chainId },
      { address: stock, abi: StockTokenABI, functionName: "allowance", args: [account, wrapper], chainId },
    ],
  })

  const decimals = info?.[0]
  const fmt = (raw: bigint) => decimals === undefined ? "…" : ethers.formatUnits(raw, decimals)

  let rawAmount: bigint | null = null
  if (decimals !== undefined && amount.trim() !== "") {
    try {
      rawAmount = ethers.parseUnits(amount.trim(), decimals)
    } catch (_) {
      rawAmount = null
    }
  }
  const validAmount = pairingOk && rawAmount !== null && rawAmount > BigInt(0)
  const canWrap = validAmount && balances !== undefined && rawAmount! <= balances[0]
  const canUnwrap = validAmount && balances !== undefined && rawAmount! <= balances[1]
  const needsApproval = canWrap && balances![2] < rawAmount!

  const send = async (label: string, write: () => Promise<`0x${string}`>) => {
    if (inFlight.current) return false
    inFlight.current = true
    try {
      if (wagmiChainId !== chainId) {
        await switchChainAsync({ chainId })
      }
      setBusy("Confirm in wallet")
      const hash = await write()
      setBusy(`${label}: waiting for confirmation`)
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId })
      if (receipt.status !== "success") {
        throw new Error("The transaction reverted.")
      }
      await refetch()
      return true
    } catch (error: any) {
      toast.error(`${label} failed`, { description: error?.shortMessage ?? error?.message ?? "Unknown error", duration: 10000 })
      return false
    } finally {
      setBusy(null)
      inFlight.current = false
    }
  }

  const wrap = async () => {
    if (rawAmount === null) return
    const value = rawAmount
    if (needsApproval) {
      await send("Approval", () => writeContractAsync({
        address: stock, abi: StockTokenABI, functionName: "approve", args: [wrapper, value], chainId,
      }))
      return
    }
    const ok = await send("Wrap", () => writeContractAsync({
      address: wrapper, abi: WrappedStockABI, functionName: "deposit", args: [value], chainId,
    }))
    if (ok) setAmount("")
  }

  const unwrap = async () => {
    if (rawAmount === null) return
    const value = rawAmount
    const ok = await send("Unwrap", () => writeContractAsync({
      address: wrapper, abi: WrappedStockABI, functionName: "withdraw", args: [value], chainId,
    }))
    if (ok) setAmount("")
  }

  return (
    <div className="bg-accent border p-4 rounded-lg flex flex-col gap-3 font-light">
      <div className="flex items-center justify-between gap-2">
        {selector}
        <p className="text-sm opacity-80">{network.displayName}</p>
      </div>

      <div className="text-sm opacity-80 flex flex-col gap-1">
        <div className="flex items-center gap-2"><span className="w-20 shrink-0">Token</span><CopyableLongHexString hexString={stock} /></div>
        <div className="flex items-center gap-2"><span className="w-20 shrink-0">Wrapper</span><CopyableLongHexString hexString={wrapper} /></div>
        <p>One token represents {info === undefined ? "…" : formatMultiplier(info[1])} shares.</p>
        {info !== undefined && !pairingOk && <p className="text-destructive">This wrapper does not wrap {token.symbol}. Wrapping is disabled.</p>}
      </div>

      {address === undefined ? (
        <Button className="w-full bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80" onClick={() => open()}>Connect Wallet</Button>
      ) : (
        <>
          <div className="flex justify-between text-sm">
            <button type="button" className="hover:opacity-80 text-left" onClick={() => balances && decimals !== undefined && setAmount(ethers.formatUnits(balances[0], decimals))}>
              {token.symbol}: {balances ? fmt(balances[0]) : "…"}
            </button>
            <button type="button" className="hover:opacity-80 text-right" onClick={() => balances && decimals !== undefined && setAmount(ethers.formatUnits(balances[1], decimals))}>
              Wrapped: {balances ? fmt(balances[1]) : "…"}
            </button>
          </div>
          <Input
            type="text"
            inputMode="decimal"
            placeholder="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy !== null}
          />
          {busy !== null ? (
            <Button disabled className="w-full bg-theme-purple text-primary"><span className="animate-pulse">{busy}</span></Button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button disabled={!canWrap} className="bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80" onClick={wrap}>
                {needsApproval ? "Approve" : "Wrap"}
              </Button>
              <Button disabled={!canUnwrap} variant="outline" onClick={unwrap}>Unwrap</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
