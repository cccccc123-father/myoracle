// scripts/exp_attack_fraction_with_audit.js
//
// Monte-Carlo 实验：扫描不同恶意比例 f，比较未加权 / 加权 + 审计 的防御表现
// 本版本在 weighted 模式下：每轮显式更新链上 reputation：
//   - honest: rep = rep + 1
//   - malicious: rep = floor(rep / 2)

const OracleCore = artifacts.require("OracleCore");
const NodeManager = artifacts.require("NodeManager");
const DisputeResolution = artifacts.require("DisputeResolution");
const IncentiveGovernance = artifacts.require("IncentiveGovernance");

module.exports = async function (callback) {
  const web3 = OracleCore.web3;

  try {
    const accounts = await web3.eth.getAccounts();
    const admin = accounts[0];
    const proposer = accounts[1];

    const core = await OracleCore.deployed();
    const nodeManager = await NodeManager.deployed();
    const dr = await DisputeResolution.deployed();
    const inc = await IncentiveGovernance.deployed();

    // ---- 读取当前参数 & probe 一次观察者集合 ----
    const lambdaTimes100 = (await core.lambdaTimes100()).toNumber();
    const auditAnomalyRatioTimes100 = (await core.auditAnomalyRatioTimes100()).toNumber();
    const useWeightsInit = await core.useWeights();
    const superMajority = (await dr.auditSuperMajorityTimes10000()).toNumber();

    console.log("=== Attack fraction experiment (unweighted + audit) ===");
    console.log(`Admin   : ${admin}`);
    console.log(`Proposer: ${proposer}`);

    // probe 一次，用来获取每轮 request 的观察者数量
    const probeTx = await core.createDataRequestEx(
      "probe",
      0,
      lambdaTimes100,
      auditAnomalyRatioTimes100,
      false,
      useWeightsInit,
      0,
      0,
      { from: proposer, value: 0 }
    );
    const evProbe = probeTx.logs.find((l) => l.event === "RequestCreated");
    const probeReqId = evProbe.args.requestId.toNumber();
    const probeObservers = await core.getRequestObservers(probeReqId);
    const nObserversPerRequest = probeObservers.length;

    console.log(
      `Probe request id = ${probeReqId} , nObservers per request = ${nObserversPerRequest}`
    );
    console.log(
      `Current params: lambdaTimes100 = ${lambdaTimes100} auditAnomalyRatioTimes100 = ${auditAnomalyRatioTimes100} core.useWeights = ${useWeightsInit} auditSuperMajorityTimes10000 = ${superMajority}`
    );

    // ⚠️ 如果这里是 0，说明 NodeManager 还没注册 observer，需要先跑初始化脚本
    if (nObserversPerRequest === 0) {
      console.log(
        "WARN: nObserversPerRequest = 0, 请先用 test_oracle.js 或初始化脚本在 NodeManager 中注册观察者/审计者，再重跑本实验脚本。"
      );
    }

    // 固定一批“潜在坏节点”：就用 probe 里看到的 observer 集合
    const badPool = probeObservers.slice(); // [addr0, addr1, ...]

    // 从 NodeManager 选出审计委员会 —— 和 DisputeResolution.initiateAudit 里的调用保持一致
    // DisputeResolution 里面也是 nodeManager.selectAuditors(0)
    const auditors = await nodeManager.selectAuditors(0, { from: admin });
    console.log(`Auditors: ${auditors.join(" ")}`);

    // 全局实验配置
    const CONFIG = {
      runsPerF: 50,
      trueValue: 100,
      honestNoise: 2, // honest 报告 true ± honestNoise
      attackDelta: 30, // 攻击偏移量: v_attack = trueValue + attackDelta
      maxF: nObserversPerRequest, // f 最大到 observer 总数
      lambdaTimes100,
      auditAnomalyRatioTimes100,
    };

    // ===== 模式 1：unweighted =====
    console.log("===== Mode: unweighted =====");
    await core.setUseWeights(false, { from: admin });

    const summaryUnweighted = await runExperimentForMode(
      core,
      dr,
      nodeManager,
      inc,
      web3,
      {
        admin,
        proposer,
        auditors,
        badPool,
        nObserversPerRequest,
        manualRepUpdate: false, // unweighted 模式下不动链上 reputation
        ...CONFIG,
      },
      /*useWeights=*/ false
    );

    printSummary("unweighted", summaryUnweighted);

    // ===== 模式 2：weighted =====
    console.log("\n===== Mode: weighted =====");
    await core.setUseWeights(true, { from: admin });

    // 先 warmup 一段全诚实的轮次，给 honest 节点刷声誉
    const WARMUP_ROUNDS = 20;
    console.log(`\n[Warmup] Running ${WARMUP_ROUNDS} honest rounds for reputation ...`);
    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      await runOneRound(core, dr, nodeManager, inc, web3, {
        admin,
        proposer,
        auditors,
        badPool,
        nObserversPerRequest,
        ...CONFIG,
        f: 0, // 全诚实
        useWeights: true,
        manualRepUpdate: true, // warmup 阶段也更新 reputation
      });
    }

    const summaryWeighted = await runExperimentForMode(
      core,
      dr,
      nodeManager,
      inc,
      web3,
      {
        admin,
        proposer,
        auditors,
        badPool,
        nObserversPerRequest,
        manualRepUpdate: true, // weighted 模式下，每轮都更新 reputation
        ...CONFIG,
      },
      /*useWeights=*/ true
    );

    printSummary("weighted", summaryWeighted);

    console.log("\n=== Attack fraction experiment with audit finished ===");

    // 恢复 useWeights 初始值
    await core.setUseWeights(useWeightsInit, { from: admin });

    callback();
  } catch (err) {
    console.error(err);
    callback(err);
  }
};

