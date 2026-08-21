# Warp Bridge Implementation Constants

## Purpose
All raw values required to reconstruct the bridge system without the source repo.
A rebuilding agent must source every constant from this file, not from memory or inference.

---

## Module File Map

| File | Role |
|------|------|
| src/app/bridge/config.tsx | Network config, token registry, NOSTR config, WalletConnect project IDs |
| src/app/bridge/drivers/offer.tsx | Offer decompression, security coin derivation, parseXCHOffer, parseXCHAndCATOffer |
| src/app/bridge/drivers/portal.tsx | Portal singleton mechanics, message coin, signature collection, receiveMessageAndSpendMessageCoin |
| src/app/bridge/drivers/catbridge.tsx | lockCATs, unlockCATs, locker/unlocker puzzles |
| src/app/bridge/drivers/erc20bridge.tsx | burnCATs, mintCATs, wrapped TAIL, minter/burner puzzles, getWrappedERC20AssetID |
| src/app/bridge/drivers/cat.tsx | CAT_MOD, CAT_MOD_HASH, getCATPuzzle, getCATSolution |
| src/app/bridge/drivers/singleton.tsx | SINGLETON_MOD_HASH, SINGLETON_LAUNCHER_HASH, getSingletonStruct |
| src/app/bridge/drivers/util.tsx | buildSpendBundle, initializeBLSWithRetries, stringToHex, hexToString |
| src/app/bridge/drivers/rpc.tsx | getCoinRecordByName, getPuzzleAndSolution, pushTx, getCoinRecordsByPuzzleHash, getBlockchainState, getMempoolItemsByCoinName, sbToJSON |
| src/app/bridge/drivers/abis.tsx | ERC20BridgeABI, PortalABI, L1BlockABI, WrappedCATABI, USDTABI, erc20ABI |
| src/app/bridge/ChiaWalletManager/WalletContext.tsx | ChiaWalletProvider React context, createOffer, addCAT, connectWallet, disconnectWallet |
| src/app/bridge/ChiaWalletManager/wallets/index.ts | walletConfigs array — Sage, Goby, Ozone (chiawalletconnect) |
| src/app/bridge/ChiaWalletManager/wallets/types.ts | createOfferParams, addCATParams, asset |
| src/app/bridge/ChiaWalletManager/wallets/sage.tsx | Sage WalletConnect adapter — chia_createOffer, chia_getAddress |
| src/app/bridge/ChiaWalletManager/wallets/walletconnect.tsx | Ozone WalletConnect adapter — chia_createOfferForIds, chia_getCurrentAddress |
| src/app/bridge/ChiaWalletManager/wallets/goby.tsx | Goby browser extension adapter — window.chia.request() |
| src/app/bridge/steps/StepZero.tsx | Route selection UI |
| src/app/bridge/steps/StepOne.tsx | Source tx initiation — Chia offer flow and EVM wagmi contract flow |
| src/app/bridge/steps/StepTwo.tsx | Confirmation waiting — Chia block polling or EVM receipt |
| src/app/bridge/steps/StepThree.tsx | Destination acceptance — EVM receiveMessage or Chia mintCATs/unlockCATs |
| src/app/bridge/steps/urls.tsx | getStepOneURL, getStepTwoURL, getStepThreeURL — URL state serialization |
| src/app/bridge/steps/OrOffer.tsx | Manual offer paste UI component |
| src/app/bridge/page.tsx | Main bridge page router — reads step from URL params, renders correct step |

---

## Puzzle Hashes (Chia/CLVM)

