// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {WrappedStock} from "../src/WrappedStock.sol";

/// Deploys one WrappedStock. Nothing is sent unless you pass --broadcast.
///
///   UNDERLYING=0x... NAME="Milli Wrapped NVDAc" SYMBOL=m.wNVDAc DECIMALS=5 \
///   forge script script/Deploy.s.sol --rpc-url $BASE_RPC --broadcast --account <keystore>
contract Deploy is Script {
    function run() external {
        address underlying = vm.envAddress("UNDERLYING");
        string memory name = vm.envString("NAME");
        string memory symbol = vm.envString("SYMBOL");
        // 5 for a milli wrapper of an 8-decimal stock; the stock's own decimals for a plain one.
        uint8 decimals = uint8(vm.envUint("DECIMALS"));

        vm.startBroadcast();
        WrappedStock wrapped = new WrappedStock(underlying, name, symbol, decimals);
        vm.stopBroadcast();

        console.log("WrappedStock:", address(wrapped));
        console.log("underlying:  ", wrapped.underlying());
        console.log("decimals:    ", wrapped.decimals());
        console.log("underlying decimals:", wrapped.underlyingDecimals());
    }
}
