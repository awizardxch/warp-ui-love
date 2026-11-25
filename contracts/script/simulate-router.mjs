// Read-only rehearsal of StockBridgeRouter against live Base. Sends nothing.
//
// Uses eth_simulateV1 with the real ERC20Bridge, Portal and the deployed
// WrappedStock wrappers. It deploys the router inside the simulation and walks
// a real holder of each stock through:
//   approve -> wrapAndBridge (one call) -> release to the holder's forwarder -> sweep
//
// Usage, from the repo root after `forge build` in contracts/:
//   node contracts/script/simulate-router.mjs
//
// All reads and the simulation use one pinned block.
//
// Limits: the release is simulated as the portal calling the bridge, because
// real validator signatures cannot be produced here, so `claimAndUnwrap`'s
// call into the portal is covered by the Foundry tests only. It does not prove
// the validators will sign a router deposit: that needs one real deposit.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";

const RPC = process.env.BASE_RPC || "https://base-rpc.publicnode.com";
const BRIDGE = "0x8412f06e811b858Ea9edcf81a5E5882dbf70aC96";
const PORTAL = "0x382bd36d1dE6Fe0a3D9943004D3ca5Ee389627EE";
const VIEWER = "0x000000000000000000000000000000000000dEaD";
const STRANGER = "0x00000000000000000000000000000000000B0b00";
const STOCKS = [
  ["SPCXc", "0xb2000000000000000000007b9fcbd005511aCBd5", "0x1209B7d5DeAC8EA458696b54558300a839eF4cf4"],
  ["NVDAc", "0xb20000000000000000000078ee7ce2fE4908108C", "0x0D8b4Fd641183350f41219180F375762E3A77567"],
  ["ANTc", "0xb20000000000000000000016e38FD364d271Ba28", "0x91d2cC66952945a4b74b18ef356942e92f473aE7"],
];
const MOJO = 500n; // 0.5 token
const RECEIVER_PH = "0x" + "11".repeat(32);

const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  readFileSync(join(here, "..", "out", "StockBridgeRouter.sol", "StockBridgeRouter.json"), "utf8")
);

// The site derives forwarder addresses itself from this hash (CREATE2) and
// requires the router to agree; the rehearsal checks the two match.
const forwarderInitCodeHash = ethers.keccak256(
  JSON.parse(readFileSync(join(here, "..", "out", "StockBridgeRouter.sol", "UnwrapForwarder.json"), "utf8")).bytecode.object
);

const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true, batchMaxCount: 1 });
const erc20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const router = new ethers.Interface(artifact.abi);
const bridge = new ethers.Interface([
  "function bridgeToChia(address,bytes32,uint256) payable",
  "function receiveMessage(bytes32,bytes3,bytes32,bytes32[])",
  "function burnPuzzleHash() view returns (bytes32)",
  "function tip() view returns (uint256)",
]);
const portal = new ethers.Interface(["function messageToll() view returns (uint256)"]);

// Every read and the simulation itself use this one block. A busy holder can
// move its tokens, or its nonce, between being picked and being simulated;
// pinning the block removes that race.
const BLOCK = (await provider.getBlockNumber()) - 2;
const BLOCK_TAG = ethers.toQuantity(BLOCK);

async function call(to, iface, fn, args = []) {
  const data = await provider.call({ to, data: iface.encodeFunctionData(fn, args), blockTag: BLOCK });
  return iface.decodeFunctionResult(fn, data)[0];
}

