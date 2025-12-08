#!/usr/bin/env bash
set -euo pipefail

# ==============================
# Ubuntu 22.x 项目环境初始化脚本
# 作用：安装系统依赖、Node.js + npm、Truffle、Ganache、Python 虚拟环境、
#      并安装项目 npm 依赖
# 使用：chmod +x setup.sh && ./setup.sh
# ==============================

echo ">>> [0/7] 更新 apt 源"
sudo apt-get update -y

echo ">>> [1/7] 安装基础工具与构建链路"
sudo apt-get install -y \
  git curl ca-certificates build-essential \
  python3 python3-venv python3-pip

echo ">>> [2/7] 通过 NodeSource 用 apt 安装 Node.js 20.x（含 npm）"
# 使用 apt（但先添加 NodeSource 源，避免 Ubuntu 源中 Node 版本过旧）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo ">>> [3/7] 校验 Node/npm 版本"
node -v
npm -v

echo ">>> [4/7] 全局安装 Truffle 与 Ganache（本地链）"
sudo npm install -g truffle ganache

echo ">>> [5/7] 创建并激活 Python 虚拟环境（可用于分析脚本/画图等）"
# 若你不需要 Python，可注释本段
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
# 仅在当前脚本中激活，方便后续 pip 安装
source .venv/bin/activate || true
python -V
pip -V

echo ">>> [6/7] 安装项目 npm 依赖（在项目根目录执行）"
# 若你的项目没有 package.json，会提示忽略
if [ -f package.json ]; then
  # 优先使用 package-lock 保证可重复安装
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
else
  echo "注意：未检测到 package.json，跳过 npm 依赖安装"
fi

echo ">>> [7/7]（可选）安装 Python 依赖"
# 若有 requirements.txt 就安装（可选）
if [ -f requirements.txt ]; then
  pip install -r requirements.txt
else
  echo "未检测到 requirements.txt，跳过 pip 安装"
fi

cat <<'TIP'

========================================
✅ 环境安装完成。后续常用命令参考：

# 1) 启动本地链（后台运行，默认 8545）
nohup ganache --chain.networkId 1337 --wallet.totalAccounts 20 --wallet.defaultBalance 100 -p 8545 \
  > /tmp/ganache.log 2>&1 &

# 2) 编译与部署（确保 truffle-config.js 的 development 指向本地 8545）
truffle compile
truffle migrate --reset --network development

# 3) 进入 Truffle 控制台
truffle console --network development

# 4) 运行你的实验脚本（示例）
#   注意：先确保 ganache 已启动且合约已部署成功
#   参数按你的项目脚本说明调整
truffle exec scripts/exp_run.js --network development \
  --runs 50 --k 8 --reward 0.3 \
  --lambdas 150,250,350 \
  --thresholds 3000,6000,9000 \
  --epsilon 0.01 --outliers 0.0,0.2,0.4 --delta 0.1 \
  --weighted off

# 5) 如果切到新的 shell，需要再次激活 Python venv（若使用）
source .venv/bin/activate

日志：
- Ganache 日志：/tmp/ganache.log
========================================
TIP
truffle exec scripts/test_oracle.js --network development

