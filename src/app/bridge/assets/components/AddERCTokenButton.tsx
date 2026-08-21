import { Button } from "@/components/ui/button"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useAccount, useReadContract, useSwitchChain, useWalletClient } from "wagmi"
import { wagmiConfig } from "../../config"

const ERC20_DECIMALS_ABI = [{
  name: "decimals",
  type: "function",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "uint8" }],
}] as const
const ERC20_SYMBOL_ABI = [{
  name: "symbol",
  type: "function",
  stateMutability: "view",
  inputs: [],
  outputs: [{ name: "", type: "string" }],
}] as const

function AddERCTokenButton({ tokenAddress, tokenChainId, className }: { tokenAddress: string, tokenChainId: number | undefined, className?: string }) {
  const { chainId: currentUserChain, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { switchChainAsync } = useSwitchChain({ config: wagmiConfig })
  const { data: tokenDecimals, isLoading: isLoadingDecimals } = useReadContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
    chainId: tokenChainId,
    query: {
      enabled: Boolean(tokenAddress && tokenChainId),
    },
  })
  const { data: tokenSymbol, isLoading: isLoadingSymbol } = useReadContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_SYMBOL_ABI,
    functionName: "symbol",
    chainId: tokenChainId,
    query: {
      enabled: Boolean(tokenAddress && tokenChainId),
    },
  })
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const switchToCorrectChain = async (tokenChainId: number) => {
    await switchChainAsync({ chainId: tokenChainId })
  }

  const addToken = async () => {
    try {
      if (tokenChainId && currentUserChain !== tokenChainId) {
        await switchToCorrectChain(tokenChainId)
      }

      if (tokenDecimals === undefined || tokenSymbol === undefined) {
        throw new Error("Unable to read ERC-20 token metadata")
      }

      const requestPayload = {
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: tokenAddress,
            symbol: tokenSymbol,
            decimals: Number(tokenDecimals),
            image: "https://warp.green/warp-green-icon.png",
          },
        },
      }

      const wasAdded = walletClient
        ? await walletClient.request(requestPayload as any)
        : await window.ethereum?.request(requestPayload)

      if (wasAdded === undefined) {
        throw new Error("No compatible wallet provider found for wallet_watchAsset")
      }

      if (wasAdded) {
        toast.success(`Successfully added token to your wallet`, { id: "added-erc-token-success" })
      } else {
        throw new Error('Add token action unsuccessful')
      }
    } catch (error) {
      console.error("Failed to add ERC-20 token", error)
      toast.error(`Failed to add token to your wallet`, { id: "added-erc-token-failed" })
    }
  }


  const handleClick = async () => {
    try {
      setIsLoading(true)
      await addToken()
    } finally {
      setIsLoading(false)
    }
  }

  if (!isConnected) return <></>

  return (
    <Button disabled={isLoading || isLoadingDecimals || isLoadingSymbol || tokenDecimals === undefined || tokenSymbol === undefined} onClick={handleClick} variant="ghost" className={cn('ml-auto hidden sm:block', className)}><span className={cn((isLoading || isLoadingDecimals || isLoadingSymbol) && 'animate-pulse')}>{isLoading ? 'Confirm in Wallet' : isLoadingDecimals || isLoadingSymbol ? 'Loading token' : '+ Add to Wallet'}</span></Button>
  )
}

export default AddERCTokenButton