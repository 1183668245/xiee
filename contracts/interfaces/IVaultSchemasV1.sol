// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

struct VaultUISchema {
    string name;
    string icon;
    string description;
    MethodSchema[] methods;
}

struct MethodSchema {
    string name;
    string label;
    string description;
    ParamSchema[] params;
}

struct ParamSchema {
    string name;
    string label;
    string typeName;
}

interface IVaultSchemasV1 {
    function vaultUISchema() external pure returns (VaultUISchema memory);
}