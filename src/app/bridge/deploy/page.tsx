"use client";

import * as GreenWeb from 'greenwebjs';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Suspense, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { BASE_NETWORK, CHIA_NETWORK } from "../config";
import { concat, ContractFactory, getCreate2Address, hexlify, Interface, keccak256, parseEther, sha256, solidityPacked, toUtf8Bytes } from "ethers";
import { MultiSendABI, WrappedCATABI, WrappedCATBytecode } from "../drivers/abis";
import { getLockerPuzzle, getUnlockerPuzzle } from "../drivers/catbridge";
import { getWrappedERC20AssetID } from "../drivers/erc20bridge";

export default function DeployPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ActualDeployPage />
    </Suspense>
  );
}

function ActualDeployPage() {
  const account = useAccount();
  const { writeContractAsync } = useWriteContract();
  
  const [assetId, setAssetId] = useState('');
  const [chiaSymbol, setChiaSymbol] = useState('');
  const [convertedSymbol, setConvertedSymbol] = useState('');
  const [name, setName] = useState('');
  const [predictedContractAddress, setPredictedContractAddress] = useState('');

  const [erc20Address, setErc20Address] = useState('');
  const [computedChiaAssetId, setComputedChiaAssetId] = useState('');
  const [erc20AddressError, setErc20AddressError] = useState('');

  const computeChiaAssetId = () => {
    const addr = erc20Address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setErc20AddressError('Invalid ERC20 address. Must be a 0x-prefixed 40-character hex address.');
      setComputedChiaAssetId('');
      return;
    }
    setErc20AddressError('');
    try {
      const assetIdHex = getWrappedERC20AssetID(BASE_NETWORK, addr.slice(2));
      setComputedChiaAssetId(assetIdHex);
    } catch (e) {
      setErc20AddressError('Failed to compute asset ID. Check that BASE_NETWORK is configured correctly.');
      setComputedChiaAssetId('');
    }
  };

  const dataCompleted = assetId.length === 64 && Array.from(chiaSymbol).length >= 1 && name.length > 0;

  // Convert symbol to Unicode code points
