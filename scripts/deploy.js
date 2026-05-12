import hre from "hardhat";
import "dotenv/config";

async function main() {
  const signers = await hre.ethers.getSigners();
  if (!signers.length) {
    throw new Error("未加载到部署账户。请检查 .env 的 PRIVATE_KEY（64位十六进制，可带或不带0x）");
  }
  const deployer = signers[0];
  console.log("正在使用账户部署合约:", deployer.address);

  // 从环境变量中读取地址
  const projectTokenAddress = process.env.PROJECT_TOKEN_ADDRESS;
  const treasuryAddress = process.env.TREASURY_ADDRESS;

  // 检查地址是否存在
  if (!projectTokenAddress || !treasuryAddress) {
    console.error("错误: 请在 .env 文件中设置 PROJECT_TOKEN_ADDRESS 和 TREASURY_ADDRESS");
    process.exit(1);
  }

  console.log("项目代币地址:", projectTokenAddress);
  console.log("国库地址:", treasuryAddress);

  const EvilFarm = await hre.ethers.getContractFactory("EvilFarm");
  const axj = await EvilFarm.deploy(projectTokenAddress, treasuryAddress);

  await axj.waitForDeployment();

  console.log("-----------------------------------------------");
  console.log("邪恶农场 (EvilFarm) 合约部署成功！");
  console.log("合约地址:", await axj.getAddress());
  console.log("-----------------------------------------------");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});