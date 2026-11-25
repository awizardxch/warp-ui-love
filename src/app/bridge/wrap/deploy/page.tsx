"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { isAddress } from "viem"
import { useAccount, useChainId, useReadContracts, useSwitchChain } from "wagmi"
import { getWalletClient, readContracts, waitForTransactionReceipt } from "wagmi/actions"
import { useWeb3Modal } from "@web3modal/wagmi/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CopyableLongHexString } from "@/components/CopyableHexString"
import { BASE_NETWORK, WRAPPED_STOCKS, wagmiConfig } from "../../config"
import { getWrappedERC20AssetID } from "../../drivers/erc20bridge"
import { WrappedStockABI } from "../../drivers/wrappedStock"
import { WRAPPED_STOCK_BYTECODE, WrappedStockConstructorABI } from "../../drivers/wrappedStockBytecode"

const StockInfoABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const

// Base's registry of native (B20) tokens. Used only to tell the user what they are wrapping.
const B20_FACTORY = "0xB20f000000000000000000000000000000000000" as const
const B20FactoryABI = [
  { type: "function", name: "isB20", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "", type: "bool" }] },
] as const

type Deployed = {
  address: `0x${string}`,
  txHash: `0x${string}`,
  verified: boolean,
}

export default function DeployWrapperPage() {
  const [customAddress, setCustomAddress] = useState("")
  const custom = customAddress.trim()
  const customValid = isAddress(custom)
  const alreadyListed = WRAPPED_STOCKS.find((stock) => stock.underlying.toLowerCase() === custom.toLowerCase())

  return (
    <div className="max-w-6xl mt-12 mx-auto w-full p-4 xl:p-0">
      <h2 className="mb-2 text-xl font-light">Deploy Stock Wrappers</h2>
      <div className="mb-6 font-light opacity-80 max-w-3xl flex flex-col gap-2">
        <p>
          Deploys a WrappedStock contract on {BASE_NETWORK.displayName} from the connected wallet. Every stock gets its own wrapper:
          one contract wraps exactly one token. Each deployment is a real transaction that costs gas, and a wrapper has no owner
          and cannot be changed or removed afterwards.
        </p>
        <p>
          After deploying, add the printed line to <code>WRAPPED_STOCKS_BASE_MAINNET</code> in <code>src/app/bridge/config.tsx</code>.
          That lists the stock. Do one minimum deposit (0.002 token) end to end before listing it publicly:
          no wrapper deposit has been signed by the validators yet.
        </p>
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        {WRAPPED_STOCKS.map((stock) => (
          <DeployCard key={stock.symbol} expectedSymbol={stock.symbol} underlying={stock.underlying} configuredWrapper={stock.wrapper} />
        ))}
      </div>

      <h2 className="mt-12 mb-2 text-xl font-light">Another stock</h2>
      <p className="mb-4 font-light opacity-80 max-w-3xl">
        For a tokenized stock that is not in the list above yet. Paste its token address on {BASE_NETWORK.displayName};
        take it from the issuer&apos;s own site, not from a search result.
      </p>
      <Input
        className="max-w-xl"
        placeholder="0x… token address"
        value={customAddress}
        onChange={(e) => setCustomAddress(e.target.value)}
      />
      <div className="mt-4 grid xl:grid-cols-2 gap-4">
        {custom !== "" && !customValid && <p className="font-light text-destructive">That is not a valid address.</p>}
        {customValid && alreadyListed !== undefined && (
          <p className="font-light">{alreadyListed.symbol} is already in the list above.</p>
        )}
        {customValid && alreadyListed === undefined && (
          <DeployCard key={custom.toLowerCase()} underlying={custom as `0x${string}`} configuredWrapper={null} />
        )}
      </div>

      <p className="mt-8 font-light opacity-80">
        Already deployed and configured? Wrap and unwrap on the <Link href="/bridge/wrap" className="underline hover:opacity-80">Wrap page</Link>.
      </p>
    </div>
  )
}

