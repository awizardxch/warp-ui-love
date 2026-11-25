// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title WrappedStock
/// @notice A 1:1, WETH-style ERC-20 wrapper around one Base-native (B20) token.
///
/// Why this exists: the warp.green validators sign an ERC-20 deposit only when
/// they can read the bridge's token balance out of ordinary contract storage.
/// B20 tokens are built into the Base node and keep no balances in contract
/// storage, so they cannot be bridged directly. This wrapper is a plain ERC-20
/// that can.
///
/// Properties:
/// - One wrapped unit is always redeemable for exactly one raw unit of the
///   underlying token. Stock splits and dividends change the underlying's
///   multiplier, never raw balances, so the wrapper needs no split logic.
/// - No owner, no upgrade path, no fees, no pause. Nothing here can be changed
///   after deployment.
/// - Underlying tokens sent straight to this contract (not through `deposit`)
///   cannot be recovered by anyone.
/// - The issuer of the underlying token can still freeze or seize this
///   contract's holdings. That risk is the underlying's, and it carries over.
contract WrappedStock {
    // ---------------------------------------------------------------------
    // Storage. The layout is load-bearing: the bridge's signer looks for the
    // balance mapping in slots 0-63 and requires `keccak256(holder . slot)` to
    // hold exactly `balanceOf(holder)`. Keep `balanceOf` in slot 0.
    // ---------------------------------------------------------------------

    mapping(address => uint256) public balanceOf; // slot 0
    mapping(address => mapping(address => uint256)) public allowance; // slot 1
    uint256 public totalSupply; // slot 2
    string public name; // slot 3
    string public symbol; // slot 4
    uint256 private _entered; // slot 5

    /// @notice The wrapped B20 token.
    address public immutable underlying;
    /// @notice Same as the underlying's decimals.
    uint8 public immutable decimals;

    uint256 private constant WAD = 1e18;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAmount();
    error InvalidReceiver(address receiver);
    error InvalidUnderlying();
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error UnderlyingTransferFailed();
    error UnexpectedAmountReceived(uint256 expected, uint256 received);
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address underlying_, string memory name_, string memory symbol_) {
        if (underlying_ == address(0) || underlying_.code.length == 0) revert InvalidUnderlying();
        underlying = underlying_;
        decimals = IUnderlying(underlying_).decimals();
        name = name_;
        symbol = symbol_;
    }

    // ---------------------------------------------------------------------
    // Wrap / unwrap
    // ---------------------------------------------------------------------

    /// @notice Wrap `amount` of the underlying for the caller. Needs approval.
    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount);
    }

    /// @notice Wrap `amount` of the caller's underlying and credit `to`.
    function depositFor(address to, uint256 amount) external {
        _deposit(to, amount);
    }

    /// @notice Unwrap `amount` to the caller.
    function withdraw(uint256 amount) external {
        _withdraw(msg.sender, amount);
    }

    /// @notice Unwrap `amount` of the caller's balance and send it to `to`.
    function withdrawTo(address to, uint256 amount) external {
        _withdraw(to, amount);
    }

    function _deposit(address to, uint256 amount) private nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _checkReceiver(to);

        uint256 before = _underlyingBalance();
        _callUnderlying(abi.encodeCall(IUnderlying.transferFrom, (msg.sender, address(this), amount)));
        uint256 received = _underlyingBalance() - before;
        // Refuse anything that is not an exact 1:1 transfer (fees, rebases).
        if (received != amount) revert UnexpectedAmountReceived(amount, received);

        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount; // cannot overflow: bounded by totalSupply
        }
        emit Transfer(address(0), to, amount);
    }

    function _withdraw(address to, uint256 amount) private nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0) || to == address(this) || to == underlying) revert InvalidReceiver(to);

        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert InsufficientBalance(msg.sender, balance, amount);
        unchecked {
            balanceOf[msg.sender] = balance - amount;
            totalSupply -= amount; // cannot underflow: balance <= totalSupply
        }
        emit Transfer(msg.sender, address(0), amount);

        _callUnderlying(abi.encodeCall(IUnderlying.transfer, (to, amount)));
    }

    // ---------------------------------------------------------------------
    // ERC-20
    // ---------------------------------------------------------------------

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(msg.sender, allowed, amount);
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        _checkReceiver(to);
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(from, balance, amount);
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount; // cannot overflow: bounded by totalSupply
        }
        emit Transfer(from, to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Underlying tokens held by this contract. Always >= totalSupply
    /// unless the underlying's issuer burns or seizes from this contract.
    function backing() external view returns (uint256) {
        return _underlyingBalance();
    }

    /// @notice The underlying's share multiplier, scaled by 1e18: how many
    /// shares one whole token represents. Returns 1e18 if the underlying does
    /// not report one. Display only; it never affects balances here.
    function uiMultiplier() external view returns (uint256) {
        (bool ok, bytes memory data) = underlying.staticcall(abi.encodeCall(IUnderlying.multiplier, ()));
        if (!ok || data.length != 32) return WAD;
        uint256 value = abi.decode(data, (uint256));
        return value == 0 ? WAD : value;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _checkReceiver(address to) private view {
        if (to == address(0) || to == address(this)) revert InvalidReceiver(to);
    }

    function _underlyingBalance() private view returns (uint256) {
        return IUnderlying(underlying).balanceOf(address(this));
    }

    /// @dev Accepts tokens that return true and tokens that return nothing.
    function _callUnderlying(bytes memory data) private {
        (bool ok, bytes memory ret) = underlying.call(data);
        // Decode as a number: decoding a non-0/1 word as bool would revert bare.
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert UnderlyingTransferFailed();
        }
    }
}

interface IUnderlying {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function multiplier() external view returns (uint256);
}