```
OFFER_MOD_HASH         = "cfbfdeed5c4ca2de3d0bf520b9cb4bb7743a359bd2e6a188d19ce7dffc21d3e7"
BRIDGING_PUZZLE_HASH   = "a09eb1ea8c6e83c0166801dabcf4a70d361cc7f6d89c4a46bcd400ac57719037"
CAT_MOD_HASH           = "37bef360ee858133b69d595a906dc45d01af50379dad515eb9518abb7c1d2a7a"
SINGLETON_MOD_HASH     = "7faa3253bfddd1e0decb0906b2dc6247bbc4cf608f58345d173adb63e8b47c9f"
SINGLETON_LAUNCHER_HASH = "eff07522495060c066f66f32acc2a77e3a3e737aca8baea4d1a64ea4cdc13da9"

P2_CONTROLLER_PUZZLE_HASH_MOD_HASH = "a8082b5622ccb27e89f196f024f9851dee0bcb0f2d8afd395caa6d4432f6f85f"
CAT_MINT_AND_PAYOUT_MOD_HASH       = "2c78140b52765a1c063062775d31a33a452410e9777c01270c1001db6e821f37"
WRAPPED_TAIL_MOD_HASH              = "2d7e6fd2e8dd27536ebba2cf6b9fde09493fa10037aa64e14b201762c902f013"
BURN_INNER_PUZZLE_MOD_HASH         = "69b9ac68db61a9941ff537cbb69158a7e1015ad44c42cff905159909cd8e1f90"
```

---

## Network Configuration

### Chia — Mainnet

```
id                   = "xch"
type                 = NetworkType.COINSET
rpcUrl               = "https://api.coinset.org"
explorerUrl          = "https://spacescan.io/"
explorer2Url         = "https://xchscan.com/"
messageToll          = 1_000_000_000n  (mojos)
signatureThreshold   = 6
confirmationMinHeight = 32
prefix               = "xch"
portalLauncherId     = "46e2bdbbcd1e372523ad4cd3c9cf4b372c389733c71bb23450f715ba5aa56d50"
aggSigData           = "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb"
multisigThreshold    = 6
```

### Chia — Testnet11

```
id                   = "xch"
type                 = NetworkType.COINSET
rpcUrl               = "https://testnet11.api.coinset.org/"
explorerUrl          = "https://testnet11.spacescan.io/"
messageToll          = 1_000_000_000n
signatureThreshold   = 3
confirmationMinHeight = 5
prefix               = "txch"
portalLauncherId     = "eca7eca48e658d45a752d2b31ca47e5683c1c86de7f7cb5c3285ef6ec56e10f5"
aggSigData           = "37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615"
multisigThreshold    = 2
```

### Ethereum — Mainnet

```
id                   = "eth"
type                 = NetworkType.EVM
chainId              = 1  (mainnet)
rpcUrl               = process.env.ETH_RPC
explorerUrl          = "https://etherscan.io"
messageToll          = 0.00001 ETH  (ethers.parseEther("0.00001"))
signatureThreshold   = 6
confirmationMinHeight = 64
portalAddress        = "0x2593C582B7a24d94Ba0056B493Fd4048bd99fc3F"
erc20BridgeAddress   = "0x208b80E85dAC3354DD80f72cC272297909EE81b7"
createCallAddress    = "0x7cbB62EaA69F79e6873cD1ecB2392971036cFAa4"
multiCallAddress     = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D"
```

### Ethereum — Sepolia Testnet

```
id                   = "eth"
chainId              = 11155111  (sepolia)
rpcUrl               = "https://rpc2.sepolia.org"
explorerUrl          = "https://sepolia.etherscan.io"
messageToll          = 0.00001 ETH
signatureThreshold   = 3
confirmationMinHeight = 64
portalAddress        = "0x383D27dA16A24a2920b14aA93270Efccf32F4104"
erc20BridgeAddress   = "0x0820a3512585dDBB720C25489DEcE6D9899C81b0"
```

### Base — Mainnet

```
id                   = "bse"
type                 = NetworkType.EVM
chainId              = 8453  (base mainnet)
rpcUrl               = process.env.BASE_RPC
explorerUrl          = "https://basescan.org"
messageToll          = 0.00001 ETH
signatureThreshold   = 6
confirmationMinHeight = 64
l1BlockContractAddress = "0x4200000000000000000000000000000000000015"
portalAddress        = "0x382bd36d1dE6Fe0a3D9943004D3ca5Ee389627EE"
erc20BridgeAddress   = "0x8412f06e811b858Ea9edcf81a5E5882dbf70aC96"
createCallAddress    = "0x7cbB62EaA69F79e6873cD1ecB2392971036cFAa4"
multiCallAddress     = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D"
```

