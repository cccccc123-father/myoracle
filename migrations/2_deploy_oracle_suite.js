// migrations/2_deploy_oracle_suite.js
const NodeManager         = artifacts.require("NodeManager");
const IncentiveGovernance = artifacts.require("IncentiveGovernance");
const DisputeResolution   = artifacts.require("DisputeResolution");
const OracleCore          = artifacts.require("OracleCore");

module.exports = async function (deployer, network, accounts) {
  // 1) 部署 NodeManager（无参）
  await deployer.deploy(NodeManager);
  const node = await NodeManager.deployed();

  // 2) 部署 IncentiveGovernance（无参）
  await deployer.deploy(IncentiveGovernance);
  const inc = await IncentiveGovernance.deployed();

  // 3) 部署 DisputeResolution
  //    构造函数：constructor(address _nodeManager, address _owner)
  //    _nodeManager 传 NodeManager 地址，owner 传 accounts[0]
  await deployer.deploy(DisputeResolution, node.address, accounts[0]);
  const dr = await DisputeResolution.deployed();

  // 4) 部署 OracleCore（构造：nodeManager, incentives, disputes）
  await deployer.deploy(OracleCore, node.address, inc.address, dr.address);
  const core = await OracleCore.deployed();

  // 5) 绑定 IncentiveGovernance.oracleCore
  try {
    await inc.setOracleCore(core.address, { from: accounts[0] });
  } catch (e) {
    console.log(">> inc.setOracleCore failed or not available:", e.message || e);
  }

  // 6) 绑定 DisputeResolution.oracleCore（如果有这个函数）
  try {
    if (dr.setOracleCore) {
      await dr.setOracleCore(core.address, { from: accounts[0] });
    }
  } catch (e) {
    console.log(">> dr.setOracleCore failed or not available:", e.message || e);
  }

  console.log("Deployed addresses:");
  console.log("  NodeManager         :", node.address);
  console.log("  IncentiveGovernance :", inc.address);
  console.log("  DisputeResolution   :", dr.address);
  console.log("  OracleCore          :", core.address);
};

