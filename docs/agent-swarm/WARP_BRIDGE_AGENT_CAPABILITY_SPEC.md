# Warp Bridge Agent Capability Spec

> **Companion reference**: `IMPLEMENTATION_CONSTANTS.md` contains ALL puzzle hashes, network addresses, NOSTR relay URLs, validator keys, token assetIds, function signatures, and fee conventions.
> Read IMPLEMENTATION_CONSTANTS.md first when rebuilding. This document describes architecture; that document provides the values.

---

## Purpose
This document defines a reusable capability pack for another agent swarm that must:
- Create and consume Chia offers for bridge operations.
- Work with Chia puzzle/contract driver flows (catbridge, erc20bridge, portal).
- Execute cross-chain bridging between Chia and EVM chains (Ethereum + Base).
- Follow the validator signature model where offers/messages are validated, then accepted on the destination side.

## Scope
In scope:
- Offer generation through Chia wallets (Sage WC, Ozone WC, Goby browser extension).
- EVM-source transactions via wagmi/web3modal.
- Chia contract/puzzle composition in portal, CAT bridge, and ERC20 bridge drivers.
- Signature collection and verification from NOSTR validator relays.
- Message receive/accept flows for destination execution.

Out of scope:
- Smart contract source edits on EVM.
- Validator key management / relay infrastructure.

---

## Source Of Truth In Repo
Core flow entrypoints:
- src/app/bridge/steps/StepOne.tsx   — source transaction initiation (both Chia and EVM)
- src/app/bridge/steps/StepThree.tsx — destination acceptance (both Chia and EVM)

Wallet and offer creation:
- src/app/bridge/ChiaWalletManager/WalletContext.tsx
- src/app/bridge/ChiaWalletManager/wallets/sage.tsx
- src/app/bridge/ChiaWalletManager/wallets/walletconnect.tsx
- src/app/bridge/ChiaWalletManager/wallets/goby.tsx
- src/app/bridge/ChiaWalletManager/wallets/types.ts

Bridge driver logic:
- src/app/bridge/drivers/offer.tsx
- src/app/bridge/drivers/portal.tsx
- src/app/bridge/drivers/catbridge.tsx
- src/app/bridge/drivers/erc20bridge.tsx

Network/validator config:
- src/app/bridge/config.tsx

---

## High-Level Flow

### Chia Source Path
```
User selects route → Chia wallet creates offer → parseXCHOffer or parseXCHAndCATOffer
  → lockCATs (Chia-native token) or burnCATs (EVM-origin wrapped token)
  → SpendBundle pushed to Chia RPC → coin becomes nonce
  → StepTwo polls Chia for confirmation → StepThree accepts on destination
```

### EVM Source Path
```
User selects route → EVM wallet (wagmi) signs tx
  → bridgeEtherToChia / bridgeToChia / bridgeBack
  → StepTwo waits for EVM receipt, decodes MessageSent event → StepThree accepts on Chia
```

### Destination Acceptance (Chia)
```
Portal bootstrap → getSigsAndSelectors from NOSTR
  → receiveMessageAndSpendMessageCoin
  → mintCATs (EVM-origin ERC20 incoming) or unlockCATs (Chia-origin token returning)
  → SpendBundle pushed to Chia RPC
```

### Destination Acceptance (EVM)
```
getSigsAndSelectors from NOSTR (EVM mode, no coin tag)
  → verifyTypedData per validator, enforce threshold
  → Portal.receiveMessage with packed sigs
```

---

## Wallet Layer

### Three Chia Wallet Adapters

| Wallet | id | Mechanism |
|--------|----|-----------|
| Sage | `sage` | WalletConnect via @walletconnect/sign-client |
| Goby | `goby` | Browser extension, `window.chia.request()` — NOT WalletConnect |
| Ozone | `chiawalletconnect` | WalletConnect via @walletconnect/sign-client |

**Critical**: Goby does NOT use WalletConnect. It injects `window.chia` into the browser. Attempting to use WalletConnect methods with Goby will fail.

### Sage WalletConnect Methods
```
chia_getAddress       — returns wallet receive address
chia_createOffer      — params: { offerAssets, requestAssets, fee }
```
Sage adapter hardcodes `fee: 2500000000` (0.0025 XCH) on top of passed params.
Custom localStorage prefix: `"sage-wc-data"`.

### Ozone WalletConnect Methods
```
chia_getCurrentAddress  — returns { data: address }
chia_getWallets         — returns wallet list; used to find wallet_id for each assetId
chia_createOfferForIds  — params: { offerAssets by wallet_id, requestAssets, fee }
chia_addCATToken        — adds CAT token to wallet
```
Custom localStorage prefix: `"chia-wc-data"`.

### Goby Browser Extension Methods
```javascript
window.chia.request({ method: "connect" })                        // connect
window.chia.selectedAddress                                        // puzzle hash
window.chia.request({ method: "createOffer", params })            // create offer
window.chia.request({ method: "walletWatchAsset", params: {       // add CAT
  type: "cat",
  options: { assetId, symbol, logo }
}})
```

