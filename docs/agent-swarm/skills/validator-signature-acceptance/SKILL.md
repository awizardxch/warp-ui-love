# Skill: validator-signature-acceptance

> Full relay URL lists, validator key sets, and network thresholds are in `IMPLEMENTATION_CONSTANTS.md`.

## Purpose
Implement the validation gate where cross-chain messages are validated through NOSTR-relayed validator signatures and then accepted on the destination chain.

## Use When
- A bridge message is ready for signature collection (post source tx confirmation).
- Destination acceptance needs threshold confirmation from NOSTR validators.
- Building portal + message coin spends for Chia destination.
- Calling `portal.receiveMessage` for EVM destination.

---

## NOSTR Relay URLs

### Mainnet (10 relays)
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

### Testnet (10 relays)
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

---

## Signature Thresholds

| Network | Threshold | Total validators |
|---------|-----------|-----------------|
| Chia mainnet | 6 of 10 | 10 |
| ETH mainnet | 6 of 10 | 10 |
| Base mainnet | 6 of 10 | 10 |
| All testnets | 2 of 3 | 3 |

---

## Routing Key Construction

NOSTR query uses bech32m-encoded routing data as an event tag:

```typescript
import { bech32m } from "bech32"

// routing data = sourceChainHex + destinationChainHex + nonce
// sourceChainHex and destinationChainHex are 3-byte hex strings (6 hex chars)
// nonce is 32-byte hex (64 hex chars)
// Total: 38 bytes

const routingDataBuff = Buffer.from(
  rawMessage.sourceChainHex + rawMessage.destinationChainHex + rawMessage.nonce,
  "hex"
)
const routingData = bech32m.encode("r", bech32m.toWords(routingDataBuff))
// Example: "r1..." bech32m string with hrp "r"
```

Chain hex values:
```
"xch" → "786368"
"eth" → "657468"
"bse" → "627365"
```
Built via `stringToHex(chainId)` which converts ASCII to hex pairs.

---

## Coin Data (Chia destination only)

For Chia destination, validators sign over a specific portal coin. Include coin tag in query:

```typescript
// coinData = bech32m encoding of portalCoinId with hrp "c"
const coinData = GreenWeb.util.address.puzzleHashToAddress(portalCoinId, "c")
// Example: "c1..." bech32m string
```

For EVM destination: coinId is null, no `#c` tag in the filter.

---

## NOSTR Event Query

```typescript
// For Chia destination (with coin tag):
const filter = { kinds: [1], "#r": [routingData], "#c": [coinData] }

// For EVM destination (no coin tag):
const filter = { kinds: [1], "#r": [routingData] }

// Use nostr-tools SimplePool to query all relays simultaneously
const pool = new SimplePool()
const events = await pool.querySync(relayUrls, filter)
```

---

## Signature String Format

Each NOSTR event.content contains raw sig bytes. Full signature string assembled as:
```
"<routingData>-<coinData>-<sigContent>"
// routingData = bech32m(r, 38 bytes)
// coinData    = bech32m(c, 32 bytes coinId) — empty string "" for EVM path
// sigContent  = event.content from NOSTR (bech32m-encoded sig bytes)
```

Full signature string: `routingData + "-" + coinData + "-" + event.content`

---

## decodeSignature

```typescript
function decodeSignature(sig: string): [
  string,  // originChain (6 hex chars, 3 bytes)
  string,  // destinationChain (6 hex chars, 3 bytes)
  string,  // nonce (64 hex chars, 32 bytes)
  string,  // coinId (64 hex chars, or "" if absent)
  string   // sigBytes (raw sig hex — 192 hex chars for BLS, or ECDSA bytes for EVM)
]
// Splits on "-", decodes each part from bech32m back to hex
// sigBytes at index [4] are concatenated for EVM receiveMessage call
```

---

## getSigsAndSelectors

```typescript
async function getSigsAndSelectors(
  rawMessage: RawMessage,
  coinId: string | null,          // portal coin id — null for EVM destination
  sigLimit: number,               // max signatures to collect
  targetEVMNetwork?: Network      // if provided, switches to EVM verification mode
): Promise<[string[], boolean[]]> // [sigStrings, selectors]
```

### EVM mode (targetEVMNetwork provided)
1. Query NOSTR with `#r` tag only (no `#c`).
2. For each event: call `decodeSignature(fullSigString)` → extract raw sig bytes.
3. Verify via `ethers.verifyTypedData(domain, types, msgStruct, sigBytes)`.
4. Recovered address must match one of `targetEVMNetwork.validatorInfos[i].address`.
5. Collect up to threshold valid signatures.
6. Sort collected validators ascending by address.
7. Return `[sortedSigStrings, selectors]`.

### Chia mode (coinId provided)
1. Query NOSTR with both `#r` and `#c` tags.
2. For each event: check for duplicate content (same sig bytes).
3. Build selector bitmask: `selectors[i] = true` if validator[i] has valid matching sig.
4. Return when threshold selectors are true.

---

