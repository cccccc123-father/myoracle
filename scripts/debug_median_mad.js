const OracleCore = artifacts.require("OracleCore");
const IIncentiveGovernance = artifacts.require("IncentiveGovernance");
const INodeManager = artifacts.require("NodeManager");

module.exports = async function (callback) {
  try {
    const core = await OracleCore.deployed();
    const nm   = await INodeManager.deployed();
    const inc  = await IIncentiveGovernance.deployed();

    const accounts = await web3.eth.getAccounts();
    const admin    = accounts[0];

    console.log("Admin:", admin);

    // 1) 设置参数：lambda=250, auditThr 超大防止乱触发
    await core.setParams(0, 250, 10000, { from: admin });

    // 2) 选一轮 request，手工喂值：5 个 honest ~ 100，2 个 130
    const trueVal    = 100;
    const attackVal  = 130;
    const nObservers = 7;

    // 确保 NodeManager 至少有 7 个节点 & selectObservers 会返回 7 个，
    // 这一部分你已有 test_oracle.js 做过，我们假设没问题。

    const query = "debug-median-mad";

    // 用扩展接口方便传参（如果你用的是 createDataRequestEx）：
    const reqId = (await core.createDataRequestEx(
      query,
      nObservers,        // _kObservers
      250,               // _lambdaTimes100
      10000,             // _auditAnomalyRatioTimes100
      false, false,      // 不覆盖 useWeights
      0, 0,              // 用全局 base / wRep
      { from: admin, value: 0 }
    )).logs[0].args.requestId || 0;

    // 取回这一轮的 observers
    const req = await core.requests(reqId); // 如果没公开 struct，就用事件里的 committee / observers

    // 这里你可以偷懒：直接复用 exp_attack_fraction_with_audit.js 里那段
    // “commit + reveal + finalize”的流程，只修改每个 observer 的取值：
    //   前 5 个：trueVal ±1 噪声
    //   后 2 个：attackVal
    //
    // 最后：
    // const ret = await core.getRequestResult(reqId);
    // console.log("consensus, lower, upper =", ret);

  } catch (err) {
    console.error(err);
  }

  callback();
};