### createOfferParams Shape
```typescript
interface asset { assetId: string; amount: number }  // assetId = "" for XCH
interface createOfferParams {
  offerAssets:   asset[]   // bridge pays FROM these
  requestAssets: asset[]   // always [] in current bridge flows
  fee: number              // mojo integer
}
```

### EVM Wallet
- Connected via `@web3modal/wagmi` + wagmi hooks.
- WalletConnect project ID: `e47a64f2fc7214f6c9f71b8b71e5e786`
- Source tx calls are made via wagmi `useWriteContract`.

---

## Chia Source: ChiaButton in StepOne

When user initiates a bridge transaction from Chia:

1. Wallet generates offer string via `createOffer(params)`.
2. Driver selection based on token type:
   - `token.sourceNetworkType === EVM` → call `burnCATs(offer, coinsetNetwork, evmNetwork, tokenContractAddress, ethReceiver, updateStatus)`
   - `token.sourceNetworkType === COINSET` → call `lockCATs(offer, evmNetwork, coinsetNetwork, tokenTailHash, wrappedCatContractAddress, ethReceiver, updateStatus)`
3. Both return `[SpendBundle, nonce]`. `pushTx` sends SpendBundle to Chia RPC.
4. Nonce = coin id of the outgoing message coin. This becomes the cross-chain message identifier.
5. Proceed to StepTwo with `txHash = nonce`.

---

## EVM Source: EthereumButton in StepOne

When user initiates a bridge transaction from EVM:

Branching by token type:
```
ETH (native ether):
  contract: portalAddress → function bridgeEtherToChia(receiver bytes32, maxMessageToll uint256) payable
  value = parseEther(amount) + messageToll

EVM-origin ERC20 (e.g. USDT, USDC, EURC):
  Step 1 — ERC20.approve(erc20BridgeAddress, mojoAmount)
  Step 2 — function bridgeToChia(assetContract address, receiver bytes32, mojoAmount uint256) payable
  value = messageToll

Chia-origin wrapped CAT on EVM (WrappedCAT contract):
  contract: token's EVM contract → function bridgeBack(receiver bytes32, amount uint256) payable
  value = messageToll
```
- `receiver` = puzzle hash as bytes32 (zero-padded 32 bytes, no 0x prefix → add 0x prefix for ABI).
- `messageToll` = `ethers.parseEther("0.00001")` from network config.
- USDT requires `USDTABI` instead of standard `erc20ABI` (USDT does not return bool from approve).
- After tx confirmed, decode `MessageSent` event from tx receipt logs to extract `nonce, source, destination, contents`.

---

## Chia Contract Driver Responsibilities

### offer.tsx — Offer Parsing
- Decompress bech32m + zlib-compressed offer string into SpendBundle.
- Derive security coin (ephemeral coin with random tempSk).
- `parseXCHOffer` → for XCH-only offers.
- `parseXCHAndCATOffer` → for CAT-inclusive offers; returns tailHash, catSourceCoin, lineageProof.

### portal.tsx — Portal Singleton + Signature Collection
- `findLatestPortalState(rpcUrl, nonce, sourceChainHex, destChainHex, bootstrapCoinId)` → walks portal singleton chain to find current coin id and pending mempool items.
- `bootstrapPortal(currentPortalInfo|null, xchNetwork, message, updateStatus)` → fetches initial portal coin id from first NOSTR signature if no current info.
- `getSigsAndSelectors(rawMessage, coinId|null, sigLimit, targetEVMNetwork?)` → queries NOSTR relays, verifies EVM EIP-712 sigs or deduplicates Chia sigs, returns `[sigStrings, selectorBitmask]`.
- `receiveMessageAndSpendMessageCoin(portalBootstrapId, network, message, messageReceiverCoin, updateStatus)` → builds portal + message coin spends for Chia destination acceptance.
- `spendOutgoingMessageCoin(coinsetNetwork, parentCoinInfo)` → creates outgoing message coin spend (Chia source path).

### catbridge.tsx — Chia-Native Token Bridge
- `lockCATs(offer, evmNetwork, coinsetNetwork, tokenTailHash|null, wrappedCatContractAddress, ethReceiver, updateStatus)` → lock Chia-native CATs or XCH in vault, send message to EVM to mint wrapped token.
- `unlockCATs(portalBootstrapCoinId, offer, rawMessage, tokenTailHash|null, evmNetwork, coinsetNetwork, updateStatus)` → unlock previously-locked Chia-native CATs or XCH when incoming message arrives from EVM.

### erc20bridge.tsx — EVM-Origin ERC20 Token Bridge
- `burnCATs(offer, coinsetNetwork, evmNetwork, tokenContractAddress, ethReceiver, updateStatus)` → burn wrapped ERC20 CATs on Chia side, send message to EVM to release original ERC20.
- `mintCATs(portalBootstrapCoinId, offer, rawMessage, coinsetNetwork, updateStatus)` → mint new wrapped ERC20 CATs on Chia side when incoming EVM ERC20 bridge message arrives.
- `getWrappedERC20AssetID(sourceChain, erc20ContractAddress)` → compute deterministic CAT assetId for a given EVM chain + contract. Based on sha256tree of wrapped TAIL curried with portal launcher id.

