// scripts/test_oracle.js
// 一键测试：角色注册 + 正常请求 + 异常请求 + 审计

const NodeManager = artifacts.require("NodeManager");
const OracleCore = artifacts.require("OracleCore");
const IncentiveGovernance = artifacts.require("IncentiveGovernance");
const DisputeResolution = artifacts.require("DisputeResolution");

// helper: 模拟合约里的 keccak256(abi.encode(value, nonce, sender))
function makeCommitment(value, nonce, addr) {
  const encoded = web3.eth.abi.encodeParameters(
    ["uint256", "uint256", "address"],
    [value, nonce, addr]
  );
  return web3.utils.keccak256(encoded);
}

module.exports = async function (callback) {
  try {
    console.log("=== Oracle end-to-end test start ===");

    const accounts = await web3.eth.getAccounts();
    console.log("Accounts:", accounts);

    const nm   = await NodeManager.deployed();
    const core = await OracleCore.deployed();
    const inc  = await IncentiveGovernance.deployed();
    const dr   = await DisputeResolution.deployed();

    // 角色约定：
    const admin     = accounts[0];
    const proposer  = accounts[1];

    // 至少 7 个观察者，便于后续实验脚本获取 n>=7
    const observer1 = accounts[2];
    const observer2 = accounts[3];
    const observer3 = accounts[4];
    const observer4 = accounts[7];
    const observer5 = accounts[8];
    const observer6 = accounts[9];
    const observer7 = accounts[10];

    // 两个审计者（保持和其他脚本一致）
    const auditor1  = accounts[5];
    const auditor2  = accounts[6];

    console.log("Admin    :", admin);
    console.log("Proposer :", proposer);
    console.log(
      "Observers:",
      observer1,
      observer2,
      observer3,
      observer4,
      observer5,
      observer6,
      observer7
    );
    console.log("Auditors :", auditor1, auditor2);

    console.log("\n[1] Binding IncentiveGovernance.oracleCore & DisputeResolution.oracleCore ...");

    // 1) IncentiveGovernance 绑定 OracleCore
    const curCore = await inc.oracleCore();
    if (curCore === "0x0000000000000000000000000000000000000000") {
      console.log("  inc.oracleCore is empty, set to:", core.address);
      await inc.setOracleCore(core.address, { from: admin });
    } else if (curCore.toLowerCase() !== core.address.toLowerCase()) {
      console.log("  inc.oracleCore already set to:", curCore);
      console.log("  (if需要改绑定，请手动用 admin 调 inc.setOracleCore)");
    } else {
      console.log("  inc.oracleCore already correctly set:", curCore);
    }

    // 2) DisputeResolution 绑定 OracleCore（用真正的 owner）
    let curDRCore = "0x0000000000000000000000000000000000000000";
    try {
      if (typeof dr.getOracleCore === "function") {
        curDRCore = await dr.getOracleCore();
      } else {
        // 如果没有 getOracleCore，就假设还没绑定过
        curDRCore = "0x0000000000000000000000000000000000000000";
      }
    } catch (e) {
      console.log("  (warning) dr.getOracleCore() not available, 请确认使用的是新版 DisputeResolution");
    }

    // 读取 DisputeResolution 的 owner
    let drOwner = null;
    try {
      if (typeof dr.owner === "function") {
        drOwner = await dr.owner();
        console.log("  DisputeResolution.owner =", drOwner);
      } else {
        console.log("  (warning) DisputeResolution 没有 owner()，跳过自动绑定");
      }
    } catch (e) {
      console.log("  (warning) 读取 dr.owner() 失败，跳过自动绑定");
    }

    if (curDRCore === "0x0000000000000000000000000000000000000000") {
      if (drOwner) {
        console.log("  dr.oracleCore is empty, set to:", core.address, "from owner", drOwner);
        await dr.setOracleCore(core.address, { from: drOwner });
      } else {
        console.log("  dr.oracleCore is empty，但无法确定 owner，跳过自动绑定（需要你手动设置一次）");
      }
    } else if (curDRCore.toLowerCase() !== core.address.toLowerCase()) {
      console.log("  dr.oracleCore already set to:", curDRCore);
      console.log("  (if需要改绑定，请手动用 owner 调 dr.setOracleCore)");
    } else {
      console.log("  dr.oracleCore already correctly set:", curDRCore);
    }

    // ---------- 2. 注册节点 ----------
    console.log("\n[2] Registering nodes in NodeManager ...");

    async function ensureRegistered(addr, role, stakeEth) {
      const info = await nm.getNode(addr); // (registered, role, stake, rep)
      const registered = info[0];
      if (!registered) {
        console.log(`  Registering ${addr} as role=${role} with stake=${stakeEth} ETH`);
        await nm.register(role, {
          from: addr,
          value: web3.utils.toWei(stakeEth, "ether"),
        });
      } else {
        console.log(
          `  Already registered: ${addr}, role=${info[1].toString()}, stake=${web3.utils.fromWei(
            info[2].toString(),
            "ether"
          )} ETH`
        );
      }
    }

    // 0=PROPOSER, 1=OBSERVER, 2=AUDITOR
    await ensureRegistered(proposer, 0, "0.5");

    // 注册 7 个观察者
    await ensureRegistered(observer1, 1, "1");
    await ensureRegistered(observer2, 1, "1");
    await ensureRegistered(observer3, 1, "1");
    await ensureRegistered(observer4, 1, "1");
    await ensureRegistered(observer5, 1, "1");
    await ensureRegistered(observer6, 1, "1");
    await ensureRegistered(observer7, 1, "1");

    // 注册审计者
    await ensureRegistered(auditor1,  2, "1");
    await ensureRegistered(auditor2,  2, "1");

    // ---------- 3. 配置 NodeManager & OracleCore 参数 ----------
    console.log("\n[3] Setting NodeManager counts & OracleCore params ...");

    // NodeManager observer/auditor count（这里只是上限）
    const ownerNM = await nm.owner();
    if (ownerNM.toLowerCase() === admin.toLowerCase()) {
      // 允许最多选 10 个观察者、3 个审计者
      await nm.setCounts(10, 3, { from: admin });
      console.log("  NodeManager.setCounts(10 observers, 3 auditors) done");
    } else {
      console.log("  Skip nm.setCounts: admin is not owner, owner is", ownerNM);
    }

    // OracleCore params: minStake=1 ETH, lambda=2.5, auditThreshold=30%
    const minStakeWei = web3.utils.toWei("1", "ether");
    await core.setParams(minStakeWei, 250, 3000, { from: admin });
    console.log("  core.setParams(minStake=1 ETH, lambda=2.5, auditThreshold=30%)");

    await core.setK(3, { from: admin });
    console.log("  core.setK(3)");

    await core.setUseWeights(false, { from: admin });
    console.log("  core.setUseWeights(false)");

    // ---------- 4. Happy path：正常请求 ----------
    console.log("\n[4] Happy path: create request #1, commit/reveal/finalize ...");

    const tx1 = await core.createDataRequestEx(
      "test request #1",
      3,      // kObservers（记录用）
      250,    // lambda
      3000,   // audit ratio threshold
      false,  // hasUseWeightsOverride
      false,  // useWeightsForReq
      0,      // base1e18ForReq
      0,      // wRep1e18ForReq
      {
        from: proposer,
        value: web3.utils.toWei("1", "ether"),
      }
    );

    const evCreated1 = tx1.logs.find((l) => l.event === "RequestCreated");
    if (!evCreated1) {
      throw new Error("RequestCreated event not found for req#1");
    }
    const reqId1 = evCreated1.args.requestId.toString();
    console.log("  Request #1 created, id =", reqId1);

    const evObs1 = tx1.logs.find((l) => l.event === "ObserversSelected");
    console.log("  Observers for #1:", evObs1 ? evObs1.args.observers : "N/A");

    // 只用前三个观察者演示一次完整流程
    const v1a = 100, n1a = 1;
    const v2a = 102, n2a = 2;
    const v3a = 98,  n3a = 3;

    const c1a = makeCommitment(v1a, n1a, observer1);
    const c2a = makeCommitment(v2a, n2a, observer2);
    const c3a = makeCommitment(v3a, n3a, observer3);

    await core.commitData(reqId1, c1a, { from: observer1 });
    await core.commitData(reqId1, c2a, { from: observer2 });
    await core.commitData(reqId1, c3a, { from: observer3 });
    console.log("  Commits submitted for #1");

    await core.openReveal(reqId1, { from: proposer });
    console.log("  Reveal opened for #1");

    await core.revealData(reqId1, v1a, n1a, { from: observer1 });
    await core.revealData(reqId1, v2a, n2a, { from: observer2 });
    await core.revealData(reqId1, v3a, n3a, { from: observer3 });
    console.log("  Reveals submitted for #1");

    const txFin1 = await core.finalizeRequest(reqId1, { from: proposer });
    console.log("  Request #1 finalized");

    const result1 = await core.getRequestResult(reqId1);
    console.log(
      "  #1 consensus =", result1[0].toString(),
      "lower =", result1[1].toString(),
      "upper =", result1[2].toString()
    );

    console.log("  Withdrawable after #1:");
    const wObs1 = await inc.withdrawable(observer1);
    const wObs2 = await inc.withdrawable(observer2);
    const wObs3 = await inc.withdrawable(observer3);
    console.log("    observer1:", web3.utils.fromWei(wObs1.toString(), "ether"), "ETH");
    console.log("    observer2:", web3.utils.fromWei(wObs2.toString(), "ether"), "ETH");
    console.log("    observer3:", web3.utils.fromWei(wObs3.toString(), "ether"), "ETH");

    console.log("  Reputation after #1:");
    const rObs1 = await inc.reputation(observer1);
    const rObs2 = await inc.reputation(observer2);
    const rObs3 = await inc.reputation(observer3);
    console.log("    observer1:", rObs1.toString());
    console.log("    observer2:", rObs2.toString());
    console.log("    observer3:", rObs3.toString());

    // 领取奖励
    await inc.claim({ from: observer1 });
    await inc.claim({ from: observer2 });
    await inc.claim({ from: observer3 });
    console.log("  Observers claimed rewards for #1");

    // ---------- 5. 异常 & 审计路径（必触发） ----------
    console.log("\n[5] Anomaly path: create request #2 with outlier to trigger audit ...");

    const tx2 = await core.createDataRequestEx(
      "test request #2",
      3,
      10,     // λ=0.1，区间非常窄，三个值几乎肯定都被判为异常
      1000,   // 10% 阈值，异常比例 >= 10% 就触发审计
      false,
      false,
      0,
      0,
      {
        from: proposer,
        value: web3.utils.toWei("1", "ether"),
      }
    );

    const evCreated2 = tx2.logs.find((l) => l.event === "RequestCreated");
    if (!evCreated2) {
      throw new Error("RequestCreated event not found for req#2");
    }
    const reqId2 = evCreated2.args.requestId.toString();
    console.log("  Request #2 created, id =", reqId2);

    const evObs2 = tx2.logs.find((l) => l.event === "ObserversSelected");
    console.log("  Observers for #2:", evObs2 ? evObs2.args.observers : "N/A");

    // 这次第三个观察者上报极端异常值 9999
    const v1b = 100,  n1b = 11;
    const v2b = 102,  n2b = 12;
    const v3b = 9999, n3b = 13;

    const c1b = makeCommitment(v1b, n1b, observer1);
    const c2b = makeCommitment(v2b, n2b, observer2);
    const c3b = makeCommitment(v3b, n3b, observer3);

    await core.commitData(reqId2, c1b, { from: observer1 });
    await core.commitData(reqId2, c2b, { from: observer2 });
    await core.commitData(reqId2, c3b, { from: observer3 });
    console.log("  Commits submitted for #2");

    await core.openReveal(reqId2, { from: proposer });
    console.log("  Reveal opened for #2");

    await core.revealData(reqId2, v1b, n1b, { from: observer1 });
    await core.revealData(reqId2, v2b, n2b, { from: observer2 });
    await core.revealData(reqId2, v3b, n3b, { from: observer3 });
    console.log("  Reveals submitted for #2");

    const txFin2 = await core.finalizeRequest(reqId2, { from: proposer });
    console.log("  Request #2 finalized");

    const result2 = await core.getRequestResult(reqId2);
    console.log(
      "  #2 consensus =", result2[0].toString(),
      "lower =", result2[1].toString(),
      "upper =", result2[2].toString()
    );

    // 打印异常统计事件（如果有）
    const anomalyLog = txFin2.logs.find((l) => l.event === "AnomalyStats");
    if (anomalyLog) {
      const a = anomalyLog.args;
      console.log(
        "  AnomalyStats:",
        "anomalies =", a.anomalies.toString(),
        "total =", a.total.toString(),
        "ratioTimes100 =", a.ratioTimes100.toString()
      );
    } else {
      console.log("  No AnomalyStats event found for #2");
    }

    // 检查是否触发审计
    const disputedVal = await dr.getDisputedValue(reqId2);
    console.log("  Disputed value stored in DisputeResolution for #2 =", disputedVal.toString());

    if (disputedVal.toString() === "0") {
      console.log("  => Audit might not have been initiated (异常比例可能没达到阈值或参数不同)");
    } else {
      console.log("  => Audit has been initiated for request #2, now casting votes...");

      // 假设审计委员会是 auditor1 & auditor2 且都支持原结果
      await dr.submitAuditVote(reqId2, true, { from: auditor1 });
      await dr.submitAuditVote(reqId2, true, { from: auditor2 });
      console.log("  Audit votes submitted (both support original)");

      const txClose = await dr.close(reqId2, { from: admin });
      console.log("  Audit closed for request #2");

      const closedLog = txClose.logs.find((l) => l.event === "AuditClosed");
      if (closedLog) {
        const c = closedLog.args;
        console.log(
          "  AuditClosed:",
          "unanimous =", c.unanimous,
          "supportOriginal =", c.supportOriginal
        );
      } else {
        console.log("  No AuditClosed event found");
      }
    }

    console.log("\n=== Oracle end-to-end test finished ===");
    return callback();
  } catch (err) {
    console.error("Test script error:", err);
    return callback(err);
  }
};