async function findHolder(token, needed) {
  const head = BLOCK;
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

// The signer's scan: every place the bridgeToChia selector appears in the
// transaction input, followed by this asset and receiver.
function signerMatches(input, wrapper, receiverPh) {
  const hex = input.toLowerCase().replace(/^0x/, "");
  const needle = ("cdb50da7" + pad(wrapper).slice(2) + receiverPh.slice(2)).toLowerCase();
  const amounts = [];
  for (let i = hex.indexOf(needle); i >= 0; i = hex.indexOf(needle, i + 2)) {
    if (i % 2 === 0) amounts.push(BigInt("0x" + hex.slice(i + needle.length, i + needle.length + 64)));
  }
  return amounts;
}

async function simulate(holder, calls) {
  return (
    await provider.send("eth_simulateV1", [
      {
        blockStateCalls: [
          {
            stateOverrides: {
              [holder]: { balance: ethers.toBeHex(ethers.parseEther("1")) },
              [PORTAL]: { balance: ethers.toBeHex(ethers.parseEther("1")) },
              [STRANGER]: { balance: ethers.toBeHex(ethers.parseEther("1")) },
            },
            calls,
          },
        ],
        validation: false,
      },
      BLOCK_TAG,
    ])
  )[0].calls;
}

async function rehearse(symbol, token, wrapper) {
  const decimals = Number(await call(token, erc20, "decimals"));
  const factor = 10n ** BigInt(decimals - 3);
  const raw = MOJO * factor;
  const holder = await findHolder(token, raw);
  if (!holder) {
    console.log(`${symbol}: NOT CHECKED, no holder with ${raw} raw units found`);
    return false;
  }

  const nonce = await provider.getTransactionCount(holder, BLOCK);
  const R = ethers.getCreateAddress({ from: holder, nonce });
  const toll = await call(PORTAL, portal, "messageToll");
  const tipBps = await call(BRIDGE, bridge, "tip");
  const burnPh = await call(BRIDGE, bridge, "burnPuzzleHash");
  let tipMojo = (MOJO * tipBps) / 10000n;
  if (tipMojo < 1n) tipMojo = 1n;
  const netMojo = MOJO - tipMojo;
  let releaseTip = (netMojo * factor * tipBps) / 10000n;
  if (releaseTip === 0n) releaseTip = 1n;

  const initcode = ethers.concat([
    artifact.bytecode.object,
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [BRIDGE, PORTAL]),
  ]);
  const bridgeCall = bridge.encodeFunctionData("bridgeToChia", [wrapper, RECEIVER_PH, MOJO]);
  const depositInput = router.encodeFunctionData("wrapAndBridge", [bridgeCall]);

  const view = (to, iface, fn, args = []) => ({ from: VIEWER, to, data: iface.encodeFunctionData(fn, args) });
  const deposit = [
    ["view: stock before", view(token, erc20, "balanceOf", [holder])],
    ["view: bridge wrapped before", view(wrapper, erc20, "balanceOf", [BRIDGE])],
    ["deploy router", { from: holder, data: initcode }],
    ["approve stock -> router", { from: holder, to: token, data: erc20.encodeFunctionData("approve", [R, raw]) }],
    ["wrapAndBridge (one call)", { from: holder, to: R, data: depositInput, value: ethers.toBeHex(toll) }],
    ["view: bridge wrapped after deposit", view(wrapper, erc20, "balanceOf", [BRIDGE])],
    ["view: router stock", view(token, erc20, "balanceOf", [R])],
    ["view: router wrapped", view(wrapper, erc20, "balanceOf", [R])],
    ["view: router->wrapper allowance", view(token, erc20, "allowance", [R, wrapper])],
    ["view: router->bridge allowance", view(wrapper, erc20, "allowance", [R, BRIDGE])],
    ["view: holder->router allowance", view(token, erc20, "allowance", [holder, R])],
    ["view: forwarderOf(holder)", view(R, router, "forwarderOf", [holder])],
  ];

  let results = await simulate(holder, deposit.map(([, c]) => c));
  let failed = results.findIndex((r) => r.status !== "0x1");
  if (failed >= 0) {
    console.log(`${symbol}: FAILED at "${deposit[failed][0]}": ${JSON.stringify(results[failed].error ?? results[failed].returnData)}`);
    const held = await call(token, erc20, "balanceOf", [holder]);
    console.log(`  holder ${holder} holds ${held} raw units at block ${BLOCK}; the deposit needs ${raw}`);
    return false;
  }
  const at = (list, res, label) => res[list.findIndex(([l]) => l === label)].returnData;
  const forwarder = ethers.getAddress("0x" + at(deposit, results, "view: forwarderOf(holder)").slice(-40));

  // Second pass: the same deposit, then the way back through the forwarder.
  const full = [
    ...deposit,
    [
      "release to the forwarder (as portal)",
      {
        from: PORTAL,
        to: BRIDGE,
        data: bridge.encodeFunctionData("receiveMessage", [
          word(1n),
          ethers.hexlify(ethers.toUtf8Bytes("xch")),
          burnPh,
          [pad(wrapper), pad(forwarder), word(netMojo)],
        ]),
      },
    ],
    ["view: forwarder wrapped after release", view(wrapper, erc20, "balanceOf", [forwarder])],
    ["sweep, called by a stranger", { from: STRANGER, to: R, data: router.encodeFunctionData("sweep", [holder, wrapper]) }],
    ["view: forwarder wrapped after sweep", view(wrapper, erc20, "balanceOf", [forwarder])],
    ["view: stock after", view(token, erc20, "balanceOf", [holder])],
    ["view: stranger stock", view(token, erc20, "balanceOf", [STRANGER])],
    ["view: bridge wrapped at end", view(wrapper, erc20, "balanceOf", [BRIDGE])],
  ];
  results = await simulate(holder, full.map(([, c]) => c));
  failed = results.findIndex((r) => r.status !== "0x1");
  if (failed >= 0) {
    console.log(`${symbol}: FAILED at "${full[failed][0]}": ${JSON.stringify(results[failed].error ?? results[failed].returnData)}`);
    return false;
  }
  const num = (label) => BigInt(at(full, results, label));
  const bridgeBefore = num("view: bridge wrapped before");
  const payout = netMojo * factor - releaseTip;
  const matches = signerMatches(depositInput, wrapper, RECEIVER_PH);

  const derived = ethers.getCreate2Address(R, ethers.zeroPadValue(holder, 32), forwarderInitCodeHash);
  const checks = [
    ["forwarder address derived off chain matches the router's", derived === forwarder],
    ["signer finds exactly one bridge call in the input", matches.length === 1 && matches[0] === MOJO],
    ["bridge gained exactly the net deposit", num("view: bridge wrapped after deposit") - bridgeBefore === netMojo * factor],
    ["router holds no stock", num("view: router stock") === 0n],
    ["router holds no wrapped token", num("view: router wrapped") === 0n],
    ["router left no approvals", num("view: router->wrapper allowance") === 0n && num("view: router->bridge allowance") === 0n],
    ["holder's approval fully used", num("view: holder->router allowance") === 0n],
    ["release reached the forwarder", num("view: forwarder wrapped after release") === payout],
    ["forwarder emptied by the sweep", num("view: forwarder wrapped after sweep") === 0n],
    ["holder got the stock back, less two tips", num("view: stock after") === num("view: stock before") - raw + payout],
    ["stranger who swept received nothing", num("view: stranger stock") === 0n],
    ["bridge back to where it started", num("view: bridge wrapped at end") === bridgeBefore],
  ];
  console.log(`${symbol}: holder ${holder}, router would deploy at ${R}`);
  console.log(`  in ${ethers.formatUnits(raw, decimals)}  back ${ethers.formatUnits(payout, decimals)}  forwarder ${forwarder}`);
  for (const [label, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  return checks.every(([, ok]) => ok);
}

let allOk = true;
for (const [symbol, token, wrapper] of STOCKS) {
  try {
    if ((await rehearse(symbol, token, wrapper)) === false) allOk = false;
  } catch (e) {
    allOk = false;
    console.log(`${symbol}: ERROR ${e.shortMessage ?? e.message}`);
  }
}
process.exit(allOk ? 0 : 1);
