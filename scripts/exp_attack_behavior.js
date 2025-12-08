// scripts/exp_attack_behavior.js
// 模拟：不同恶意观测者比例下，系统的聚合结果偏移 & 审计触发情况

const NodeManager = artifacts.require("NodeManager");
const OracleCore = artifacts.require("OracleCore");
const DisputeResolution = artifacts.require("DisputeResolution");

// helper: 模拟合约里的 keccak256(abi.encode(value, nonce, sender))
function makeCommitment(value, nonce, addr) {
  const encoded = web3.eth.abi.encodeParameters(
    ["uint256", "uint256", "address"],
    [value, nonce, addr]
  );
  return web3.utils.keccak256(encoded);
}

// 简单整数“高斯近似”：在 [v-σ, v+σ] 区间内均匀取值
function sampleHonestValue(vTrue, sigma) {
  const low = vTrue - sigma;
  const high = vTrue + sigma;
  const u = Math.random();
  return Math.floor(low + (high - low + 1) * u);
}

module.exports = async function (callback) {
  try {
    console.log("=== exp_attack_behavior: start ===");

    const nm = await NodeManager.deployed();
    const core = await OracleCore.deployed();
    const dr = await DisputeResolution.deployed();
    const accounts = await web3.eth.getAccounts();

    const admin = accounts[0];
    const proposer = accounts[1];

    // ---------- 0. 注册足够多的观察者 / 审计者 ----------
    const maxObservers = 15;  // 最大需要的观察者候选数量
    const maxAuditors  = 5;

    async function ensureRegistered(addr, role, stakeEth) {
      const info = await nm.getNode(addr); // (registered, role, stake, rep)
      const registered = info[0];
      if (!registered) {
        await nm.register(role, {
          from: addr,
          value: web3.utils.toWei(stakeEth, "ether"),
        });
      }
    }

    // 注册观察者
    const observerAddrs = [];
    for (let i = 0; i < maxObservers; i++) {
      const addr = accounts[2 + i];
      observerAddrs.push(addr);
      await ensureRegistered(addr, 1, "1"); // role=1 => OBSERVER
    }

    // 注册審計者
    const auditorAddrs = [];
    for (let i = 0; i < maxAuditors; i++) {
      const addr = accounts[2 + maxObservers + i];
      auditorAddrs.push(addr);
      await ensureRegistered(addr, 2, "1"); // role=2 => AUDITOR
    }

    // NodeManager & OracleCore 基本参数
    await nm.setCounts(maxObservers, maxAuditors, { from: admin });

    const minStakeWei = web3.utils.toWei("1", "ether");
    await core.setParams(minStakeWei, 250, 3000, { from: admin }); // lambda=2.5, auditThreshold=30%
    await core.setUseWeights(false, { from: admin });

    // ---------- 1. 实验参数 ----------
    const vTrue = 100;          // 真实值
    const sigma = 2;            // honest 噪声幅度
    const vAttack = 1000;       // 恶意报送值
    const deltaTol = 10;        // 认为“共识被成功拖偏”的阈值 |consensus - vTrue| > deltaTol

    const lambdaTimes100 = 250;      // λ = 2.5
    const auditRatioTimes100 = 2000; // 20% 异常比例触发审计

    const nObsList = [3, 5, 7, 9];   // 每轮选多少观察者
    const roundsPerConfig = 30;      // 每组参数重复次数

    console.log(
      "Params:",
      "vTrue=", vTrue,
      "sigma=", sigma,
      "vAttack=", vAttack,
      "deltaTol=", deltaTol,
      "lambdaTimes100=", lambdaTimes100,
      "auditRatioTimes100=", auditRatioTimes100,
      "roundsPerConfig=", roundsPerConfig
    );

    // ---------- 2. 主循环：遍历 nObs / fMal ----------
    for (const nObs of nObsList) {
      // 每组 nObs 时，最多考虑到 floor(nObs/2)+1 个恶意节点
      const maxMal = Math.floor(nObs / 2) + 1;
      await nm.setCounts(nObs, maxAuditors, { from: admin });
      await core.setK(nObs, { from: admin });

      console.log(`\n=== nObs = ${nObs} ===`);

      for (let fMal = 0; fMal <= maxMal; fMal++) {
        let successCount = 0;
        let auditCount = 0;
        let anomalyRatioSum = 0;

        for (let r = 0; r < roundsPerConfig; r++) {
          // 2.1 创建请求（覆盖 λ / 审计阈值）
          const txCreate = await core.createDataRequestEx(
            `attack nObs=${nObs} fMal=${fMal} round=${r}`,
            nObs,
            lambdaTimes100,
            auditRatioTimes100,
            false,  // 不覆盖 useWeights
            false,
            0,
            0,
            {
              from: proposer,
              value: web3.utils.toWei("1", "ether"),
            }
          );

          const evReq = txCreate.logs.find((l) => l.event === "RequestCreated");
          const requestId = evReq.args.requestId.toString();

          const evObs = txCreate.logs.find((l) => l.event === "ObserversSelected");
          const selectedObservers = evObs.args.observers;
          // 防御性处理：只取前 nObs 个
          const obsList = selectedObservers.slice(0, nObs);

          // 2.2 commit 阶段：前 fMal 个为恶意，其余诚实
          const values = {};
          const nonces = {};

          for (let i = 0; i < obsList.length; i++) {
            const addr = obsList[i];
            const isMalicious = i < fMal;
            const val = isMalicious
              ? vAttack
              : sampleHonestValue(vTrue, sigma);

            const nonce = (r + 1) * 1000 + i + 1;
            const commit = makeCommitment(val, nonce, addr);
            await core.commitData(requestId, commit, { from: addr });

            values[addr] = val;
            nonces[addr] = nonce;
          }

          // 2.3 openReveal + reveal
          await core.openReveal(requestId, { from: proposer });

          for (let i = 0; i < obsList.length; i++) {
            const addr = obsList[i];
            await core.revealData(
              requestId,
              values[addr],
              nonces[addr],
              { from: addr }
            );
          }

          // 2.4 finalize
          const txFin = await core.finalizeRequest(requestId, { from: proposer });
          const res = await core.getRequestResult(requestId);
          const consensus = Number(res[0].toString());

          const deviation = Math.abs(consensus - vTrue);
          const attackSuccess = deviation > deltaTol;
          if (attackSuccess) {
            successCount += 1;
          }

          // 拿 anomaly ratio & audit 触发情况
          const evAn = txFin.logs.find((l) => l.event === "AnomalyStats");
          if (evAn) {
            const ratioTimes100 = Number(evAn.args.ratioTimes100.toString());
            anomalyRatioSum += ratioTimes100;
          }

          const disputed = await dr.getDisputedValue(requestId);
          const auditTriggered = disputed.toString() !== "0";
          if (auditTriggered) {
            auditCount += 1;
          }
        }

        const successRate = successCount / roundsPerConfig;
        const auditRate = auditCount / roundsPerConfig;
        const avgAnomalyRatio = anomalyRatioSum / roundsPerConfig;

        console.log(
          `nObs=${nObs}, fMal=${fMal} (${(fMal / nObs * 100).toFixed(1)}% malicious): ` +
          `attackSuccessRate=${(successRate * 100).toFixed(1)}%, ` +
          `auditTriggerRate=${(auditRate * 100).toFixed(1)}%, ` +
          `avgAnomalyRatioTimes100=${avgAnomalyRatio.toFixed(1)}`
        );
      }
    }

    console.log("=== exp_attack_behavior: done ===");
    callback();
  } catch (err) {
    console.error("exp_attack_behavior error:", err);
    callback(err);
  }
};

