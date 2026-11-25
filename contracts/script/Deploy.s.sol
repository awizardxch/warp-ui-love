// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {WrappedStock} from "../src/WrappedStock.sol";

/// Deploys one WrappedStock. Nothing is sent unless you pass --broadcast.
///
///   UNDERLYING=0x... NAME="Wrapped NVDAc" SYMBOL=wNVDAc \
///   forge script script/Deploy.s.sol --rpc-url $BASE_RPC --broadcast --account <keystore>
contract Deploy is Script {
    function run() external {
        address underlying = vm.envAddress("UNDERLYING");
        string memory name = vm.envString("NAME");
        string memory symbol = vm.envString("SYMBOL");

        vm.startBroadcast();
        WrappedStock wrapped = new WrappedStock(underlying, name, symbol);
        vm.stopBroadcast();

        console.log("WrappedStock:", address(wrapped));
        console.log("underlying:  ", wrapped.underlying());
        console.log("decimals:    ", wrapped.decimals());
    }
}
