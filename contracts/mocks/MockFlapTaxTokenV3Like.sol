// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MockFlapTaxTokenV3Like is ERC20, Ownable {
    uint16 private _buyTaxRate;   // bps
    uint16 private _sellTaxRate;  // bps
    address public taxVault;      // 安小将合约地址

    uint256 public constant BPS = 10_000;
    uint256 public constant TOKENS_PER_BNB = 1_000_000 ether; // 1 BNB -> 100万代币(示例)

    event TaxVaultUpdated(address indexed vault);
    event TaxRatesUpdated(uint16 buyTaxRate, uint16 sellTaxRate);
    event TaxForwarded(address indexed payer, uint256 taxAmount, bool isBuy);
    event MockBuy(address indexed buyer, uint256 bnbIn, uint256 tax, uint256 minted);
    event MockSell(address indexed seller, uint256 burned, uint256 grossOut, uint256 tax, uint256 netOut);

    constructor(address initialVault, uint16 buyTaxBps, uint16 sellTaxBps) ERC20("Mock FLAP Tax V3", "mFLAPV3") Ownable(msg.sender) {
        require(buyTaxBps <= BPS && sellTaxBps <= BPS, "bad tax");
        taxVault = initialVault;
        _buyTaxRate = buyTaxBps;
        _sellTaxRate = sellTaxBps;
    }

    receive() external payable {}

    function setTaxVault(address vault) external onlyOwner {
        taxVault = vault;
        emit TaxVaultUpdated(vault);
    }

    function setTaxRates(uint16 buyTaxBps, uint16 sellTaxBps) external onlyOwner {
        require(buyTaxBps <= BPS && sellTaxBps <= BPS, "bad tax");
        _buyTaxRate = buyTaxBps;
        _sellTaxRate = sellTaxBps;
        emit TaxRatesUpdated(buyTaxBps, sellTaxBps);
    }

    function buyTaxRate() external view returns (uint16) {
        return _buyTaxRate;
    }

    function sellTaxRate() external view returns (uint16) {
        return _sellTaxRate;
    }

    // 与 Flap 文档兼容：返回 max(buy, sell)
    function taxRate() external view returns (uint16) {
        return _buyTaxRate >= _sellTaxRate ? _buyTaxRate : _sellTaxRate;
    }

    // 模拟买入：msg.value 作为买入金额，抽 buy tax 并转发至安小将
    function mockBuy() external payable {
        require(msg.value > 0, "zero bnb");
        uint256 tax = (msg.value * _buyTaxRate) / BPS;
        uint256 effective = msg.value - tax;
        uint256 mintAmount = effective * TOKENS_PER_BNB / 1 ether;

        _mint(msg.sender, mintAmount);

        if (tax > 0 && taxVault != address(0)) {
            (bool ok, ) = payable(taxVault).call{value: tax}("");
            require(ok, "tax forward failed");
            emit TaxForwarded(msg.sender, tax, true);
        }

        emit MockBuy(msg.sender, msg.value, tax, mintAmount);
    }

    // 给合约注入 BNB，模拟池子有资金用于卖出兑付
    function seedBnb() external payable onlyOwner {}

    // 模拟卖出：用户烧币，按 grossOut 计算 sell tax，税转发，净额给用户
    function mockSell(uint256 burnAmount, uint256 grossOutWei) external {
        require(burnAmount > 0, "zero burn");
        require(grossOutWei > 0, "zero out");
        _burn(msg.sender, burnAmount);

        uint256 tax = (grossOutWei * _sellTaxRate) / BPS;
        uint256 netOut = grossOutWei - tax;
        require(address(this).balance >= grossOutWei, "insufficient bnb");

        if (tax > 0 && taxVault != address(0)) {
            (bool ok1, ) = payable(taxVault).call{value: tax}("");
            require(ok1, "tax forward failed");
            emit TaxForwarded(msg.sender, tax, false);
        }

        (bool ok2, ) = payable(msg.sender).call{value: netOut}("");
        require(ok2, "pay user failed");

        emit MockSell(msg.sender, burnAmount, grossOutWei, tax, netOut);
    }
}