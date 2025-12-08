// scripts/exp_summarize.js
// 读取 exp/last_runs.jsonl（或 --file 指定的 jsonl）并输出 4 个 CSV：
// 1) summary_accuracy.csv
// 2) summary_gas.csv
// 3) summary_audit_curve.csv
// 4) summary_distrib.csv
//
// 健壮性：
// - 跳过 status!="ok" 的行
// - 所有指标仅在有限数值上统计
// - 每个 CSV 都带上有效样本数 n_ok 与失败样本数 n_failed

const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, {recursive:true}); }

function isFiniteNumber(x) { return Number.isFinite(x); }

// 线性插值分位数（含小样本时的合理插值）
function percentile(arr, q) {
  const a = arr.filter(isFiniteNumber).slice().sort((x,y)=>x-y);
  const n = a.length;
  if (!n) return '';
  if (q <= 0) return a[0];
  if (q >= 1) return a[n-1];
  const idx = (n - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (hi === lo) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
function mean(arr) {
  const a = arr.filter(isFiniteNumber);
  if (!a.length) return '';
  return a.reduce((s,x)=>s+x,0)/a.length;
}
function boolRate(arr) {
  const a = arr.filter(x => x === true || x === false);
  if (!a.length) return '';
  return a.reduce((s,x)=>s+(x?1:0),0)/a.length;
}
function readJSONL(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split('\n').map(s=>s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      out.push(obj);
    } catch (e) {
      // 跳过坏行
    }
  }
  return out;
}
function groupKey(r) {
  return `${r.lambdaTimes100}|${r.auditThresholdTimes100}|${r.outlierRate}`;
}
function groupLabel(key) {
  const [lambdaTimes100, auditThresholdTimes100, outlierRate] = key.split('|').map(x=>Number(x));
  return { lambdaTimes100, auditThresholdTimes100, outlierRate };
}

module.exports = async function (cb) {
  try {
    const file = arg('file', path.join(process.cwd(), 'exp', 'last_runs.jsonl'));
    const outDir = path.join(process.cwd(), 'exp');
    ensureDir(outDir);

    if (!fs.existsSync(file)) {
      throw new Error(`File not found: ${file}`);
    }

    const all = readJSONL(file);
    const failed = all.filter(r => !r || r.status !== 'ok');
    const ok = all.filter(r => r && r.status === 'ok');

    // 分组
    const byKey = new Map();
    for (const r of ok) {
      const key = groupKey(r);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }

    // ---- 1) accuracy ----
    const rowsAcc = [];
    rowsAcc.push([
      'lambdaTimes100','auditThresholdTimes100','outlierRate',
      'n_ok','n_failed',
      'acc_consensus','acc_mean','acc_median','acc_tmean10',
      'err_consensus_p50','err_consensus_p95','err_consensus_p99',
      'err_mean_p50','err_mean_p95','err_mean_p99',
      'err_median_p50','err_median_p95','err_median_p99',
      'err_tmean10_p50','err_tmean10_p95','err_tmean10_p99'
    ].join(','));

    for (const [key, runs] of byKey.entries()) {
      const label = groupLabel(key);
      const kFailed = failed.filter(fr => groupKey(fr||{}) === key).length;

      const acc_consensus = boolRate(runs.map(r=>r.acc_consensus));
      const acc_mean      = boolRate(runs.map(r=>r.acc_mean));
      const acc_median    = boolRate(runs.map(r=>r.acc_median));
      const acc_tmean10   = boolRate(runs.map(r=>r.acc_tmean10));

      const err_cons = runs.map(r=>r.err_consensus).filter(isFiniteNumber);
      const err_mean = runs.map(r=>r.err_mean).filter(isFiniteNumber);
      const err_med  = runs.map(r=>r.err_median).filter(isFiniteNumber);
      const err_tm   = runs.map(r=>r.err_tmean10).filter(isFiniteNumber);

      rowsAcc.push([
        label.lambdaTimes100,
        label.auditThresholdTimes100,
        label.outlierRate,
        runs.length,
        kFailed,
        acc_consensus, acc_mean, acc_median, acc_tmean10,
        percentile(err_cons,0.5), percentile(err_cons,0.95), percentile(err_cons,0.99),
        percentile(err_mean,0.5), percentile(err_mean,0.95), percentile(err_mean,0.99),
        percentile(err_med, 0.5), percentile(err_med, 0.95), percentile(err_med, 0.99),
        percentile(err_tm,  0.5), percentile(err_tm,  0.95), percentile(err_tm,  0.99)
      ].join(','));
    }
    fs.writeFileSync(path.join(outDir,'summary_accuracy.csv'), rowsAcc.join('\n'));

    // ---- 2) gas ----
    const rowsGas = [];
    rowsGas.push([
      'lambdaTimes100','auditThresholdTimes100','outlierRate',
      'n_ok','n_failed',
      'gas_create_mean','gas_commit_mean','gas_reveal_mean','gas_finalize_mean',
      'gas_total_p50','gas_total_p95','gas_total_p99','gas_total_mean'
    ].join(','));

    for (const [key, runs] of byKey.entries()) {
      const label = groupLabel(key);
      const kFailed = failed.filter(fr => groupKey(fr||{}) === key).length;

      const createArr   = runs.map(r=>r.gas && r.gas.create).filter(isFiniteNumber);
      const commitArr   = runs.map(r=>r.gas && r.gas.commit).filter(isFiniteNumber);
      const revealArr   = runs.map(r=>r.gas && r.gas.reveal).filter(isFiniteNumber);
      const finalizeArr = runs.map(r=>r.gas && r.gas.finalize).filter(isFiniteNumber);
      const totalArr    = runs.map(r=>r.gas && r.gas.total).filter(isFiniteNumber);

      rowsGas.push([
        label.lambdaTimes100,
        label.auditThresholdTimes100,
        label.outlierRate,
        runs.length,
        kFailed,
        mean(createArr), mean(commitArr), mean(revealArr), mean(finalizeArr),
        percentile(totalArr,0.5), percentile(totalArr,0.95), percentile(totalArr,0.99), mean(totalArr)
      ].join(','));
    }
    fs.writeFileSync(path.join(outDir,'summary_gas.csv'), rowsGas.join('\n'));

    // ---- 3) audit curve（基于 AnomalyStats；若合约内接通了自动审计可直接改为审计事件） ----
    const rowsAudit = [];
    rowsAudit.push([
      'lambdaTimes100','auditThresholdTimes100','outlierRate',
      'n_ok','n_failed',
      'trigger_rate_by_threshold', // 以 anomalyRatioTimes100 >= auditThresholdTimes100 判定触发
      'anomaly_ratio_p50','anomaly_ratio_p95','anomaly_ratio_p99','anomaly_ratio_mean'
    ].join(','));

    for (const [key, runs] of byKey.entries()) {
      const label = groupLabel(key);
      const kFailed = failed.filter(fr => groupKey(fr||{}) === key).length;

      const ratios = runs.map(r=>r.anomalyRatioTimes100).filter(isFiniteNumber);
      const trigBools = runs.map(r=>{
        if (!isFiniteNumber(r.anomalyRatioTimes100)) return null;
        return r.anomalyRatioTimes100 >= label.auditThresholdTimes100;
      }).filter(v => v === true || v === false);

      rowsAudit.push([
        label.lambdaTimes100,
        label.auditThresholdTimes100,
        label.outlierRate,
        runs.length,
        kFailed,
        boolRate(trigBools),
        percentile(ratios,0.5), percentile(ratios,0.95), percentile(ratios,0.99), mean(ratios)
      ].join(','));
    }
    fs.writeFileSync(path.join(outDir,'summary_audit_curve.csv'), rowsAudit.join('\n'));

    // ---- 4) distrib（揭示数量、区间宽度、共识的简单分布） ----
    const rowsDist = [];
    rowsDist.push([
      'lambdaTimes100','auditThresholdTimes100','outlierRate',
      'n_ok','n_failed',
      'reveals_mean','reveals_p50',
      'interval_width_mean','interval_width_p50',
      'consensus_mean','consensus_p50'
    ].join(','));

    for (const [key, runs] of byKey.entries()) {
      const label = groupLabel(key);
      const kFailed = failed.filter(fr => groupKey(fr||{}) === key).length;

      const revealsArr  = runs.map(r=>r.reveals).filter(isFiniteNumber);
      const widthArr    = runs.map(r=> (isFiniteNumber(r.upper) && isFiniteNumber(r.lower)) ? (r.upper - r.lower) : NaN ).filter(isFiniteNumber);
      const consensusArr= runs.map(r=>r.consensus).filter(isFiniteNumber);

      rowsDist.push([
        label.lambdaTimes100,
        label.auditThresholdTimes100,
        label.outlierRate,
        runs.length,
        kFailed,
        mean(revealsArr), percentile(revealsArr,0.5),
        mean(widthArr),   percentile(widthArr,0.5),
        mean(consensusArr), percentile(consensusArr,0.5)
      ].join(','));
    }
    fs.writeFileSync(path.join(outDir,'summary_distrib.csv'), rowsDist.join('\n'));

    console.log('Done:');
    console.log(' - exp/summary_accuracy.csv');
    console.log(' - exp/summary_gas.csv');
    console.log(' - exp/summary_audit_curve.csv');
    console.log(' - exp/summary_distrib.csv');
    cb();
  } catch (err) {
    console.error(err);
    cb(err);
  }
};

