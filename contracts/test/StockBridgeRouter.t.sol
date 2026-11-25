// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WrappedStock} from "../src/WrappedStock.sol";
import {StockBridgeRouter, UnwrapForwarder} from "../src/StockBridgeRouter.sol";

/// 8-decimal stock stand-in with a simplified permit (no signature check:
/// `v == 27` is accepted, anything else reverts).
contract PermitStock {
    uint8 public constant decimals = 8;
    bool public frozen;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFrozen(bool f) external {
        frozen = f;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32, bytes32)
        external
    {
        require(block.timestamp <= deadline, "expired");
        require(v == 27, "bad sig");
        allowance[owner][spender] = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!frozen, "frozen");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!frozen, "frozen");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

interface IERC20Like {
    function decimals() external view returns (uint8);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Mirrors the parts of ERC20Bridge the router touches.
contract MockBridge {
    address public immutable portal;
    uint256 public constant TOLL = 0.00001 ether;
    uint256 public constant TIP_BPS = 30;

    address public lastAsset;
    bytes32 public lastReceiver;
    uint256 public lastMojo;
    address public lastCaller;

    constructor(address portal_) {
        portal = portal_;
    }

    function bridgeToChia(address asset, bytes32 receiver, uint256 mojoAmount) external payable {
        require(msg.value == TOLL, "!toll");
        uint256 factor = 10 ** (IERC20Like(asset).decimals() - 3);
        uint256 tip = mojoAmount * TIP_BPS / 10000;
        if (tip == 0) tip = 1;
        require(mojoAmount > tip, "!amnt");
        lastAsset = asset;
        lastReceiver = receiver;
        lastMojo = mojoAmount - tip;
        lastCaller = msg.sender;
        require(IERC20Like(asset).transferFrom(msg.sender, address(this), mojoAmount * factor), "pull");
        require(IERC20Like(asset).transfer(portal, tip * factor), "tip");
    }

    /// What ERC20Bridge.receiveMessage does with a verified message.
    function release(bytes32[] calldata contents) external {
        require(msg.sender == portal, "!portal");
        address asset = address(uint160(uint256(contents[0])));
        address receiver = address(uint160(uint256(contents[1])));
        uint256 amount = uint256(contents[2]) * 10 ** (IERC20Like(asset).decimals() - 3);
        uint256 tip = amount * TIP_BPS / 10000;
        if (tip == 0) tip = 1;
        require(IERC20Like(asset).transfer(receiver, amount - tip), "pay");
        require(IERC20Like(asset).transfer(portal, tip), "tip");
    }
}

/// Stands in for the Portal: no signature checks, one use per nonce.
contract MockPortal {
    MockBridge public bridge;
    mapping(bytes32 => bool) public used;

    function setBridge(MockBridge b) external {
        bridge = b;
    }

    function receiveMessage(bytes32 nonce, bytes3, bytes32, address destination, bytes32[] calldata contents, bytes memory)
        external
    {
        require(!used[nonce], "!nonce");
        used[nonce] = true;
        require(destination == address(bridge), "!dest");
        bridge.release(contents);
    }

    function somethingElse() external pure returns (uint256) {
        return 1;
    }
}

/// Pretends to be a wrapper. When a forwarder calls it, it tries to re-enter
/// the router and to pull the real wrapper token out of the forwarder.
contract HostileWrapper {
    StockBridgeRouter immutable router;
    address immutable realWrapper;
    address immutable victim;
    bool public reentryBlocked;

    constructor(StockBridgeRouter router_, address realWrapper_, address victim_) {
        router = router_;
        realWrapper = realWrapper_;
        victim = victim_;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1e18;
    }

    function withdrawTo(address, uint256) external {
        try router.sweep(victim, realWrapper) {} catch {
            reentryBlocked = true;
        }
        // msg.sender is the forwarder, but this contract has no allowance from it.
        (bool pulled,) = realWrapper.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), 1)
        );
        require(!pulled, "pulled a real token");
    }
}

