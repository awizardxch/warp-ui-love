"use client"
// The connected wallet's balance under the bridge's amount field, and 25% / 50% /
// 75% / MAX pills above it: the Forge swap's "You Pay" field (lib/amountBalance.ts
// has the rules). The balance is of the asset the form would spend, on the From
// chain: on an EVM chain the ERC-20 (or ether) in the EVM wallet, on Chia the XCH
// or CAT in the Chia wallet. Nothing is shown without that chain's wallet.
import { useQuery } from "@tanstack/react-query"
import { erc20Abi } from "viem"
import { useAccount, useBalance, useEstimateFeesPerGas, useReadContracts } from "wagmi"
import { CHIA_OFFER_FEE_MOJOS, getEvmUnitShift, Network, NetworkType, Token } from "../config"
import { useWallet } from "../ChiaWalletManager/WalletContext"
import { readChiaBalance, XCH_ASSET_ID } from "../drivers/chiaBalance"
import {
  exceedsSpendable, formatBalance, formatUnits, parseUnits, PERCENT_PRESETS, percentOfBalance, rescaleDown,
  reserveFor, spendableBalance,
} from "@/lib/amountBalance"
import { cn } from "@/lib/utils"

const REFRESH_MS = 30_000
// Gas a bridge deposit of ether takes, generously: the reserve is twice this at the
// current fee, plus the toll (lib/amountBalance reserveFor).
const ETHER_BRIDGE_GAS = BigInt(150_000)

/**
 * The decimal places the amount field takes for `token` leaving `sourceChain`: the
 * same rule StepOne parses the amount with.
 */
export function amountDecimals(token: Token, sourceChain: Network): number {
  const unitShift = getEvmUnitShift(token)
  let decimals = 3
  if (token.symbol === "ETH" && sourceChain.type === NetworkType.EVM) decimals = 6
  if (unitShift > 0 && sourceChain.type === NetworkType.EVM) decimals = 3 + unitShift
  if (token.symbol === "XCH") decimals = 12
  return decimals
}

export type BridgeBalance = {
  /** The field's decimal places. */
  decimals: number
  /** What the wallet holds, in the field's units; null when unknown. */
  held: bigint | null
  /** What the form may spend (the native asset keeps its fee and toll back); null when unknown. */
  spendable: bigint | null
  /** The native-asset reserve MAX leaves, in the field's units, for the pill's tooltip. */
  reserve: bigint
  /** `held` covers only part of the wallet (a Chia wallet read at one address). */
  atLeast: boolean
  reading: boolean
  connected: boolean
}

export function useBridgeBalance(token: Token, sourceChain: Network | undefined): BridgeBalance {
  const decimals = sourceChain ? amountDecimals(token, sourceChain) : 3
  const isEvm = sourceChain?.type === NetworkType.EVM
  const isChia = sourceChain?.type === NetworkType.COINSET

  // ── EVM side ──────────────────────────────────────────────
  const account = useAccount()
  const evmAddress = isEvm ? account.address : undefined
  const chainId = sourceChain?.chainId
  const evmInfo = isEvm ? token.supported.find((s) => s.evmNetworkId === sourceChain!.id) : undefined
  const etherNative = isEvm && token.symbol === "ETH" && token.sourceNetworkType === NetworkType.EVM
  // A wrapped stock is spent from the wrapper and the stock together (WrapThenBridge
  // wraps the shortfall); both count in the stock's raw units.
  const holdings = evmInfo === undefined
    ? []
    : evmInfo.underlyingAddress !== undefined
      ? [evmInfo.contractAddress, evmInfo.underlyingAddress]
      : [evmInfo.contractAddress]
  const evmEnabled = evmAddress !== undefined && chainId !== undefined

  const ether = useBalance({
    address: evmAddress,
    chainId,
    query: { enabled: evmEnabled && etherNative, refetchInterval: REFRESH_MS },
  })
  const fees = useEstimateFeesPerGas({ chainId, query: { enabled: evmEnabled && etherNative, refetchInterval: REFRESH_MS } })
  const tokenReads = useReadContracts({
    contracts: [
      ...holdings.map((address) => ({ address, abi: erc20Abi, functionName: "balanceOf" as const, args: [evmAddress!] as const, chainId })),
      { address: holdings[holdings.length - 1], abi: erc20Abi, functionName: "decimals" as const, chainId },
    ],
    query: { enabled: evmEnabled && !etherNative && holdings.length > 0, refetchInterval: REFRESH_MS },
  })

  // ── Chia side ─────────────────────────────────────────────
  const { walletConnected, address: chiaAddress } = useWallet()
  const chiaInfo = isChia ? token.supported.find((s) => s.coinsetNetworkId === sourceChain!.id) : undefined
  const chiaEnabled = isChia && Boolean(walletConnected && chiaAddress) && chiaInfo !== undefined
  const chia = useQuery({
    queryKey: ["chia-balance", walletConnected, chiaAddress, chiaInfo?.assetId, sourceChain?.rpcUrl],
    queryFn: () => readChiaBalance({
      walletId: walletConnected,
      address: chiaAddress!,
      assetId: chiaInfo!.assetId,
      rpcUrl: sourceChain!.rpcUrl,
    }),
    enabled: chiaEnabled,
    refetchInterval: REFRESH_MS,
  })

  const none = (connected: boolean, reading = false): BridgeBalance =>
    ({ decimals, held: null, spendable: null, reserve: BigInt(0), atLeast: false, reading, connected })

  if (isEvm) {
    if (!evmEnabled) return none(false)
    if (etherNative) {
      if (ether.data === undefined) return none(true, ether.isLoading)
      const gas = (fees.data?.maxFeePerGas ?? fees.data?.gasPrice ?? BigInt(0)) * ETHER_BRIDGE_GAS
      const reserveWei = reserveFor(gas, sourceChain!.messageToll)
      const raw = ether.data.value
      return {
        decimals,
        held: rescaleDown(raw, 18, decimals),
        spendable: rescaleDown(spendableBalance(raw, true, reserveWei), 18, decimals),
        reserve: rescaleDown(reserveWei, 18, decimals),
        atLeast: false,
        reading: false,
        connected: true,
      }
    }
    const results = tokenReads.data
    if (results === undefined || results.some((r) => r.status !== "success")) return none(true, tokenReads.isLoading)
    const tokenDecimals = Number(results[results.length - 1].result)
    let raw = BigInt(0)
    for (const r of results.slice(0, -1)) raw += r.result as bigint
    const held = rescaleDown(raw, tokenDecimals, decimals)
    return { decimals, held, spendable: held, reserve: BigInt(0), atLeast: false, reading: false, connected: true }
  }

  if (isChia) {
    if (!chiaEnabled) return none(false)
    if (chia.data === undefined) return none(true, chia.isLoading)
    // XCH counts mojos (12 places), a CAT its own mojos (3): the field's units already.
    const native = chiaInfo!.assetId.replace(/^0x/, "").toLowerCase() === XCH_ASSET_ID
    const reserve = native ? reserveFor(BigInt(CHIA_OFFER_FEE_MOJOS), sourceChain!.messageToll) : BigInt(0)
    return {
      decimals,
      held: chia.data.units,
      spendable: spendableBalance(chia.data.units, native, reserve),
      reserve,
      atLeast: chia.data.atLeast,
      reading: chia.isFetching && chia.data === undefined,
      connected: true,
    }
  }

  return none(false)
}

