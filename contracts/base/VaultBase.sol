// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/**
 * @title VaultBase
 * @notice FLAP 平台金库基础合约
 */
abstract contract VaultBase {
    /// @notice 错误：不支持的链 ID
    error UnsupportedChain(uint256 chainId);

    /// @notice 获取当前链的 Portal 地址
    function _getPortal() internal view returns (address portal) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            return 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0; // BSC Mainnet
        } else if (chainId == 97) {
            return 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9; // BSC Testnet
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice 获取当前链的 Guardian 地址
    function _getGuardian() internal view returns (address guardian) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            return 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
        } else if (chainId == 97) {
            return 0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950;
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice 返回金库描述
    function description() public view virtual returns (string memory);
}