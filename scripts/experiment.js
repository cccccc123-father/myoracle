const fs = require("fs");
const path = require("path");

const OracleCore = artifacts.require("OracleCore");
const IncentiveGovernance = artifacts.require("IncentiveGovernance");
const NodeManager = artifacts.require("NodeManager");

function cmt(web3, v, n, a) {
  return web3.utils.soliditySha3(
    {t:'uint256',v:v},{t:'uint256',v:n},{t:'address',v:a}
  );
}
function rnd(mu, sigma){ // 简单高斯
  let u=0,v=0; while(u===0)u=Math.random(); while(v===0)v=Math.random();
  return Math.round(mu + sigma * Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v));
}

module.exports = async function(callback){
  try{
    const core = await OracleCore.deployed();
    const inc  = await IncentiveGovernance.deployed();
    const node = await NodeManager.deployed();
    const accs = await web3.eth.getAccounts();

    // 注册若干观察者（已注册会忽略错误继续）
    for(let i=1;i<=10;i++){
      try{ await node.register(1,{from:accs[i], value:web3.utils.toWei("1")}); }catch(e){}
    }

    // 实验参数（可改）
    const rounds = 20;           // 轮数
    const k = 5;                 // 每轮参与者
    const mu = 10000, sigma = 50;// 观测分布
    const rewardEth = "0.5";

    // 不触发审计，先稳定跑数据
    await core.setParams(0, 250, 10000);   // λ=2.5σ, 审计阈值=100%
    await core.setWeightParams("1000000000000000000","1000000000000000000"); // base=1, wRep=1

    // 基线：记录 withdrawable 初值，用差分得到“本轮分配额”
    const baseW = {};
    for (let i=1;i<=10;i++){
      baseW[accs[i]] = (await inc.withdrawable(accs[i])).toString();
    }

    const results = [];
    for (let r=0;r<rounds;r++){
      const sel = accs.slice(1, 1+k);
      const vals = Array.from({length:k},()=>rnd(mu,sigma));
      const nonces = sel.map((_,i)=> 1000 + r*10 + i);

      await core.createDataRequest(`exp-${r}`, {from: accs[0], value: web3.utils.toWei(rewardEth)});
      const rid = (await core.nextRequestId()).toNumber() - 1;

      for (let i=0;i<k;i++){
        await core.commitData(rid, cmt(web3, vals[i], nonces[i], sel[i]), {from: sel[i]});
      }
      await core.openReveal(rid, {from: accs[0]});
      for (let i=0;i<k;i++){
        await core.revealData(rid, vals[i], nonces[i], {from: sel[i]});
      }
      await core.finalizeRequest(rid, {from: accs[0]});

      const res = await core.getRequestResult(rid);
      const consensus = res[0].toString(), lower = res[1].toString(), upper = res[2].toString();

      // 差分得到本轮各参与者的分配额
      const payouts = {};
      for (let i=0;i<k;i++){
        const now = (await inc.withdrawable(sel[i])).toString();
        const diff = web3.utils.toBN(now).sub(web3.utils.toBN(baseW[sel[i]] || "0"));
        payouts[sel[i]] = diff.toString();
        baseW[sel[i]] = now; // 更新基线
      }

      const reput = {};
      for (let i=0;i<k;i++){
        reput[sel[i]] = (await inc.reputation(sel[i])).toString();
      }

      results.push({ rid, participants: sel, values: vals, consensus, lower, upper, payoutsWei: payouts, reputationAfter: reput });
    }

    const outDir = path.join(__dirname, "..", "results");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const fname = path.join(outDir, `run-${Date.now()}.json`);
    fs.writeFileSync(fname, JSON.stringify(results, null, 2));
    console.log(">> wrote", fname);
  }catch(e){ console.error(e); }
  callback();
};

