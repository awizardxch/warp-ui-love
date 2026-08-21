# Skill: chia-contract-drivers

> All puzzle hashes and function signatures are in `IMPLEMENTATION_CONSTANTS.md`.

## Purpose
Orchestrate Chia puzzle/contract driver execution for bridge actions, including portal/message coin mechanics and CAT lock/unlock or mint/burn paths.

## Use When
- Building Chia coin spends for bridge settlement.
- Selecting the correct driver (catbridge vs erc20bridge) for a given token type.
- Producing spend bundles for portal, vault, and CAT operations.

---

## Driver Selection Logic

### StepOne — Chia source → EVM destination

```typescript
if (token.sourceNetworkType === NetworkType.EVM) {
  // These are wrapped ERC20 CATs on Chia being sent BACK to EVM
  // Driver burns the wrapped CATs and sends a message to EVM to release original ERC20
  [sb, nonce] = await burnCATs(offer, coinsetNetwork, evmNetwork, 
    token.contractAddress, ethReceiver, updateStatus)
} else {
  // These are Chia-native CATs or XCH being sent TO EVM
  // Driver locks them in a vault and sends a message to EVM to mint wrapped tokens
  [sb, nonce] = await lockCATs(offer, evmNetwork, coinsetNetwork,
    tokenTailHash, wrappedCatContractAddress, ethReceiver, updateStatus)
}
```

### StepThree — EVM source → Chia destination

```typescript
const isNativeCAT = rawMessage.contents.length === 2
if (isNativeCAT) {
  // Chia-origin token returning: contents = [xchReceiverPH, tokenAmount]
  [sb, txId] = await unlockCATs(portalBootstrapCoinId, offer, rawMessage,
    tokenTailHash, evmNetwork, coinsetNetwork, updateStatus)
} else {
  // EVM-origin ERC20 arriving: contents = [ethAssetContract, xchReceiverPH, tokenAmount]
  [sb, txId] = await mintCATs(portalBootstrapCoinId, offer, rawMessage,
    coinsetNetwork, updateStatus)
}
```

---

## Driver: lockCATs (catbridge.tsx)

**When to use**: Chia source, EVM destination, token originates on Chia (COINSET type).

```typescript
async function lockCATs(
  offer: string,
  evmNetwork: Network,               // destination EVM network
  coinsetNetwork: Network,            // source Chia network
  tokenTailHash: string | null,       // null = XCH; hex TAIL hash = CAT
  wrappedCatContractAddress: string,  // EVM contract that mints wrapped version
  ethTokenReceiverAddress: string,    // EVM recipient address (rejects "0x00..00")
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>    // [spendBundle, nonce (= message coin id)]
```

Internals:
1. `initializeBLSWithRetries()`
2. `parseXCHAndCATOffer(offer)` → coin spends, aggSig, security coin
3. Build locker puzzle: curry `LOCKER_MOD` with vault puzzle hash
4. Build vault spend: lock catSourceCoin in locker puzzle
5. `spendOutgoingMessageCoin(coinsetNetwork, parentCoinInfo)` → message coin spend
6. `buildSpendBundle(coinSpends, sigs)` → aggregated SpendBundle
7. Return `[SpendBundle, messageCoinId]`

Key puzzle hashes used:
- `LOCKER_MOD` (from catbridge.tsx hex literal)
- `P2_CONTROLLER_PUZZLE_HASH_MOD_HASH = "a8082b5622ccb27e89f196f024f9851dee0bcb0f2d8afd395caa6d4432f6f85f"`
- `BRIDGING_PUZZLE_HASH = "a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037"`

---

## Driver: burnCATs (erc20bridge.tsx)

**When to use**: Chia source, EVM destination, token originates on EVM (EVM type) — i.e., these are wrapped ERC20 CATs on Chia being redeemed.

