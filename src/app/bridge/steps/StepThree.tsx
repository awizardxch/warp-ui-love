"use client"

import { useRouter, useSearchParams } from "next/navigation"
import * as GreenWeb from 'greenwebjs';
import { getStockRouter, getWrappedStockInfo, NETWORKS, Network, NetworkType, TESTNET, TOKENS, WALLET_BATCHING_ENABLED, wagmiConfig } from "../config"
import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { getStepThreeURL } from "./urls"
import { useQuery } from "@tanstack/react-query"
import { useAccount, useChainId, useSwitchChain, useWriteContract } from "wagmi"
import { readContract, readContracts, waitForTransactionReceipt, writeContract as sendContractWrite } from "wagmi/actions"
import { encodeFunctionData } from "viem"
import { bootstrapPortal, decodeSignature, getSigsAndSelectors, PortalInfo, RawMessage } from "../drivers/portal"
import { stringToHex } from "../drivers/util"
import { PortalABI } from "../drivers/abis"
import { getCoinRecordByName, pushTx, sbToJSON } from "../drivers/rpc"
import { mintCATs } from "../drivers/erc20bridge"
import { unlockCATs } from "../drivers/catbridge"
import { Button } from "@/components/ui/button"
import { ArrowUpRight, Loader, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { useWallet } from "../ChiaWalletManager/WalletContext"
import AddERCTokenButton from "../assets/components/AddERCTokenButton"
import { cn } from "@/lib/utils"
import { ethers } from "ethers"
import OrPasteOffer from "./OrOffer";
import UnwrapPrompt from "./UnwrapPrompt";
import { agreedForwarder, BridgeTipABI, releasedRawAmount, StockBridgeRouterABI, WrappedStockABI } from "../drivers/wrappedStock";
import { sendAtomicBatch, supportsAtomicBatch, waitForAtomicBatch } from "../drivers/walletBatch";

export default function StepThree({
  sourceChain,
  destinationChain,
}: {
  sourceChain: Network,
  destinationChain: Network,
}) {
  return destinationChain.type === NetworkType.COINSET ? (
    <StepThreeCoinsetDestination
      sourceChain={sourceChain}
      destinationChain={destinationChain}
    />
  ) : (
    <StepThreeEVMDestination
      sourceChain={sourceChain}
      destinationChain={destinationChain}
    />
  )
}

function StepThreeEVMDestination({
  sourceChain,
  destinationChain,
}: {
  sourceChain: Network,
  destinationChain: Network,
}) {

  const wagmiChainId = useChainId()
  const { address, isConnected: isEthWalletConnected } = useAccount()
  const { switchChainAsync, status } = useSwitchChain({ config: wagmiConfig })

  const searchParams = useSearchParams()
  const nonce = searchParams.get("nonce")!
  const source = searchParams.get("source")!
  const destination = searchParams.get("destination")! as `0x${string}`
  const contents = JSON.parse(searchParams.get("contents")!).map((c: string) => `0x${c}`) as `0x${string}`[]
  const [waitingForTx, setWaitingForTx] = useState(false)
  const { data: hash, writeContract } = useWriteContract()

  const [sigs, setSigs] = useState<string[]>([])
  useQuery({
    queryKey: ['StepThree_fetchSigsAndSelectors', nonce],
    queryFn: () => getSigsAndSelectors(
      {
        nonce: nonce.replace("0x", ""),
        sourceChainHex: stringToHex(sourceChain.id),
        sourceHex: source.replace("0x", ""),
        destinationChainHex: stringToHex(destinationChain.id),
        destinationHex: destination.replace("0x", ""),
        contents: contents.map(c => c.replace("0x", ""))
      },
      null, destinationChain.signatureThreshold, destinationChain
    ).then((sigsAndSelectors) => {
      setSigs(sigsAndSelectors[0])
      return 1
    }),
    enabled: hash !== undefined || sigs.length < destinationChain.signatureThreshold,
    refetchInterval: 5000,
  })

  // A wrapped stock coming back: [asset, receiver, mojo amount] released by the ERC20Bridge.
  // If the connected wallet is the receiver and can batch, the claim and the
  // unwrap can go out together as one transaction.
  const [batchHash, setBatchHash] = useState<`0x${string}` | null>(null)
  const [batchBusy, setBatchBusy] = useState<string | null>(null)
  const batchInFlight = useRef(false)
  let stockRelease: { symbol: string, wrapper: `0x${string}`, receiver: string, amountMojo: bigint } | null = null
  if (
    destinationChain.erc20BridgeAddress !== undefined &&
    destination.toLowerCase() === destinationChain.erc20BridgeAddress.toLowerCase() &&
    contents.length === 3
  ) {
    const asset = '0x' + contents[0].slice(-40).toLowerCase()
    for (const token of TOKENS) {
      const info = getWrappedStockInfo(token, destinationChain.id)
      if (info !== undefined && info.contractAddress.toLowerCase() === asset) {
        stockRelease = {
          symbol: token.symbol,
          wrapper: info.contractAddress,
          receiver: '0x' + contents[1].slice(-40).toLowerCase(),
          amountMojo: BigInt(contents[2]),
        }
      }
    }
  }
  const isReceiver = stockRelease !== null && address !== undefined && address.toLowerCase() === stockRelease.receiver

  // Sent through the router: the receiver is a forwarder that pays out only to
  // one wallet. If that wallet is the one connected, a single ordinary
  // transaction claims and unwraps.
  const stockRouter = stockRelease !== null ? getStockRouter(destinationChain.id) : null
  const { data: myForwarder } = useQuery({
    queryKey: ['StepThree_forwarder', address, stockRouter],
    queryFn: () => readContract(wagmiConfig, {
      address: stockRouter!,
      abi: StockBridgeRouterABI,
      functionName: "forwarderOf",
      args: [address as `0x${string}`],
      chainId: destinationChain.chainId!,
    }),
    enabled: stockRouter !== null && address !== undefined,
    staleTime: Infinity,
  })
  const agreedMine = stockRouter !== null && address !== undefined ? agreedForwarder(stockRouter, address, myForwarder) : null
  const viaRouter = stockRelease !== null && agreedMine !== null && agreedMine.toLowerCase() === stockRelease.receiver
  const { data: canBatch } = useQuery({
    queryKey: ['StepThree_atomicBatch', address, wagmiChainId],
    queryFn: () => supportsAtomicBatch(wagmiConfig, destinationChain.chainId!, address as `0x${string}`),
    enabled: WALLET_BATCHING_ENABLED && isReceiver && wagmiChainId === destinationChain.chainId,
    staleTime: 60000,
  })

  if (batchHash) {
    return (
      <FinalEVMTxConfirmer destinationChain={destinationChain} txId={batchHash} unwrappedSymbol={stockRelease?.symbol} />
    )
  }

  if (hash) {
    return (
      <FinalEVMTxConfirmer destinationChain={destinationChain} txId={hash} />
    )
  }

  if (sigs.length < destinationChain.signatureThreshold) {
    return (
      <div className="flex gap-2 items-center bg-background h-14 w-full px-6 rounded-md font-light ">
        <Loader className="w-4 shrink-0 h-auto animate-spin" />
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
          <p className="animate-pulse"> {`Collecting signatures (${sigs?.length ?? 0}/${destinationChain.signatureThreshold})`}</p>
        </div>
      </div>
    )
  }

  const generateTxPls = async () => {
    setWaitingForTx(true)

    writeContract({
      address: destinationChain.portalAddress! as `0x${string}`,
      abi: PortalABI,
      functionName: "receiveMessage",
      args: [
        ("0x" + nonce) as `0x${string}`,
        ("0x" + stringToHex(sourceChain.id)) as `0x${string}`,
        ("0x" + source) as `0x${string}`,
        destination,
        contents,
        "0x" + sigs.map(sig => decodeSignature(sig)[4]).join("") as `0x${string}`
      ],
      chainId: destinationChain.chainId
    })
  }

  const switchToCorrectChain = async () => await switchChainAsync({ chainId: destinationChain.chainId! })
  const isOnRightChain = destinationChain.chainId! === wagmiChainId

  const onClick = async () => {
    if (!isOnRightChain) {
      await switchToCorrectChain()
    }
    generateTxPls()
  }

  // Claim and unwrap as one atomic batch: both happen or neither does.
  const claimAndUnwrap = async () => {
    if (stockRelease === null || address === undefined || batchInFlight.current) return
    batchInFlight.current = true
    const chainId = destinationChain.chainId!
    try {
      setBatchBusy("Preparing")
      const [decimals, tipBps] = await readContracts(wagmiConfig, {
        allowFailure: false,
        contracts: [
          { address: stockRelease.wrapper, abi: WrappedStockABI, functionName: "decimals", chainId },
          { address: destinationChain.erc20BridgeAddress as `0x${string}`, abi: BridgeTipABI, functionName: "tip", chainId },
        ],
      })
      // Exactly what the bridge is about to pay this wallet.
      const unwrapAmount = releasedRawAmount(stockRelease.amountMojo, decimals, tipBps)
      if (unwrapAmount <= BigInt(0)) {
        throw new Error("Nothing to unwrap for this amount.")
      }
      setBatchBusy("Confirm in wallet")
      const id = await sendAtomicBatch(wagmiConfig, chainId, address, [
        {
          to: destinationChain.portalAddress! as `0x${string}`,
          data: encodeFunctionData({
            abi: PortalABI,
            functionName: "receiveMessage",
            args: [
              ("0x" + nonce) as `0x${string}`,
              ("0x" + stringToHex(sourceChain.id)) as `0x${string}`,
              ("0x" + source) as `0x${string}`,
              destination,
              contents,
              "0x" + sigs.map(sig => decodeSignature(sig)[4]).join("") as `0x${string}`
            ],
          }),
        },
        {
          to: stockRelease.wrapper,
          data: encodeFunctionData({ abi: WrappedStockABI, functionName: "withdraw", args: [unwrapAmount] }),
        },
      ])
      setBatchBusy("Waiting for confirmation")
      const batchTx = await waitForAtomicBatch(wagmiConfig, chainId, id)
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: batchTx, chainId })
      if (receipt.status !== "success") {
        throw new Error("The transaction reverted. Nothing was claimed.")
      }
      setBatchHash(batchTx)
    } catch (error: any) {
      toast.error("Claim and unwrap failed", {
        description: `${error?.shortMessage ?? error?.message ?? "Unknown error"} You can claim first and unwrap after.`,
        duration: 15000,
      })
    } finally {
      setBatchBusy(null)
      batchInFlight.current = false
    }
  }
  const offerBatch = WALLET_BATCHING_ENABLED && stockRelease !== null && isReceiver && isOnRightChain && canBatch === true

  // One ordinary transaction to the router: it relays the claim and has the
  // forwarder unwrap to this wallet.
  const claimThroughRouter = async () => {
    if (stockRelease === null || stockRouter === null || address === undefined || batchInFlight.current) return
    batchInFlight.current = true
    const chainId = destinationChain.chainId!
    try {
      if (!isOnRightChain) {
        await switchToCorrectChain()
      }
      setBatchBusy("Confirm in wallet")
      const portalCall = encodeFunctionData({
        abi: PortalABI,
        functionName: "receiveMessage",
        args: [
          ("0x" + nonce) as `0x${string}`,
          ("0x" + stringToHex(sourceChain.id)) as `0x${string}`,
          ("0x" + source) as `0x${string}`,
          destination,
          contents,
          "0x" + sigs.map(sig => decodeSignature(sig)[4]).join("") as `0x${string}`
        ],
      })
      const txHash = await sendContractWrite(wagmiConfig, {
        address: stockRouter,
        abi: StockBridgeRouterABI,
        functionName: "claimAndUnwrap",
        args: [address, stockRelease.wrapper, portalCall],
        chainId,
      })
      setBatchBusy("Waiting for confirmation")
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash, chainId })
      if (receipt.status !== "success") {
        throw new Error("The transaction reverted. Nothing was claimed.")
      }
      setBatchHash(txHash)
    } catch (error: any) {
      toast.error("Claim and unwrap failed", {
        description: `${error?.shortMessage ?? error?.message ?? "Unknown error"} You can claim only, and collect it on the wrap page.`,
        duration: 15000,
      })
    } finally {
      setBatchBusy(null)
      batchInFlight.current = false
    }
  }

  return (
    <div className="p-6 mt-2 bg-background flex flex-col gap-2 font-light rounded-md transition-none animate-in fade-in slide-in-from-bottom-2 duration-500">
      <p className="px-4">
        Click the button below to receive your assets on {destinationChain.displayName}.
        Note that lower fees mean slower confirmations.
      </p>
      {stockRelease !== null && (
        <p className="px-4 mt-2 text-sm opacity-80">
          {viaRouter
            ? `This was sent through the bridge router: one transaction claims it and unwraps it to ${stockRelease.symbol} in this wallet.`
            : stockRouter !== null && !isReceiver
              ? `This pays out wrapped ${stockRelease.symbol}. If it was sent to another wallet through the bridge router, connect that wallet to claim and unwrap in one transaction.`
              : `This pays out wrapped ${stockRelease.symbol}, which is then unwrapped 1:1 to ${stockRelease.symbol} from the receiving wallet.`}
        </p>
      )}
      <div className="flex flex-col gap-3 mt-6">
        {batchBusy !== null ? (
          <Button
            className="relative flex items-center gap-2 w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
            disabled={true}
          >
            <p className="animate-pulse whitespace-normal">{batchBusy}</p>
          </Button>
        ) : viaRouter && !waitingForTx ? (
          <>
            <Button
              className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
              onClick={claimThroughRouter}
            >
              Claim and unwrap
            </Button>
            <button type="button" className="text-sm font-light opacity-80 underline hover:opacity-100" onClick={onClick}>
              Claim only, collect later on the wrap page
            </button>
          </>
        ) : offerBatch && !waitingForTx ? (
          <>
            <Button
              className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
              onClick={claimAndUnwrap}
            >
              Claim and unwrap in one confirmation
            </Button>
            <button type="button" className="text-sm font-light opacity-80 underline hover:opacity-100" onClick={onClick}>
              Claim only, unwrap later
            </button>
          </>
        ) : !waitingForTx ? (
          <Button
            disabled={!isEthWalletConnected}
            className={cn("w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl", status === "pending" && 'animate-pulse')}
            onClick={onClick}
          >
            {isEthWalletConnected ? 'Generate Transaction' : 'Connect ETH Wallet'}
          </Button>
        ) : (
          <Button
            className="relative flex items-center gap-2 w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
            disabled={true}
          >
            <p className="animate-pulse whitespace-normal">Waiting for transaction approval</p>
          </Button>
        )}
      </div>
    </div>
  )
}


