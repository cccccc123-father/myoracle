// scripts/exp_attack_fraction_unweighted.js
//
// 恶意比例扫描（unweighted）：
// 固定当前系统的观察者数量 nObs（由 NodeManager 决定），
// 对 f = 0..nObs 不同恶意人数，跑多轮请求，统计：
//  1) 攻击是否成功（共识偏离真实值超过阈值）
//  2) 是否触发审计（ratioTimes100 >= auditThr）

const OracleCore = artifacts.require("OracleCore");

module.exports = async function (callback) {
  try {
    const accounts = await web3.eth.getAccounts();
    const admin    = accounts[0];
    const proposer = accounts[1];

    const core = await OracleCore.deployed();

    console.log("=== Attack fraction experiment (unweighted trimmed) ===");
    console.log("Admin   :", admin);
    console.log("Proposer:", proposer);

    // 读取当前链上参数
    const lamTimes100 = (await core.lambdaTimes100()).toNumber();
    const auditThr100 = (await core.auditAnomalyRatioTimes100()).toNumber();
    const useWeights  = await core.useWeights();

    console.log(
      "Current params:",
      "lambdaTimes100 =", lamTimes100,
      "auditAnomalyRatioTimes100 =", auditThr100,
      "useWeights =", useWeights
    );

    // 先发一个探针请求，看看每次会抽多少观察者（nObs）
    const probeTx = await core.createDataRequestEx(
      "probe-nObs",
      0,      // _kObservers (记录用，不影响 NodeManager.selectObservers)
      0,      // _lambdaTimes100 (0 => 用全局 lambdaTimes100)
      0,      // _auditAnomalyRatioTimes100 (0 => 用全局 auditAnomalyRatioTimes100)
      true,   // _hasUseWeightsOverride
      false,  // _useWeightsForReq (明确用非加权)
      0,      // _base1e18ForReq
      0,      // _wRep1e18ForReq
      { from: proposer, value: 0 }
    );

    const probeCreated = probeTx.logs.find(l => l.event === "RequestCreated");
    const probeId      = probeCreated.args.requestId.toNumber();

    const probeObsLog  = probeTx.logs.find(l => l.event === "ObserversSelected");
    const probeObs     = probeObsLog.args.observers;
    const nObs         = probeObs.length;

    console.log("Probe request id =", probeId, ", nObservers per request =", nObs);

    // 这里随便完整跑一遍 probe（用全部 honest=100），以免留下半成品请求
    {
      const trueValue = 100;
      const obs       = probeObs;

      // commits
      for (let i = 0; i < obs.length; i++) {
        const addr  = obs[i];
        const v     = trueValue;
        const nonce = web3.utils.toBN(999000 + i);

        const encoded = web3.eth.abi.encodeParameters(
          ["uint256", "uint256", "address"],
          [v.toString(), nonce.toString(), addr]
        );
        const commitment = web3.utils.keccak256(encoded);

        await core.commitData(probeId, commitment, { from: addr });
      }

      await core.openReveal(probeId, { from: proposer });

      for (let i = 0; i < obs.length; i++) {
        const addr  = obs[i];
        const v     = trueValue;
        const nonce = web3.utils.toBN(999000 + i);
        await core.revealData(probeId, v, nonce.toString(), { from: addr });
      }

      await core.finalizeRequest(probeId, { from: proposer });
    }

    // ==== 正式实验配置 ====
    const runsPerF      = 50;     // 每个恶意人数跑多少轮
    const trueValue     = 100;    // 真实值
    const attackValue   = 130;    // 恶意上报值
    const deltaAttack   = 5;      // |consensus - trueValue| > deltaAttack 视为攻击成功
    const maxF          = nObs;   // f 从 0..nObs，包含多数恶意的情况

    console.log("\nExperiment config:");
    console.log("  runsPerF   =", runsPerF);
    console.log("  trueValue  =", trueValue);
    console.log("  attackValue=", attackValue);
    console.log("  deltaAttack=", deltaAttack);
    console.log("  nObservers =", nObs);
    console.log("  f in [0..", maxF, "]");

    const stats = []; // 每个 f 一条统计

    for (let f = 0; f <= maxF; f++) {
      let total          = 0;
      let attackSuccess  = 0;
      let auditTriggers  = 0;

      console.log(`\n=== f = ${f} malicious observers ===`);

      for (let r = 0; r < runsPerF; r++) {
        // 1) 创建请求（请求级参数覆盖：强制 useWeights=false）
        const txCreate = await core.createDataRequestEx(
          `attack-f${f}-run${r}`,
          0,      // _kObservers
          0,      // _lambdaTimes100 (使用全局 lambdaTimes100)
          0,      // _auditAnomalyRatioTimes100 (使用全局 auditAnomalyRatioTimes100)
          true,   // _hasUseWeightsOverride
          false,  // _useWeightsForReq = false
          0,      // _base1e18ForReq
          0,      // _wRep1e18ForReq
          { from: proposer, value: 0 }
        );

        const createdLog = txCreate.logs.find(l => l.event === "RequestCreated");
        const requestId  = createdLog.args.requestId.toNumber();
        const obsLog     = txCreate.logs.find(l => l.event === "ObserversSelected");
        const observers  = obsLog.args.observers;
        const nRoundObs  = observers.length;

        // 这一轮实际能用的恶意人数（不能超过 nRoundObs）
        const maliciousCount = Math.min(f, nRoundObs);

        // 2) commits
        const reportVals  = [];
        const reportNonce = [];

        for (let i = 0; i < nRoundObs; i++) {
          const addr = observers[i];
          const isMalicious = i < maliciousCount;

          const v = isMalicious ? attackValue : trueValue;
          const nonce = web3.utils.toBN(1000000 + f * 1000 + r * 10 + i);

          const encoded = web3.eth.abi.encodeParameters(
            ["uint256", "uint256", "address"],
            [v.toString(), nonce.toString(), addr]
          );
          const commitment = web3.utils.keccak256(encoded);

          await core.commitData(requestId, commitment, { from: addr });

          reportVals.push(v);
          reportNonce.push(nonce);
        }

        // 3) 打开 reveal
        await core.openReveal(requestId, { from: proposer });

        // 4) reveals
        for (let i = 0; i < nRoundObs; i++) {
          const addr  = observers[i];
          const v     = reportVals[i];
          const nonce = reportNonce[i];
          await core.revealData(requestId, v, nonce.toString(), { from: addr });
        }

        // 5) finalize
        const txFin = await core.finalizeRequest(requestId, { from: proposer });

        const res = await core.getRequestResult(requestId);
        const consensus = Number(res[0].toString());

        const evAnom = txFin.logs.find(l => l.event === "AnomalyStats");
        let ratioTimes100 = 0;
        if (evAnom) {
          ratioTimes100 = Number(evAnom.args.ratioTimes100.toString());
        }

        const isAttackSuccess = Math.abs(consensus - trueValue) > deltaAttack;
        const isAuditTrigger  = ratioTimes100 >= auditThr100;

        total++;
        if (isAttackSuccess) attackSuccess++;
        if (isAuditTrigger)  auditTriggers++;
      }

      stats.push({
        f,
        total,
        attackSuccess,
        auditTriggers
      });

      const attackRate = total > 0 ? attackSuccess / total : 0;
      const auditRate  = total > 0 ? auditTriggers / total : 0;

      console.log(
        `Summary f=${f}: attack_success_rate=${attackRate.toFixed(3)}, audit_trigger_rate=${auditRate.toFixed(3)}`
      );
    }

    console.log("\n=== Final summary (unweighted) ===");
    console.log("f, total_runs, attack_success_rate, audit_trigger_rate");
    for (const s of stats) {
      const attackRate = s.total > 0 ? s.attackSuccess / s.total : 0;
      const auditRate  = s.total > 0 ? s.auditTriggers / s.total : 0;
      console.log(
        `${s.f}, ${s.total}, ${attackRate.toFixed(3)}, ${auditRate.toFixed(3)}`
      );
    }

    console.log("\n=== Attack fraction experiment finished ===");
  } catch (err) {
    console.error("Test script error:", err);
  }

  callback();
};

