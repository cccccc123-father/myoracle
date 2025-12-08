// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/INodeManager.sol";
import "./interfaces/IIncentiveGovernance.sol";
import "./interfaces/IDisputeResolution.sol";

/// @title OracleCore — 可切换“加权/非加权聚合”，支持“请求级参数传参”，使用 median+MAD 预处理 + 加权均值
contract OracleCore {
    // ---- 外部模块 ----
    INodeManager public nodeManager;
    IIncentiveGovernance public incentives;
    IDisputeResolution public disputes;

    // ---- 全局默认参数（可被“请求级参数”覆盖）----
    uint256 public nextRequestId;

    // 质押与审计阈值/区间参数（默认）
    uint256 public minStake;                         // 预留：最小质押（当前未强制）
    uint256 public lambdaTimes100 = 250;             // 默认 λ×100（区间：median ± λ·MAD）
    uint256 public auditAnomalyRatioTimes100 = 1e4;  // 默认 异常比例 ×100（‰‰），10000=100%（基本不审）
    uint256 public kObservers = 3;                   // 默认每次选 3 个观察者

    // 加权相关全局参数
    bool    public useWeights   = false;             // 是否启用加权
    uint256 public base1e18     = 1e18;              // 基础权重
    uint256 public wRep1e18     = 1e18;              // 声誉权重系数（线性）

    // ---- （保留）鲁棒聚合裁剪比例（按权重），ppm=1e-6，当前版本主逻辑未使用 ----
    uint256 public trimLowPpm  = 0;      // 左尾裁剪比例，0 表示不裁剪
    uint256 public trimHighPpm = 0;      // 右尾裁剪比例

    // ---- 请求结构 ----
    struct DataRequest {
        string query;
        address requester;
        uint256 rewardWei;

        // 观察者集合
        address[] observers;

        // commit/reveal
        mapping(address => bytes32) commits;
        uint256[] revealedValues;
        address[] revealedAddrs;

        // 共识结果
        uint256 consensus;
        uint256 lower;
        uint256 upper;

        // 状态
        bool revealOpened;
        bool finalized;

        // 请求级参数（0 表示 fall back 到全局）
        uint256 kUsed;              // 实际使用的 kObservers（仅记录，不用于 selectObservers）
        uint256 lamTimes100;        // λ×100
        uint256 auditRatioTimes100; // 审计触发阈值 ×100（‰‰）

        bool    hasUseWeightsOverride;
        bool    useWeightsForReq;

        uint256 base1e18ForReq;
        uint256 wRep1e18ForReq;
    }

    mapping(uint256 => DataRequest) public requests;

    // ---- 事件 ----
    event RequestCreated(uint256 indexed requestId, string query, address requester, uint256 rewardWei);
    event ObserversSelected(uint256 indexed requestId, address[] observers);
    event RevealOpened(uint256 indexed requestId);
    event RequestFinalized(uint256 indexed requestId, uint256 consensus, uint256 lower, uint256 upper);
    event AnomalyStats(uint256 indexed requestId, uint256 anomalies, uint256 total, uint256 ratioTimes100);
    event PayoutFailed(uint256 indexed requestId, bytes lowLevelData);
    event AuditCallFailed(uint256 indexed requestId, bytes lowLevelData);

    // ---- onlyOwner 模式（简化版）----
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _nodeManager, address _incentives, address _disputes) {
        owner       = msg.sender;
        nodeManager = INodeManager(_nodeManager);
        incentives  = IIncentiveGovernance(_incentives);
        disputes    = IDisputeResolution(_disputes);
    }

    // ---- 管理员配置 ----

    function setNodeManager(address _nm) external onlyOwner {
        require(_nm != address(0), "zero");
        nodeManager = INodeManager(_nm);
    }

    function setIncentives(address _inc) external onlyOwner {
        require(_inc != address(0), "zero");
        incentives = IIncentiveGovernance(_inc);
    }

    function setDisputes(address _dr) external onlyOwner {
        require(_dr != address(0), "zero");
        disputes = IDisputeResolution(_dr);
    }
    
    function getRequestObservers(uint256 _requestId)
    external
    view
    returns (address[] memory)
{
    return requests[_requestId].observers;
}


    function setParams(
        uint256 _minStake,
        uint256 _lambdaTimes100,
        uint256 _auditRatioTimes100
    ) external onlyOwner {
        minStake                  = _minStake;
        lambdaTimes100            = _lambdaTimes100;
        auditAnomalyRatioTimes100 = _auditRatioTimes100;
    }

    function setK(uint256 _k) external onlyOwner {
        require(_k > 0, "k=0");
        kObservers = _k;
    }

    function setUseWeights(bool _use) external onlyOwner {
        useWeights = _use;
    }

    function setWeightParams(uint256 _base1e18, uint256 _wRep1e18) external onlyOwner {
        base1e18 = _base1e18;
        wRep1e18 = _wRep1e18;
    }

    /// @notice 设置全局裁剪比例（按权重），ppm=1e-6，例如 5% = 50_000
    /// @dev 当前版本主聚合逻辑使用 median+MAD，该参数只为后续 trimmed 实验预留
    function setTrimParams(uint256 _trimLowPpm, uint256 _trimHighPpm) external onlyOwner {
        require(_trimLowPpm + _trimHighPpm < 1_000_000, "invalid trim");
        trimLowPpm  = _trimLowPpm;
        trimHighPpm = _trimHighPpm;
    }

    // ---- 创建请求 / commit / reveal ----

    /// @notice 旧接口：使用全局默认参数发起请求（保留以兼容既有脚本）
    function createDataRequest(string calldata _query)
        external
        payable
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;

        DataRequest storage r = requests[requestId];
        r.query     = _query;
        r.requester = msg.sender;
        r.rewardWei = msg.value;

        // 记录“当时使用的默认参数”（便于链下可追溯）
        r.kUsed                 = kObservers;
        r.lamTimes100           = lambdaTimes100;
        r.auditRatioTimes100    = auditAnomalyRatioTimes100;
        r.hasUseWeightsOverride = true;
        r.useWeightsForReq      = useWeights;
        r.base1e18ForReq        = base1e18;
        r.wRep1e18ForReq        = wRep1e18;

        // 由 NodeManager 决定“抽几个观察者”，这里只传 minStake
        address[] memory obs = nodeManager.selectObservers(minStake);
        r.observers = obs;

        emit RequestCreated(requestId, _query, msg.sender, msg.value);
        emit ObserversSelected(requestId, obs);
    }

    /// @notice 新接口：发起请求时直接传“本次请求参数”，便于实验逐轮切换
    /// @dev 传 0 值表示“使用全局默认”；useWeights 采用三态：hasOverride=false→用默认；true→按 useWeightsForReq
    function createDataRequestEx(
        string calldata _query,
        uint256 _kObservers,                   // 0 表示使用默认 kObservers（仅记录在 r.kUsed 中，真正抽取数量由 NodeManager 决定）
        uint256 _lambdaTimes100,               // 0 表示使用默认 lambdaTimes100
        uint256 _auditAnomalyRatioTimes100,    // 0 表示使用默认 auditAnomalyRatioTimes100
        bool    _hasUseWeightsOverride,        // 是否覆盖 useWeights
        bool    _useWeightsForReq,             // 覆盖值（当 _hasUseWeightsOverride=true 时生效）
        uint256 _base1e18ForReq,               // 0 表示使用默认 base1e18
        uint256 _wRep1e18ForReq                // 0 表示使用默认 wRep1e18
    )
        external
        payable
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;

        DataRequest storage r = requests[requestId];
        r.query     = _query;
        r.requester = msg.sender;
        r.rewardWei = msg.value;

        // 写入“请求级参数”（0 → 回落默认；真正使用是在 finalizeRequest 里做 fallback）
        r.kUsed                 = (_kObservers > 0 ? _kObservers : kObservers);
        r.lamTimes100           = _lambdaTimes100;
        r.auditRatioTimes100    = _auditAnomalyRatioTimes100;
        r.hasUseWeightsOverride = _hasUseWeightsOverride;
        r.useWeightsForReq      = _useWeightsForReq;
        r.base1e18ForReq        = _base1e18ForReq;
        r.wRep1e18ForReq        = _wRep1e18ForReq;

        // 同样只给 NodeManager 一个 minStake，由它内部根据 observerCount 决定抽多少个
        address[] memory obs = nodeManager.selectObservers(minStake);
        r.observers = obs;

        emit RequestCreated(requestId, _query, msg.sender, msg.value);
        emit ObserversSelected(requestId, obs);
    }

    /// @notice 提交承诺（commit = keccak256(abi.encode(value, nonce, sender))）
    function commitData(uint256 _requestId, bytes32 _commitment) external {
        DataRequest storage r = requests[_requestId];
        require(r.requester != address(0), "no req");
        require(!r.revealOpened, "reveal opened");
        require(r.commits[msg.sender] == bytes32(0), "already committed");

        bool found = false;
        for (uint256 i = 0; i < r.observers.length; i++) {
            if (r.observers[i] == msg.sender) {
                found = true;
                break;
            }
        }
        require(found, "not observer");

        r.commits[msg.sender] = _commitment;
    }

    /// @notice 打开揭示阶段
    function openReveal(uint256 _requestId) external {
        DataRequest storage r = requests[_requestId];
        require(msg.sender == r.requester, "not requester");
        require(!r.revealOpened, "opened");
        require(!r.finalized, "finalized");

        r.revealOpened = true;
        emit RevealOpened(_requestId);
    }

    /// @notice 揭示数值
    function revealData(uint256 _requestId, uint256 _value, uint256 _nonce) external {
        DataRequest storage r = requests[_requestId];
        require(!r.finalized, "finalized");
        require(r.revealOpened, "not opened");

        bytes32 c = r.commits[msg.sender];
        require(c != bytes32(0), "no commit");

        bytes32 calc = keccak256(abi.encode(_value, _nonce, msg.sender));
        require(calc == c, "commit mismatch");

        r.revealedValues.push(_value);
        r.revealedAddrs.push(msg.sender);
    }

    // =====（保留）加权 trimmed mean 工具函数：当前主流程未调用，仅供后续实验使用 =====
    function _computeWeightedTrimmedStats(
        uint256[] memory values,
        address[] memory observers,
        bool useWeights_,
        uint256 lambdaTimes100_,
        uint256 trimLowPpm_,
        uint256 trimHighPpm_,
        uint256 baseUsed_,
        uint256 wRepUsed_
    )
        internal
        view
        returns (
            uint256 vTrim,
            uint256 lower,
            uint256 upper,
            uint256 anomaliesCount,
            uint256 anomalyRatioTimes100
        )
    {
        uint256 n = values.length;
        require(n > 0, "no reveals");

        // -------- 1. 按数值从小到大排序，同时带上权重 --------
        uint256[] memory sortedVals    = new uint256[](n);
        uint256[] memory sortedWeights = new uint256[](n);
        bool[]    memory used          = new bool[](n);

        for (uint256 k = 0; k < n; k++) {
            uint256 minIndex = type(uint256).max;
            uint256 minVal   = 0;

            // 选出当前未用过的最小值
            for (uint256 i = 0; i < n; i++) {
                if (used[i]) continue;
                if (minIndex == type(uint256).max || values[i] < minVal) {
                    minIndex = i;
                    minVal   = values[i];
                }
            }

            used[minIndex]  = true;
            sortedVals[k]   = minVal;

            // 计算对应权重
            uint256 w;
            if (useWeights_) {
                int256 rep      = incentives.reputation(observers[minIndex]);
                uint256 repU    = rep > 0 ? uint256(rep) : 0;
                w               = baseUsed_ + (wRepUsed_ * repU);
            } else {
                w = baseUsed_; // 等权
            }
            sortedWeights[k] = w;
        }

        // -------- 2. 前缀和 & 总权重 --------
        uint256[] memory prefix = new uint256[](n);
        uint256 totalWeight = 0;
        for (uint256 k = 0; k < n; k++) {
            totalWeight += sortedWeights[k];
            prefix[k] = totalWeight;
        }

        // 裁剪阈值（按权重）
        uint256 lowWeight  = (totalWeight * trimLowPpm_)  / 1_000_000;
        uint256 highWeight = (totalWeight * (1_000_000 - trimHighPpm_)) / 1_000_000;
        if (lowWeight > highWeight) {
            lowWeight  = 0;
            highWeight = totalWeight;
        }

        // 统计会被保留的 index 个数
        uint256 keptCount = 0;
        for (uint256 k = 0; k < n; k++) {
            uint256 wk = prefix[k];
            if (wk >= lowWeight && wk <= highWeight) {
                keptCount++;
            }
        }
        // 如果裁剪过猛导致 0 个，退化成全保留
        if (keptCount == 0) {
            keptCount  = n;
            lowWeight  = 0;
            highWeight = totalWeight;
        }

        // 收集 trimmed band 中的值 & 权重
        uint256[] memory tVals    = new uint256[](keptCount);
        uint256[] memory tWeights = new uint256[](keptCount);
        uint256 keptWeight = 0;
        uint256 idx = 0;
        for (uint256 k = 0; k < n; k++) {
            uint256 wk = prefix[k];
            if ((wk >= lowWeight && wk <= highWeight) || keptCount == n) {
                tVals[idx]    = sortedVals[k];
                tWeights[idx] = sortedWeights[k];
                keptWeight   += sortedWeights[k];
                idx++;
                if (idx == keptCount) break;
            }
        }

        // -------- 3. 加权 trimmed mean --------
        uint256 num = 0;
        for (uint256 i = 0; i < keptCount; i++) {
            num += tVals[i] * tWeights[i];
        }
        if (keptWeight == 0) {
            vTrim = 0;
        } else {
            vTrim = num / keptWeight;
        }

        // -------- 4. 加权 trimmed std --------
        uint256 sigmaTrim;
        if (keptWeight == 0) {
            sigmaTrim = 0;
        } else {
            uint256 varNum = 0;
            for (uint256 i = 0; i < keptCount; i++) {
                uint256 diff = tVals[i] >= vTrim ? (tVals[i] - vTrim) : (vTrim - tVals[i]);
                uint256 diff2 = diff * diff;
                varNum += tWeights[i] * diff2;
            }
            uint256 variance = varNum / keptWeight;
            sigmaTrim = _sqrt(variance);
        }

        // -------- 5. 置信区间 [lower, upper] --------
        if (sigmaTrim == 0 || lambdaTimes100_ == 0) {
            lower = vTrim;
            upper = vTrim;
        } else {
            uint256 delta = (sigmaTrim * lambdaTimes100_) / 100;
            lower = delta > vTrim ? 0 : (vTrim - delta);
            upper = vTrim + delta;
        }

        // -------- 6. 异常统计（按原始 values + 权重） --------
        anomaliesCount       = 0;
        uint256 anomalyWeight = 0;
        uint256 totalWeightOriginal = 0;

        for (uint256 i = 0; i < n; i++) {
            uint256 w;
            if (useWeights_) {
                int256 rep   = incentives.reputation(observers[i]);
                uint256 repU = rep > 0 ? uint256(rep) : 0;
                w            = baseUsed_ + (wRepUsed_ * repU);
            } else {
                w = baseUsed_;
            }
            totalWeightOriginal += w;

            uint256 diff = values[i] >= vTrim ? (values[i] - vTrim) : (vTrim - values[i]);
            bool isAnomaly = false;
            if (sigmaTrim == 0 || lambdaTimes100_ == 0) {
                isAnomaly = false;
            } else {
                // diff > λ * σ
                if (diff * 100 > lambdaTimes100_ * sigmaTrim) {
                    isAnomaly = true;
                }
            }

            if (isAnomaly) {
                anomaliesCount += 1;
                anomalyWeight  += w;
            }
        }

        if (totalWeightOriginal == 0) {
            anomalyRatioTimes100 = 0;
        } else {
            // ×100（‰‰），和 auditAnomalyRatioTimes100 的含义保持一致
            anomalyRatioTimes100 = (anomalyWeight * 10000) / totalWeightOriginal;
        }
    }

    /// @dev uint256 开方
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    // ===== 主流程：median+MAD 预处理 + 加权均值聚合 =====
    function finalizeRequest(uint256 _requestId) external {
        DataRequest storage r = requests[_requestId];
        require(!r.finalized, "finalized");
        require(r.revealOpened, "not opened");

        // 1) 本次请求使用的参数（0 -> 用全局默认）
        uint256 lamUsed  = (r.lamTimes100        > 0) ? r.lamTimes100        : lambdaTimes100;
        uint256 thrUsed  = (r.auditRatioTimes100 > 0) ? r.auditRatioTimes100 : auditAnomalyRatioTimes100;
        bool    useWUsed = r.hasUseWeightsOverride ? r.useWeightsForReq : useWeights;
        uint256 baseUsed = (r.base1e18ForReq     > 0) ? r.base1e18ForReq     : base1e18;
        uint256 wRepUsed = (r.wRep1e18ForReq     > 0) ? r.wRep1e18ForReq     : wRep1e18;

        uint256 n = r.revealedValues.length;
        require(n > 0, "no reveals");

        // 2) median + MAD 预处理，得到稳健区间 [lower, upper]
        uint256[] memory tmp = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            tmp[i] = r.revealedValues[i];
        }
        uint256 med = _median(tmp);

        uint256[] memory dev = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 v0 = r.revealedValues[i];
            dev[i] = v0 > med ? (v0 - med) : (med - v0);
        }
        uint256 MAD = _median(dev);

        uint256 lower_;
        uint256 upper_;
        if (MAD == 0 || lamUsed == 0) {
            lower_ = med;
            upper_ = med;
        } else {
            uint256 mul = (lamUsed * MAD) / 100;   // lamTimes100 = λ×100
            lower_ = med > mul ? (med - mul) : 0;
            upper_ = med + mul;
        }

        r.lower = lower_;
        r.upper = upper_;

        // 3) 统计异常 & 在 inlier 上做加权平均，得到最终共识
        uint256 anomalies   = 0;
        uint256 inlierCount = 0;
        uint256 sumW        = 0;
        uint256 weightedSum = 0;

        for (uint256 i = 0; i < n; i++) {
            uint256 v = r.revealedValues[i];

            // 判定是否异常（只用 median+MAD，和权重无关）
            if (v < r.lower || v > r.upper) {
                anomalies += 1;
                continue;
            }

            inlierCount += 1;

            // 计算该 inlier 的权重（和奖励一致）
            uint256 w;
            if (!useWUsed) {
                w = baseUsed;
            } else {
                int256 rep = incentives.reputation(r.revealedAddrs[i]);
                uint256 repNonNeg = rep > 0 ? uint256(rep) : 0;
                w = baseUsed + (wRepUsed * repNonNeg);
            }

            sumW        += w;
            weightedSum += v * w;
        }

        if (sumW > 0) {
            r.consensus = weightedSum / sumW;
        } else {
            // 极端情况：所有点都被判为异常，退化成 median
            r.consensus = med;
        }

        uint256 ratioTimes100 = (anomalies * 10000) / n; // “‰‰”表示
        emit AnomalyStats(_requestId, anomalies, n, ratioTimes100);

        // 4) 分配奖励（只给 inlier）
        if (r.rewardWei > 0 && inlierCount > 0) {
            address[] memory inlierAddrs = new address[](inlierCount);
            uint256[] memory amounts     = new uint256[](inlierCount);
            int256[]  memory repDeltas   = new int256[](inlierCount);
            uint256[] memory weights     = new uint256[](inlierCount);

            uint256 idx  = 0;
            uint256 paid = 0;

            // 再跑一遍，把 inlier 和权重填进数组
            for (uint256 i = 0; i < n; i++) {
                uint256 v = r.revealedValues[i];
                if (v < r.lower || v > r.upper) {
                    continue;
                }

                address a = r.revealedAddrs[i];

                uint256 w;
                if (!useWUsed) {
                    w = baseUsed;
                } else {
                    int256 rep = incentives.reputation(a);
                    uint256 repNonNeg = rep > 0 ? uint256(rep) : 0;
                    w = baseUsed + (wRepUsed * repNonNeg);
                }

                inlierAddrs[idx] = a;
                weights[idx]     = w;
                idx++;
            }

            if (sumW > 0) {
                for (uint256 i = 0; i < inlierCount; i++) {
                    uint256 amt = (r.rewardWei * weights[i]) / sumW;
                    amounts[i]   = amt;
                    repDeltas[i] = int256(1); // inlier +1 reputation
                    paid        += amt;
                }
                // 处理整除误差，把剩余几 wei 给第一个 inlier
                if (r.rewardWei > paid) {
                    amounts[0] += (r.rewardWei - paid);
                }

                incentives.distributeRewards{value: r.rewardWei}(
                    _requestId,
                    inlierAddrs,
                    amounts,
                    inlierAddrs,
                    repDeltas
                );
            }
        }

        // 5) 触发审计
        if (ratioTimes100 >= thrUsed) {
            disputes.initiateAudit(_requestId);
        }

        r.finalized = true;
        emit RequestFinalized(_requestId, r.consensus, r.lower, r.upper);
    }

    /// @notice 查询结算结果
    function getRequestResult(uint256 _requestId) external view returns (uint256, uint256, uint256, bool) {
        DataRequest storage r = requests[_requestId];
        return (r.consensus, r.lower, r.upper, r.finalized);
    }

    // ---- 辅助：排序 / median ----

    // 简单插入排序，用于统计 median / MAD
    function _sort(uint256[] memory a) internal pure {
        uint256 n = a.length;
        for (uint256 i = 1; i < n; i++) {
            uint256 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = key;
        }
    }

    // 计算中位数（会原地排序数组 a）
    function _median(uint256[] memory a) internal pure returns (uint256) {
        uint256 n = a.length;
        if (n == 0) return 0;
        _sort(a);
        uint256 mid = n / 2;
        if (n % 2 == 1) {
            return a[mid];
        } else {
            return (a[mid - 1] + a[mid]) / 2;
        }
    }
}

