// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WrappedStock} from "../src/WrappedStock.sol";

/// Stand-in for a B20 stock token: 8 decimals, raw balances, a multiplier view.
contract MockStock {
    string public name = "Mock Stock";
    string public symbol = "MOCKc";
    uint8 public constant decimals = 8;
    uint256 public multiplier = 1e18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burnFrom(address from, uint256 amount) external {
        balanceOf[from] -= amount;
    }

    function setMultiplier(uint256 m) external {
        multiplier = m;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Takes 1% on every transferFrom.
contract FeeStock is MockStock {
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }
}

/// Returns false instead of reverting.
contract FalseStock is MockStock {
    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// Returns the word 2 from transferFrom: neither true nor false.
contract OddReturnStock is MockStock {
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/// Returns nothing from transfer/transferFrom, like some older tokens.
contract NoReturnStock {
    uint8 public constant decimals = 8;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Deposits work; every transfer out fails, like a frozen holder.
contract FrozenOutStock is MockStock {
    function transfer(address, uint256) external pure override returns (bool) {
        revert("frozen");
    }
}

/// No multiplier() view at all.
contract PlainToken {
    uint8 public constant decimals = 6;

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/// Tries to re-enter the wrapper from inside transferFrom.
contract ReentrantStock is MockStock {
    WrappedStock public target;

    function setTarget(WrappedStock t) external {
        target = t;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        target.withdraw(1);
        return true;
    }
}

contract WrappedStockTest is Test {
    MockStock stock;
    WrappedStock wrapped;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address bridge = makeAddr("bridge");

    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public {
        stock = new MockStock();
        wrapped = new WrappedStock(address(stock), "Wrapped MOCKc", "wMOCKc");
        stock.mint(alice, 1_000e8);
        vm.prank(alice);
        stock.approve(address(wrapped), type(uint256).max);
    }

    function _assertSolvent() internal view {
        assertGe(wrapped.backing(), wrapped.totalSupply(), "backing < supply");
    }

    // --- metadata -------------------------------------------------------

    function test_metadata() public view {
        assertEq(wrapped.name(), "Wrapped MOCKc");
        assertEq(wrapped.symbol(), "wMOCKc");
        assertEq(wrapped.decimals(), 8);
        assertEq(wrapped.underlying(), address(stock));
        assertEq(wrapped.totalSupply(), 0);
    }

    function test_constructor_rejectsNonContract() public {
        vm.expectRevert(WrappedStock.InvalidUnderlying.selector);
        new WrappedStock(address(0), "x", "x");
        vm.expectRevert(WrappedStock.InvalidUnderlying.selector);
        new WrappedStock(makeAddr("eoa"), "x", "x");
    }

    function test_constructor_acceptsOneByteCode() public {
        // B20 tokens report a single 0xef byte of code.
        address native = makeAddr("native");
        vm.etch(native, hex"ef");
        vm.mockCall(native, abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        WrappedStock w = new WrappedStock(native, "x", "x");
        assertEq(w.decimals(), 8);
    }

    // --- deposit / withdraw ---------------------------------------------

    function test_deposit_mintsOneToOne() public {
        vm.expectEmit(true, true, false, true, address(wrapped));
        emit Transfer(address(0), alice, 5e8);
        vm.prank(alice);
        wrapped.deposit(5e8);

        assertEq(wrapped.balanceOf(alice), 5e8);
        assertEq(wrapped.totalSupply(), 5e8);
        assertEq(stock.balanceOf(address(wrapped)), 5e8);
        assertEq(stock.balanceOf(alice), 995e8);
        _assertSolvent();
    }

    function test_depositFor_creditsReceiver() public {
        vm.prank(alice);
        wrapped.depositFor(bob, 3e8);
        assertEq(wrapped.balanceOf(bob), 3e8);
        assertEq(wrapped.balanceOf(alice), 0);
    }

    function test_withdraw_returnsOneToOne() public {
        vm.startPrank(alice);
        wrapped.deposit(5e8);
        vm.expectEmit(true, true, false, true, address(wrapped));
        emit Transfer(alice, address(0), 2e8);
        wrapped.withdraw(2e8);
        vm.stopPrank();

        assertEq(wrapped.balanceOf(alice), 3e8);
        assertEq(wrapped.totalSupply(), 3e8);
        assertEq(stock.balanceOf(alice), 997e8);
        assertEq(stock.balanceOf(address(wrapped)), 3e8);
        _assertSolvent();
    }

    function test_withdrawTo_sendsUnderlyingElsewhere() public {
        vm.startPrank(alice);
        wrapped.deposit(5e8);
        wrapped.withdrawTo(bob, 5e8);
        vm.stopPrank();
        assertEq(stock.balanceOf(bob), 5e8);
        assertEq(wrapped.totalSupply(), 0);
    }

    function test_withdraw_revertsOverBalance() public {
        vm.startPrank(alice);
        wrapped.deposit(1e8);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InsufficientBalance.selector, alice, 1e8, 1e8 + 1));
        wrapped.withdraw(1e8 + 1);
        vm.stopPrank();
    }

    function test_withdraw_cannotTakeOthersBacking() public {
        vm.prank(alice);
        wrapped.deposit(5e8);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InsufficientBalance.selector, bob, 0, 1));
        wrapped.withdraw(1);
    }

    function test_zeroAmountsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(WrappedStock.ZeroAmount.selector);
        wrapped.deposit(0);
        vm.expectRevert(WrappedStock.ZeroAmount.selector);
        wrapped.withdraw(0);
        vm.stopPrank();
    }

    function test_badReceiversRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InvalidReceiver.selector, address(0)));
        wrapped.depositFor(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InvalidReceiver.selector, address(wrapped)));
        wrapped.depositFor(address(wrapped), 1);

        wrapped.deposit(10);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InvalidReceiver.selector, address(0)));
        wrapped.withdrawTo(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InvalidReceiver.selector, address(wrapped)));
        wrapped.withdrawTo(address(wrapped), 1);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InvalidReceiver.selector, address(stock)));
        wrapped.withdrawTo(address(stock), 1);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InvalidReceiver.selector, address(0)));
        wrapped.transfer(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InvalidReceiver.selector, address(wrapped)));
        wrapped.transfer(address(wrapped), 1);
        vm.stopPrank();
    }

    function test_deposit_revertsWithoutApproval() public {
        stock.mint(bob, 1e8);
        vm.prank(bob);
        vm.expectRevert(WrappedStock.UnderlyingTransferFailed.selector);
        wrapped.deposit(1e8);
    }

    // --- hostile or odd underlyings -------------------------------------

    function test_deposit_rejectsFeeOnTransfer() public {
        FeeStock fee = new FeeStock();
        WrappedStock w = new WrappedStock(address(fee), "x", "x");
        fee.mint(alice, 100e8);
        vm.startPrank(alice);
        fee.approve(address(w), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.UnexpectedAmountReceived.selector, 100e8, 99e8));
        w.deposit(100e8);
        vm.stopPrank();
        assertEq(w.totalSupply(), 0);
    }

    function test_deposit_rejectsFalseReturn() public {
        FalseStock bad = new FalseStock();
        WrappedStock w = new WrappedStock(address(bad), "x", "x");
        bad.mint(alice, 1e8);
        vm.prank(alice);
        vm.expectRevert(WrappedStock.UnderlyingTransferFailed.selector);
        w.deposit(1e8);
    }

    function test_deposit_rejectsOddReturnValue() public {
        OddReturnStock odd = new OddReturnStock();
        WrappedStock w = new WrappedStock(address(odd), "x", "x");
        odd.mint(alice, 1e8);
        vm.prank(alice);
        vm.expectRevert(WrappedStock.UnderlyingTransferFailed.selector);
        w.deposit(1e8);
        assertEq(w.totalSupply(), 0);
    }

    function test_noReturnValueTokenWorks() public {
        NoReturnStock plain = new NoReturnStock();
        WrappedStock w = new WrappedStock(address(plain), "x", "x");
        plain.mint(alice, 3e8);
        vm.startPrank(alice);
        w.deposit(3e8);
        w.withdraw(1e8);
        vm.stopPrank();
        assertEq(w.balanceOf(alice), 2e8);
        assertEq(plain.balanceOf(alice), 1e8);
        assertEq(w.backing(), w.totalSupply());
    }

    function test_withdraw_rollsBackWhenUnderlyingTransferFails() public {
        FrozenOutStock frozen = new FrozenOutStock();
        WrappedStock w = new WrappedStock(address(frozen), "x", "x");
        frozen.mint(alice, 5e8);
        vm.startPrank(alice);
        frozen.approve(address(w), type(uint256).max);
        w.deposit(5e8);
        vm.expectRevert(WrappedStock.UnderlyingTransferFailed.selector);
        w.withdraw(5e8);
        vm.stopPrank();
        // Nothing was burned: the holder can still unwrap once transfers resume.
        assertEq(w.balanceOf(alice), 5e8);
        assertEq(w.totalSupply(), 5e8);
        assertEq(w.backing(), 5e8);
    }

    function test_selfAndZeroTransfers() public {
        vm.startPrank(alice);
        wrapped.deposit(2e8);
        assertTrue(wrapped.transfer(alice, 2e8));
        assertTrue(wrapped.transfer(bob, 0));
        vm.stopPrank();
        assertEq(wrapped.balanceOf(alice), 2e8);
        assertEq(wrapped.balanceOf(bob), 0);
        assertEq(wrapped.totalSupply(), 2e8);
    }

    function test_reentrancyBlocked() public {
        ReentrantStock evil = new ReentrantStock();
        WrappedStock w = new WrappedStock(address(evil), "x", "x");
        evil.setTarget(w);
        evil.mint(alice, 10e8);
        vm.prank(alice);
        // The inner withdraw hits the guard; its revert fails the token call.
        vm.expectRevert(WrappedStock.UnderlyingTransferFailed.selector);
        w.deposit(1e8);
        assertEq(w.totalSupply(), 0);
    }

    function test_directDonationDoesNotMint() public {
        stock.mint(address(wrapped), 7e8);
        assertEq(wrapped.totalSupply(), 0);
        vm.prank(alice);
        wrapped.deposit(1e8);
        assertEq(wrapped.balanceOf(alice), 1e8);
        assertEq(wrapped.backing(), 8e8);
        _assertSolvent();
    }

    // --- multiplier ------------------------------------------------------

    function test_multiplier_passesThroughAndNeverMovesBalances() public {
        vm.prank(alice);
        wrapped.deposit(4e8);
        assertEq(wrapped.uiMultiplier(), 1e18);

        stock.setMultiplier(10e18); // a 10-for-1 split
        assertEq(wrapped.uiMultiplier(), 10e18);
        assertEq(wrapped.balanceOf(alice), 4e8);
        assertEq(wrapped.totalSupply(), 4e8);
        assertEq(wrapped.backing(), 4e8);

        vm.prank(alice);
        wrapped.withdraw(4e8);
        assertEq(stock.balanceOf(alice), 1_000e8);
    }

    function test_multiplier_defaultsWhenMissing() public {
        PlainToken plain = new PlainToken();
        WrappedStock w = new WrappedStock(address(plain), "x", "x");
        assertEq(w.uiMultiplier(), 1e18);
        assertEq(w.decimals(), 6);
    }

    // --- ERC-20 ----------------------------------------------------------

    function test_transferAndAllowance() public {
        vm.startPrank(alice);
        wrapped.deposit(10e8);
        assertTrue(wrapped.transfer(bob, 4e8));
        assertTrue(wrapped.approve(bridge, 5e8));
        vm.stopPrank();

        vm.prank(bridge);
        assertTrue(wrapped.transferFrom(alice, bridge, 2e8));
        assertEq(wrapped.allowance(alice, bridge), 3e8);
        assertEq(wrapped.balanceOf(alice), 4e8);
        assertEq(wrapped.balanceOf(bob), 4e8);
        assertEq(wrapped.balanceOf(bridge), 2e8);
        assertEq(wrapped.totalSupply(), 10e8);

        vm.prank(bridge);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InsufficientAllowance.selector, bridge, 3e8, 4e8));
        wrapped.transferFrom(alice, bridge, 4e8);
    }

    function test_infiniteAllowanceIsNotSpent() public {
        vm.startPrank(alice);
        wrapped.deposit(10e8);
        wrapped.approve(bridge, type(uint256).max);
        vm.stopPrank();
        vm.prank(bridge);
        wrapped.transferFrom(alice, bridge, 10e8);
        assertEq(wrapped.allowance(alice, bridge), type(uint256).max);
    }

    function test_transfer_revertsOverBalance() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedStock.InsufficientBalance.selector, alice, 0, 1));
        wrapped.transfer(bob, 1);
    }

    // --- the property the bridge's signer depends on ---------------------

    /// The signer reads keccak256(holder . slot) for slots 0-63 plus one
    /// OpenZeppelin slot and needs exactly one of them to equal balanceOf.
    function test_signerFindsBalanceInExactlyOneSlot() public {
        vm.startPrank(alice);
        wrapped.deposit(123_45678900);
        wrapped.approve(bridge, type(uint256).max);
        vm.stopPrank();
        // Same shape as ERC20Bridge.bridgeToChia: the bridge pulls the tokens.
        vm.prank(bridge);
        wrapped.transferFrom(alice, bridge, 99_70000000);

        uint256 balance = wrapped.balanceOf(bridge);
        assertEq(balance, 99_70000000);

        uint256 matches;
        uint256 matchedSlot = type(uint256).max;
        for (uint256 slot = 0; slot < 64; slot++) {
            bytes32 key = keccak256(abi.encode(bridge, slot));
            if (uint256(vm.load(address(wrapped), key)) == balance) {
                matches++;
                matchedSlot = slot;
            }
        }
        bytes32 ozKey =
            keccak256(abi.encode(bridge, 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00));
        if (uint256(vm.load(address(wrapped), ozKey)) == balance) matches++;

        assertEq(matches, 1, "balance must sit in exactly one candidate slot");
        assertEq(matchedSlot, 0, "balance mapping must be slot 0");
    }

    /// First-ever deposit into the bridge: the only candidate key written for
    /// the bridge is slot 0, going from zero to the deposited amount.
    function test_firstBridgeDepositWritesOnlySlotZero() public {
        vm.startPrank(alice);
        wrapped.deposit(10e8);
        wrapped.approve(bridge, type(uint256).max);
        vm.stopPrank();

        bytes32 slot0Key = keccak256(abi.encode(bridge, uint256(0)));
        assertEq(uint256(vm.load(address(wrapped), slot0Key)), 0);

        vm.record();
        vm.prank(bridge);
        wrapped.transferFrom(alice, bridge, 4e8);
        (, bytes32[] memory writes) = vm.accesses(address(wrapped));

        assertEq(uint256(vm.load(address(wrapped), slot0Key)), 4e8);
        for (uint256 i = 0; i < writes.length; i++) {
            for (uint256 slot = 1; slot < 64; slot++) {
                assertTrue(writes[i] != keccak256(abi.encode(bridge, slot)), "wrote another candidate key");
            }
        }
    }

    // --- fuzz ------------------------------------------------------------

    function testFuzz_roundTripIsExact(uint128 amount, uint128 back) public {
        amount = uint128(bound(amount, 1, 1_000e8));
        back = uint128(bound(back, 1, amount));
        vm.startPrank(alice);
        wrapped.deposit(amount);
        wrapped.withdraw(back);
        vm.stopPrank();

        assertEq(wrapped.balanceOf(alice), amount - back);
        assertEq(wrapped.totalSupply(), amount - back);
        assertEq(stock.balanceOf(alice), 1_000e8 - amount + back);
        assertEq(wrapped.backing(), wrapped.totalSupply());
    }

    function testFuzz_supplyEqualsSumOfBalances(uint64 a, uint64 b, uint64 moved) public {
        uint256 da = bound(a, 1, 400e8);
        uint256 db = bound(b, 1, 400e8);
        stock.mint(bob, db);
        vm.prank(bob);
        stock.approve(address(wrapped), type(uint256).max);

        vm.prank(alice);
        wrapped.deposit(da);
        vm.prank(bob);
        wrapped.deposit(db);

        uint256 m = bound(moved, 0, da);
        vm.prank(alice);
        wrapped.transfer(bridge, m);

        assertEq(
            wrapped.balanceOf(alice) + wrapped.balanceOf(bob) + wrapped.balanceOf(bridge), wrapped.totalSupply()
        );
        _assertSolvent();
    }
}
