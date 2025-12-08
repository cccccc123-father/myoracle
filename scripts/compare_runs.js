// scripts/compare_runs.js
// 用法：
// truffle exec scripts/compare_runs.js --network development \
//   --a /path/to/runs-1763384607789.jsonl --b /path/to/runs-1763384840590.jsonl
//
// 产物：控制台 console.table 对比 + exp/compare-<ts>-*.csv 摘要表

const fs = require("fs");
const path = require("path");
const minimist = require("minimist");

function loadJsonl(p) {
  const rows = [];
  const txt = fs.readFileSync(p, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) {}
  }
  return rows.map(r => ({ _file: path.basename(p), ...r }));
}

function pct(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(q * (s.length - 1)));
  return s[idx];
}

function summarize(rows) {
  const ok = rows.filter(r => r.status === "ok");
  const fails = rows.filter(r => r.status !== "ok");

  const mae = ok.length
    ? ok.map(r => Math.abs(Number(r.consensus) - Number(r.truth)))
        .reduce((a, b) => a + b, 0) / ok.length
    : 0;

  const gas = ok.map(r => Number((r.gas || {}).total || 0)).filter(Number.isFinite);
  const reveals = ok.map(r => Number(r.reveals || 0));
  const epsOKRate = ok.length ? ok.filter(r => r.epsOK === true).length / ok.length : 0;

  return {
    runs_ok: ok.length,
    runs_fail: fails.length,
    epsOK_rate: +epsOKRate.toFixed(4),
    mae: +mae.toFixed(2),
    gas_mean: gas.length ? Math.round(gas.reduce((a, b) => a + b, 0) / gas.length) : 0,
    gas_p50: pct(gas, 0.50),
    gas_p95: pct(gas, 0.95),
    gas_p99: pct(gas, 0.99),
    reveals_mean: reveals.length
      ? +(reveals.reduce((a, b) => a + b, 0) / reveals.length).toFixed(2)
      : 0,
  };
}

function groupBy(arr, keys) {
  const m = new Map();
  for (const r of arr) {
    const k = keys.map(k => String(r[k])).join("|");
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([k, rows]) => ({ key: k, rows }));
}

function toCSV(rows) {
  if (!rows.length) return "";
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const header = keys.join(",");
  const body = rows.map(r =>
    keys.map(k => JSON.stringify(r[k] ?? "")).join(",")
  ).join("\n");
  return header + "\n" + body + "\n";
}

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function nowTs() { return Date.now(); }

module.exports = async function (callback) {
  const args = minimist(process.argv.slice(2));
  try {
    const A = args.a, B = args.b;
    if (!A || !B) {
      console.error("Usage:\n  truffle exec scripts/compare_runs.js --network development --a <fileA.jsonl> --b <fileB.jsonl>");
      return;
    }

    const rowsA = loadJsonl(A);
    const rowsB = loadJsonl(B);
    const merged = rowsA.concat(rowsB).map(r => {
      if (r.status === "ok") {
        const p = r.params || {};
        return {
          ...r,
          file: r._file,
          lambda: Number(p.lambda),
          auditThr: Number(p.auditThr),
          K: Number(p.K),
          weighted: String(p.weighted || "off"),
          abs_err: Math.abs(Number(r.consensus) - Number(r.truth)),
          gas_total: Number((r.gas || {}).total || 0),
        };
      } else {
        return { ...r, file: r._file };
      }
    });

    const ok = merged.filter(r => r.status === "ok");
    const byFile = groupBy(ok, ["file"]).map(g => ({ file: g.rows[0].file, ...summarize(g.rows) }));
    const byFileWeighted = groupBy(ok, ["file", "weighted"]).map(g => {
      const [file, weighted] = g.key.split("|");
      return { file, weighted, ...summarize(g.rows) };
    });
    const byFileLambda = groupBy(ok, ["file", "lambda"]).map(g => {
      const [file, lambda] = g.key.split("|");
      return { file, lambda: Number(lambda), ...summarize(g.rows) };
    });

    const fails = merged.filter(r => r.status !== "ok");
    const failAgg = groupBy(fails, ["file", "phase", "error"]).map(g => {
      const [file, phase, error] = g.key.split("|");
      return { file, phase, error, count: g.rows.length };
    });

    // 控制台展示
    console.log("=== Summary by file ===");
    console.table(byFile);
    console.log("\n=== By file & weighted ===");
    console.table(byFileWeighted.sort((a, b) => (a.file + a.weighted).localeCompare(b.file + b.weighted)));
    console.log("\n=== By file & lambda ===");
    console.table(byFileLambda.sort((a, b) => (a.file + a.lambda).localeCompare(b.file + b.lambda)));
    console.log("\n=== Failures (phase/error) ===");
    if (failAgg.length) console.table(failAgg);
    else console.log("None");

    // 写 CSV
    ensureDir("exp");
    const ts = nowTs();
    fs.writeFileSync(`exp/compare-${ts}-byfile.csv`, toCSV(byFile));
    fs.writeFileSync(`exp/compare-${ts}-byfile-weighted.csv`, toCSV(byFileWeighted));
    fs.writeFileSync(`exp/compare-${ts}-byfile-lambda.csv`, toCSV(byFileLambda));
    fs.writeFileSync(`exp/compare-${ts}-failures.csv`, toCSV(failAgg));
    console.log(`\nCSV written under exp/compare-${ts}-*.csv`);

  } catch (e) {
    console.error(e);
  } finally {
    callback();
  }
};