### Base — Sepolia Testnet

```
id                   = "bse"
chainId              = 84532  (baseSepolia)
rpcUrl               = "https://sepolia.base.org"
explorerUrl          = "https://sepolia.basescan.org"
messageToll          = 0.00001 ETH
signatureThreshold   = 3
confirmationMinHeight = 10
l1BlockContractAddress = "0x4200000000000000000000000000000000000015"
portalAddress        = "0x1c14e49d74c4c8302CEFC58A08E3CE77Eb38A066"
erc20BridgeAddress   = "0x1e15a85558042aa1378071853dA500D3A3669214"
```

---

## Validator Keys

### Mainnet Chia Validator BLS Pubkeys (validatorInfos for CHIA_NETWORK)
10 keys configured; threshold = 6. Last key is always a placeholder `c000...00`.
See src/app/bridge/config.tsx CHIA_NETWORK mainnet validatorInfos array.

### Mainnet EVM Validator ECDSA Addresses (validatorInfos for ETH/BASE)
10 addresses configured; threshold = 6.
```
0x12a67BDC9a74dc0Bde185d6cA03480a16BFB0E96
0x0838a3f6B6465BF44898c91B89823B4D743001Cb
0x9b03A7e2868B922D0f24bedC63145EDb04697A60
0xDd0f7b677cD79A28Faf43A1140251fd804341943
0xCEc9e92B3C9D7fd7f8211FB8CaD24ba064A9185c
0x9EC3559492Cd4F1109EE6467B052184F79C28fe7
0xe456b36224f163242778db6C877eaED81922166F
0xAd2169657d32B302a6519C545B5425608e4aC4E2
0x8094548A72eadAC2742F368E9e8Bf644FF17D03f
0x5110FB4762021ad3954Bdf2caBF4510C0ACd6d2f
```

---

## NOSTR Relay Config

### NOSTR_CONFIG.relays — Mainnet
```
wss://relay.fireacademy.io
wss://relay.bufflehead.org
wss://xch-relay.tns.cx
wss://relay.spacescan.io
wss://relay.chainhq.tech
wss://relay.ozonewallet.io
wss://warpgreen-relay.232220.xyz
wss://relay.msmc.dev
wss://warpgreen-mainnet-relay.midl.dev
wss://relay.giritec.com
```

### NOSTR_CONFIG.relays — Testnet
```
wss://test-relay.fireacademy.io
wss://txch-relay.bufflehead.org
wss://txch-relay.tns.cx
wss://testnet-relay.spacescan.io
wss://relay.prime-tek.com
wss://testrelay.ozonewallet.io
wss://warpgreen-relay-test.232220.xyz
wss://testnet-relay.msmc.dev
wss://warpgreen-testnet-relay.midl.dev
wss://relay.testnet.giritec.com
```

### NOSTR_CONFIG.validatorKeys — Mainnet (Nostr pubkeys corresponding to EVM validator addresses)
```
db5790fd1aac8f0cb60879cd468b0cc845e5b692350ef7a26d4776c4f6da3776
ad4bc8487872b07d5acd9dd4ee11906e107a97945f2141eb60d6f0880c29f8e7
85146a6d0a14a2ae1e8eaa27142f7880caf5fe4428e11fb1fcdc0dc010a8829a
ca0085b5cae15bcc80740bb62ab3688cee8fc88dd9520edf23ce120217e653e5
5e9a145844238c5968c79a86fa614acc79edd1628e2267e06495a0b2e4aab7ba
7eff2950197deca52b67901a9641f4e4aac84b8bdd973d44edc6d73fb98af259
7567a34d43e5fbed05afe8b085eadf2462a9f9cf8e1bbb53701ecb9e04e8c09c
10eade3fefcf87d15235bf23e9e6c23bef85aac2762badabe18567fe603c1945
e0a2e65ee292aff65b0fa92a74541a4e5b54f2919bfa6dba08e7df25b4300fb6
2239f413ce7b399ad1e91e2fb4742960d73637b87a3616c4a28771cc84fb648e
```
Index N in validatorKeys corresponds to index N in EVM validatorInfos. This mapping is used in getSigsAndSelectors to recover addresses.