```typescript
async function burnCATs(
  offer: string,
  coinsetNetwork: Network,           // source Chia network
  evmNetwork: Network,               // destination EVM network
  tokenContractAddress: string,      // EVM original ERC20 contract address
  ethTokenReceiverAddress: string,   // EVM recipient address
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>    // [spendBundle, nonce]
```

Internals:
1. `initializeBLSWithRetries()`
2. `parseXCHAndCATOffer(offer)`
3. Build `CAT_BURNER_MOD` puzzle curried with burn inner puzzle hash and EVM destination info
4. Build `BURN_INNER_PUZZLE_MOD` solution that sends message to EVM portal
5. Spend the wrapped CAT coin using burner puzzle
6. `spendOutgoingMessageCoin(coinsetNetwork, parentCoinInfo)`
7. `buildSpendBundle` and return `[SpendBundle, nonce]`

Key module hashes:
- `BURN_INNER_PUZZLE_MOD_HASH = "69b9ac68db61a9941ff537cbb69158a7e1015ad44c42cff905159909cd8e1f90"`
- `WRAPPED_TAIL_MOD_HASH = "2d7e6fd2e8dd27536ebba2cf6b9fde09493fa10037aa64e14b201762c902f013"`
- `CAT_MINT_AND_PAYOUT_MOD_HASH = "2c78140b52765a1c063062775d31a33a452410e9777c01270c1001db6e821f37"`

---

## Driver: unlockCATs (catbridge.tsx)

**When to use**: Chia destination, EVM source, token originated on Chia (COINSET type) — returning from EVM.
Contents must have length 2.

```typescript
async function unlockCATs(
  portalBootstrapCoinId: string,
  offer: string,
  rawMessage: RawMessage,
  tokenTailHash: string | null,   // null = XCH; hex TAIL hash for CAT
  evmNetwork: Network,            // source EVM network
  coinsetNetwork: Network,         // destination Chia network
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>  // [spendBundle, txId = message coin id]
```

Internals:
1. `initializeBLSWithRetries()`
2. `parseXCHAndCATOffer(offer)` for fee payment
3. `receiveMessageAndSpendMessageCoin(portalBootstrapCoinId, ...)` → portal + message coin spends
4. Find locked coins in vault by puzzle hash `getCoinRecordsByPuzzleHash(rpcUrl, lockerPuzzleHash)`
5. Build `UNLOCKER_MOD` spend to release locked coins to receiver
6. If XCH: direct output; if CAT: rebuild CAT puzzle with lineage proof
7. `buildSpendBundle` and return

---

## Driver: mintCATs (erc20bridge.tsx)

**When to use**: Chia destination, EVM source, token originated on EVM (EVM type).
Contents must have length 3.

```typescript
async function mintCATs(
  portalBootstrapCoinId: string,
  offer: string,
  rawMessage: RawMessage,
  coinsetNetwork: Network,          // destination Chia network
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>   // [spendBundle, txId]
```

Internals:
1. `initializeBLSWithRetries()`
2. `parseXCHAndCATOffer(offer)` for fee payment
3. Decode `contents[0]` as EVM contract address → compute `getWrappedERC20AssetID(evmNetwork, addr)`
4. Build `CAT_MINTER_MOD` puzzle curried with wrapped TAIL
5. Build `CAT_MINT_AND_PAYOUT_MOD` to mint new wrapped CATs to receiver
6. `receiveMessageAndSpendMessageCoin(portalBootstrapCoinId, ...)` → portal + message coin spends
7. `buildSpendBundle` and return

---

## Portal Singleton Mechanics

### findLatestPortalState
```typescript
async function findLatestPortalState(
  rpcUrl: string,
  messageNonce: string,           // hex
  messageSourceChainHex: string,
  messageDestChainHex: string,
  bootstrapCoinId: string
): Promise<PortalInfo>
```
- Starts at `bootstrapCoinId` (portal launcher or known recent coin).
- Calls `getCoinRecordByName` → if spent, follows to next coin via `getPuzzleAndSolution`.
- Inspects mempool via `getMempoolItemsByCoinName` for pending portal spends.
- Returns current `PortalInfo` with active coin id and mempool state.

