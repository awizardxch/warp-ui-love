# Skill: cross-chain-eth-base

> Portal and bridge contract addresses, chain IDs, messageToll values are in `IMPLEMENTATION_CONSTANTS.md`.

## Purpose
Handle all EVM-side interoperability for Ethereum and Base routes — source transaction initiation, event parsing, and destination message acceptance.

## Use When
- Source network is EVM: initiate bridgeEtherToChia / bridgeToChia / bridgeBack.
- StepTwo waiting on EVM source tx receipt and parsing MessageSent event.
- Destination is EVM: collect signatures and call portal.receiveMessage.

---

## EVM Source Transaction (StepOne — EthereumButton)

Uses wagmi `useWriteContract` hook. Three variants based on token type:

### Variant 1 — ETH (native ether)
```typescript
writeContract({
  address: evmNetwork.portalAddress as `0x${string}`,
  abi: PortalABI,
  functionName: "bridgeEtherToChia",
  args: [
    receiver_bytes32,     // "0x" + xchPuzzleHash (32 bytes hex)
    messageToll           // BigInt from ethers.parseEther("0.00001")
  ],
  value: parseEther(amount) + messageToll
})
```

### Variant 2 — EVM-origin ERC20 (USDT, USDC, EURC, etc.)
Requires approval before bridging:
```typescript
// Step 1: Approve
// Note: USDT requires USDTABI (no return value from approve)
const approvalABI = token.symbol === "USDT" ? USDTABI : erc20ABI
writeContract({
  address: token.contractAddress as `0x${string}`,
  abi: approvalABI,
  functionName: "approve",
  args: [evmNetwork.erc20BridgeAddress, mojoAmount]
})

// Step 2: Bridge (after approval tx confirmed)
writeContract({
  address: evmNetwork.erc20BridgeAddress as `0x${string}`,
  abi: ERC20BridgeABI,
  functionName: "bridgeToChia",
  args: [
    token.contractAddress,  // asset contract address
    receiver_bytes32,       // "0x" + xchPuzzleHash
    mojoAmount              // BigInt token amount in smallest units
  ],
  value: messageToll
})
```

### Variant 3 — Chia-origin wrapped CAT on EVM (WrappedCAT)
No approval needed:
```typescript
writeContract({
  address: token.contractAddress as `0x${string}`,
  abi: WrappedCATABI,
  functionName: "bridgeBack",
  args: [
    receiver_bytes32,  // "0x" + xchPuzzleHash (32 bytes)
    amount             // BigInt token amount
  ],
  value: messageToll
})
```

---

## StepTwo — Parsing the MessageSent Event

After EVM tx receipt received via wagmi `useWaitForTransactionReceipt`:

```typescript
const eventSignature = ethers.id("MessageSent(bytes32,address,bytes3,bytes32,bytes32[])")

const log = receipt.logs.find(log =>
  log.topics[0] === eventSignature &&
  log.address.toLowerCase() === portalAddress.toLowerCase()
)

// nonce is indexed — in topics[1]
const nonce = log.topics[1]  // "0x" + 64 hex chars

// remaining fields in log.data:
const [source, destinationChain, destination, contents] = AbiCoder.decode(
  ["address", "bytes3", "bytes32", "bytes32[]"],
  log.data
)
```

Build RawMessage from decoded values (strip "0x", lowercase):
```typescript
{
  nonce:               nonce.slice(2),
  sourceChainHex:      ethers.hexlify(sourceChainBytes3).slice(2),
  sourceHex:           source.toLowerCase().slice(2).padStart(64, "0"),
  destinationChainHex: ethers.hexlify(destinationChain).slice(2),
  destinationHex:      destination.slice(2),
  contents:            contents.map(c => c.slice(2))
}
```

### Base Chain: L1 Block Confirmation
Base has `l1BlockContractAddress = "0x4200000000000000000000000000000000000015"`.
StepTwo on Base reads the L1 block number from that contract before allowing StepThree.
This ensures sufficient L1 finality before accepting on Chia.

---

## StepThree — EVM Destination Acceptance

### 1. Collect Validator Signatures
```typescript
const [sigStrings, _selectors] = await getSigsAndSelectors(
  rawMessage,
  null,                    // coinId = null for EVM destination
  sigLimit,
  destinationEVMNetwork    // passed to trigger EVM verification mode
)
// Polls until signatureThreshold met: 6 mainnet, 3 testnet
```