---

## WalletConnect Project IDs

```
WALLETCONNECT_PROJECT_ID_ETH = "e47a64f2fc7214f6c9f71b8b71e5e786"
WALLETCONNECT_PROJECT_ID_XCH = "777b63154ba9ec11877caf45a17b523e"
```

---

## External API Endpoints

```
WATCHER_API_ROOT  (mainnet) = "https://watcher-api.warp.green/"
WATCHER_API_ROOT  (testnet) = "https://watcher-api.testnet.warp.green/"
STATUS_URL        (mainnet) = "https://status.warp.green/"
STATUS_URL        (testnet) = "https://warp-validators.bufflehead.org/"
WELCOME_KIT_API             = "https://welcome-kits.kuhi.to/offers"
```

---

## Fee and Decimal Conventions

### Protocol Fee
- 0.3% taken on token amount at the UI level (30 / 10000).
- Minimum fee: 1 mojo.
- Minimum output after fee: 1 mojo.

### Wallet Offer Fee (mojo)
- Sage adapter hardcodes: `fee: 2500000000` (2.5 XCH / 1000 = 0.0025 XCH).
- Ozone WC and Goby: fee passed through from params.
- Chia BLS minimum positive fee: `2500000000`.

### Token Decimal Places
| Token | Chia side decimals | EVM side decimals | Notes |
|-------|--------------------|-------------------|-------|
| XCH | 12 | N/A (lock/unlock) | XCH uses mojos |
| ETH/milliETH | 3 (milliETH) | 6 (milliETH) | 1000:1 conversion. milliETH displayed as ETH in final UI with ×1000 |
| USDT | 3 | contract decimals (6) | |
| USDC | 3 | contract decimals (6) | |
| EURC | 3 | contract decimals | |
| CAT memecoins | 3 | N/A (lock/unlock) | |
| DBX | 3 | N/A | |

---

## Token Registry (Key Tokens)

### XCH (Chia-native)
```
symbol            = "XCH"
sourceNetworkType = COINSET
assetId (XCH)     = "0000000000000000000000000000000000000000000000000000000000000000"  ("00".repeat(32))
  Base mainnet:   contractAddress = "0x36be1d329444aeF5D28df3662Ec5B4F965Cd93E9"
  Base testnet:   contractAddress = "0xf374cF9D090E19E8d39Db96eEDc8daf62a6C435a"
  ETH mainnet:    contractAddress = "0x1be362F422A862055dCFF627D33f9bD478e6C7d7"
  ETH testnet:    contractAddress = "0x3df856f8d94BAF6527b89Cf07fAFea447A4418CA"
```

### ETH / milliETH (EVM-native)
```
symbol            = "ETH"
sourceNetworkType = EVM
assetId           = computed via getWrappedERC20AssetID(evmNetwork, milliEthAddress)
  Base mainnet:   milliETH contract = "0xf2D5d8eC69E2faed5eB4De90749c87ee314a4B12"
  Base testnet:   milliETH contract = "0xf913766646C8E404183EbC8Ba1E3d379305CE155"
  ETH mainnet:    milliETH contract = "0xf2D5d8eC69E2faed5eB4De90749c87ee314a4B12"
  ETH testnet:    milliETH contract = "0xc08Bce08391807CBa2cF76BcFD693ce82ba6d27C"
```

### DBX (Chia-native)
```
symbol            = "DBX"
sourceNetworkType = COINSET
assetId mainnet   = "db1a9020d48d9d4ad22631b66ab4b9ebd3637ef7758ad38881348c5d24c38f20"
assetId testnet   = "d82dd03f8a9ad2f84353cd953c4de6b21dbaaf7de3ba3f4ddd9abe31ecba80ad"
  Base mainnet:   contractAddress = "0x2dabfFED5584DAb0CA3f9A56BA849f97A08cAd9A"
  Base testnet:   contractAddress = "0x360fE6604dC410BB98595C76E0aA4B7ba35d3B70"
```