function DeployCard({ expectedSymbol, underlying, configuredWrapper }: {
  // Set for stocks from the config: the token must report this symbol.
  expectedSymbol?: string,
  underlying: `0x${string}`,
  configuredWrapper: `0x${string}` | null,
}) {
  const { address } = useAccount()
  const wagmiChainId = useChainId()
  const { switchChainAsync } = useSwitchChain({ config: wagmiConfig })
  const { open } = useWeb3Modal()
  // null means "not edited": the default is derived from the token's symbol.
  const [nameEdit, setNameEdit] = useState<string | null>(null)
  const [symbolEdit, setSymbolEdit] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [deployed, setDeployed] = useState<Deployed | null>(null)
  const inFlight = useRef(false)

  const chainId = BASE_NETWORK.chainId!

  // Read the token itself first: a wrong address here would wrap the wrong thing.
  const { data: stockInfo, isError: stockReadFailed } = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: underlying, abi: StockInfoABI, functionName: "symbol", chainId },
      { address: underlying, abi: StockInfoABI, functionName: "decimals", chainId },
    ],
  })
  const { data: registry } = useReadContracts({
    contracts: [
      { address: B20_FACTORY, abi: B20FactoryABI, functionName: "isB20", args: [underlying], chainId },
    ],
  })
  const isNative = registry?.[0]?.status === "success" ? registry[0].result : undefined

  const tokenSymbol = stockInfo?.[0]
  const tokenDecimals = stockInfo?.[1]
  const symbolMatches = tokenSymbol !== undefined && (expectedSymbol === undefined || tokenSymbol === expectedSymbol)
  // The bridge scales by 10^(decimals - 3); anything below 3 cannot be bridged.
  const decimalsOk = tokenDecimals !== undefined && tokenDecimals >= 3
  const title = expectedSymbol ?? tokenSymbol ?? "Unknown token"

  const name = nameEdit ?? (tokenSymbol !== undefined ? `Wrapped ${tokenSymbol}` : "")
  const wrappedSymbol = symbolEdit ?? (tokenSymbol !== undefined ? `w${tokenSymbol}` : "")
  const namesValid = name.trim() !== "" && wrappedSymbol.trim() !== ""

  const deploy = async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      if (wagmiChainId !== chainId) {
        await switchChainAsync({ chainId })
      }
      setBusy("Confirm in wallet")
      // A contract creation has no `to`, so it goes through the wallet client directly.
      const walletClient = await getWalletClient(wagmiConfig, { chainId })
      const txHash = await walletClient.deployContract({
        abi: WrappedStockConstructorABI,
        bytecode: WRAPPED_STOCK_BYTECODE,
        args: [underlying, name.trim(), wrappedSymbol.trim()],
      })
      setBusy("Waiting for confirmation")
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash, chainId })
      if (receipt.status !== "success" || !receipt.contractAddress) {
        throw new Error("The deployment transaction reverted.")
      }
      const wrapper = receipt.contractAddress

      // Confirm what landed on chain is the wrapper for this token.
      setBusy("Checking the deployed contract")
      let verified = false
      try {
        const [onchainUnderlying, onchainDecimals] = await readContracts(wagmiConfig, {
          allowFailure: false,
          contracts: [
            { address: wrapper, abi: WrappedStockABI, functionName: "underlying", chainId },
            { address: wrapper, abi: WrappedStockABI, functionName: "decimals", chainId },
          ],
        })
        verified = onchainUnderlying.toLowerCase() === underlying.toLowerCase() && onchainDecimals === tokenDecimals
      } catch (_) {
        verified = false
      }
      setDeployed({ address: wrapper, txHash, verified })
    } catch (error: any) {
      toast.error("Deployment failed", { description: error?.shortMessage ?? error?.message ?? "Unknown error", duration: 10000 })
    } finally {
      setBusy(null)
      inFlight.current = false
    }
  }

  const shown = deployed?.address ?? configuredWrapper

  return (
    <div className="bg-accent border p-4 rounded-lg flex flex-col gap-3 font-light">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xl">{title}</p>
        <p className="text-sm opacity-80">
          {stockInfo === undefined ? (stockReadFailed ? "Could not read the token" : "Reading token…") : `${tokenDecimals} decimals`}
        </p>
      </div>
      <div className="text-sm opacity-80 flex items-center gap-2">
        <span className="w-20 shrink-0">Token</span><CopyableLongHexString hexString={underlying} />
      </div>

      {isNative === true && <p className="text-sm opacity-80">Registered with Base as a native (B20) token.</p>}
      {isNative === false && (
        <p className="text-sm border rounded-md px-3 py-2">
          Base does not list this as a native (B20) token. An ordinary ERC-20 can usually be bridged directly and does not need a wrapper. Check the address.
        </p>
      )}
      {tokenSymbol !== undefined && !symbolMatches && (
        <p className="text-sm text-destructive">This address reports the symbol {tokenSymbol}, not {expectedSymbol}. Deployment is disabled.</p>
      )}
      {tokenDecimals !== undefined && !decimalsOk && (
        <p className="text-sm text-destructive">This token has fewer than 3 decimals and cannot be bridged. Deployment is disabled.</p>
      )}
      {configuredWrapper !== null && deployed === null && (
        <p className="text-sm border rounded-md px-3 py-2">A wrapper for {title} is already configured. Deploying another creates a second, separate wrapped token.</p>
      )}

      {deployed === null && (
        <>
          <label className="text-sm flex flex-col gap-1">
            <span className="opacity-80">Wrapper name</span>
            <Input value={name} onChange={(e) => setNameEdit(e.target.value)} disabled={busy !== null || tokenSymbol === undefined} />
          </label>
          <label className="text-sm flex flex-col gap-1">
            <span className="opacity-80">Wrapper symbol</span>
            <Input value={wrappedSymbol} onChange={(e) => setSymbolEdit(e.target.value)} disabled={busy !== null || tokenSymbol === undefined} />
          </label>
          {address === undefined ? (
            <Button className="w-full bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80" onClick={() => open()}>Connect Wallet</Button>
          ) : (
            <Button disabled={busy !== null || !symbolMatches || !decimalsOk || !namesValid} className="w-full bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80" onClick={deploy}>
              {busy !== null ? <span className="animate-pulse">{busy}</span> : `Deploy ${title} wrapper`}
            </Button>
          )}
        </>
      )}

      {shown !== null && shown !== undefined && (
        <div className="text-sm flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 opacity-80">Wrapper</span><CopyableLongHexString hexString={shown} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 opacity-80">Chia asset</span><CopyableLongHexString hexString={getWrappedERC20AssetID(BASE_NETWORK, shown)} />
          </div>
          {deployed !== null && (
            <>
              <p className={deployed.verified ? "" : "text-destructive"}>
                {deployed.verified
                  ? `Deployed and checked: it wraps ${tokenSymbol} with ${tokenDecimals} decimals.`
                  : "Deployed, but the on-chain check did not confirm it. Do not configure this address until you have verified it."}
              </p>
              <p>
                <Link href={`${BASE_NETWORK.explorerUrl}/tx/${deployed.txHash}`} target="_blank" className="underline hover:opacity-80">View the deployment on the explorer</Link>
              </p>
              <p className="opacity-80">Config line:</p>
              <code className="block break-all bg-background rounded-md px-3 py-2">
                {`{ symbol: '${tokenSymbol}', underlying: '${underlying}', wrapper: '${deployed.address}' },`}
              </code>
              <p className="opacity-80">This page does not remember the address after a reload. Copy it now.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
