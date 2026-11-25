// Read-only rehearsal of the wrapper against live Base. Sends nothing.
//
// A local fork cannot run B20 tokens (they live in the Base node, not in
// contract code), so this uses eth_simulateV1 on a real RPC: it deploys the
// wrapper inside the simulation and walks a holder through
//   wrap -> approve -> bridgeToChia -> (portal) release -> unwrap.
//
// Usage, from the repo root after `forge build` in contracts/:
//   node contracts/script/simulate-base.mjs
//   BASE_RPC=https://your-rpc node contracts/script/simulate-base.mjs
//
// It does NOT prove the validators will sign: it reads no storage and checks
// no logs the way the signer does. That needs one real deposit. The sampled
// holder may also be a contract, and paused or frozen states are not covered.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";

const RPC = process.env.BASE_RPC || "https://base-rpc.publicnode.com";
const BRIDGE = "0x8412f06e811b858Ea9edcf81a5E5882dbf70aC96";
const PORTAL = "0x382bd36d1dE6Fe0a3D9943004D3ca5Ee389627EE";
const STOCKS = [
  ["SPCXc", "0xb2000000000000000000007b9fcbd005511aCBd5"],
  ["NVDAc", "0xb20000000000000000000078ee7ce2fE4908108C"],
  ["ANTc", "0xb20000000000000000000016e38FD364d271Ba28"],
];
const MOJO = 500n; // 0.5 token; 1 mojo = 10^(decimals-3) raw units
const RECEIVER_PH = "0x" + "11".repeat(32); // placeholder Chia puzzle hash

const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  readFileSync(join(here, "..", "out", "WrappedStock.sol", "WrappedStock.json"), "utf8")
);

const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true, batchMaxCount: 1 });
const erc20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function multiplier() view returns (uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const wrapper = new ethers.Interface(artifact.abi);
const bridge = new ethers.Interface([
  "function bridgeToChia(address,bytes32,uint256) payable",
  "function receiveMessage(bytes32,bytes3,bytes32,bytes32[])",
  "function burnPuzzleHash() view returns (bytes32)",
  "function tip() view returns (uint256)",
]);
const portal = new ethers.Interface(["function messageToll() view returns (uint256)"]);

async function call(to, iface, fn, args = []) {
  const data = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, data)[0];
}

async function findHolder(token, needed) {
  const head = await provider.getBlockNumber();
  const topic = erc20.getEvent("Transfer").topicHash;
  for (let back = 0; back < 80; back++) {
    const toBlock = head - back * 2000;
    let logs;
    try {
      logs = await provider.getLogs({ address: token, topics: [topic], fromBlock: toBlock - 1999, toBlock });
    } catch {
      continue;
    }
    for (const log of logs.reverse()) {
      const holder = ethers.getAddress("0x" + log.topics[2].slice(26));
      if (holder.toLowerCase() === BRIDGE.toLowerCase()) continue;
      if ((await call(token, erc20, "balanceOf", [holder])) >= needed) return holder;
    }
  }
  return null;
}

const pad = (addr) => ethers.zeroPadValue(addr, 32);
const word = (n) => ethers.toBeHex(n, 32);