### 2. EIP-712 Signature Verification (inside getSigsAndSelectors)
```typescript
const domain = {
  name: "warp.green Portal",
  version: "1",
  chainId: destinationNetwork.chainId,
  verifyingContract: destinationNetwork.portalAddress
}

const types = {
  Message: [
    { name: "nonce",           type: "bytes32"   },
    { name: "source_chain",    type: "bytes3"    },
    { name: "source",          type: "bytes32"   },
    { name: "destination",     type: "address"   },
    { name: "contents",        type: "bytes32[]" }
  ]
}

const recoveredAddr = ethers.verifyTypedData(domain, types, messageStruct, rawSigBytes)
// Must match the expected validator address at the same index in validatorInfos
// Validators are sorted ascending by address before concatenating sigs
```

### 3. Portal receiveMessage
```typescript
// Pack all sig bytes: each signature is 96 bytes (48-byte BLS or 65-byte ECDSA packed as r+s+v)
const packedSigs = "0x" + sigStrings.map(s => decodeSignature(s)[4]).join("")

writeContract({
  address: destinationNetwork.portalAddress as `0x${string}`,
  abi: PortalABI,
  functionName: "receiveMessage",
  args: [
    nonce_bytes32,        // "0x" + nonce hex
    sourceChain_bytes3,   // e.g. "0x786368" for "xch"
    source_bytes32,       // source puzzle hash
    destination_address,  // EVM destination address
    contents_bytes32arr,  // ["0x" + each content]
    packedSigs            // "0x" + concatenated raw sig bytes
  ]
})
```

---

## ERC20BridgeABI Key Functions

```solidity
// Ether bridging:
function bridgeEtherToChia(bytes32 _receiver, uint256 _maxMessageToll) external payable

// ERC20 bridging:
function bridgeToChia(address _assetContract, bytes32 _receiver, uint256 _mojoAmount) external payable

// ERC20 with permit (no separate approve tx):
function bridgeToChiaWithPermit(address _assetContract, bytes32 _receiver, uint256 _mojoAmount,
  uint256 _deadline, uint8 _v, bytes32 _r, bytes32 _s) external payable

// Portal receive (EVM destination):
function receiveMessage(bytes32 nonce, bytes3 source_chain, bytes32 source,
  bytes32[] calldata contents) external

// View:
function burnPuzzleHash() external view returns (bytes32)
function mintPuzzleHash() external view returns (bytes32)
function tip() external view returns (uint256)
function wethToEthRatio() external view returns (uint256)
```

## PortalABI Key Items

```solidity
// Events:
event MessageSent(bytes32 indexed nonce, address source, bytes3 destination_chain,
  bytes32 destination, bytes32[] contents)
event MessageReceived(bytes32 indexed nonce, bytes3 source_chain, bytes32 source,
  address destination, bytes32[] contents)

// Functions:
function receiveMessage(bytes32 nonce, bytes3 source_chain, bytes32 source,
  address destination, bytes32[] calldata contents, bytes calldata sigs) external
```

## WrappedCATABI Key Function

```solidity
function bridgeBack(bytes32 _receiver, uint256 _amount) external payable
```

---

## Network Addresses (Mainnet)

### Ethereum Mainnet
```
portalAddress      = "0x2593C582B7a24d94Ba0056B493Fd4048bd99fc3F"
erc20BridgeAddress = "0x208b80E85dAC3354DD80f72cC272297909EE81b7"
chainId            = 1
```

### Base Mainnet
```
portalAddress      = "0x382bd36d1dE6Fe0a3D9943004D3ca5Ee389627EE"
erc20BridgeAddress = "0x8412f06e811b858Ea9edcf81a5E5882dbf70aC96"
chainId            = 8453
l1BlockContract    = "0x4200000000000000000000000000000000000015"
```

### Sepolia Testnet
```
portalAddress      = "0x383D27dA16A24a2920b14aA93270Efccf32F4104"
erc20BridgeAddress = "0x0820a3512585dDBB720C25489DEcE6D9899C81b0"
chainId            = 11155111
```

### Base Sepolia Testnet
```
portalAddress      = "0x1c14e49d74c4c8302CEFC58A08E3CE77Eb38A066"
erc20BridgeAddress = "0x1e15a85558042aa1378071853dA500D3A3669214"
chainId            = 84532
```

---

## messageToll

```typescript
const messageToll = ethers.parseEther("0.00001")  // 10000000000000 wei
// Applied to all three EVM source contract variants (bridgeEtherToChia, bridgeToChia, bridgeBack)
// For bridgeEtherToChia: total value = parseEther(amount) + messageToll
// For bridgeToChia and bridgeBack: total value = messageToll only
```

---

## WalletConnect Project ID (EVM)

```
WALLETCONNECT_PROJECT_ID_ETH = "e47a64f2fc7214f6c9f71b8b71e5e786"
```

Used in wagmiConfig via `@web3modal/wagmi`.
