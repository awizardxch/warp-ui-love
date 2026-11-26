# WrappedStock

A 1:1, WETH-style ERC-20 wrapper for one Base-native (B20) token, used to bridge
Coinbase tokenized stocks to Chia.

## Why a wrapper

Since the August 2026 incident, the warp.green validators sign an ERC-20 deposit
only if they can read the bridge's balance of the token out of ordinary contract
storage. B20 tokens live in the Base node and keep no balances in contract
storage, so a direct deposit is never signed and stays locked in `ERC20Bridge`.
`WrappedStock` is a plain ERC-20 whose balance mapping sits in storage slot 0,
where the signer looks.

## What it is

- `deposit` / `depositFor` wrap; `withdraw` / `withdrawTo` unwrap. Always 1:1 in
  raw units.
- No owner, no upgrade path, no fee, no pause.
- A wrapper may declare fewer decimals than its stock (at least 3). Nothing is
  scaled; only the decimal point moves. See "Plain and milli wrappers" below.
- A deposit that does not arrive in full (fee-on-transfer, rebase) reverts.
- `uiMultiplier()` passes through the stock's share multiplier for display. It
  never affects balances: splits and dividends change the multiplier, not raw
  units.
- Stock sent straight to the wrapper, not through `deposit`, is stuck for good.

## Plain and milli wrappers

The bridge gives the Chia side `10^(decimals - 3)` raw units per mojo, using the
wrapper's `decimals()`. A stock can therefore have two wrappers, which differ
only in how finely Chia can divide it:

| | Wrapper decimals | Base symbol | Chia CAT | 1 CAT | 1 mojo |
|---|---|---|---|---|---|
| Plain | 8 (the stock's) | `wSPCXc` | `wSPCXc.b` | 1 stock token | 0.001 |
| Milli | 5 | `mwSPCXc` | `mwSPCXc.b` | 0.001 stock token | 0.000001 |

Both hold the stock 1:1 in raw units, and both can be listed at once. They are
separate contracts with separate Chia asset ids: one cannot be redeemed through
the other. To move between them, unwrap on Base and wrap again.

## What it does not fix

- The stock's issuer can freeze, pause, seize or burn the wrapper's holdings.
  A freeze makes wrapped tokens (and the CATs minted from them) unredeemable; a
  seizure leaves them unbacked.
- Whether validators sign a wrapper deposit has not been proven on chain. Do one
  minimum deposit (0.002 token) end to end before listing a stock publicly.
- Because wrapped tokens move freely, the wrapper bypasses the stock's
  blocklist. That gives the issuer a reason to freeze the wrapper as a whole.
- The signer reads the deposit amount by scanning the transaction's input for
  the `bridgeToChia` call. The transaction must contain exactly one such call
  for that asset and receiver, and must not change the bridge's wrapper balance
  in any other way. A plain wallet call satisfies this. A helper contract that
  builds the call internally does not, and its deposits would stay unsigned.
- On the way back the bridge pays out the wrapper token, not the stock. The
  receiver must be a wallet that can call `withdraw`. Never an exchange or
  custodial address, and never the wrapper, stock, bridge or portal address.

## Develop

```sh
forge install foundry-rs/forge-std@v1.9.4 --no-git   # once
forge test
```

`test_signerFindsBalanceInExactlyOneSlot` pins the storage layout the signer
depends on. Do not reorder the state variables.

## Rehearse against live Base (read-only)

A local fork cannot run B20 tokens, so the rehearsal uses `eth_simulateV1`:

```sh
forge build
node contracts/script/simulate-base.mjs      # from the repo root
```

It deploys the wrapper inside the simulation and walks a real holder through
wrap, approve, `bridgeToChia`, a release from the bridge, and unwrap, for each
of the three stocks. It sends nothing.

## Deploy and list

One contract per stock and unit (plain or milli). Deployment is a real
transaction: review it first.

From a browser wallet: run the web app locally (`npm run dev`) and open
`/bridge/wrap/deploy`. The page deploys the compiled contract, checks what
landed on chain, and prints the config line. Its bytecode comes from
`src/app/bridge/drivers/wrappedStockBytecode.ts`; after any change to the
contract, regenerate it with `node contracts/script/export-bytecode.mjs`.

Or from the command line:

```sh
UNDERLYING=0x... NAME="Milli Wrapped NVDAc" SYMBOL=mwNVDAc DECIMALS=5 \
forge script script/Deploy.s.sol --rpc-url $BASE_RPC --broadcast --account <keystore>
```

Then set the `wrapper` address of that stock's entry (`milli: true` or `false`)
in `WRAPPED_STOCKS_BASE_MAINNET` in
`src/app/bridge/config.tsx`. The Chia asset id is derived from it automatically.
