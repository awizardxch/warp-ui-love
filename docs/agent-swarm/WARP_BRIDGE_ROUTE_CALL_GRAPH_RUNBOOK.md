# Warp Bridge Route Call Graph Runbook

> All constants, addresses, puzzle hashes, and function signatures referenced here are in `IMPLEMENTATION_CONSTANTS.md`.

## Overview

The bridge is a 4-step wizard. All state is URL-encoded. Steps are:
- **StepZero**: Select route, token, amount, wallets.
- **StepOne**: Initiate source transaction (Chia offer or EVM wagmi call).
- **StepTwo**: Wait for source tx confirmation and extract nonce.
- **StepThree**: Accept message on destination chain.

Page router reads `?step=` query param to render the correct component.

---

## Route Decision Matrix

| Source | Destination | Token origin | StepOne driver | StepThree driver |
|--------|-------------|--------------|----------------|-----------------|
| Chia | EVM | COINSET (XCH/CAT) | `lockCATs` | EVM `portal.receiveMessage` |
| Chia | EVM | EVM (wrapped ERC20 CAT) | `burnCATs` | EVM `portal.receiveMessage` |
| EVM | Chia | EVM (ERC20 bridging in) | wagmi `bridgeToChia` / `bridgeEtherToChia` | `mintCATs` |
| EVM | Chia | COINSET (wrapped token returning) | wagmi `bridgeBack` | `unlockCATs` |

---

## Call Graph 1: Chia → EVM (StepOne)

### 1. UI Entry
```
StepOne.tsx → ChiaButton component
```

### 2. Offer Generation
```
WalletContext.createOffer(params)
  → sage adapter: SignClient.request("chia_createOffer", {offerAssets, requestAssets, fee})
  → ozone adapter: SignClient.request("chia_createOfferForIds", {offerAssets, requestAssets, fee})
  → goby adapter: window.chia.request({method: "createOffer", params})
Returns: offer string (bech32m compressed SpendBundle)
```

### 3. Driver Selection
```typescript
if (token.sourceNetworkType === NetworkType.EVM) {
  // Token originated on EVM — burn wrapped CATs to release ERC20
  [spendBundle, nonce] = await burnCATs(offer, coinsetNetwork, evmNetwork, 
    token.contractAddress, ethReceiver, updateStatus)
} else {
  // Token originated on Chia — lock CATs/XCH to mint wrapped on EVM
  [spendBundle, nonce] = await lockCATs(offer, evmNetwork, coinsetNetwork, 
    tokenTailHash, wrappedCatContractAddress, ethReceiver, updateStatus)
}
```
- `tokenTailHash = null` when token is XCH (assetId = "00".repeat(32))
- Fee validation: minimum offerAssets amount to cover 0.3% protocol fee + 1 mojo minimum

### 4. BLS Init (inside each driver)
```typescript
const blsOk = await initializeBLSWithRetries()  // max 2 retries, 1s delay
if (!blsOk) return ["", ""]  // surfaces error to UI
```

### 5. Offer Parsing (inside lockCATs / burnCATs)
```typescript
const [coinSpends, aggSig, securityCoin, securityCoinPuzzle, tempSk, tailHash, catSourceCoin, lineageProof]
  = await parseXCHAndCATOffer(offer)
// parseXCHOffer used only for XCH-only offers without a CAT spend
```

### 6. Message Coin Spend (inside lockCATs / burnCATs)
```typescript
// Coin spent in vault (locker puzzle) triggers outgoing message coin
const messageCoinSpend = spendOutgoingMessageCoin(coinsetNetwork, parentCoinInfo)
// message coin id = nonce for the cross-chain message
```

### 7. Push to Chia
```typescript
const [response, feeError] = await pushTx(coinsetNetwork.rpcUrl, spendBundle)
// nonce returned from driver = message coin id
// URL: getStepTwoURL({sourceNetworkId, destinationNetworkId, txHash: nonce})
```

---

## Call Graph 2: EVM → Chia (StepOne)

### 1. UI Entry
```
StepOne.tsx → EthereumButton component
Uses wagmi useWriteContract hook
```

