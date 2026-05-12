import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

// 兼容 PRIVATE_KEY 写法：支持带或不带 0x
const rawPk = process.env.PRIVATE_KEY?.trim() || "";
const normalizedPk = rawPk.startsWith("0x") ? rawPk.slice(2) : rawPk;
const accounts = normalizedPk.length === 64 ? [`0x${normalizedPk}`] : [];

const config = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // 本地网络不需要私钥，方便测试编译
    hardhat: {},
    bsc_testnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545",
      accounts: accounts,
    },
    bsc_mainnet: {
      url: process.env.BSC_RPC || "https://binance.llamarpc.com",
      accounts: accounts,
      timeout: 60000, // 增加超时时间到 60 秒
    },
  },
  etherscan: {
    // Etherscan V2: 使用单一 API Key（多链通用）
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: false,
  },
};

export default config;