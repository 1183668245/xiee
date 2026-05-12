// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {VaultBase} from "./VaultBase.sol";
import {VaultUISchema} from "../interfaces/IVaultSchemasV1.sol";

/**
 * @title VaultBaseV2
 * @notice 扩展了 UI Schema 支持的基础合约
 */
abstract contract VaultBaseV2 is VaultBase {
    /// @notice 返回用于前端自动渲染的 UI 架构
    function vaultUISchema() public pure virtual returns (VaultUISchema memory);
}