### 2. Contract Call Branching
```typescript
// ETH (native ether):
writeContract({
  address: portalAddress,
  abi: PortalABI,
  functionName: "bridgeEtherToChia",
  args: [receiver_bytes32, messageToll],
  value: parseEther(amount) + messageToll
})

// EVM-origin ERC20 (USDT, USDC, EURC, etc.):
// First: approve erc20BridgeAddress for mojoAmount
writeContract({ address: tokenAddress, abi: erc20ABI, functionName: "approve",
  args: [erc20BridgeAddress, mojoAmount] })
// Then: bridge
writeContract({
  address: erc20BridgeAddress, abi: ERC20BridgeABI,
  functionName: "bridgeToChia",
  args: [tokenContractAddress, receiver_bytes32, mojoAmount],
  value: messageToll
})

// Chia-origin wrapped CAT on EVM (WrappedCAT contract):
writeContract({
  address: token.contractAddress, abi: WrappedCATABI,
  functionName: "bridgeBack",
  args: [receiver_bytes32, amount],
  value: messageToll
})
```
- `messageToll = ethers.parseEther("0.00001")`
- USDT uses `USDTABI` (not standard erc20ABI) because USDT.approve has no return value
- `receiver_bytes32` = `"0x" + recipientPuzzleHash` (32-byte hex)

### 3. After EVM tx submitted
```
URL: getStepTwoURL({sourceNetworkId, destinationNetworkId, txHash: evmTxHash})
```

---

## Call Graph 3: StepTwo — Wait for Confirmation

### Chia Source Path
```typescript
// Poll getCoinRecordByName(rpcUrl, txHash) until coin_record.spent === true
// Then count blocks: blockchainState.peak.height - coin_record.spent_block_index >= confirmationMinHeight
// confirmationMinHeight = 32 (mainnet), 5 (testnet11)
```

### EVM Source Path
```typescript
// wagmi useWaitForTransactionReceipt(txHash)
// Once receipt received, parse MessageSent event from logs:
const eventSig = ethers.id("MessageSent(bytes32,address,bytes3,bytes32,bytes32[])")
const log = receipt.logs.find(l => l.topics[0] === eventSig)
const nonce = log.topics[1]  // indexed bytes32
const [source, destChain, destination, contents] =
  AbiCoder.decode(["address","bytes3","bytes32","bytes32[]"], log.data)

// Base chain: checks l1BlockContractAddress for L1 confirmation height before allowing proceed
// confirmationMinHeight = 64 (ETH mainnet), 10 (Base testnet)
```

### Transition
```
URL: getStepThreeURL({sourceNetworkId, destinationNetworkId, nonce, source, destination, contents, offer?, portalBootstrapId?})
```
- `offer` param included only for Chia destination paths (wallet must provide offer for fee payment)
- `portalBootstrapId` included when known from Nostr bootstrapping

---

## Call Graph 4: StepThree — Destination Acceptance (EVM)

### Entry condition
Source = Chia or EVM, Destination = EVM (eth or bse)

### 1. Signature Collection
```typescript
const rawMessage: RawMessage = { nonce, sourceChainHex, destinationChainHex, sourceHex, destinationHex, contents }

// No coinId needed for EVM destination — validators sign routing data only
const [sigStrings, selectors] = await getSigsAndSelectors(
  rawMessage,
  null,          // coinId = null for EVM
  sigLimit,
  destinationEVMNetwork
)
// Returns when signatureThreshold met (6 mainnet, 3 testnet)
```

### 2. Signature Verification (inside getSigsAndSelectors for EVM)
```typescript
const domain = {
  name: "warp.green Portal",
  version: "1",
  chainId: destinationNetwork.chainId,
  verifyingContract: destinationNetwork.portalAddress
}
const types = {
  Message: [
    { name: "nonce",           type: "bytes32" },
    { name: "source_chain",    type: "bytes3"  },
    { name: "source",          type: "bytes32" },
    { name: "destination",     type: "address" },
    { name: "contents",        type: "bytes32[]" }
  ]
}
const recoveredAddress = ethers.verifyTypedData(domain, types, msgStruct, sig)
// Must match expected validator address; sorted ascending by address
```

### 3. Portal receiveMessage Call
```typescript
const packedSigs = "0x" + sigStrings.map(s => decodeSignature(s)[4]).join("")
writeContract({
  address: destinationNetwork.portalAddress,
  abi: PortalABI,
  functionName: "receiveMessage",
  args: [nonce, sourceChain, source, destination, contents, packedSigs]
})
```

---

## Call Graph 5: StepThree — Destination Acceptance (Chia)

### Entry condition
Source = EVM, Destination = Chia (xch)

### 1. Determine Driver Branch
```typescript
const isNativeCAT = rawMessage.contents.length === 2
// 2 items → Chia-origin token returning → unlockCATs
// 3 items → EVM-origin ERC20 arriving → mintCATs
```

### 2. Portal Bootstrap
```typescript
let portalInfo = await bootstrapPortal(currentPortalInfo, xchNetwork, rawMessage, updateStatus)
// If no portalBootstrapId in URL: queries Nostr for first sig to get initial portal coin id
// Fetches portal coin from Chia RPC, walks singleton chain to current coin
```