/**
 * 运行整个模式（unweighted / weighted）：扫描 f = 0..maxF
 */
async function runExperimentForMode(
  core,
  dr,
  nodeManager,
  inc,
  web3,
  ctx,
  useWeights
) {
  const {
    runsPerF,
    maxF,
    manualRepUpdate,
  } = ctx;

  const summary = {};

  for (let f = 0; f <= maxF; f++) {
    let attackSucc = 0;
    let auditTrig = 0;
    let auditHasDecision = 0;
    let auditFix = 0;
    let auditWrongFlip = 0;
    let auditDeadlock = 0;

    console.log(`=== ${useWeights ? "[weighted] " : ""} f = ${f} malicious observers ===`);

    for (let r = 0; r < runsPerF; r++) {
      const result = await runOneRound(core, dr, nodeManager, inc, web3, {
        ...ctx,
        f,
        useWeights,
        manualRepUpdate,
      });

      if (result.attackSuccess) attackSucc++;
      if (result.auditTriggered) auditTrig++;
      if (result.auditHasDecision) auditHasDecision++;
      if (result.auditFix) auditFix++;
      if (result.auditWrongFlip) auditWrongFlip++;
      if (result.auditDeadlock) auditDeadlock++;
    }

    const total = runsPerF;
    const line = {
      f,
      total_runs: total,
      attack_success_rate: attackSucc / total,
      audit_trigger_rate: auditTrig / total,
      audit_has_decision_rate: auditHasDecision / total,
      audit_fix_rate: auditFix / total,
      audit_wrong_flip_rate: auditWrongFlip / total,
      audit_deadlock_rate: auditDeadlock / total,
    };

    console.log(
      `Summary ${useWeights ? "[weighted] " : ""}f=${f}: ` +
        `attack_success_rate=${line.attack_success_rate.toFixed(3)}, ` +
        `audit_trigger_rate=${line.audit_trigger_rate.toFixed(3)}, ` +
        `audit_decision_rate=${line.audit_has_decision_rate.toFixed(3)}, ` +
        `audit_fix_rate=${line.audit_fix_rate.toFixed(3)}`
    );

    summary[f] = line;
  }

  return summary;
}