### USDT (EVM-native, Ethereum only)
```
symbol            = "USDT"
sourceNetworkType = EVM
  ETH mainnet:    contractAddress = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
  ETH testnet:    contractAddress = "0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0"
```

### USDC (EVM-native, mainnet only)
```
symbol            = "USDC"
sourceNetworkType = EVM
  ETH mainnet:    contractAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  Base mainnet:   contractAddress = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
```

### EURC (EVM-native, Base only)
```
symbol            = "EURC"
sourceNetworkType = EVM
  Base mainnet:   contractAddress = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"
  Base testnet:   contractAddress = "0x808456652fdb597867f38412077A9182bf77359F"
```

### getWrappedERC20AssetID formula
```typescript
// assetId for a wrapped ERC20 CAT = sha256tree of the wrappedTAIL puzzle
// wrappedTAIL is curried from source chain portal launcher id, source chain id, 
// erc20 bridge address (unhexlified), and contract address (padded to 32 bytes)
function getWrappedERC20AssetID(sourceChain: Network, erc20ContractAddress: string): string {
  // pad contract address to 32 bytes hex
  erc20ContractAddress = GreenWeb.util.unhexlify(erc20ContractAddress)!;
  erc20ContractAddress = "0".repeat(64 - erc20ContractAddress.length) + erc20ContractAddress;
  return GreenWeb.util.sexp.sha256tree(
    getWrappedTAIL(
      CHIA_NETWORK.portalLauncherId!,
      stringToHex(sourceChain.id),
      GreenWeb.util.unhexlify(sourceChain.erc20BridgeAddress!)!,
      erc20ContractAddress
    )
  );
}
```

Note: assetId is therefore NOT static — it depends on the portal launcher id.
Changing portalLauncherId invalidates all wrapped ERC20 assetIds.

---

## Wallet Adapters

### Registered Wallets (walletConfigs in wallets/index.ts)

| id | display name | mechanism | key method |
|----|-------------|-----------|------------|
| sage | Sage | WalletConnect | chia_createOffer |
| goby | Goby | Browser extension window.chia | createOffer |
| chiawalletconnect | Ozone | WalletConnect | chia_createOfferForIds |

### Sage WalletConnect Methods Used
```
chia_getAddress         — get wallet receive address
chia_createOffer        — create offer; fee is passed in params; adapter adds fee: 2500000000
```

### Ozone (chiawalletconnect) Methods Used
```
chia_getCurrentAddress  — get wallet address (returns { data: address })
chia_getWallets         — list wallets and asset ids for lookup
chia_createOfferForIds  — create offer by wallet ids
chia_addCATToken        — add CAT to wallet
```

### Goby (browser extension)
```javascript
// Does NOT use WalletConnect. Uses window.chia injected by browser extension.
window.chia.request({ method: "connect" })
window.chia.selectedAddress  // puzzle hash (not address string)
window.chia.request({ method: "createOffer", params })
window.chia.request({ method: "walletWatchAsset", params: { type: "cat", options: { assetId, symbol, logo } } })
```

---

## createOfferParams Shape

```typescript
interface asset {
  assetId: string   // hex CAT TAIL hash; empty string "" = XCH
  amount: number    // integer mojos
}

interface createOfferParams {
  offerAssets:   asset[]  // what the wallet offers
  requestAssets: asset[]  // always [] in current bridge flows
  fee: number             // mojo fee integer
}
```

---

## Driver Function Signatures