---

## Driver Selection Logic (StepOne and StepThree)

### StepOne (Chia source → EVM destination)
```
if token.sourceNetworkType == EVM:
  burnCATs(offer, coinsetNetwork, evmNetwork, ...)   // burning wrapped ERC20 CATs to release originals on EVM
else:  // COINSET
  lockCATs(offer, evmNetwork, coinsetNetwork, ...)   // locking Chia-native tokens to mint wrapped on EVM
```

### StepThree (EVM source → Chia destination)
```
const isNativeCAT = rawMessage.contents.length === 2
if isNativeCAT:
  unlockCATs(...)   // Chia-origin token returning: 2-item contents [receiver, amount]
else:
  mintCATs(...)     // EVM-origin ERC20 arriving: 3-item contents [contractAddress, receiver, amount]
```

---

## Message Contents Array Semantics

The shape of `contents` in `RawMessage` determines the driver branch in StepThree:

| contents.length | Meaning | Driver |
|-----------------|---------|--------|
| 2 | Chia-origin token (XCH/CAT) returning from EVM | `unlockCATs` |
| 3 | EVM-origin ERC20 minted on Chia | `mintCATs` |

Contents format:
- 3 items: `[ethAssetContractAddr_b32, xchReceiverPH_b32, tokenAmount_b32]`
- 2 items: `[xchReceiverPH_b32, tokenAmount_b32]`

---

## Validator Validation and Acceptance Model

1. Build routing data from `sourceChainHex + destinationChainHex + nonce`.
2. bech32m-encode with prefix `"r"` → `routingData`.
3. For Chia destination: also encode `coinId` with prefix `"c"` → `coinData`.
4. Query NOSTR relays with filter `{ kinds: [1], "#r": [routingData], "#c": [coinData] }`.
5. For EVM destination: verify each validator's signature via `ethers.verifyTypedData(domain, types, msg, sig)`. Recover address must match expected validator address from network config. Sort validators by address ascending.
6. For Chia destination: deduplicate signatures by content; compute selector bitmask.
7. Enforce `signatureThreshold` from network config (6 for mainnet, 3 for testnet).
8. Concatenate raw sig bytes for EVM portal `receiveMessage` call.

---

## Chia-Specific: isNativeCAT vs Wrapped ERC20 in StepThree

```
isNativeCAT = (contents.length === 2)

Chia destination — native CAT path:
  unlockCATs(portalBootstrapCoinId, offer, rawMessage, tokenTailHash, evmNetwork, coinsetNetwork, ...)
  tokenTailHash = null for XCH; set from token.assetId for CATs

Chia destination — wrapped ERC20 path:
  mintCATs(portalBootstrapCoinId, offer, rawMessage, coinsetNetwork, ...)
  contents[0] decoded as EVM contract address to identify which wrapped TAIL to use
```

---

## Welcome Kit Integration (StepThree Chia destination)

If recipient's puzzle hash has no XCH coins, StepThree polls `https://welcome-kits.kuhi.to/offers` and attempts to obtain a welcome kit offer providing a small XCH seed for transaction fees. This is optional and does not block the main acceptance flow.

---

## Network Matrix
Three configured bridge networks:

| id | type | Chia field | EVM field |
|----|------|-----------|-----------|
| xch | COINSET | portalLauncherId, rpcUrl, prefix, confirmationMinHeight, messageToll | — |
| eth | EVM | — | chainId, portalAddress, erc20BridgeAddress, messageToll, confirmationMinHeight |
| bse | EVM | — | chainId, l1BlockContractAddress, portalAddress, erc20BridgeAddress |

All addresses, thresholds, validator keys, and RPC URLs → see IMPLEMENTATION_CONSTANTS.md.

---

## Non-Functional Requirements
- **Determinism**: Same inputs → consistent puzzle hashes and equivalent spend bundles.
- **Safety**: Reject zero-address EVM recipients, malformed puzzle hashes, empty assetIds.
- **BLS resilience**: `initializeBLSWithRetries()` max 2 retries with 1s delay; surface failure gracefully.
- **Status transparency**: Each driver and acceptor emits `updateStatus(string)` at every major stage.
- **Re-entrant StepThree**: URL carries all state; user may reload and resume without re-doing source tx.

---

## Acceptance Criteria For Another Swarm

A swarm integration is complete when it can:
- Generate an offer through Sage WalletConnect and return offer string.
- Initiate EVM-source bridge transaction via wagmi and parse MessageSent event.
- Parse Chia offer and branch correctly between CAT and wrapped ERC20 paths.
- Build source-chain spend bundle with proper message coin semantics.
- Collect enough validator signatures from NOSTR to satisfy destination network threshold.
- Verify EVM EIP-712 signatures against configured validator addresses.
- Reconstruct correct `contents` array and determine 2-item vs 3-item destination branch.
- Complete destination acceptance flow and return deterministic tx id/coin id.
