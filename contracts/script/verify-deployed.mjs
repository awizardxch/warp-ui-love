// Read-only check that a deployed wrapper is the compiled WrappedStock for the
// expected token. Sends nothing.
//
// Usage, from the repo root after `forge build` in contracts/:
//   node contracts/script/verify-deployed.mjs <underlying> <wrapper> [<underlying> <wrapper> ...]
//
// It compares the on-chain runtime code with the compiled artifact (ignoring
// the immutable slots, which differ per deployment) and reads the wrapper's
// own view of what it wraps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";

const RPC = process.env.BASE_RPC || "https://base-rpc.publicnode.com";
const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  readFileSync(join(here, "..", "out", "WrappedStock.sol", "WrappedStock.json"), "utf8")
);
const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true, batchMaxCount: 1 });
const wrapperAbi = new ethers.Interface(artifact.abi);
const tokenAbi = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

async function call(to, iface, fn, args = []) {
  const data = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, data)[0];
}

// Zero out the bytes where immutables are stored so two deployments compare equal.
function maskImmutables(hex) {
  const bytes = ethers.getBytes(hex);
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) bytes.fill(0, start, start + length);
  }
  return ethers.hexlify(bytes);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
  console.error("Usage: verify-deployed.mjs <underlying> <wrapper> [<underlying> <wrapper> ...]");
  process.exit(2);
}

const expectedCode = maskImmutables(artifact.deployedBytecode.object);
let allOk = true;
for (let i = 0; i < args.length; i += 2) {
  const underlying = ethers.getAddress(args[i].toLowerCase());
  const wrapper = ethers.getAddress(args[i + 1].toLowerCase());
  try {
    const code = await provider.getCode(wrapper);
    const stockSymbol = await call(underlying, tokenAbi, "symbol");
    const stockDecimals = await call(underlying, tokenAbi, "decimals");
    const checks = [
      ["runtime code is the compiled WrappedStock", code !== "0x" && maskImmutables(code) === expectedCode],
      ["wraps the expected token", (await call(wrapper, wrapperAbi, "underlying")) === underlying],
      ["decimals match the token", (await call(wrapper, wrapperAbi, "decimals")) === stockDecimals],
      ["fully backed", (await call(wrapper, wrapperAbi, "backing")) >= (await call(wrapper, wrapperAbi, "totalSupply"))],
    ];
    console.log(`${stockSymbol}: wrapper ${wrapper}`);
    console.log(`  name "${await call(wrapper, wrapperAbi, "name")}"  symbol "${await call(wrapper, wrapperAbi, "symbol")}"  supply ${ethers.formatUnits(await call(wrapper, wrapperAbi, "totalSupply"), stockDecimals)}`);
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
      if (!ok) allOk = false;
    }
  } catch (e) {
    allOk = false;
    console.log(`${wrapper}: ERROR ${e.shortMessage ?? e.message}`);
  }
}
process.exit(allOk ? 0 : 1);