### offer.tsx
```typescript
offerToRawSpendBundle(offer: string): SpendBundle
parseXCHOffer(offer: string): [CoinSpend[], string, Coin, SExp, any]
// returns: [coinSpends, aggSig, securityCoin, securityCoinPuzzle, tempSk]

parseXCHAndCATOffer(offer: string): [CoinSpend[], string, Coin, SExp, any, string|null, Coin, Coin]
// returns: [coinSpends, aggSig, securityCoin, securityCoinPuzzle, tempSk, tailHash|null, catSourceCoin, catSourceCoinLineageProof]
```

### portal.tsx
```typescript
getMessageCoinPuzzle1stCurry(portalReceiverLauncherId: string): SExp
getPortalReceiverInnerPuzzle(launcherId, sigThreshold, sigPubkeys[], updaterPuzzleHash, lastChainsAndNonces?): SExp
getPortalReceiverInnerSolution(messageInfos: [RawMessage, number][]): SExp
getSigsSwitch(sigSwitches: boolean[]): number
decodeSignature(sig: string): [originChain, destinationChain, nonce, coinId, sigData]
getSigsAndSelectors(rawMessage, coinId|null, sigLimit, targetEVMNetwork?): Promise<[string[], boolean[]]>
receiveMessageAndSpendMessageCoin(portalBootstrapId, network, message, messageReceiverCoin, updateStatus): Promise<[CoinSpend[], string[], Coin]>
spendOutgoingMessageCoin(coinsetNetwork, parentCoinInfo): CoinSpend
getSecurityCoinSig(securityCoin, conditions, tempSk, aggSigAdditionalDataHex): string
findLatestPortalState(rpcUrl, messageNonce, messageSourceChainHex, messageDestinationChainHex, portalBootstrapCoinId): Promise<PortalInfo>
bootstrapPortal(currentPortalInfo|null, xchNetwork, message, updateStatus): Promise<PortalInfo>
getMessageSentFromXCHStepThreeData(coinsetNetwork, nonce): Promise<{sourceNetworkId, destinationNetworkId, nonce, source, destination, contents}>
messageContentsAsSexp(messageContents: string[]): SExp

type RawMessage = {
  nonce: string              // hex bytes32, no 0x prefix
  destinationHex: string     // hex bytes32
  destinationChainHex: string // 3-byte chain id as hex e.g. "657468" for "eth"
  sourceHex: string          // hex bytes32
  sourceChainHex: string     // 3-byte chain id as hex
  contents: string[]         // array of hex bytes32 strings
}

type PortalInfo = {
  coinId: string
  messageCoinAlreadyCreated: boolean
  mempoolPendingThings: [RawMessage, number][]
  mempoolSb: SpendBundle | null
  mempoolSbCost: BigNumber
  mempoolSbFee: BigNumber
}
```

### catbridge.tsx
```typescript
lockCATs(
  offer: string,
  evmNetwork: Network,          // DESTINATION (EVM)
  coinsetNetwork: Network,       // SOURCE (Chia)
  tokenTailHash: string | null,  // null = XCH
  wrappedCatContractAddress: string, // EVM contract address of the wrapped token
  ethTokenReceiverAddress: string,   // EVM address of token recipient
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>  // [sb, nonce]

unlockCATs(
  portalBootstrapCoinId: string,
  offer: string,
  rawMessage: RawMessage,
  tokenTailHash: string | null,  // null = XCH
  evmNetwork: Network,           // SOURCE (EVM)
  coinsetNetwork: Network,        // DESTINATION (Chia)
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>  // [sb, txId = message coin id]
```

### erc20bridge.tsx
```typescript
burnCATs(
  offer: string,
  coinsetNetwork: Network,         // SOURCE (Chia)
  evmNetwork: Network,             // DESTINATION (EVM)
  tokenContractAddress: string,    // EVM contract address of original ERC20
  ethTokenReceiverAddress: string, // EVM address of recipient
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>  // [sb, nonce]

mintCATs(
  portalBootstrapCoinId: string,
  offer: string,
  rawMessage: RawMessage,
  coinsetNetwork: Network,  // DESTINATION (Chia)
  updateStatus: (s: string) => void
): Promise<[SpendBundle, string]>  // [sb, txId]

getWrappedERC20AssetID(sourceChain: Network, erc20ContractAddress: string): string
```