/**
 * 单轮实验：
 *  - 固定坏节点集合 badPool，取前 f 个作为“长期作恶者”
 *  - honest: 报告 trueValue ± honestNoise
 *  - malicious: 报告 trueValue + attackDelta
 *  - median+MAD 在合约内完成，脚本只负责 commit/reveal/finalize 和审计
 *  - weighted 模式下：本轮结束后显式更新链上 rep（诚实 +1，恶意 /2）
 */
async function runOneRound(core, dr, nodeManager, inc, web3, ctx) {
  const {
    admin,
    proposer,
    auditors,
    badPool,
    nObserversPerRequest,
    trueValue,
    honestNoise,
    attackDelta,
    lambdaTimes100,
    auditAnomalyRatioTimes100,
    f,
    useWeights,
    manualRepUpdate,
  } = ctx;

  // 确保参数就位（可以移到外层，但这里写一次更安全）
  await core.setParams(1, lambdaTimes100, auditAnomalyRatioTimes100, { from: admin });
  await core.setUseWeights(useWeights, { from: admin });

  const vTrue = trueValue;
  const vAttack = trueValue + attackDelta;

  // 固定坏节点集合：badPool 的前 f 个
  const badSet = badPool.slice(0, f);

  // 1) 创建请求
  const txReq = await core.createDataRequestEx(
    "exp_attack_fraction",
    nObserversPerRequest,
    lambdaTimes100,
    auditAnomalyRatioTimes100,
    true,
    useWeights,
    0,
    0,
    { from: proposer, value: 0 }
  );
  const evReq = txReq.logs.find((l) => l.event === "RequestCreated");
  const reqId = evReq.args.requestId.toNumber();

  // 当轮真正被选中的 observers
  const obs = await core.getRequestObservers(reqId);
  const nObs = obs.length;

  // 2) 为每个 observer 决定报告值 & nonce，并生成 commit
  const valueMap = {};
  const nonceMap = {};

  for (let i = 0; i < nObs; i++) {
    const addr = obs[i];
    const isMalicious = badSet.includes(addr);

    let v;
    if (isMalicious) {
      v = vAttack;
    } else {
      const rand =
        Math.floor(Math.random() * (2 * honestNoise + 1)) - honestNoise;
      v = vTrue + rand;
    }

    // 为了避免重放 / 冲突，用 reqId 和 i 生成 nonce
    const nonce = (reqId + 1) * 1000 + i;

    valueMap[addr] = v;
    nonceMap[addr] = nonce;

    const encoded = web3.eth.abi.encodeParameters(
      ["uint256", "uint256", "address"],
      [v.toString(), nonce.toString(), addr]
    );
    const commit = web3.utils.keccak256(encoded);

    // ⚠️ commit 一定要从 observer 地址发
    await core.commitData(reqId, commit, { from: addr });
  }

  // 3) 打开 reveal
  await core.openReveal(reqId, { from: proposer });

  // 4) reveal：必须传入 commit 时用的同一 value & nonce，并从同一 observer 地址发
  for (let i = 0; i < nObs; i++) {
    const addr = obs[i];
    const v = valueMap[addr];
    const nonce = nonceMap[addr];
    await core.revealData(reqId, v, nonce, { from: addr });
  }

  // 5) finalize
  const txFin = await core.finalizeRequest(reqId, { from: proposer });
  const res = await core.getRequestResult(reqId);
  const consensus = res[0].toNumber();
  const lower = res[1].toNumber();
  const upper = res[2].toNumber();
  const finalized = res[3];

  if (!finalized) {
    throw new Error("finalizeRequest did not finalize");
  }

  const attackSuccess = Math.abs(consensus - vTrue) > attackDelta / 2;

  // 6) 是否触发审计
  const disputedValue = await dr.getDisputedValue(reqId);
  const auditTriggered = disputedValue.toString() !== "0";

  let auditHasDecision = false;
  let auditFix = false;
  let auditWrongFlip = false;
  let auditDeadlock = false;

  if (auditTriggered) {
    // 简单策略：审计者总是“理性”：如果 consensus 偏离 trueValue 太远就反对
    const supportOriginal = Math.abs(consensus - vTrue) <= attackDelta / 2;

    for (let i = 0; i < auditors.length; i++) {
      await dr.submitAuditVote(reqId, supportOriginal, { from: auditors[i] });
    }

    const txClose = await dr.close(reqId, { from: admin });
    auditHasDecision = true;

    const evClose = txClose.logs.find((l) => l.event === "AuditClosed");
    const supportOriginalFinal = evClose.args.supportOriginal;

    if (attackSuccess && !supportOriginalFinal) {
      auditFix = true; // 原本被攻击成功，但审计否决了原结果
    }
    if (!attackSuccess && !supportOriginalFinal) {
      auditWrongFlip = true; // 原本正确，但审计推翻了正确结果
    }
  }

  // 7) weighted 模式下：本轮结束后显式更新链上 reputation
  if (useWeights && manualRepUpdate) {
    await updateReputationAfterRound(inc, web3, admin, reqId, obs, badSet);
  }

  return {
    attackSuccess,
    auditTriggered,
    auditHasDecision,
    auditFix,
    auditWrongFlip,
    auditDeadlock,
  };
}