async function rehearse(symbol, token) {
  const decimals = Number(await call(token, erc20, "decimals"));
  const factor = 10n ** BigInt(decimals - 3);
  const raw = MOJO * factor;
  const holder = await findHolder(token, raw);
  if (!holder) {
    console.log(`${symbol}: NOT CHECKED, no holder with ${raw} raw units found`);
    return false;
  }

  const nonce = await provider.getTransactionCount(holder);
  const W = ethers.getCreateAddress({ from: holder, nonce });
  const toll = await call(PORTAL, portal, "messageToll");
  const tipBps = await call(BRIDGE, bridge, "tip");
  const burnPh = await call(BRIDGE, bridge, "burnPuzzleHash");

  let tipMojo = (MOJO * tipBps) / 10000n;
  if (tipMojo < 1n) tipMojo = 1n;
  const netMojo = MOJO - tipMojo;

  const initcode = ethers.concat([
    artifact.bytecode.object,
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "string", "string"],
      [token, `Wrapped ${symbol}`, `w${symbol}`]
    ),
  ]);

  const h = (to, data, value) => ({ from: holder, to, data, ...(value ? { value: ethers.toBeHex(value) } : {}) });
  // Views come from a neutral address: every simulated call bumps its sender's
  // nonce, and the wrapper's address depends on the holder's.
  const VIEWER = "0x000000000000000000000000000000000000dEaD";
  const view = (to, iface, fn, args = []) => ({ from: VIEWER, to, data: iface.encodeFunctionData(fn, args) });
  const steps = [
    ["view: stock with holder before", view(token, erc20, "balanceOf", [holder])],
    ["deploy wrapper", { from: holder, data: initcode }],
    ["approve stock -> wrapper", h(token, erc20.encodeFunctionData("approve", [W, raw]))],
    ["wrap (deposit)", h(W, wrapper.encodeFunctionData("deposit", [raw]))],
    ["approve wrapped -> bridge", h(W, wrapper.encodeFunctionData("approve", [BRIDGE, raw]))],
    ["bridgeToChia", h(BRIDGE, bridge.encodeFunctionData("bridgeToChia", [W, RECEIVER_PH, MOJO]), toll)],
    ["view: wrapped held by bridge", view(W, wrapper, "balanceOf", [BRIDGE])],
    ["view: wrapped tip at portal", view(W, wrapper, "balanceOf", [PORTAL])],
    ["view: wrapper backing", view(W, wrapper, "backing")],
    ["view: wrapper totalSupply", view(W, wrapper, "totalSupply")],
    ["view: wrapper decimals", view(W, wrapper, "decimals")],
    ["view: wrapper uiMultiplier", view(W, wrapper, "uiMultiplier")],
    [
      "release from bridge (as portal)",
      {
        from: PORTAL,
        to: BRIDGE,
        data: bridge.encodeFunctionData("receiveMessage", [
          word(1n),
          ethers.hexlify(ethers.toUtf8Bytes("xch")),
          burnPh,
          [pad(W), pad(holder), word(netMojo)],
        ]),
      },
    ],
    ["view: wrapped back with holder", view(W, wrapper, "balanceOf", [holder])],
    ["view: wrapped left in bridge", view(W, wrapper, "balanceOf", [BRIDGE])],
  ];

  const run = async (list) =>
    (
      await provider.send("eth_simulateV1", [
        {
          blockStateCalls: [
            {
              stateOverrides: {
                [holder]: { balance: ethers.toBeHex(ethers.parseEther("1")) },
                [PORTAL]: { balance: ethers.toBeHex(ethers.parseEther("1")) },
              },
              calls: list.map(([, c]) => c),
            },
          ],
          validation: false,
        },
        "latest",
      ])
    )[0].calls;

  let results = await run(steps);
  const failed = results.findIndex((r) => r.status !== "0x1");
  if (failed >= 0) {
    console.log(`${symbol}: FAILED at "${steps[failed][0]}": ${JSON.stringify(results[failed].error ?? results[failed].returnData)}`);
    return false;
  }
  const num = (label) => BigInt(results[steps.findIndex(([l]) => l === label)].returnData);
  const back = num("view: wrapped back with holder");

  // Second pass: same steps plus unwrapping everything the holder got back.
  const full = [
    ...steps,
    ["unwrap (withdraw)", h(W, wrapper.encodeFunctionData("withdraw", [back]))],
    ["view: stock back with holder", view(token, erc20, "balanceOf", [holder])],
    ["view: wrapper totalSupply after", view(W, wrapper, "totalSupply")],
    ["view: wrapper backing after", view(W, wrapper, "backing")],
  ];
  results = await run(full);
  const failed2 = results.findIndex((r) => r.status !== "0x1");
  if (failed2 >= 0) {
    console.log(`${symbol}: FAILED at "${full[failed2][0]}": ${JSON.stringify(results[failed2].error ?? results[failed2].returnData)}`);
    return false;
  }
  const num2 = (label) => BigInt(results[full.findIndex(([l]) => l === label)].returnData);
  // Both reads come from the same simulated block, so a busy holder (a pool)
  // cannot move between them.
  const stockBefore = num2("view: stock with holder before");
  const stockAfter = num2("view: stock back with holder");

  // ERC20Bridge.receiveMessage takes its tip in raw units, minimum 1.
  let releaseTip = (netMojo * factor * tipBps) / 10000n;
  if (releaseTip === 0n) releaseTip = 1n;

  const checks = [
    ["bridge holds net deposit", num("view: wrapped held by bridge") === netMojo * factor],
    ["portal holds the deposit tip", num("view: wrapped tip at portal") === tipMojo * factor],
    ["wrapper fully backed while bridged", num("view: wrapper backing") === num("view: wrapper totalSupply")],
    ["wrapper decimals match stock", num("view: wrapper decimals") === BigInt(decimals)],
    ["multiplier passes through", num("view: wrapper uiMultiplier") === (await call(token, erc20, "multiplier"))],
    ["bridge emptied by release", num("view: wrapped left in bridge") === 0n],
    ["wrapper still fully backed after unwrap", num2("view: wrapper backing after") === num2("view: wrapper totalSupply after")],
    ["only the two tips left wrapped", num2("view: wrapper totalSupply after") === tipMojo * factor + releaseTip],
    ["holder got stock back 1:1", stockAfter === stockBefore - raw + back],
  ];
  console.log(`${symbol}: holder ${holder}, wrapper would deploy at ${W}`);
  console.log(`  in ${ethers.formatUnits(raw, decimals)}  back ${ethers.formatUnits(back, decimals)}  multiplier ${ethers.formatUnits(num("view: wrapper uiMultiplier"), 18)}`);
  for (const [label, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  return checks.every(([, ok]) => ok);
}

let allOk = true;
for (const [symbol, token] of STOCKS) {
  try {
    if ((await rehearse(symbol, token)) === false) allOk = false;
  } catch (e) {
    allOk = false;
    console.log(`${symbol}: ERROR ${e.shortMessage ?? e.message}`);
  }
}
process.exit(allOk ? 0 : 1);
