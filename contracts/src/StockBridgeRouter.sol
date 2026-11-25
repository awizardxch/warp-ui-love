// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title StockBridgeRouter
/// @notice Lets a wrapped stock cross the warp.green bridge in one ordinary
/// transaction each way, instead of several.
///
/// Base -> Chia: `wrapAndBridge` pulls the stock from the caller, wraps it in
/// its WrappedStock wrapper and deposits the wrapper into the ERC20Bridge.
///
/// Chia -> Base: the bridge pays out the wrapper token with no callback, so a
/// plain address would need a second transaction to unwrap. Instead the Chia
/// side names the user's *forwarder* as receiver: a tiny contract at an
/// address derived from the user's own address. `claimAndUnwrap` relays the
/// bridge message and has the forwarder unwrap straight to the user.
///
/// Properties:
/// - No owner, no fees, no upgrade path. The router holds nothing between
///   transactions.
/// - A forwarder can only ever send funds to the one address it was derived
///   from, so anyone may relay or sweep on a user's behalf.
/// - Works with any WrappedStock wrapper; nothing is registered here.
///
/// The bridge's validators read a deposit's amount by scanning the transaction
/// input for the bridge call. That is why `wrapAndBridge` takes the encoded
/// `bridgeToChia` call as bytes and forwards it unchanged: the call then
/// appears word for word inside the transaction.
contract StockBridgeRouter {
    /// @notice The warp.green ERC20Bridge on this chain.
    address public immutable bridge;
    /// @notice The warp.green Portal on this chain.
    address public immutable portal;

    bytes4 private constant BRIDGE_TO_CHIA = bytes4(keccak256("bridgeToChia(address,bytes32,uint256)"));
    bytes4 private constant RECEIVE_MESSAGE =
        bytes4(keccak256("receiveMessage(bytes32,bytes3,bytes32,address,bytes32[],bytes)"));

    uint256 private _entered;

    error ZeroAddress();
    error NotAContract(address target);
    error InvalidBridgeCall();
    error InvalidPortalCall();
    error ZeroAmount();
    error UnsupportedDecimals(uint8 decimals);
    error UnexpectedAmountReceived(uint256 expected, uint256 received);
    error TokenCallFailed(address token);
    error LeftoverBalance(address token, uint256 expected, uint256 actual);
    error PortalMismatch(address bridgePortal, address portal);
    error NotUser();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address bridge_, address portal_) {
        if (bridge_ == address(0) || portal_ == address(0)) revert ZeroAddress();
        if (bridge_.code.length == 0) revert NotAContract(bridge_);
        if (portal_.code.length == 0) revert NotAContract(portal_);
        address bridgePortal = IBridge(bridge_).portal();
        if (bridgePortal != portal_) revert PortalMismatch(bridgePortal, portal_);
        bridge = bridge_;
        portal = portal_;
    }

    // ---------------------------------------------------------------------
    // Base -> Chia
    // ---------------------------------------------------------------------

    /// @notice Wrap the caller's stock and bridge it, in one transaction.
    /// The caller must have approved this router for the raw amount.
    /// @param bridgeCall `abi.encodeCall(ERC20Bridge.bridgeToChia, (wrapper,
    /// receiver, mojoAmount))`, forwarded to the bridge unchanged.
    /// `msg.value` must be the portal's message toll.
    function wrapAndBridge(bytes calldata bridgeCall) external payable nonReentrant {
        _wrapAndBridge(bridgeCall);
    }

    /// @notice Same as `wrapAndBridge`, using an EIP-2612 permit for the
    /// approval, so no separate approval transaction is needed.
    function wrapAndBridgeWithPermit(bytes calldata bridgeCall, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        payable
        nonReentrant
    {
        (address wrapper,, uint256 raw) = _decodeBridgeCall(bridgeCall);
        address stock = IWrappedStock(wrapper).underlying();
        // If someone already submitted this permit, the allowance is in place
        // and the transfer below succeeds; if the permit is bad, it fails there.
        try IPermit(stock).permit(msg.sender, address(this), raw, deadline, v, r, s) {} catch {}
        _wrapAndBridge(bridgeCall);
    }

    function _wrapAndBridge(bytes calldata bridgeCall) private {
        (address wrapper,, uint256 raw) = _decodeBridgeCall(bridgeCall);
        address stock = IWrappedStock(wrapper).underlying();

        // Pull exactly `raw` of the stock from the caller.
        uint256 before = IToken(stock).balanceOf(address(this));
        _call(stock, abi.encodeCall(IToken.transferFrom, (msg.sender, address(this), raw)));
        uint256 received = IToken(stock).balanceOf(address(this)) - before;
        if (received != raw) revert UnexpectedAmountReceived(raw, received);

        // Wrap it. The wrapper takes all of the stock and mints 1:1 to this router.
        uint256 wrappedBefore = IToken(wrapper).balanceOf(address(this));
        _call(stock, abi.encodeCall(IToken.approve, (wrapper, raw)));
        IWrappedStock(wrapper).deposit(raw);
        uint256 wrapped = IToken(wrapper).balanceOf(address(this)) - wrappedBefore;
        if (wrapped != raw) revert UnexpectedAmountReceived(raw, wrapped);
        uint256 stockAfter = IToken(stock).balanceOf(address(this));
        if (stockAfter != before) revert LeftoverBalance(stock, before, stockAfter);

        // Bridge it: the bridge pulls the wrapper token from this router.
        _call(wrapper, abi.encodeCall(IToken.approve, (bridge, raw)));
        (bool ok, bytes memory ret) = bridge.call{value: msg.value}(bridgeCall);
        if (!ok) _bubble(ret);

        // Nothing may stay behind, and no approval may outlive the call.
        uint256 wrappedAfter = IToken(wrapper).balanceOf(address(this));
        if (wrappedAfter != wrappedBefore) revert LeftoverBalance(wrapper, wrappedBefore, wrappedAfter);
        _call(stock, abi.encodeCall(IToken.approve, (wrapper, 0)));
        _call(wrapper, abi.encodeCall(IToken.approve, (bridge, 0)));
    }

    /// @dev Checks the bytes are exactly one `bridgeToChia` call and returns
    /// the wrapper, the Chia receiver, and the raw token amount it stands for.
    function _decodeBridgeCall(bytes calldata bridgeCall)
        private
        view
        returns (address wrapper, bytes32 receiver, uint256 raw)
    {
        if (bridgeCall.length != 4 + 32 * 3 || bytes4(bridgeCall[:4]) != BRIDGE_TO_CHIA) revert InvalidBridgeCall();
        uint256 mojoAmount;
        (wrapper, receiver, mojoAmount) = abi.decode(bridgeCall[4:], (address, bytes32, uint256));
        if (wrapper.code.length == 0) revert NotAContract(wrapper);
        if (mojoAmount == 0) revert ZeroAmount();
        // The bridge scales by 10^(decimals - 3): one CAT mojo is that many raw units.
        uint8 decimals = IWrappedStock(wrapper).decimals();
        if (decimals < 3 || decimals > 36) revert UnsupportedDecimals(decimals);
        raw = mojoAmount * 10 ** (decimals - 3);
    }

    // ---------------------------------------------------------------------
    // Chia -> Base
    // ---------------------------------------------------------------------

    /// @notice The address to name as receiver on the Chia side so that the
    /// payout can be unwrapped to `user` in the claim transaction.
    function forwarderOf(address user) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), _salt(user), keccak256(type(UnwrapForwarder).creationCode))
        );
        return address(uint160(uint256(hash)));
    }

    /// @notice Relay a bridge message that pays `wrapper` tokens to `user`'s
    /// forwarder, then unwrap them to `user`. Anyone may call this.
    /// @param portalCall `abi.encodeCall(Portal.receiveMessage, (...))`.
    function claimAndUnwrap(address user, address wrapper, bytes calldata portalCall) external nonReentrant {
        if (portalCall.length < 4 || bytes4(portalCall[:4]) != RECEIVE_MESSAGE) revert InvalidPortalCall();
        (bool ok, bytes memory ret) = portal.call(portalCall);
        if (!ok) _bubble(ret);
        _sweep(user, wrapper);
    }

    /// @notice Unwrap whatever `wrapper` tokens sit at `user`'s forwarder and
    /// send the stock to `user`. Anyone may call this; it is how a payout is
    /// collected when the message was relayed by someone else.
    function sweep(address user, address wrapper) external nonReentrant {
        _sweep(user, wrapper);
    }

    /// @notice Send the wrapper tokens at the caller's forwarder to the caller
    /// without unwrapping. For when unwrapping is not possible, for example
    /// while the stock's transfers are paused. Only the user may call this.
    function sweepWrapped(address user, address wrapper) external nonReentrant {
        if (msg.sender != user) revert NotUser();
        _forwarder(user).sendWrapped(wrapper, user);
    }

    /// @notice Send any ether at `user`'s forwarder to `user`. A forwarder is
    /// only meant to receive wrapper tokens; this exists so that ether sent
    /// there by mistake is not lost. Anyone may call it.
    function sweepEther(address user) external nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        _forwarder(user).sendEther(user);
    }

    function _sweep(address user, address wrapper) private {
        if (user == address(0)) revert ZeroAddress();
        if (wrapper.code.length == 0) revert NotAContract(wrapper);
        _forwarder(user).unwrapTo(wrapper, user);
    }

    /// @dev The user's forwarder, deployed on first use.
    function _forwarder(address user) private returns (UnwrapForwarder forwarder) {
        address predicted = forwarderOf(user);
        if (predicted.code.length == 0) {
            forwarder = new UnwrapForwarder{salt: _salt(user)}();
        } else {
            forwarder = UnwrapForwarder(payable(predicted));
        }
    }

    function _salt(address user) private pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Accepts tokens that return true and tokens that return nothing.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenCallFailed(token);
        }
    }

    function _bubble(bytes memory ret) private pure {
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}