/** 25% / 50% / 75% / MAX of the spendable balance, rounded down. Hidden while it is unknown. */
export function PercentPills({ balance, value, onPick }: { balance: BridgeBalance, value: string, onPick: (amount: string) => void }) {
  if (balance.spendable === null) return null
  return (
    <div className="flex gap-1 justify-end flex-wrap">
      {PERCENT_PRESETS.map((pct) => {
        // spendable already has the native reserve taken out.
        const share = percentOfBalance(balance.spendable!, pct, false, BigInt(0))
        const text = formatUnits(share, balance.decimals)
        const selected = share > BigInt(0) && value.trim() !== "" && value.trim() === text
        return (
          <button
            key={pct}
            type="button"
            disabled={share <= BigInt(0)}
            onClick={() => onPick(text)}
            aria-label={pct === 100 ? "MAX" : `${pct}%`}
            title={pct === 100 && balance.reserve > BigInt(0)
              ? `Leaves ${formatUnits(balance.reserve, balance.decimals)} for the network fee and bridge toll`
              : undefined}
            className={cn(
              "h-5 px-1.5 rounded text-[11px] font-normal leading-none transition-colors",
              "disabled:opacity-40 disabled:cursor-not-allowed",
              selected
                ? "bg-theme-purple text-primary"
                : "bg-theme-purple/20 text-[#b9a9f5] hover:bg-theme-purple/35",
            )}
          >
            {pct === 100 ? "MAX" : `${pct}%`}
          </button>
        )
      })}
    </div>
  )
}

/** "Balance: 12.345" under the field, red when the typed amount is more than the wallet can spend. */
export function BalanceLine({ balance, amount }: { balance: BridgeBalance, amount: string }) {
  if (!balance.connected) return null
  if (balance.held === null) {
    return balance.reading ? <p className="text-xs text-muted-foreground text-right">Balance: reading…</p> : null
  }
  const over = isOverBalance(balance, amount)
  return (
    <p
      className={cn("text-xs text-right truncate", over ? "text-red-500 font-normal" : "text-muted-foreground")}
      title={over ? "More than this wallet can spend" : balance.atLeast ? "Coins at this wallet's current address; the wallet may hold more" : undefined}
    >
      Balance: {balance.atLeast ? "≥ " : ""}{formatBalance(balance.held, balance.decimals)}
    </p>
  )
}

/**
 * The typed amount asks for more than the wallet can spend. Unknown balances never
 * block, and neither does a lower bound (a Chia wallet read at one address).
 */
export function isOverBalance(balance: BridgeBalance, amount: string): boolean {
  if (balance.atLeast) return false
  return exceedsSpendable(parseUnits(amount, balance.decimals), balance.spendable, false, BigInt(0))
}
