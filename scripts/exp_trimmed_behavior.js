// scripts/exp_trimmed_behavior.js
//
// 用来测试：加权 trimmed mean 聚合在不同异常场景下的行为。
// 假设合约已经通过 migrations 部署，且 NodeManager / IncentiveGovernance 已经按之前脚本注册好节点。

const OracleCore = artifacts.require("OracleCore");

module.exports = async function (callback) {
  try {
    const accounts = await web3.eth.getAccounts();
    const admin    = accounts[0];
    const proposer = accounts[1];
    const obs      = [accounts[2], accounts[3], accounts[4]]; // 三个观察者（和 test_oracle.js 中前三个一致）

    const core = await OracleCore.deployed();

    console.log("=== Trimmed aggregation behavior experiment ===");
    console.log("Admin    :", admin);
    console.log("Proposer :", proposer);
    console.log("Observers:", obs.join(" "));

    const minStakeWei = await core.minStake();
    const lamTimes100 = (await core.lambdaTimes100()).toNumber();
    const auditThr100 = (await core.auditAnomalyRatioTimes100()).toNumber();

    console.log(
      "Current params:",
      "minStake =", web3.utils.fromWei(minStakeWei.toString(), "ether"), "ETH,",
      "lambdaTimes100 =", lamTimes100,
      "auditAnomalyRatioTimes100 =", auditThr100
    );

    // 三个典型场景
    const scenarios = [
      {
        name: "All honest (no outlier)",
        values: [100, 99, 101]
      },
      {
        name: "One moderate outlier",
        values: [100, 102, 130]
      },
      {
        name: "Two colluding outliers",
        values: [100, 130, 130]
      }
    ];

    for (let sIdx = 0; sIdx < scenarios.length; sIdx++) {
      const sc = scenarios[sIdx];
      console.log(`\n[Scenario ${sIdx + 1}] ${sc.name}`);
      console.log("  Reports:", sc.values.map(v => v.toString()).join(", "));

      // 1) 发起请求（这里请求级参数都传 0，走全局默认）
      const txCreate = await core.createDataRequestEx(
        `exp-scenario-${sIdx + 1}`,
        0,      // _kObservers (记录用，不影响 NodeManager.selectObservers)
        0,      // _lambdaTimes100 (0 => 用全局 lambdaTimes100)
        0,      // _auditAnomalyRatioTimes100 (0 => 用全局 auditAnomalyRatioTimes100)
        false,  // _hasUseWeightsOverride
        false,  // _useWeightsForReq
        0,      // _base1e18ForReq
        0,      // _wRep1e18ForReq
        { from: proposer, value: 0 }
      );

      const createdLog = txCreate.logs.find(l => l.event === "RequestCreated");
      const requestId  = createdLog.args.requestId.toNumber();
      console.log(`  Request created, id = ${requestId}`);

      // 2) 三个观察者提交 commit
      for (let i = 0; i < obs.length; i++) {
        const addr  = obs[i];
        const v     = sc.values[i];
        const nonce = web3.utils.toBN(1000 + sIdx * 10 + i); // 可复现实验的固定 nonce

        const encoded = web3.eth.abi.encodeParameters(
          ["uint256", "uint256", "address"],
          [v.toString(), nonce.toString(), addr]
        );
        const commitment = web3.utils.keccak256(encoded);

        await core.commitData(requestId, commitment, { from: addr });
      }
      console.log("  Commits submitted");

      // 3) 打开 reveal 阶段
      await core.openReveal(requestId, { from: proposer });
      console.log("  Reveal opened");

      // 4) 三个观察者揭示数据
      for (let i = 0; i < obs.length; i++) {
        const addr  = obs[i];
        const v     = sc.values[i];
        const nonce = web3.utils.toBN(1000 + sIdx * 10 + i);
        await core.revealData(requestId, v, nonce.toString(), { from: addr });
      }
      console.log("  Reveals submitted");

      // 5) finalize，本次会进行 trimmed 聚合 + 区间 + 异常统计 + 可能触发审计
      const txFinalize = await core.finalizeRequest(requestId, { from: proposer });

      const res = await core.getRequestResult(requestId);
      const consensus = res[0].toString();
      const lower     = res[1].toString();
      const upper     = res[2].toString();
      const finalized = res[3];

      console.log(
        `  Result: consensus = ${consensus}, lower = ${lower}, upper = ${upper}, finalized = ${finalized}`
      );

      // 6) 解析 AnomalyStats 事件，查看异常权重比例
      const ev = txFinalize.logs.find(l => l.event === "AnomalyStats");
      if (ev) {
        const anomalies      = ev.args.anomalies.toString();
        const total          = ev.args.total.toString();
        const ratioTimes100  = ev.args.ratioTimes100.toString(); // ×100（‰‰），10000=100%
        console.log(
          `  AnomalyStats: anomalies = ${anomalies}/${total}, weightedRatioTimes100 = ${ratioTimes100}/10000`
        );

        // 简单判断是否应该触发审计（按当前全局阈值）
        const ratioInt = parseInt(ratioTimes100, 10);
        const thrInt   = auditThr100;
        console.log(
          `  Audit condition: ratioTimes100 = ${ratioInt}, threshold = ${thrInt} => ${
            ratioInt >= thrInt ? "SHOULD AUDIT" : "no audit"
          }`
        );
      } else {
        console.log("  [WARN] no AnomalyStats event found");
      }
    }

    console.log("\n=== Trimmed aggregation experiment finished ===");
  } catch (err) {
    console.error("Test script error:", err);
  }

  callback();
};