### bootstrapPortal
```typescript
async function bootstrapPortal(
  currentPortalInfo: PortalInfo | null,
  xchNetwork: Network,
  message: RawMessage,
  updateStatus: (s: string) => void
): Promise<PortalInfo>
```
- If `currentPortalInfo` is null: queries NOSTR for first matching signature to get the portal coin id embedded in the signature's coin data.
- Then calls `findLatestPortalState` to walk to current state.

### PortalInfo type
```typescript
type PortalInfo = {
  coinId: string                            // current active portal coin id
  messageCoinAlreadyCreated: boolean        // true if message coin exists in mempool
  mempoolPendingThings: [RawMessage, number][]  // pending messages and indices
  mempoolSb: SpendBundle | null            // pending spend bundle if exists
  mempoolSbCost: BigNumber
  mempoolSbFee: BigNumber
}
```

---

## Key Puzzle Hashes (Required to Reconstruct)

```
CAT_MOD_HASH                       = "37bef360ee858133b69d595a906dc45d01af50379dad515eb9518abb7c1d2a7a"
SINGLETON_MOD_HASH                 = "7faa3253bfddd1e0decb0906b2dc6247bbc4cf608f58345d173adb63e8b47c9f"
SINGLETON_LAUNCHER_HASH            = "eff07522495060c066f66f32acc2a77e3a3e737aca8baea4d1a64ea4cdc13da9"
BRIDGING_PUZZLE_HASH               = "a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037"
OFFER_MOD_HASH                     = "cfbfdeed5c4ca2de3d0bf520b9cb4bb7743a359bd2e6a188d19ce7dffc21d3e7"
P2_CONTROLLER_PUZZLE_HASH_MOD_HASH = "a8082b5622ccb27e89f196f024f9851dee0bcb0f2d8afd395caa6d4432f6f85f"
CAT_MINT_AND_PAYOUT_MOD_HASH       = "2c78140b52765a1c063062775d31a33a452410e9777c01270c1001db6e821f37"
WRAPPED_TAIL_MOD_HASH              = "2d7e6fd2e8dd27536ebba2cf6b9fde09493fa10037aa64e14b201762c902f013"
BURN_INNER_PUZZLE_MOD_HASH         = "69b9ac68db61a9941ff537cbb69158a7e1015ad44c42cff905159909cd8e1f90"
```

---

## BLS Initialization

All four driver functions call `initializeBLSWithRetries()` as their first step:

```typescript
async function initializeBLSWithRetries(): Promise<boolean> {
  // Attempts to initialize BLS WebAssembly module
  // Max 2 retries, 1 second delay between attempts
  // Returns false if all attempts fail
}
// If false: driver returns empty SpendBundle and empty nonce ""
```

---

## getWrappedERC20AssetID

```typescript
// Computes the Chia CAT assetId for a given EVM chain + ERC20 contract.
// Deterministic: changes if portalLauncherId changes.
function getWrappedERC20AssetID(sourceChain: Network, erc20ContractAddress: string): string {
  // Unhexlify contract address, pad to 32 bytes (64 hex chars)
  // sha256tree of wrappedTAIL curried with:
  //   - CHIA_NETWORK.portalLauncherId
  //   - stringToHex(sourceChain.id)       e.g. "627365" for "bse"
  //   - GreenWeb.util.unhexlify(sourceChain.erc20BridgeAddress)
  //   - padded contract address (32 bytes)
}
```

---

## Security Coin Pattern

Every spend bundle in the bridge includes a security coin:
- Ephemeral coin created from a random BLS private key (`tempSk`).
- Bound to the bundle via a BLS signature over the spend conditions.
- Prevents replay attacks: same offer cannot be submitted twice.
- `parseXCHOffer` and `parseXCHAndCATOffer` both extract the security coin and tempSk from the offer.
- All four drivers call `getSecurityCoinSig(securityCoin, conditions, tempSk, aggSigData)` to add the security sig.
