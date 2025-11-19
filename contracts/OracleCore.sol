// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/INodeManager.sol";
import "./interfaces/IIncentiveGovernance.sol";
import "./interfaces/IDisputeResolution.sol";

/// @title OracleCore — 可切换“加权/非加权聚合”，支持“请求级参数传参”，并给外部合约调用加保险丝（try/catch）
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
        uint256 kUsed;              // 实际使用的 kObservers
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

    function setParams(
        uint256 _minStake,
        uint256 _lambdaTimes100,
        uint256 _auditRatioTimes100
    ) external onlyOwner {
        minStake                   = _minStake;
        lambdaTimes100             = _lambdaTimes100;
        auditAnomalyRatioTimes100  = _auditRatioTimes100;
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

    // ---- 创建请求 / commit / reveal ----
    // ---- 任务生命周期 ----

    /// @notice 旧接口：使用全局默认参数发起请求（保留以兼容既有脚本）
    function createDataRequest(string calldata _query)
        external
        payable
        returns (uint256 requestId)
    {
        // 不再强制要求 msg.value > 0，方便做“零奖励”的纯逻辑测试
        requestId = nextRequestId++;

        DataRequest storage r = requests[requestId];
        r.query     = _query;
        r.requester = msg.sender;
        r.rewardWei = msg.value;

        // 记录“当时使用的默认参数”（便于链下可追溯）
        r.kUsed               = kObservers;
        r.lamTimes100         = lambdaTimes100;
        r.auditRatioTimes100  = auditAnomalyRatioTimes100;
        r.hasUseWeightsOverride = true;
        r.useWeightsForReq    = useWeights;
        r.base1e18ForReq      = base1e18;
        r.wRep1e18ForReq      = wRep1e18;

        // ✅ 由 NodeManager 决定“抽几个观察者”，这里只传 minStake
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
        // ✅ 去掉强制 msg.value > 0，防止因为脚本没带 value 而直接 revert
        requestId = nextRequestId++;

        DataRequest storage r = requests[requestId];
        r.query     = _query;
        r.requester = msg.sender;
        r.rewardWei = msg.value;

        // 写入“请求级参数”（0 → 回落默认；真正使用是在 finalizeRequest 里做 fallback）
        r.kUsed               = (_kObservers > 0 ? _kObservers : kObservers);
        r.lamTimes100         = _lambdaTimes100;
        r.auditRatioTimes100  = _auditAnomalyRatioTimes100;
        r.hasUseWeightsOverride = _hasUseWeightsOverride;
        r.useWeightsForReq    = _useWeightsForReq;
        r.base1e18ForReq      = _base1e18ForReq;
        r.wRep1e18ForReq      = _wRep1e18ForReq;

        // ✅ 同样只给 NodeManager 一个 minStake，由它内部根据 observerCount 决定抽多少个
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

    function finalizeRequest(uint256 _requestId) external {
        DataRequest storage r = requests[_requestId];
        require(!r.finalized, "finalized");
        require(r.revealOpened, "not opened");

        // 计算使用的“本次请求参数”（0→回落默认）
        uint256 lamUsed  = (r.lamTimes100        > 0) ? r.lamTimes100        : lambdaTimes100;
        uint256 thrUsed  = (r.auditRatioTimes100 > 0) ? r.auditRatioTimes100 : auditAnomalyRatioTimes100;
        bool    useWUsed = r.hasUseWeightsOverride ? r.useWeightsForReq : useWeights;
        uint256 baseUsed = (r.base1e18ForReq     > 0) ? r.base1e18ForReq     : base1e18;
        uint256 wRepUsed = (r.wRep1e18ForReq     > 0) ? r.wRep1e18ForReq     : wRep1e18;

        uint256 n = r.revealedValues.length;
        require(n > 0, "no reveals");

        // 1) 复制一份数值到 memory，用于鲁棒统计（Median + MAD）
        uint256[] memory vals = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            vals[i] = r.revealedValues[i];
        }

        // 中位数
        uint256 med = _median(vals);
        // 中位数绝对偏差（MAD）
        uint256 mad = _mad(vals, med);

        // 计算区间：median ± lambda * MAD（lambda = lamUsed / 100）
        if (mad == 0 || lamUsed == 0) {
            // 完全一致或没设置 lambda：所有值都视为 inlier
            r.consensus = med;
            r.lower = med;
            r.upper = med;
        } else {
            (uint256 lower_, uint256 upper_) = _interval(med, mad, lamUsed);
            r.consensus = med;
            r.lower = lower_;
            r.upper = upper_;
        }

        // 2) 统计 inlier / anomaly
        uint256 anomalies = 0;
        uint256 inlierCount = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 v = r.revealedValues[i];
            if (v < r.lower || v > r.upper) {
                anomalies += 1;
            } else {
                inlierCount += 1;
            }
        }

        // 异常比例（×100，即 “‰‰”）
        uint256 ratioTimes100 = (anomalies * 10000) / n;
        emit AnomalyStats(_requestId, anomalies, n, ratioTimes100);

        // 3) 给 inlier 分配奖励（如果有奖励 且 存在 inlier）
        if (r.rewardWei > 0 && inlierCount > 0) {
            address[] memory inlierAddrs = new address[](inlierCount);
            uint256[] memory amounts     = new uint256[](inlierCount);
            int256[]  memory repDeltas   = new int256[](inlierCount);
            uint256[] memory weights     = new uint256[](inlierCount);

            uint256 idx = 0;
            uint256 sumW = 0;

            // 先计算每个 inlier 的权重和总权重
            for (uint256 i = 0; i < n; i++) {
                uint256 v = r.revealedValues[i];
                if (v < r.lower || v > r.upper) continue;

                address a = r.revealedAddrs[i];

                uint256 w;
                if (!useWUsed) {
                    // 非加权：等权
                    w = baseUsed;
                } else {
                    // 加权：基于声誉的线性权重
                    int256 rep = incentives.reputation(a);
                    uint256 repNonNeg = rep > 0 ? uint256(rep) : 0;
                    w = baseUsed + (wRepUsed * repNonNeg);
                }

                inlierAddrs[idx] = a;
                weights[idx]     = w;
                sumW            += w;
                idx++;
            }

            if (sumW > 0) {
                uint256 paid = 0;
                for (uint256 i = 0; i < inlierCount; i++) {
                    uint256 amt = (r.rewardWei * weights[i]) / sumW;
                    amounts[i]   = amt;
                    repDeltas[i] = int256(1); // inlier +1 声誉
                    paid        += amt;
                }
                // 处理整除尾差，把剩余几 wei 给第一个 inlier
                if (r.rewardWei > paid) {
                    amounts[0] += (r.rewardWei - paid);
                }

                // 注意：这里不再用 try/catch，避免 Yul 堆栈过深
                // 如果奖励分发失败，整个 finalize 会回滚（在私链测试环境可接受）
                incentives.distributeRewards{value: r.rewardWei}(
                    _requestId,
                    inlierAddrs,
                    amounts,
                    inlierAddrs,
                    repDeltas
                );
            }
        }

        // 4) 判断是否触发审计（阈值 thrUsed 同样是 “‰‰”）
        if (ratioTimes100 >= thrUsed) {
            disputes.initiateAudit(_requestId);
        }

        // 5) 标记完成
        r.finalized = true;
        emit RequestFinalized(_requestId, r.consensus, r.lower, r.upper);
    }


    /// @notice 查询结算结果
    function getRequestResult(uint256 _requestId) external view returns (uint256, uint256, uint256, bool) {
        DataRequest storage r = requests[_requestId];
        return (r.consensus, r.lower, r.upper, r.finalized);
    }

    // ---- 内部工具 ----
    function _meanStd(uint256[] storage vals) internal view returns (uint256 mean, uint256 std) {
        uint256 m = vals.length;
        if (m == 0) return (0, 0);

        uint256 sum = 0;
        for (uint256 i = 0; i < m; i++) sum += vals[i];
        mean = sum / m;

        if (m == 1) return (mean, 0);

        uint256 acc = 0;
        for (uint256 i = 0; i < m; i++) {
            uint256 x = vals[i];
            uint256 d = x > mean ? (x - mean) : (mean - x);
            acc += d * d;
        }
        uint256 variance = acc / m;
        std = _sqrt(variance);
    }

    function _interval(uint256 mean, uint256 std, uint256 lamTimes100_) internal pure returns (uint256 lower, uint256 upper) {
        uint256 mul = (std * lamTimes100_) / 100;
        lower = (mean > mul) ? (mean - mul) : 0;
        upper = mean + mul;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }

    // ---- 稳健聚合辅助函数：排序 + 中位数 + MAD 区间 ----

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

    // 计算中位数绝对偏差 MAD = median(|x_i - med|)
    function _mad(uint256[] memory original, uint256 med) internal pure returns (uint256) {
        uint256 n = original.length;
        if (n == 0) return 0;
        uint256[] memory dev = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 x = original[i];
            dev[i] = x > med ? (x - med) : (med - x);
        }
        _sort(dev);
        uint256 mid = n / 2;
        if (n % 2 == 1) {
            return dev[mid];
        } else {
            return (dev[mid - 1] + dev[mid]) / 2;
        }
    }


    /// @dev 基于 median + MAD 计算稳健区间 [lower, upper]，共识值使用 median
    function _robustInterval(
        uint256[] storage vals,
        uint256 lamTimes100_
    ) internal view returns (uint256 consensus, uint256 lower, uint256 upper) {
        uint256 m = vals.length;
        if (m == 0) {
            return (0, 0, 0);
        }

        // 拷贝到内存数组以便排序
        uint256[] memory tmp = new uint256[](m);
        for (uint256 i = 0; i < m; i++) {
            tmp[i] = vals[i];
        }

        uint256 med = _median(tmp);

        // 计算 dev = |v - med|
        uint256[] memory dev = new uint256[](m);
        for (uint256 i = 0; i < m; i++) {
            uint256 v = vals[i];
            dev[i] = v > med ? (v - med) : (med - v);
        }
        uint256 MAD = _median(dev);

        // λ=0 或 MAD=0 时，退化为点估计
        if (lamTimes100_ == 0 || MAD == 0) {
            consensus = med;
            lower     = med;
            upper     = med;
            return (consensus, lower, upper);
        }

        // lower/upper = med ± λ·MAD
        // lamTimes100_ = λ×100，因此这里 /100
        uint256 mul = (lamTimes100_ * MAD) / 100;
        consensus = med;
        lower     = med > mul ? (med - mul) : 0;
        upper     = med + mul;
        return (consensus, lower, upper);
    }
}