## EIP-712 Domain (EVM signatures)

```typescript
const domain = {
  name: "warp.green Portal",
  version: "1",
  chainId: destinationNetwork.chainId,
  verifyingContract: destinationNetwork.portalAddress  // checksummed EVM address
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

// Message struct built from rawMessage fields (add "0x" prefix where needed)
```

---

## receiveMessageAndSpendMessageCoin

```typescript
async function receiveMessageAndSpendMessageCoin(
  portalBootstrapId: string,
  network: Network,                    // Chia destination network
  message: RawMessage,
  messageReceiverCoin: Coin,           // the message receiver coin on Chia
  updateStatus: (s: string) => void
): Promise<[
  CoinSpend[],   // portal spend + message coin spend
  string[],      // sig strings
  Coin           // message receiver coin (for use in subsequent driver spend)
]>
```

Steps:
1. `bootstrapPortal(...)` or use provided bootstrap id → get `PortalInfo`.
2. `getSigsAndSelectors(rawMessage, portalCoinId, sigLimit)` → collect Chia-mode signatures.
3. Build portal receiver inner puzzle: `getPortalReceiverInnerPuzzle(launcherId, threshold, pubkeys, updaterPH, lastChainsAndNonces)`.
4. Build portal receiver inner solution: `getPortalReceiverInnerSolution([(message, receiverCoinIndex)])`.
5. Create singleton spend wrapping portal inner puzzle/solution.
6. Create message coin spend using `MESSAGE_COIN_PUZZLE_MOD` curried with portal coin id.
7. Return combined coin spends and sig strings.

---

## Validator Key Mapping

Each NOSTR validator event must be verified against the known validator public key for that validator index.

### Mainnet NOSTR Pubkeys (Nostr npub hex, index-aligned with EVM addresses)
```
Index 0: db5790fd1aac8f0cb60879cd468b0cc845e5b692350ef7a26d4776c4f6da3776
Index 1: ad4bc8487872b07d5acd9dd4ee11906e107a97945f2141eb60d6f0880c29f8e7
Index 2: 85146a6d0a14a2ae1e8eaa27142f7880caf5fe4428e11fb1fcdc0dc010a8829a
Index 3: ca0085b5cae15bcc80740bb62ab3688cee8fc88dd9520edf23ce120217e653e5
Index 4: 5e9a145844238c5968c79a86fa614acc79edd1628e2267e06495a0b2e4aab7ba
Index 5: 7eff2950197deca52b67901a9641f4e4aac84b8bdd973d44edc6d73fb98af259
Index 6: 7567a34d43e5fbed05afe8b085eadf2462a9f9cf8e1bbb53701ecb9e04e8c09c
Index 7: 10eade3fefcf87d15235bf23e9e6c23bef85aac2762badabe18567fe603c1945
Index 8: e0a2e65ee292aff65b0fa92a74541a4e5b54f2919bfa6dba08e7df25b4300fb6
Index 9: 2239f413ce7b399ad1e91e2fb4742960d73637b87a3616c4a28771cc84fb648e
```

### Mainnet EVM Validator Addresses (index-aligned with NOSTR pubkeys)
```
Index 0: 0x12a67BDC9a74dc0Bde185d6cA03480a16BFB0E96
Index 1: 0x0838a3f6B6465BF44898c91B89823B4D743001Cb
Index 2: 0x9b03A7e2868B922D0f24bedC63145EDb04697A60
Index 3: 0xDd0f7b677cD79A28Faf43A1140251fd804341943
Index 4: 0xCEc9e92B3C9D7fd7f8211FB8CaD24ba064A9185c
Index 5: 0x9EC3559492Cd4F1109EE6467B052184F79C28fe7
Index 6: 0xe456b36224f163242778db6C877eaED81922166F
Index 7: 0xAd2169657d32B302a6519C545B5425608e4aC4E2
Index 8: 0x8094548A72eadAC2742F368E9e8Bf644FF17D03f
Index 9: 0x5110FB4762021ad3954Bdf2caBF4510C0ACd6d2f
```

---

## Acceptance Status States

| Status string | Meaning |
|---------------|---------|
| "Bootstrapping portal..." | fetchin portal coin from NOSTR/RPC |
| "Collecting validator signatures..." | querying NOSTR relays |
| "Got N/M signatures..." | threshold progress |
| "Building transaction..." | assembling coin spends |
| "Pushing transaction..." | calling pushTx on Chia RPC |
| "Waiting for EVM confirmation..." | waiting for wagmi receipt |

---

## Error Cases

| Condition | Resolution |
|-----------|------------|
| Fewer signatures than threshold after timeout | Retry getSigsAndSelectors; some validators may be offline |
| Signature recovers wrong address | Discard; validator may be signing different message |
| Portal coin not found at bootstrap id | bootstrapPortal re-queries NOSTR for correct starting coin |
| NOSTR relay connection failure | SimplePool connects to multiple relays; partial failure tolerated |
| coinId mismatch in signature | Discard; sig is for a different portal state |