function StepThreeCoinsetDestination({
  sourceChain,
  destinationChain,
}: {
  sourceChain: Network,
  destinationChain: Network,
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const portalBootstrapCoinId: string | null = searchParams.get("portal_bootstrap_id")
  const offer: string | null = searchParams.get("offer")

  const [status, setStatus] = useState("Loading...")
  const [key, setKey] = useState(0)
  useEffect(() => {
    // Update status key to re-trigger fade-in animation
    setKey(prevKey => prevKey + 1)
  }, [status])

  const nonce: `0x${string}` = (searchParams.get("nonce") ?? "0x") as `0x${string}`
  const source = searchParams.get("source") ?? ""
  const destination = searchParams.get("destination") ?? ""
  const contents = JSON.parse(searchParams.get("contents") ?? "[]")

  const rawMessage: RawMessage = {
    nonce: nonce.replace("0x", ""),
    destinationHex: destination.replace("0x", ""),
    destinationChainHex: stringToHex(destinationChain.id),
    sourceHex: source.replace("0x", ""),
    sourceChainHex: stringToHex(sourceChain.id),
    contents: contents.map((c: string) => c.replace("0x", "")),
  }

  const isNativeCAT = contents.length == 2

  const destTxId = searchParams.get("tx")
  useQuery({
    queryKey: ['StepThree_buildAndSubmitTx', rawMessage.nonce],
    queryFn: async () => {
      var sb, txId
      if (!isNativeCAT) { // wrapped ERC20s
        try {
          [sb, txId] = await mintCATs(
            portalBootstrapCoinId!,
            offer!,
            rawMessage,
            destinationChain,
            setStatus
          )
        } catch (_) {
          console.error(_)
          toast.error("Failed to mint wrapped ERC-20 CATs.", { duration: 20000, id: "failed-to-mint-erc20" })
        }
      } else {
        // native CATs being unwrapped
        // find asset id via bruteforce
        var assetId: string = "00".repeat(32)
        TOKENS.forEach((token) => {
          token.supported.forEach((tokenInfo) => {
            if (tokenInfo.contractAddress.toLowerCase() === source.toLowerCase()) {
              assetId = tokenInfo.assetId
            }
          })
        })

        try {
          [sb, txId] = await unlockCATs(
            portalBootstrapCoinId!,
            offer!,
            rawMessage,
            assetId === "00".repeat(32) ? null : assetId,
            sourceChain,
            destinationChain,
            setStatus
          )
        } catch (_) {
          console.error(_)
          toast.error("Failed to unlock CATs.", { duration: 20000, id: "failed-to-unlock-cats" })
        }
      }


      if(txId!.length == 0) {
        const retries = parseInt(window.localStorage.getItem("bls_retries") ?? "0")
        if(retries < 3) {
          window.localStorage.setItem("bls_retries", (retries + 1).toString())
          location.reload()
          return;
        } else {
          navigator.clipboard.writeText(location.href)
          alert('Failed to initialize BLS after several retries - try restarting your browser, and contact us if this issue persists. Current URL has been copied to your clipboard - you can also view pending operations at warp.green/explorer');
          window.localStorage.setItem("bls_retries", "0")
          return;
        }
      }

      window.localStorage.setItem("bls_retries", "0")
      const [pushTxResp, feeError] = await pushTx(destinationChain.rpcUrl, sb)
      if (feeError) {
        alert(`Transaction push failed - fee is too low`)
          router.back()
          return;
      } else if (!pushTxResp.success) {
        const sbJson = sbToJSON(sb)
        await navigator.clipboard.writeText(JSON.stringify(sbJson, null, 2))
        toast.error("Failed to push transaction - please check console for more details.", { duration: 20000, id: "failed-to-push-transaction" })
        console.error(pushTxResp)
      } else {
        if(pushTxResp.status !== "SUCCESS") {
          alert(`Transaction push failed - you might be using a fee that is too low`)
          router.back()
          return;
        }

        router.push(getStepThreeURL({
          sourceNetworkId: sourceChain.id,
          destinationNetworkId: destinationChain.id,
          destTransactionId: txId
        }))
      }

      return 1
    },
    enabled: offer !== null && destTxId === null,
  })

  if (!offer && !destTxId) {
    const nonce: `0x${string}` = searchParams.get("nonce")! as `0x${string}`
    const source = searchParams.get("source")!
    const destination = searchParams.get("destination")!
    const contents = JSON.parse(searchParams.get("contents")!)
    const amount = parseInt(contents[2], 16)

    return (
      <GenerateOfferPrompt
        sourceChain={sourceChain}
        destinationChain={destinationChain}
        amount={isNativeCAT ? 1 : amount}
        rawMessage={rawMessage}
        onOfferGenerated={async (portalBootstrapId, offer) => {
          router.push(getStepThreeURL({
            sourceNetworkId: sourceChain.id,
            destinationNetworkId: destinationChain.id,
            nonce,
            source,
            destination,
            contents,
            offer,
            portalBootstrapId
          }))
        }}
      />
    )
  }

  if (!destTxId) {
    return (
      <div className="flex gap-2 items-center bg-background h-14 w-full px-6 rounded-md font-light">
        <Loader className="w-4 shrink-0 h-auto animate-spin" />
        <div key={key} className="animate-in fade-in slide-in-from-bottom-2 duration-500">
          <p className="animate-pulse">{status}</p>
        </div>
      </div>
    )
  }

  return (
    <FinalCoinsetTxConfirmer destinationChain={destinationChain} txId={destTxId!} />
  )
}

function ChiaFeeWarning({
  portalInfo,
}: {
  portalInfo: PortalInfo
}) {
  const originalCost = GreenWeb.BigNumber.from(portalInfo.mempoolSbCost);
  const originalFee = portalInfo.mempoolSbFee.eq(0) ? originalCost.mul(4) : GreenWeb.BigNumber.from(portalInfo.mempoolSbFee);

  const estAdditionalCost = GreenWeb.BigNumber.from("200000000");
  let recommendedFeeMojos: GreenWeb.BigNumber = (
    originalCost.add(estAdditionalCost) // new cost = original_cost + estimated cost for adding new coin spends (200 mil.)
  ).mul(
    (originalFee.add(originalCost)).div(originalCost) // fpc + 1 = original_fee / original_cost + 1 = (original_fee + original_cost) / original_cost
  )
  const minPositiveFee = GreenWeb.BigNumber.from("2500000000");
  if(recommendedFeeMojos.gt(0) && recommendedFeeMojos.lt(minPositiveFee)) {
    recommendedFeeMojos = minPositiveFee;
  }

  return (
    <div className="p-6 mt-2 bg-background flex flex-col gap-2 font-light rounded-md relative animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex items-center gap-2">
        <TriangleAlert className="w-12 h-auto opacity-80" />
        <div className="px-2">
          <p><span className="font-medium">The mempool already contains a portal spend</span><span className="opacity-100"> with a fee of {ethers.formatUnits(portalInfo.mempoolSbFee.toString(), 12)} XCH.</span></p>
          <p className="pt-4"><span className="opacity-80">To replace it, it is recommended that you </span><span className="font-medium opacity-100">use a minimum fee of {ethers.formatUnits(recommendedFeeMojos.toString(), 12)} XCH</span>.</p>
          <p className="pt-5 opacity-80">Alternatively, you can wait for the pending transaction to be confirmed, when this warning will disappear.</p>
        </div>
      </div>
    </div>
  );
}

function GenerateOfferPrompt({
  sourceChain,
  destinationChain,
  rawMessage,
  amount,
  onOfferGenerated,
}: {
  sourceChain: Network,
  destinationChain: Network,
  rawMessage: RawMessage,
  amount: number,
  onOfferGenerated: (portalInfo: string, offer: string) => Promise<void>
}) {
  const [portalInfo, setPortalInfo] = useState<PortalInfo | null>(null)
  const [status, setStatus] = useState("Fetching portal bootstrap coin id...")
  const [waitingForTx, setWaitingForTx] = useState(false)
  const [welcomeKitOffer, setWelcomeKitOffer] = useState<string | null>(null)
  const { createOffer, address } = useWallet()
  const isConnectedToChiaWallet = Boolean(address)

  useQuery({
    queryKey: ['StepThree_bootstrapPortalCoinId', rawMessage.nonce],
    queryFn: async () => {
      try {
        const newPortalInfo = await bootstrapPortal(portalInfo, destinationChain, rawMessage, setStatus);
        setPortalInfo(newPortalInfo)
      } catch(_) {
        console.error(_)
        setStatus("Failed to fetch portal bootstrap coin id.")
      }

      return 1
    },
    refetchInterval: 5000,
  });

  useQuery({
    queryKey: ['StepThree_checkWelcomeKit', rawMessage.sourceChainHex, rawMessage.nonce],
    queryFn: async () => {
      if (destinationChain.type === NetworkType.COINSET) {
        const response = await fetch('https://welcome-kits.kuhi.to/offers')
        const data = await response.json()
        const lookupKey = `${sourceChain.id}-${rawMessage.nonce.replace("0x", "")}`
        if (data.active_offers && data.active_offers[lookupKey]) {
          console.log("Welcome kit offer found")
          setWelcomeKitOffer(data.active_offers[lookupKey])
        }
      }
      return null
    },
    enabled: destinationChain.type === NetworkType.COINSET
  });

  const generateOfferPls = async () => {
    setWaitingForTx(true)
    try {
      const params = {
        offerAssets: [
          {
            assetId: "",
            amount: amount
          }
        ],
        requestAssets: [],
        fee: 2500000000,
      }
      const offer = await createOffer(params)
      if (offer) {
        onOfferGenerated(portalInfo?.coinId ?? "", offer)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setWaitingForTx(false)
    }
  }

  if(portalInfo === null) {
    return (
      <div className="flex gap-2 items-center bg-background h-14 w-full px-6 rounded-md font-light">
        <Loader className="w-4 shrink-0 h-auto animate-spin" />
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
          <p className="animate-pulse">{status}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      {portalInfo.mempoolSb !== null && <ChiaFeeWarning portalInfo={portalInfo} />}
      {portalInfo.mempoolSb === null && welcomeKitOffer !== null && (
        <div className="p-6 mb-2 bg-green-100 dark:bg-green-900 flex flex-col gap-2 font-light rounded-md relative animate-in fade-in slide-in-from-bottom-2 duration-500">
          <h3 className="text-xl font-medium">Welcome Kit Available</h3>
          <p className="opacity-90">
            Your transaction is eligible to receive a welcome kit - click the button below 
            to finish bridging and receive 0.00042 additional XCH. Welcome to Chia!
          </p>
          <p className="opacity-90 w-full text-right pr-4">
            - Yak
          </p>

          <Button className="w-full mt-4 h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl" onClick={() => {
            onOfferGenerated(portalInfo?.coinId ?? "", welcomeKitOffer)
          }}>
            Claim Welcome Kit
          </Button>
        </div>
      )}
      <div className="p-6 mt-2 bg-background flex flex-col gap-2 font-light rounded-md relative animate-in fade-in slide-in-from-bottom-2 duration-500">
        <p className="px-4">
          Click the button below to create an offer for minting assets on {destinationChain.displayName}.
          Note that using lower fees will result in slower confirmations.
        </p>
        <div className="w-full mt-6">
          {!waitingForTx ? (
            <>
              <Button
                disabled={!isConnectedToChiaWallet}
                className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
                onClick={isConnectedToChiaWallet ? generateOfferPls : () => { }}
              >
                {isConnectedToChiaWallet ? 'Generate Offer via Wallet' : 'Connect Chia Wallet'}
              </Button>
              <OrPasteOffer
                onOfferSubmitted={async (manualOffer: string) => await onOfferGenerated(portalInfo?.coinId ?? "", manualOffer)}
                requiredAssetsStr={`${ethers.formatUnits(amount, 12)} XCH`}
              />
            </>
          ) : (
            <Button
              className="relative flex items-center gap-2 w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
              disabled={true}
            >
              <p className="animate-pulse whitespace-normal">Waiting for transaction approval</p>
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

function FinalCoinsetTxConfirmer({
  destinationChain,
  txId,
}: {
  destinationChain: Network,
  txId: string
}) {
  const [coinRecord, setCoinRecord] = useState<any>(null)
  const includedInBlock = coinRecord?.spent === true

  const { data } = useQuery({
    queryKey: ['StepThree_getCoinRecordByName', txId],
    queryFn: () => getCoinRecordByName(destinationChain.rpcUrl, txId).then((res) => {
      setCoinRecord(res)
      return 1
    }),
    enabled: !includedInBlock,
    refetchInterval: 5000,
  })

  return (
    <div className="flex flex-col">
      <div className="p-6 my-2 bg-background flex flex-col gap-2 font-light rounded-md relative animate-in fade-in slide-in-from-bottom-2 duration-500">
        <p className="font-extralight opacity-80 mb-4">Transaction ID</p>
        <p className="text-xl font-light">{txId}</p>
      </div>
        {
        includedInBlock ? (
          <>
            <div className="p-6 bg-background flex gap-2 font-light rounded-md animate-[delayed-fade-in_0.4s_ease_forwards]">
              <div className="flex flex-col w-full gap-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
                <p className="font-extralight opacity-80 mb-4">Transaction Sent</p>
                <Button className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl" asChild>
                  <Link href={`${destinationChain.explorerUrl}coin/0x${txId}`} target="_blank">Verify on SpaceScan <ArrowUpRight className="w-5 mb-3 h-auto" /></Link>
                </Button>
                {destinationChain.explorer2Url && (
                  <Button className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl" asChild>
                    <Link href={`${destinationChain.explorer2Url}txns/0x${txId}`} target="_blank">Verify on XCHScan <ArrowUpRight className="w-5 mb-3 h-auto" /></Link>
                  </Button>
                )}
              </div>
            </div>
            <div className="p-6 py-4 mt-2 bg-background flex flex-col gap-2 font-light rounded-md relative animate-[delayed-fade-in_0.7s_ease_forwards]">
              <div className="flex items-center gap-2">
                <TriangleAlert className="opacity-80 w-4 h-auto" />
                <p className="opacity-80">Don&apos;t see your bridged asset?</p>
                <Button variant="outline" className="ml-auto" asChild><Link href="/bridge/assets" target="_blank">Add to Wallet</Link></Button>
              </div>
            </div>
          </>
        ) : (
          <div className="p-6 bg-background flex gap-2 font-light rounded-md animate-[delayed-fade-in_0.7s_ease_forwards]">
            <Loader className="w-4 shrink-0 h-auto animate-spin" />
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
              <p className="animate-pulse">Waiting for transaction to be included in a block...</p>
            </div>
          </div>
        )
      }
    </div>
  )
}

function FinalEVMTxConfirmer({
  destinationChain,
  txId,
  unwrappedSymbol,
}: {
  destinationChain: Network,
  txId: string,
  // Set when the claim and the unwrap already happened together in txId.
  unwrappedSymbol?: string,
}) {
  const searchParams = useSearchParams()
  const destinationAddr = searchParams.get('destination') as string
  const toChainName = searchParams.get('to')
  const chainId = NETWORKS.find(n => n.id === toChainName)?.chainId

  // An ERC20Bridge release of a wrapped stock pays out the wrapper token:
  // offer to unwrap it. Message contents are [asset, receiver, mojo amount].
  let unwrapPrompt = null
  try {
    const contents: string[] = JSON.parse(searchParams.get('contents') ?? '[]')
    const isBridgeRelease = destinationChain.erc20BridgeAddress !== undefined &&
      destinationAddr?.toLowerCase() === destinationChain.erc20BridgeAddress.toLowerCase()
    if (unwrappedSymbol === undefined && isBridgeRelease && contents.length === 3) {
      const asset = '0x' + contents[0].replace('0x', '').slice(-40).toLowerCase()
      const receiver = ethers.getAddress('0x' + contents[1].replace('0x', '').slice(-40))
      for (const token of TOKENS) {
        const info = getWrappedStockInfo(token, destinationChain.id)
        if (info !== undefined && info.contractAddress.toLowerCase() === asset) {
          unwrapPrompt = (
            <UnwrapPrompt
              symbol={token.symbol}
              tokenInfo={info}
              chain={destinationChain}
              claimTxId={txId as `0x${string}`}
              receiver={receiver}
              amountMojo={BigInt('0x' + contents[2].replace('0x', ''))}
            />
          )
        }
      }
    }
  } catch (_) {
    unwrapPrompt = null
  }

  return (
    <div className="flex flex-col">
      <div className="p-6 my-2 bg-background flex flex-col gap-2 font-light rounded-md relative animate-in fade-in slide-in-from-bottom-2 duration-500">
        <p className="font-extralight opacity-80 mb-4">Transaction ID</p>
        <p className="text-xl font-light">{txId}</p>
      </div>
      <div className="p-6 bg-background flex gap-2 font-light rounded-md animate-[delayed-fade-in_0.4s_ease_forwards]">
        <div className="flex flex-col w-full gap-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
          <p className="font-extralight opacity-80 mb-4">Transaction Confirmed</p>
          <Button className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl" asChild>
            <Link href={`${destinationChain.explorerUrl}/tx/${txId}`} target="_blank">View on Explorer <ArrowUpRight className="w-5 mb-3 ml-0.5 h-auto" /></Link>
          </Button>
        </div>
      </div>
      {unwrapPrompt}
      {unwrappedSymbol !== undefined && (
        <div className="p-6 mt-2 bg-background flex flex-col gap-2 font-light rounded-md animate-in fade-in slide-in-from-bottom-2 duration-500">
          <p>Claimed and unwrapped in this transaction. The {unwrappedSymbol} is in your wallet.</p>
        </div>
      )}
      <div className="p-6 py-4 mt-2 bg-background flex flex-col gap-2 font-light rounded-md relative animate-[delayed-fade-in_0.7s_ease_forwards]">
        <div className="flex items-center gap-2">
          <TriangleAlert className="opacity-80 w-4 h-auto" />
          <p className="opacity-80">Don&apos;t see your bridged asset?</p>
          {chainId ? <AddERCTokenButton tokenAddress={destinationAddr} tokenChainId={chainId} /> : <Button variant="ghost" className="ml-auto" asChild><Link href={`/bridge/assets?addAssets=${destinationAddr}`} target="_blank">+ Add to Wallet</Link></Button>}
        </div>
      </div>
    </div>
  )
}