/**
 * 根据 ground truth（badSet）更新链上 reputation：
 *  - honest: rep = rep + 1
 *  - malicious: rep = floor(rep / 2)
 *
 * 通过 IncentiveGovernance.distributeRewards(...) 写回：
 *   - amounts 全 0（不转钱）
 *   - repDeltas[i] = newRep_i - oldRep_i
 */
async function updateReputationAfterRound(inc, web3, admin, reqId, observers, badSet) {
  const BN = web3.utils.toBN;

  const payees = [];
  const amounts = [];
  const repAddrs = [];
  const repDeltas = [];

  for (let i = 0; i < observers.length; i++) {
    const addr = observers[i];

    // 读取当前声誉
    const repBN = await inc.reputation(addr); // int256 -> BN
    let rep = BN(repBN.toString()); // 统一成 BN

    let newRep;
    if (badSet.includes(addr)) {
      // 恶意：减半
      newRep = rep.div(BN("2"));
    } else {
      // 诚实：+1
      newRep = rep.add(BN("1"));
    }

    const delta = newRep.sub(rep); // 可能为负数或正数或 0

    if (!delta.isZero()) {
      payees.push(addr);
      amounts.push("0"); // 不转账，只更新声誉
      repAddrs.push(addr);
      repDeltas.push(delta.toString());
    }
  }

  if (repAddrs.length === 0) {
    return;
  }

  await inc.distributeRewards(
    reqId,
    payees,
    amounts,
    repAddrs,
    repDeltas,
    { from: admin, value: 0 }
  );
}

/**
 * 打印最终 summary 表格
 */
function printSummary(label, summary) {
  console.log(`\n=== Final summary for mode: ${label} ===`);
  console.log(
    "f, total_runs, attack_success_rate, audit_trigger_rate, audit_has_decision_rate, audit_fix_rate, audit_wrong_flip_rate, audit_deadlock_rate"
  );
  const keys = Object.keys(summary)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);
  for (const f of keys) {
    const s = summary[f];
    console.log(
      [
        s.f,
        s.total_runs,
        s.attack_success_rate.toFixed(3),
        s.audit_trigger_rate.toFixed(3),
        s.audit_has_decision_rate.toFixed(3),
        s.audit_fix_rate.toFixed(3),
        s.audit_wrong_flip_rate.toFixed(3),
        s.audit_deadlock_rate.toFixed(3),
      ].join(", ")
    );
  }
}