### util.tsx
```typescript
buildSpendBundle(coinSpends: CoinSpend[], sigs: string[]): Promise<SpendBundle>
initializeBLSWithRetries(): Promise<boolean>  // max 2 retries, 1s delay between
stringToHex(str: string): string
hexToString(hex: string): string
```

### rpc.tsx
```typescript
getCoinRecordByName(rpcBaseUrl, coinName): Promise<CoinRecord>
getPuzzleAndSolution(rpcBaseUrl, coinId, spentBlockIndex): Promise<CoinSolution>
pushTx(rpcBaseUrl, sb): Promise<[response, feeError: boolean]>
getCoinRecordsByPuzzleHash(rpcBaseUrl, puzzleHash): Promise<CoinRecord[]>
getBlockchainState(rpcBaseUrl): Promise<BlockchainState>
getMempoolItemsByCoinName(rpcBaseUrl, coinName): Promise<MempoolItem[]>
sbToJSON(sb): any  // converts SpendBundle to JSON format for push_tx
```

---

## Message Contents Array Format

The `contents` array in RawMessage differs by token type and determines StepThree branching.

### ERC20-origin token (EVM → Chia): 3 items
```
contents[0] = ethAssetContractAddress  (bytes32, zero-padded EVM contract address)
contents[1] = xchReceiverPuzzleHash    (bytes32, destination puzzle hash on Chia)
contents[2] = tokenAmount              (bytes32, big-endian token amount in mojos)
```
Detection: `contents.length !== 2` → use `mintCATs`

### Chia-origin token (EVM → Chia): 2 items
```
contents[0] = xchReceiverPuzzleHash    (bytes32)
contents[1] = tokenAmount_b32          (bytes32)
```
Detection: `contents.length === 2` → use `unlockCATs`
Also used for XCH (assetId = "00".repeat(32), tokenTailHash = null passed to unlockCATs).

---

## EVM Contract Entry Functions

### ERC20Bridge (EthereumButton in StepOne)

ETH (native ether bridging to Chia):
```solidity
function bridgeEtherToChia(bytes32 _receiver, uint256 _maxMessageToll) external payable
// msg.value = ethers.parseEther(amount) + messageToll
```

EVM-origin ERC20 (requires prior ERC20.approve of erc20BridgeAddress):
```solidity
function bridgeToChia(address _assetContract, bytes32 _receiver, uint256 _mojoAmount) external payable
// msg.value = messageToll
```

Chia-origin wrapped CAT on EVM (WrappedCAT contract, no approval needed):
```solidity
function bridgeBack(bytes32 _receiver, uint256 _amount) external payable
// msg.value = messageToll
```

ERC20 Approval (required for EVM-origin ERC20 before bridgeToChia, except ETH):
```solidity
function approve(address spender, uint256 amount) external returns (bool)
// spender = erc20BridgeAddress; amount = parsed ERC20 units
// USDT requires USDTABI (different from standard erc20ABI due to no return value)
```

### Portal (StepThree EVM destination, write to destination chain)
```solidity
function receiveMessage(
  bytes32 nonce,
  bytes3 source_chain,
  bytes32 source,
  address destination,
  bytes32[] calldata contents,
  bytes calldata sigs   // packed concatenation of (v,r,s) for each validator sig
) external
```

Signature packing for receiveMessage:
- Each decoded sig is 96 hex chars (48 bytes)
- Format per sig: `v(1 byte) + r(32 bytes) + s(32 bytes)` — but stored as `r + s + v` in Nostr content then repacked
- Decoded from Nostr event content via decodeSignature, producing raw sig bytes at index [4]
- All sigs concatenated: `"0x" + sigs.map(sig => decodeSignature(sig)[4]).join("")`

---

## NOSTR Signature Protocol

