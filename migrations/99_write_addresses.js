// migrations/99_write_addresses.js
const fs = require("fs");
const path = require("path");

const names = [
  "NodeManager",
  "IncentiveGovernance",
  "DisputeResolution",
  "OracleCore",
  // 如果 DataAggregation 不是必需，可以先保留在列表里；未部署会被跳过
  "DataAggregation",
];

async function safeDeployed(artifactName) {
  try {
    const A = artifacts.require(artifactName);
    const i = await A.deployed();
    return i.address;
  } catch (_) {
    return undefined; // 未部署或网络不匹配 -> 跳过
  }
}

module.exports = async function (deployer, network, accounts) {
  const out = {};
  for (const n of names) {
    const addr = await safeDeployed(n);
    if (addr) out[n] = addr;
  }

  const p = path.resolve("deployment-addresses.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(">> wrote", p);
};