/// @notice Holds a bridge payout for one user until it is unwrapped. Deployed
/// by the router at an address derived from the user's address. It has no
/// record of who that user is: the router, which derived the address, tells it
/// where to send, and only the router can.
contract UnwrapForwarder {
    address private immutable ROUTER;

    error NotRouter();
    error TransferFailed();

    constructor() {
        ROUTER = msg.sender;
    }

    /// @dev Accepts ether so a payment made here by mistake does not make the
    /// paying message impossible to relay. It leaves through `sendEther`.
    receive() external payable {}

    /// @notice Send this forwarder's whole ether balance to `to`.
    function sendEther(address to) external returns (uint256 amount) {
        if (msg.sender != ROUTER) revert NotRouter();
        amount = address(this).balance;
        if (amount != 0) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Unwrap this forwarder's whole `wrapper` balance to `to`.
    function unwrapTo(address wrapper, address to) external returns (uint256 amount) {
        if (msg.sender != ROUTER) revert NotRouter();
        amount = IToken(wrapper).balanceOf(address(this));
        if (amount != 0) {
            IWrappedStock(wrapper).withdrawTo(to, amount);
        }
    }

    /// @notice Send this forwarder's whole `wrapper` balance to `to`, still wrapped.
    function sendWrapped(address wrapper, address to) external returns (uint256 amount) {
        if (msg.sender != ROUTER) revert NotRouter();
        amount = IToken(wrapper).balanceOf(address(this));
        if (amount != 0) {
            (bool ok, bytes memory ret) = wrapper.call(abi.encodeCall(IToken.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
                revert TransferFailed();
            }
        }
    }
}

interface IToken {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IBridge {
    function portal() external view returns (address);
}

interface IWrappedStock {
    function underlying() external view returns (address);
    function decimals() external view returns (uint8);
    function deposit(uint256 amount) external;
    function withdrawTo(address to, uint256 amount) external;
}

interface IPermit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