const convertSymbolToUnicode = (symbol: string) => {
  return Array.from(symbol)
    .map(char => {
      const cp = char.codePointAt(0);
      if (cp === undefined) return '';
      const codePoint = cp.toString(16).toUpperCase();
      return codePoint !== 'FE0F' ? `U+${codePoint}` : ''; // Exclude U+FE0F
    })
    .filter(Boolean) // Remove empty entries
    .join(' ');
};

  // Handle chiaSymbol change
  const handleChiaSymbolChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newSymbol = e.target.value;
    setChiaSymbol(newSymbol);
    setConvertedSymbol(convertSymbolToUnicode(newSymbol));
  };

  const deployPls = async () => {
    const symbol = chiaSymbol;
    if (!symbol) return; // Ensures the symbol is set

    console.log({ symbol, name, assetId });

    const mojoToTokenRatio = 1e15;
    const createCallAddress = BASE_NETWORK.createCallAddress!;
    const portalAddress = BASE_NETWORK.portalAddress!;

    const deploymentSalt = sha256(
      toUtf8Bytes("you cannot imagine how many times yak manually changed this string during testing")
    );

    const wrappedCatFactory = new ContractFactory(
      WrappedCATABI,
      WrappedCATBytecode
    );

    const deploymentTx = await wrappedCatFactory.getDeployTransaction(
      name,
      symbol,
      portalAddress,
      30,
      mojoToTokenRatio,
      hexlify(toUtf8Bytes("xch"))
    );

    const deploymentTxData = deploymentTx.data;

    const initCodeHash = keccak256(deploymentTxData);
    const predictedAddress = getCreate2Address(
      createCallAddress,
      deploymentSalt,
      initCodeHash
    );
    console.log("Predicted WrappedCAT address:", predictedAddress);
    setPredictedContractAddress(predictedAddress);

    const lockerPuzzleHash = GreenWeb.util.sexp.sha256tree(getLockerPuzzle(
      hexlify(toUtf8Bytes("bse")).replace("0x", ""),
      predictedAddress.replace("0x", ""),
      CHIA_NETWORK.portalLauncherId!.replace("0x", ""),
      assetId
    ));
    console.log("Locker puzzle hash:", lockerPuzzleHash);

    const unlockerPuzzleHash = GreenWeb.util.sexp.sha256tree(getUnlockerPuzzle(
      hexlify(toUtf8Bytes("bse")).replace("0x", ""),
      predictedAddress.replace("0x", ""),
      CHIA_NETWORK.portalLauncherId!.replace("0x", ""),
      assetId
    ));
    console.log("Unlocker puzzle hash:", unlockerPuzzleHash);

    const CreateCallABI = [
      "function performCreate2(uint256 value, bytes memory deploymentData, bytes32 salt) external returns (address)"
    ];
    const createCallInterface = new Interface(CreateCallABI);
    const deployData = createCallInterface.encodeFunctionData("performCreate2", [
      0,
      deploymentTxData,
      deploymentSalt
    ]);

    const deployDataSize = Math.floor(deployData.replace("0x", "").length / 2);
    const deployTxEncoded = solidityPacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [0, createCallAddress, 0, deployDataSize, deployData]
    );

    const wrappedCatInterface = new Interface(WrappedCATABI);
    const initData = wrappedCatInterface.encodeFunctionData("initializePuzzleHashes", [
      `0x${lockerPuzzleHash}`,
      `0x${unlockerPuzzleHash}`,
    ]);

    const initDataSize = Math.floor(initData.replace("0x", "").length / 2);
    const initTxEncoded = solidityPacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [0, predictedAddress, 0, initDataSize, initData]
    );

    console.log("Calling multiSend...");
    const transactions = concat([deployTxEncoded, initTxEncoded]);
    const resp = await writeContractAsync({
      address: BASE_NETWORK.multiCallAddress!,
      abi: MultiSendABI,
      functionName: "multiSend",
      args: [transactions as `0x${string}`],
      value: BigInt(0),
      chainId: BASE_NETWORK.chainId!
    });
    console.log({ resp });
  };

  return (
    <div className="max-w-xl flex flex-col justify-center mx-auto w-full break-words grow">
      <div className="rounded-lg flex flex-col gap-4 p-6 ">
        <h1 className="text-2xl font-bold">Deploy a Wrapped CAT Contract</h1>
        <p className="text-muted-foreground mb-8">
          For more information, please see <a className="underline" href="https://docs.warp.green/users/creating-a-new-wrapped-cat" target="_blank">this page</a>.
        </p>
        <p>CAT asset id on Chia (TAIL hash):</p>
        <div className="flex items-center h-14 w-full gap-2 mb-4">
          <Input
            type="text"
            placeholder="Asset ID"
            className="text-xl h-full border-0"
            pattern="^\d*(\.\d{0,8})?$"
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
          />
        </div>

        <p>Asset Name:</p>
        <div className="flex items-center h-14 w-full gap-2 mb-4">
          <Input
            type="text"
            placeholder="Name"
            className="text-xl h-full border-0"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <p>CAT symbol on Chia:</p>
        <div className="flex items-center h-14 w-full gap-2 mb-8">
          <Input
            type="text"
            placeholder="Symbol"
            className="text-xl h-full border-0"
            value={chiaSymbol}
            onChange={handleChiaSymbolChange}
          />
        </div>

        <div className={cn("mx-8 flex justify-center", account?.address == undefined || !dataCompleted && 'cursor-not-allowed')}>
          <Button
            type="submit"
            className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
            onClick={deployPls}
            disabled={account?.address == undefined || !dataCompleted}
          >
            {
              account?.address == undefined ? "Connect Base Wallet First"
                :
                dataCompleted ? "Deploy" : "Complete Info First"
            }
          </Button>
        </div>

        {predictedContractAddress && (
          <p>Predicted contract address: {predictedContractAddress}</p>
        )}

        {chiaSymbol && (
          <p>Unicode representation (for testing): {convertSymbolToUnicode(chiaSymbol)}</p>
        )}
      </div>

      <div className="rounded-lg flex flex-col gap-4 p-6 mt-4 border-t border-border">
        <h1 className="text-2xl font-bold">ERC20 → Chia Asset ID Calculator</h1>
        <p className="text-muted-foreground mb-4">
          Enter any Base ERC20 contract address to compute the Chia wrapped asset ID (TAIL hash).
          Use this ID when adding the token to the bridge token list in <code>config.tsx</code>.
        </p>

        <p>Base ERC20 contract address:</p>
        <div className="flex items-center h-14 w-full gap-2 mb-2">
          <Input
            type="text"
            placeholder="0x..."
            className="text-xl h-full border-0 font-mono"
            value={erc20Address}
            onChange={(e) => { setErc20Address(e.target.value); setComputedChiaAssetId(''); setErc20AddressError(''); }}
          />
        </div>

        {erc20AddressError && (
          <p className="text-red-500 text-sm">{erc20AddressError}</p>
        )}

        <div className="mx-8 flex justify-center mb-2">
          <Button
            type="button"
            className="w-full h-14 bg-theme-purple hover:bg-theme-purple text-primary hover:opacity-80 text-xl"
            onClick={computeChiaAssetId}
            disabled={erc20Address.trim().length === 0}
          >
            Compute Chia Asset ID
          </Button>
        </div>

        {computedChiaAssetId && (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground">Chia Wrapped Asset ID (TAIL hash):</p>
            <p className="font-mono text-sm break-all bg-muted rounded p-3 select-all">{computedChiaAssetId}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add this as <code>assetId</code> and <code>{erc20Address}</code> as <code>contractAddress</code> in a new token entry in <code>config.tsx</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}