contract StockBridgeRouterTest is Test {
    PermitStock stock;
    WrappedStock wrapped;
    MockPortal portal;
    MockBridge bridge;
    StockBridgeRouter router;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32 constant CHIA_RECEIVER = bytes32(uint256(0xC41A));
    uint256 constant TOLL = 0.00001 ether;
    uint256 constant FACTOR = 1e5; // 8 decimals -> 10^(8-3) raw units per mojo

    function setUp() public {
        stock = new PermitStock();
        wrapped = new WrappedStock(address(stock), "Wrapped MOCKc", "wMOCKc");
        portal = new MockPortal();
        bridge = new MockBridge(address(portal));
        portal.setBridge(bridge);
        router = new StockBridgeRouter(address(bridge), address(portal));

        stock.mint(alice, 1_000e8);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    function _bridgeCall(uint256 mojo) internal view returns (bytes memory) {
        return abi.encodeWithSignature("bridgeToChia(address,bytes32,uint256)", address(wrapped), CHIA_RECEIVER, mojo);
    }

    function _portalCall(bytes32 nonce, address receiver, uint256 mojo) internal view returns (bytes memory) {
        bytes32[] memory contents = new bytes32[](3);
        contents[0] = bytes32(uint256(uint160(address(wrapped))));
        contents[1] = bytes32(uint256(uint160(receiver)));
        contents[2] = bytes32(mojo);
        return abi.encodeWithSignature(
            "receiveMessage(bytes32,bytes3,bytes32,address,bytes32[],bytes)",
            nonce,
            bytes3("xch"),
            bytes32(uint256(1)),
            address(bridge),
            contents,
            hex""
        );
    }

    /// Puts `mojo` worth of wrapped stock in the bridge, as an earlier deposit would have.
    function _fundBridge(uint256 mojo) internal {
        stock.mint(address(this), mojo * FACTOR);
        stock.approve(address(wrapped), mojo * FACTOR);
        wrapped.depositFor(address(bridge), mojo * FACTOR);
    }

    function _assertRouterEmpty() internal view {
        assertEq(stock.balanceOf(address(router)), 0, "router holds stock");
        assertEq(wrapped.balanceOf(address(router)), 0, "router holds wrapped");
        assertEq(address(router).balance, 0, "router holds ether");
        assertEq(stock.allowance(address(router), address(wrapped)), 0, "stale stock approval");
        assertEq(wrapped.allowance(address(router), address(bridge)), 0, "stale wrapped approval");
    }

    // --- construction ---------------------------------------------------

    function test_constructor_checks() public {
        vm.expectRevert(StockBridgeRouter.ZeroAddress.selector);
        new StockBridgeRouter(address(0), address(portal));
        vm.expectRevert(abi.encodeWithSelector(StockBridgeRouter.NotAContract.selector, makeAddr("eoa")));
        new StockBridgeRouter(makeAddr("eoa"), address(portal));
        assertEq(router.bridge(), address(bridge));
        assertEq(router.portal(), address(portal));

        // The bridge must itself point at the portal the router is given.
        MockPortal otherPortal = new MockPortal();
        vm.expectRevert(
            abi.encodeWithSelector(StockBridgeRouter.PortalMismatch.selector, address(portal), address(otherPortal))
        );
        new StockBridgeRouter(address(bridge), address(otherPortal));
    }

    // --- Base -> Chia ---------------------------------------------------

    function test_wrapAndBridge_oneCall() public {
        uint256 mojo = 500; // 0.5 token
        vm.startPrank(alice);
        stock.approve(address(router), mojo * FACTOR);
        router.wrapAndBridge{value: TOLL}(_bridgeCall(mojo));
        vm.stopPrank();

        uint256 tip = 1; // floor(500 * 30 / 10000) = 1 mojo
        assertEq(stock.balanceOf(alice), 1_000e8 - mojo * FACTOR);
        assertEq(wrapped.balanceOf(address(bridge)), (mojo - tip) * FACTOR);
        assertEq(wrapped.balanceOf(address(portal)), tip * FACTOR);
        assertEq(wrapped.totalSupply(), mojo * FACTOR);
        assertEq(wrapped.backing(), mojo * FACTOR);
        assertEq(bridge.lastAsset(), address(wrapped));
        assertEq(bridge.lastReceiver(), CHIA_RECEIVER);
        assertEq(bridge.lastMojo(), mojo - tip);
        assertEq(bridge.lastCaller(), address(router));
        assertEq(address(bridge).balance, TOLL);
        _assertRouterEmpty();
    }

    /// The validators find the deposit by scanning the transaction input for
    /// the bridgeToChia selector followed by the asset, receiver and amount.
    function test_bridgeCallAppearsVerbatimInTransactionInput() public view {
        bytes memory inner = _bridgeCall(500);
        bytes memory outer = abi.encodeCall(StockBridgeRouter.wrapAndBridge, (inner));
        bytes memory outerPermit = abi.encodeCall(
            StockBridgeRouter.wrapAndBridgeWithPermit, (inner, block.timestamp, 27, bytes32(0), bytes32(0))
        );
        assertEq(_occurrences(outer, inner), 1, "plain call must contain the bridge call exactly once");
        assertEq(_occurrences(outerPermit, inner), 1, "permit call must contain the bridge call exactly once");
        assertEq(bytes4(inner), bytes4(0xcdb50da7), "selector the signer looks for");
    }

    function _occurrences(bytes memory haystack, bytes memory needle) internal pure returns (uint256 count) {
        if (needle.length > haystack.length) return 0;
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool same = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    same = false;
                    break;
                }
            }
            if (same) count++;
        }
    }

    function test_wrapAndBridgeWithPermit_noPriorApproval() public {
        uint256 mojo = 2_000;
        vm.prank(alice);
        router.wrapAndBridgeWithPermit{value: TOLL}(_bridgeCall(mojo), block.timestamp + 600, 27, bytes32(0), bytes32(0));
        assertEq(stock.balanceOf(alice), 1_000e8 - mojo * FACTOR);
        assertEq(stock.allowance(alice, address(router)), 0, "permit allowance fully used");
        _assertRouterEmpty();
    }

    function test_permit_alreadyUsedStillWorksWhenAllowanceIsThere() public {
        uint256 mojo = 2_000;
        vm.startPrank(alice);
        stock.approve(address(router), mojo * FACTOR); // as if the permit was front-run
        router.wrapAndBridgeWithPermit{value: TOLL}(_bridgeCall(mojo), block.timestamp + 600, 28, bytes32(0), bytes32(0));
        vm.stopPrank();
        assertEq(wrapped.totalSupply(), mojo * FACTOR);
    }

    function test_permit_badSignatureAndNoAllowanceReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockBridgeRouter.TokenCallFailed.selector, address(stock)));
        router.wrapAndBridgeWithPermit{value: TOLL}(_bridgeCall(2_000), block.timestamp + 600, 28, bytes32(0), bytes32(0));
    }

    function test_wrapAndBridge_withoutApprovalReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockBridgeRouter.TokenCallFailed.selector, address(stock)));
        router.wrapAndBridge{value: TOLL}(_bridgeCall(500));
    }

    function test_wrapAndBridge_wrongTollBubblesAndMovesNothing() public {
        vm.startPrank(alice);
        stock.approve(address(router), 500 * FACTOR);
        vm.expectRevert(bytes("!toll"));
        router.wrapAndBridge{value: TOLL + 1}(_bridgeCall(500));
        vm.stopPrank();
        assertEq(stock.balanceOf(alice), 1_000e8);
        assertEq(wrapped.totalSupply(), 0);
    }

    function test_wrapAndBridge_rejectsMalformedCalls() public {
        vm.startPrank(alice);
        stock.approve(address(router), type(uint256).max);

        vm.expectRevert(StockBridgeRouter.InvalidBridgeCall.selector);
        router.wrapAndBridge{value: TOLL}(hex"");

        bytes memory wrongSelector =
            abi.encodeWithSignature("bridgeBack(address,bytes32,uint256)", address(wrapped), CHIA_RECEIVER, 500);
        vm.expectRevert(StockBridgeRouter.InvalidBridgeCall.selector);
        router.wrapAndBridge{value: TOLL}(wrongSelector);

        bytes memory tooLong = bytes.concat(_bridgeCall(500), bytes32(0));
        vm.expectRevert(StockBridgeRouter.InvalidBridgeCall.selector);
        router.wrapAndBridge{value: TOLL}(tooLong);

        vm.expectRevert(StockBridgeRouter.ZeroAmount.selector);
        router.wrapAndBridge{value: TOLL}(_bridgeCall(0));

        bytes memory notAContract =
            abi.encodeWithSignature("bridgeToChia(address,bytes32,uint256)", makeAddr("nope"), CHIA_RECEIVER, 500);
        vm.expectRevert(abi.encodeWithSelector(StockBridgeRouter.NotAContract.selector, makeAddr("nope")));
        router.wrapAndBridge{value: TOLL}(notAContract);
        vm.stopPrank();
    }

    function test_wrapAndBridge_frozenStockReverts() public {
        vm.startPrank(alice);
        stock.approve(address(router), 500 * FACTOR);
        vm.stopPrank();
        stock.setFrozen(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockBridgeRouter.TokenCallFailed.selector, address(stock)));
        router.wrapAndBridge{value: TOLL}(_bridgeCall(500));
    }

    function testFuzz_wrapAndBridge(uint32 mojoSeed) public {
        uint256 mojo = bound(mojoSeed, 2, 1_000_000); // up to 1000 tokens
        vm.startPrank(alice);
        stock.approve(address(router), mojo * FACTOR);
        router.wrapAndBridge{value: TOLL}(_bridgeCall(mojo));
        vm.stopPrank();

        uint256 tip = mojo * 30 / 10000;
        if (tip == 0) tip = 1;
        assertEq(wrapped.balanceOf(address(bridge)), (mojo - tip) * FACTOR);
        assertEq(wrapped.balanceOf(address(bridge)) + wrapped.balanceOf(address(portal)), wrapped.totalSupply());
        assertEq(wrapped.backing(), wrapped.totalSupply());
        _assertRouterEmpty();
    }

    // --- Chia -> Base ---------------------------------------------------

    function test_forwarderOf_isStableDistinctAndUndeployedUntilUsed() public view {
        address a = router.forwarderOf(alice);
        assertEq(a, router.forwarderOf(alice));
        assertTrue(a != router.forwarderOf(bob));
        assertEq(a.code.length, 0);
    }

    function test_claimAndUnwrap_oneCall() public {
        uint256 mojo = 1_000;
        _fundBridge(mojo);
        address fwd = router.forwarderOf(alice);
        uint256 payout = mojo * FACTOR - (mojo * FACTOR * 30 / 10000);

        vm.prank(alice);
        router.claimAndUnwrap(alice, address(wrapped), _portalCall(bytes32(uint256(1)), fwd, mojo));

        assertEq(stock.balanceOf(alice), 1_000e8 + payout, "user got the stock itself");
        assertEq(wrapped.balanceOf(alice), 0);
        assertEq(wrapped.balanceOf(fwd), 0);
        assertGt(fwd.code.length, 0, "forwarder deployed at the predicted address");
        assertEq(wrapped.backing(), wrapped.totalSupply());
        _assertRouterEmpty();
    }

    function test_claimAndUnwrap_reusesForwarder() public {
        _fundBridge(2_000);
        address fwd = router.forwarderOf(alice);
        vm.startPrank(alice);
        router.claimAndUnwrap(alice, address(wrapped), _portalCall(bytes32(uint256(1)), fwd, 1_000));
        router.claimAndUnwrap(alice, address(wrapped), _portalCall(bytes32(uint256(2)), fwd, 1_000));
        vm.stopPrank();
        assertEq(wrapped.balanceOf(fwd), 0);
        assertGt(stock.balanceOf(alice), 1_000e8 + 1_900 * FACTOR);
    }

    /// Anyone can relay; the money still only reaches the user the forwarder belongs to.
    function test_claimAndUnwrap_relayedByStrangerPaysTheUser() public {
        _fundBridge(1_000);
        address fwd = router.forwarderOf(alice);
        uint256 bobBefore = stock.balanceOf(bob);
        vm.prank(bob);
        router.claimAndUnwrap(alice, address(wrapped), _portalCall(bytes32(uint256(1)), fwd, 1_000));
        assertGt(stock.balanceOf(alice), 1_000e8);
        assertEq(stock.balanceOf(bob), bobBefore);
    }

    /// Naming yourself as `user` on someone else's message gets you nothing:
    /// the payout sits at the real owner's forwarder.
    function test_claimAndUnwrap_cannotRedirectAnotherUsersPayout() public {
        _fundBridge(1_000);
        address aliceFwd = router.forwarderOf(alice);
        vm.prank(bob);
        router.claimAndUnwrap(bob, address(wrapped), _portalCall(bytes32(uint256(1)), aliceFwd, 1_000));

        assertEq(stock.balanceOf(bob), 0, "the stranger received nothing");
        assertGt(wrapped.balanceOf(aliceFwd), 0, "payout still waits for its owner");

        vm.prank(bob);
        router.sweep(alice, address(wrapped)); // anyone may finish it, but it pays alice
        assertGt(stock.balanceOf(alice), 1_000e8);
        assertEq(stock.balanceOf(bob), 0);
    }

    function test_sweep_afterDirectPortalRelay() public {
        _fundBridge(1_000);
        address fwd = router.forwarderOf(alice);
        (bool ok,) = address(portal).call(_portalCall(bytes32(uint256(1)), fwd, 1_000));
        assertTrue(ok);
        assertGt(wrapped.balanceOf(fwd), 0);

        router.sweep(alice, address(wrapped));
        assertEq(wrapped.balanceOf(fwd), 0);
        assertGt(stock.balanceOf(alice), 1_000e8);
    }

    function test_sweep_withNothingWaitingIsHarmless() public {
        router.sweep(alice, address(wrapped));
        assertEq(stock.balanceOf(alice), 1_000e8);
    }

    function test_claimAndUnwrap_rejectsOtherPortalCalls() public {
        vm.expectRevert(StockBridgeRouter.InvalidPortalCall.selector);
        router.claimAndUnwrap(alice, address(wrapped), abi.encodeWithSignature("somethingElse()"));
        vm.expectRevert(StockBridgeRouter.InvalidPortalCall.selector);
        router.claimAndUnwrap(alice, address(wrapped), hex"");
    }

    function test_claimAndUnwrap_replayedMessageBubbles() public {
        _fundBridge(2_000);
        address fwd = router.forwarderOf(alice);
        bytes memory call_ = _portalCall(bytes32(uint256(1)), fwd, 1_000);
        router.claimAndUnwrap(alice, address(wrapped), call_);
        vm.expectRevert(bytes("!nonce"));
        router.claimAndUnwrap(alice, address(wrapped), call_);
    }

    /// If the stock cannot move, the whole claim reverts and the message is
    /// not consumed, so it can be retried later.
    function test_claimAndUnwrap_frozenStockLeavesMessageUnused() public {
        _fundBridge(1_000);
        address fwd = router.forwarderOf(alice);
        stock.setFrozen(true);
        vm.expectRevert();
        router.claimAndUnwrap(alice, address(wrapped), _portalCall(bytes32(uint256(1)), fwd, 1_000));
        assertFalse(portal.used(bytes32(uint256(1))));

        stock.setFrozen(false);
        router.claimAndUnwrap(alice, address(wrapped), _portalCall(bytes32(uint256(1)), fwd, 1_000));
        assertGt(stock.balanceOf(alice), 1_000e8);
    }

    /// While the stock is frozen the user can still take the wrapped token out.
    function test_sweepWrapped_onlyByTheUser() public {
        _fundBridge(1_000);
        address fwd = router.forwarderOf(alice);
        (bool ok,) = address(portal).call(_portalCall(bytes32(uint256(1)), fwd, 1_000));
        assertTrue(ok);
        uint256 waiting = wrapped.balanceOf(fwd);
        stock.setFrozen(true);

        vm.prank(bob);
        vm.expectRevert(StockBridgeRouter.NotUser.selector);
        router.sweepWrapped(alice, address(wrapped));

        vm.prank(alice);
        router.sweepWrapped(alice, address(wrapped));
        assertEq(wrapped.balanceOf(alice), waiting);
        assertEq(wrapped.balanceOf(fwd), 0);
    }

    function test_forwarder_onlyObeysTheRouter() public {
        _fundBridge(1_000);
        address fwd = router.forwarderOf(alice);
        router.claimAndUnwrap(alice, address(wrapped), _portalCall(bytes32(uint256(1)), fwd, 1_000));

        vm.startPrank(bob);
        vm.expectRevert(UnwrapForwarder.NotRouter.selector);
        UnwrapForwarder(payable(fwd)).unwrapTo(address(wrapped), bob);
        vm.expectRevert(UnwrapForwarder.NotRouter.selector);
        UnwrapForwarder(payable(fwd)).sendWrapped(address(wrapped), bob);
        vm.stopPrank();
    }

    function test_sweep_rejectsBadArguments() public {
        vm.expectRevert(StockBridgeRouter.ZeroAddress.selector);
        router.sweep(address(0), address(wrapped));
        vm.expectRevert(abi.encodeWithSelector(StockBridgeRouter.NotAContract.selector, makeAddr("nope")));
        router.sweep(alice, makeAddr("nope"));
    }

    // --- ether sent to a forwarder by mistake ---------------------------

    function test_sweepEther_beforeAndAfterTheForwarderExists() public {
        address fwd = router.forwarderOf(alice);
        uint256 aliceBefore = alice.balance;

        // Ether can land on the address before any contract is there.
        vm.deal(fwd, 0.3 ether);
        vm.prank(bob);
        router.sweepEther(alice);
        assertEq(fwd.balance, 0);
        assertEq(alice.balance, aliceBefore + 0.3 ether, "it goes to the forwarder's own user");

        // And once the forwarder is deployed it still accepts and releases ether.
        vm.prank(bob);
        (bool ok,) = fwd.call{value: 0.2 ether}("");
        assertTrue(ok, "a deployed forwarder accepts ether");
        vm.prank(bob);
        router.sweepEther(alice);
        assertEq(alice.balance, aliceBefore + 0.5 ether);
        assertEq(address(router).balance, 0);
    }

    function test_forwarder_sendEtherOnlyByRouter() public {
        router.sweepEther(alice); // deploys the forwarder
        address fwd = router.forwarderOf(alice);
        vm.deal(fwd, 1 ether);
        vm.prank(bob);
        vm.expectRevert(UnwrapForwarder.NotRouter.selector);
        UnwrapForwarder(payable(fwd)).sendEther(bob);
    }

    // --- hostile wrapper -------------------------------------------------

    /// A made-up "wrapper" pointed at a real user's forwarder moves nothing real.
    function test_hostileWrapperCannotTouchARealPayout() public {
        _fundBridge(1_000);
        address fwd = router.forwarderOf(alice);
        (bool ok,) = address(portal).call(_portalCall(bytes32(uint256(1)), fwd, 1_000));
        assertTrue(ok);
        uint256 waiting = wrapped.balanceOf(fwd);

        HostileWrapper hostile = new HostileWrapper(router, address(wrapped), alice);
        vm.prank(bob);
        router.sweep(alice, address(hostile));

        assertEq(wrapped.balanceOf(fwd), waiting, "the real payout is untouched");
        assertEq(wrapped.balanceOf(address(hostile)), 0);
        assertEq(stock.balanceOf(bob), 0);
        assertTrue(hostile.reentryBlocked(), "its attempt to re-enter the router was refused");
    }

    // --- round trip -----------------------------------------------------

    function test_roundTrip_throughTheRouterBothWays() public {
        uint256 mojo = 10_000; // 10 tokens
        vm.startPrank(alice);
        stock.approve(address(router), mojo * FACTOR);
        router.wrapAndBridge{value: TOLL}(_bridgeCall(mojo));

        uint256 netMojo = bridge.lastMojo(); // what the Chia side would mint
        router.claimAndUnwrap(
            alice, address(wrapped), _portalCall(bytes32(uint256(7)), router.forwarderOf(alice), netMojo)
        );
        vm.stopPrank();

        uint256 outTip = mojo * 30 / 10000 * FACTOR;
        uint256 backTip = netMojo * FACTOR * 30 / 10000;
        assertEq(stock.balanceOf(alice), 1_000e8 - outTip - backTip, "only the two tips are gone");
        assertEq(wrapped.balanceOf(address(bridge)), 0);
        assertEq(wrapped.totalSupply(), outTip + backTip, "only the tips stay wrapped, at the portal");
        assertEq(wrapped.backing(), wrapped.totalSupply());
        _assertRouterEmpty();
    }
}