### 3a. EVM-origin ERC20 path (isNativeCAT === false, contents.length === 3)
```typescript
const [spendBundle, txId] = await mintCATs(
  portalInfo.coinId,
  offer,             // user's Chia wallet offer string (for fee)
  rawMessage,
  coinsetNetwork,
  updateStatus
)
// contents[0] = EVM contract address → used to determine wrapped TAIL
// contents[1] = xchReceiverPuzzleHash
// contents[2] = tokenAmount
```

### 3b. Chia-origin token return path (isNativeCAT === true, contents.length === 2)
```typescript
const [spendBundle, txId] = await unlockCATs(
  portalInfo.coinId,
  offer,             // user's Chia wallet offer string (for fee)
  rawMessage,
  tokenTailHash,    // null for XCH; CAT TAIL hash for CATs
  evmNetwork,
  coinsetNetwork,
  updateStatus
)
// contents[0] = xchReceiverPuzzleHash
// contents[1] = tokenAmount
```

### 4. Inside mintCATs / unlockCATs (shared inner path)
```typescript
// Both call receiveMessageAndSpendMessageCoin(portalInfo.coinId, network, rawMessage, ...)
// Which calls:
//   findLatestPortalState(rpcUrl, nonce, sourceChainHex, destChainHex, bootstrapCoinId)
//   getSigsAndSelectors(rawMessage, portalCoinId, sigLimit)   // coinset mode, coinId provided
//   getPortalReceiverInnerPuzzle(...)
//   getPortalReceiverInnerSolution(...)
// Returns [coinSpends, sigStrings, messageReceiverCoin]
// Driver then appends its own coin spends (vault unlock or CAT mint)
// buildSpendBundle(allCoinSpends, allSigs)
// pushTx(rpcUrl, spendBundle)
```

### 5. Welcome Kit Check (Chia destination only)
```typescript
// Before accepting: check if recipient has any XCH coins
// If not: attempt to get welcome kit offer from https://welcome-kits.kuhi.to/offers
// Welcome kit provides seed XCH for fees — optional, does not block main flow
```

---

## URL State Machine Summary

```
Step 0: /bridge  (or /)
Step 1: /bridge?step=1&from=<id>&to=<id>&token=<symbol>&recipient=<addr>&amount=<decimal>[&offer=<str>]
Step 2: /bridge?step=2&from=<id>&to=<id>&tx=<hash>
Step 3 (EVM dest): /bridge?step=3&from=<id>&to=<id>&nonce=<0xhex>&source=<0xhex>&destination=<0xhex>&contents=<JSON>[&tx=<hash>]
Step 3 (Chia dest): /bridge?step=3&from=<id>&to=<id>&nonce=<0xhex>&source=<0xhex>&destination=<0xhex>&contents=<JSON>&offer=<str>&portal_bootstrap_id=<coinId>[&tx=<hash>]
```

Network IDs: `xch`, `eth`, `bse`  
`tx` present in Step 3 = flow complete, show explorer link.

---

## RawMessage Construction Reference

```typescript
// From EVM source (StepTwo parsing MessageSent event):
{
  nonce:              log.topics[1].slice(2),          // strip 0x, 64 hex chars
  sourceChainHex:     hexlify(sourceChainBytes3),       // e.g. "657468" for "eth"
  sourceHex:          sourceAddress_0xpadded_to_32bytes.slice(2),
  destinationChainHex: hexlify(destChainBytes3),        // e.g. "786368" for "xch"
  destinationHex:     destination_b32.slice(2),
  contents:           contents.map(c => c.slice(2))     // strip 0x from each bytes32
}

// From Chia source (nonce = message coin id, extracted after pushTx):
{
  nonce:              messageCoinId,                    // 64 hex chars, no 0x
  sourceChainHex:     stringToHex("xch"),               // "786368"
  sourceHex:          lockerPuzzleHash,
  destinationChainHex: stringToHex(evmNetwork.id),
  destinationHex:     ethReceiverAddress_0xpadded,
  contents:           [evmContractAddr_b32?, xchPH_b32, amount_b32]
}
```

---

## Error Recovery

| Error | Action |
|-------|--------|
| BLS init failure | Retry up to 2 times with 1s delay; surface error if all fail |
| Signature threshold not met | Poll NOSTR relays, retry getSigsAndSelectors |
| Portal coin not found | bootstrapPortal re-fetches from NOSTR first signature |
| pushTx feeError | Surface fee too low; user must retry with higher offer fee |
| ERC20 approve tx pending | Wait for approval receipt before bridgeToChia call |
| EVM tx reverted | Decode revert reason; check messageToll value, allowance, and recipient format |
