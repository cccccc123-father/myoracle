// scripts/exp_run.js
// 运行示例：
// truffle exec scripts/exp_run.js --network development \
//   --runs 50 --k 8 --reward 0.3 \
//   --lambdas 150,250,350 \
//   --thresholds 3000,6000,9000 \
//   --epsilon 0.01 --outliers 0.0,0.2,0.4 --delta 0.1 \
//   --weighted on
//
// 可选：
//   --autotopup on|off        自动补余额（默认 on）
//   --minDeploy 1             部署者最低余额阈值（ETH，默认 1）
//   --minObserver 0.2         观察者最低余额阈值（ETH，默认 0.2）
//
// 日志输出：exp/last_runs.jsonl 与 exp/runs-<timestamp>.jsonl

const fs = require("fs");
const path = require("path");
const minimist = require("minimist");

const OracleCore = artifacts.require("OracleCore");
const NodeManager = artifacts.require("NodeManager");
const IncentiveGovernance = artifacts.require("IncentiveGovernance");
const DisputeResolution = artifacts.require("DisputeResolution");

// -------- 工具函数 --------
function parseList(str, mapFn) {
  if (!str) return [];
  return String(str).split(",").map(s => (mapFn ? mapFn(s.trim()) : s.trim()));
}
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function nowTs() { return Date.now(); }
function toWei(x) { return web3.utils.toWei(String(x)); }
function BN(x) { return web3.utils.toBN(String(x)); }
async function getBalanceBN(addr) {
  const b = await web3.eth.getBalance(addr);
  return BN(b);
}
function writeLine(writers, obj) {
  const line = JSON.stringify(obj);
  for (const w of writers) fs.appendFileSync(w, line + "\n");
}

async function resolveInstance(Artifact, name, cliFlag, args) {
  if (args[cliFlag]) return await Artifact.at(args[cliFlag]);
  try { return await Artifact.deployed(); } catch (_) {}
  try {
    const m = JSON.parse(fs.readFileSync("deployment-addresses.json", "utf8"));
    if (m && m[name]) return await Artifact.at(m[name]);
  } catch (_) {}
  throw new Error(
    `${name} has not been deployed on this network. ` +
    `Run 'truffle migrate --reset --network ${args.network || "development"}' ` +
    `or pass --${cliFlag} <address>.`
  );
}

// 选余额最多的账户（可排除集合）
async function getRichestAccount(addrs, excludeSet = new Set()) {
  let best = null, bestBal = BN(0);
  for (const a of addrs) {
    if (excludeSet.has(a)) continue;
    const bal = await getBalanceBN(a);
    if (bal.gt(bestBal)) { bestBal = bal; best = a; }
  }
  return best;
}

// 自动补余额：若 addr < minWei，则由 funder 转过去(差额+buffer)
async function ensureBalance(addr, minWeiBN, funder, writers, tag) {
  const bal = await getBalanceBN(addr);
  if (bal.gte(minWeiBN)) return false;
  const buffer = BN(toWei("0.1")); // 额外缓冲 0.1 ETH
  const need = minWeiBN.sub(bal).add(buffer);
  try {
    await web3.eth.sendTransaction({ from: funder, to: addr, value: need });
    writeLine(writers, { status: "topup", who: addr, from: funder, valueWei: need.toString(), tag });
    return true;
  } catch (e) {
    writeLine(writers, { status: "topup_failed", who: addr, from: funder, needWei: need.toString(), error: e.message, tag });
    throw e;
  }
}

// ---- 观察者池：自动注册 + setK ----
// 如 NodeManager.register 签名不同，请按你的合约调整这里
async function ensureObservers(core, node, accs, wantK, stakeEth = "1") {
  const stakeWei = toWei(stakeEth);
  let newly = 0;
  for (let i = 1; i <= wantK && i < accs.length; i++) {
    try {
      await node.register(1, { from: accs[i], value: stakeWei });
      newly++;
    } catch (_) { /* 已注册等，忽略 */ }
  }
  try { await core.setK(wantK, { from: accs[0] }); } catch (_) { /* 旧版本可能没有 setK */ }
  return newly;
}