### Routing Key Encoding
```typescript
// Build routing data (3 + 3 + 32 bytes = 38 bytes total):
const routingDataBuff = Buffer.from(sourceChainHex + destinationChainHex + nonce, "hex");
const routingData = bech32m.encode("r", bech32m.toWords(routingDataBuff));

// Coin data (for coinset target — the portal coin id):
const coinData = GreenWeb.util.address.puzzleHashToAddress(coinId, "c");

// Nostr filter:
{ kinds: [1], "#r": [routingData], "#c": [coinData] }   // coinset mode
{ kinds: [1], "#r": [routingData] }                      // EVM mode (no coin tag)
```

### Signature String Format
```
"<routingData>-<coinData>-<sigContent>"
// routingData = bech32m with hrp "r"
// coinData    = bech32m with hrp "c" (or empty string for EVM path)
// sigContent  = bech32m validator signature (from Nostr event.content)
```
Assembled in getSigsAndSelectors as: `routingData + "-" + coinData + "-" + event.content`

### Signature Verification (EVM path)
EIP-712 typed data domain:
```typescript
{
  name: "warp.green Portal",
  version: "1",
  chainId: destinationNetwork.chainId,
  verifyingContract: destinationNetwork.portalAddress
}
```
EIP-712 message type:
```typescript
Message: [
  { name: "nonce",           type: "bytes32" },
  { name: "source_chain",    type: "bytes3"  },
  { name: "source",          type: "bytes32" },
  { name: "destination",     type: "address" },
  { name: "contents",        type: "bytes32[]" },
]
```
Verify: `ethers.verifyTypedData(domain, types, messageNotRaw, signature)` must equal expected validator address.
EVM signatures are sorted ascending by validator address before concatenation.

---

## MessageSent Event (EVM source tx parsing in StepTwo)

```solidity
event MessageSent(
  bytes32 indexed nonce,   // topics[1]
  address source,
  bytes3 destination_chain,
  bytes32 destination,
  bytes32[] contents
)
// eventSignature = ethers.id("MessageSent(bytes32,address,bytes3,bytes32,bytes32[])")
// decoded data: AbiCoder.decode(["address","bytes3","bytes32","bytes32[]"], eventLog.data)
```

---

## URL State Contract

All bridge state is carried in URL query parameters. The page.tsx reads `step` to decide which component to render.

### Step 1 URL
```
/bridge?step=1&from=<networkId>&to=<networkId>&token=<symbol>&recipient=<address>&amount=<decimal>[&offer=<offerString>]
```

### Step 2 URL
```
/bridge?step=2&from=<networkId>&to=<networkId>&tx=<txHash>
```

### Step 3 URL (EVM destination — waiting for sigs then calling receiveMessage)
```
/bridge?step=3&from=<networkId>&to=<networkId>&nonce=<0xhex>&source=<0xhex>&destination=<0xhex>&contents=<JSON>&[tx=<finalTxHash>]
```

### Step 3 URL (Chia destination — needs offer to complete)
```
/bridge?step=3&from=<networkId>&to=<networkId>&nonce=<0xhex>&source=<0xhex>&destination=<0xhex>&contents=<JSON>&offer=<offerString>&portal_bootstrap_id=<coinId>[&tx=<finalTxHash>]
```

---

## Chain ID to Network String Mapping

| chain string | hex encoding (stringToHex) |
|---|---|
| "xch" | "786368" |
| "eth" | "657468" |
| "bse" | "627365" |

`stringToHex` converts ASCII chars to 2-char hex pairs.
`hexToString` reverses it.
Used everywhere RawMessage.sourceChainHex and destinationChainHex are built.

---

## BLS Initialization

BLS is a WebAssembly module that must be initialized before any signing.
`initializeBLSWithRetries()` attempts up to 2 retries with 1-second delay.
If all retries fail, the driver function returns an empty SpendBundle and empty nonce string "".
All four driver entry functions check this and surface the failure to the UI.

---

## Token assetId = "00".repeat(32)

This is the sentinel value meaning XCH (native Chia coin, no TAIL).
In lockCATs/unlockCATs, `tokenTailHash === null` is passed when assetId equals this value.
The offer parser produces `tailHash === null` for XCH offers.