// 与合约一致的 commit：keccak256(abi.encode(value, nonce, sender))
function makeCommit(value, nonce, addr) {
  const encoded = web3.eth.abi.encodeParameters(
    ["uint256", "uint256", "address"],
    [String(value), String(nonce), addr]
  );
  return web3.utils.keccak256(encoded);
}

// 生成一次观测（真值/异常/噪声）
function genObservation(truth, outlierRate, delta) {
  const nonce = Math.floor(Math.random() * 1e9) + 1;
  const isOut = Math.random() < outlierRate;
  if (isOut) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const val = Math.max(0, Math.floor(truth * (1 + sign * delta)));
    return { value: val, nonce, outlier: true };
  } else {
    const noise = (Math.random() - 0.5) * 0.008; // ±0.4%
    const val = Math.max(0, Math.floor(truth * (1 + noise)));
    return { value: val, nonce, outlier: false };
  }
}

module.exports = async function (callback) {
  const args = minimist(process.argv.slice(2));

  const RUNS = parseInt(args.runs || "10", 10);
  const K = parseInt(args.k || "3", 10);
  const rewardEth = parseFloat(args.reward || "0.3");

  const lambdas = parseList(args.lambdas, s => parseInt(s || "250", 10));        // ×100
  const thresholds = parseList(args.thresholds, s => parseInt(s || "6000", 10)); // ×100（‰‰）
  const eps = parseFloat(args.epsilon || "0.01");
  const outlierRates = parseList(args.outliers, parseFloat);
  const delta = parseFloat(args.delta || "0.1");
  const weighted = String(args.weighted || "off").toLowerCase(); // on/off/both（此脚本里 on/off 二选一，both 请分两次跑）

  const autoTopUp = String(args.autotopup || "on").toLowerCase() !== "off";
  const minDeployETH = parseFloat(args.minDeploy || "1");
  const minObserverETH = parseFloat(args.minObserver || "0.2");

  ensureDir("exp");
  const outA = path.resolve(`exp/runs-${nowTs()}.jsonl`);
  const outB = path.resolve(`exp/last_runs.jsonl`);
  const writers = [outA, outB];

  try {
    const core = await resolveInstance(OracleCore, "OracleCore", "core", args);
    const inc  = await resolveInstance(IncentiveGovernance, "IncentiveGovernance", "inc", args);
    const node = await resolveInstance(NodeManager, "NodeManager", "node", args);
    let dr = null;
    try { dr = await resolveInstance(DisputeResolution, "DisputeResolution", "dr", args); } catch (_) {}

    const accs = await web3.eth.getAccounts();
    const deployer = accs[0];

    // 选择资助者（尽量与 deployer 不同）
    const funder = await getRichestAccount(accs, new Set([deployer])) || deployer;

    // “接线”
    try { await inc.setOracleCore(core.address, { from: deployer }); } catch (_) {}
    try { if (dr && dr.setCore) await dr.setCore(core.address, { from: deployer }); } catch (_) {}

    // 加权参数
    if (weighted === "off") {
      try { await core.setWeightParams(BN("1000000000000000000"), BN("0"), { from: deployer }); } catch (_) {}
    } else {
      try { await core.setWeightParams(BN("1000000000000000000"), BN("1000000000000000000"), { from: deployer }); } catch (_) {}
    }

    // 自动注册观察者 + setK
    const fixed = await ensureObservers(core, node, accs, K, "1");
    if (fixed) console.log("auto-registered observers:", fixed);

    // 固定真值
    const TRUTH = 10000;

    for (const lam of lambdas) {
      for (const thr of thresholds) {
        for (const OR of outlierRates) {
          for (let r = 1; r <= RUNS; r++) {
            const runId = `${lam}-${thr}-${OR}-#${r}`;
            let gasTotal = 0;

            try {
              // 每轮链上参数
              try { await core.setParams(0, lam, thr, { from: deployer }); } catch (_) {}
              try { await core.setK(K, { from: deployer }); } catch (_) {}

              // --- 自动补部署者余额（create 需要 reward + gas） ---
              if (autoTopUp) {
                const minWei = BN(toWei(Math.max(minDeployETH, rewardEth + 0.05)));
                await ensureBalance(deployer, minWei, funder, writers, `pre-create:${runId}`);
              }

              // 1) create
              const beforeBlk = await web3.eth.getBlockNumber();
              let txCreate;
              try {
                txCreate = await core.createDataRequest(`exp:${runId}`, {
                  from: deployer,
                  value: toWei(rewardEth),
                });
                gasTotal += (txCreate.receipt && txCreate.receipt.gasUsed) || 0;
              } catch (e) {
                writeLine(writers, { status: "failed", phase: "create", run: runId, error: e.reason || e.message });
                continue;
              }

              const ridBN = await core.nextRequestId();
              const rid = Number(ridBN.toString()) - 1;

              // 读取选中观察者
              const ev = await core.getPastEvents("ObserversSelected", {
                fromBlock: beforeBlk + 1,
                toBlock: "latest",
                filter: { requestId: rid },
              });
              const observers = (ev.length && ev[ev.length - 1].args && ev[ev.length - 1].args.observers) ? ev[ev.length - 1].args.observers : [];
              if (!observers.length) {
                writeLine(writers, { status: "failed", phase: "create", run: runId, error: "no observers selected" });
                continue;
              }

              // --- 自动补观察者余额（commit/reveal） ---
              if (autoTopUp) {
                const minObsWei = BN(toWei(minObserverETH));
                for (const a of observers) {
                  await ensureBalance(a, minObsWei, funder, writers, `pre-commit:${runId}`);
                }
              }

              // 2) commit
              const perObserver = [];
              for (const a of observers) {
                const ob = genObservation(TRUTH, OR, delta);
                const cmt = makeCommit(ob.value, ob.nonce, a);
                try {
                  const tx = await core.commitData(rid, cmt, { from: a });
                  gasTotal += (tx.receipt && tx.receipt.gasUsed) || 0;
                  perObserver.push({ addr: a, val: ob.value, nonce: ob.nonce, outlier: ob.outlier });
                } catch (e) {
                  writeLine(writers, { status: "failed", phase: "commit", run: runId, observer: a, error: e.reason || e.message });
                  throw e;
                }
              }

              // 3) openReveal（由请求者）
              try {
                const tx = await core.openReveal(rid, { from: deployer });
                gasTotal += (tx.receipt && tx.receipt.gasUsed) || 0;
              } catch (e) {
                writeLine(writers, { status: "failed", phase: "openReveal", run: runId, error: e.reason || e.message });
                throw e;
              }

              // 4) reveal
              for (const ob of perObserver) {
                try {
                  const tx = await core.revealData(rid, ob.val, ob.nonce, { from: ob.addr });
                  gasTotal += (tx.receipt && tx.receipt.gasUsed) || 0;
                } catch (e) {
                  writeLine(writers, { status: "failed", phase: "reveal", run: runId, observer: ob.addr, error: e.reason || e.message });
                  throw e;
                }
              }

              // 5) finalize（修复：先拿 res，再取命名字段/下标，避免“中间值不可迭代”）
              try {
                const txFin = await core.finalizeRequest(rid, { from: deployer });
                gasTotal += (txFin.receipt && txFin.receipt.gasUsed) || 0;

                const res = await core.getRequestResult(rid);
                const consBN = (res.consensus !== undefined) ? res.consensus : res[0];
                const lowBN  = (res.lower     !== undefined) ? res.lower     : res[1];
                const upBN   = (res.upper     !== undefined) ? res.upper     : res[2];

                const consensus = Number(consBN.toString());
                const lower     = Number(lowBN.toString());
                const upper     = Number(upBN.toString());
                const reveals   = perObserver.length;
                const epsOK     = Math.abs(consensus - TRUTH) <= Math.floor(TRUTH * eps);

                writeLine(writers, {
                  status: "ok",
                  run: runId,
                  rid,
                  params: { lambda: lam, auditThr: thr, K, weighted },
                  truth: TRUTH,
                  consensus, lower, upper,
                  reveals,
                  eps, epsOK,
                  gas: { total: gasTotal }
                });
              } catch (e) {
                writeLine(writers, { status: "failed", phase: "finalize", run: runId, error: e.reason || e.message || String(e) });
              }

            } catch (_) {
              // 已记录失败
            }
          }
        }
      }
    }

    console.log("=== EXP DONE ===");
    console.log("write ->", outA);

  } catch (err) {
    console.error(err);
  } finally {
    callback();
  }
};

