// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/INodeManager.sol";
import "./interfaces/IDisputeResolution.sol";

// 只用到 OracleCore 的一个只读接口：getRequestResult(...)
interface IOracleCore {
    function getRequestResult(uint256 _requestId)
        external
        view
        returns (uint256 consensus, uint256 lower, uint256 upper);
}

contract DisputeResolution is IDisputeResolution {
    /* ============ Ownable ============ */
    address public owner;
    modifier onlyOwner() {
        require(msg.sender == owner, "DR: not owner");
        _;
    }

    /* ============ 外部合约 ============ */
    INodeManager public nodeManager;
    IOracleCore public oracleCore; // 只做访问控制 + 读结果用

    // 审计决策阈值：超级多数（×10000，6667 ≈ 66.67%）
    uint256 public auditSuperMajorityTimes10000 = 6667;

    function setAuditSuperMajority(uint256 _qTimes10000) external onlyOwner {
        require(_qTimes10000 > 5000 && _qTimes10000 <= 10000, "DR: q in (50%,100]");
        auditSuperMajorityTimes10000 = _qTimes10000;
    }

    /* ============ 审计状态 ============ */
    struct AuditCase {
        bool exists;
        bool open;
        uint256 disputedValue;     // 被审计的共识值（来自 OracleCore）
        address[] committee;       // 审计委员会成员（从 NodeManager 选出）
        uint256 supportCount;      // 支持原结果票数
        uint256 againstCount;      // 反对原结果票数
        mapping(address => bool) hasVoted;  // 是否已投票
    }

    mapping(uint256 => AuditCase) private audits; // requestId -> 审计记录

    /* ============ 事件 ============ */
    // unanimous 含义更新：表示“是否达成有效裁决（达到超级多数阈值）”
    // supportOriginal：在达成裁决时，是否支持原结果
    event AuditInitiated(uint256 indexed requestId, uint256 disputedValue, address[] committee);
    event AuditVoted(uint256 indexed requestId, address indexed auditor, bool supportOriginal);
    event AuditClosed(uint256 indexed requestId, bool unanimous, bool supportOriginal);

    /* ============ 构造与配置 ============ */

    constructor(address _nodeManager, address _owner) {
        require(_nodeManager != address(0), "DR: zero nodeMgr");
        require(_owner != address(0), "DR: zero owner");
        nodeManager = INodeManager(_nodeManager);
        owner = _owner;
    }

    /// 由 owner 绑定 OracleCore 地址（只绑定一次即可）
    function setOracleCore(address _oracle) external onlyOwner {
        require(_oracle != address(0), "DR: zero oracle");
        oracleCore = IOracleCore(_oracle);
    }

    /// 方便脚本检查当前 oracleCore
    function getOracleCore() external view returns (address) {
        return address(oracleCore);
    }

    modifier onlyOracleCore() {
        require(msg.sender == address(oracleCore), "DR: not oracleCore");
        _;
    }

    /* ============ IDisputeResolution 接口实现 ============ */

    /// 由 OracleCore 在 finalize 时触发
    function initiateAudit(uint256 requestId) external override onlyOracleCore {
        AuditCase storage a = audits[requestId];
        require(!a.exists, "DR: audit exists");

        // 从 OracleCore 读取本次请求的共识结果
        (uint256 consensus, , ) = oracleCore.getRequestResult(requestId);

        a.exists = true;
        a.open = true;
        a.disputedValue = consensus;

        // 这里先简单地选所有声誉 >= 0 的审计者，数量由 NodeManager.auditorCount 限制
        address[] memory committee = nodeManager.selectAuditors(0);
        a.committee = committee;

        emit AuditInitiated(requestId, consensus, committee);
    }

    /// 返回被审计的值（没审计过就是 0）
    function getDisputedValue(uint256 requestId) external view override returns (uint256) {
        return audits[requestId].disputedValue;
    }

    /// 审计者投票：supportOriginal = true 表示支持 Oracle 原始共识结果
    function submitAuditVote(uint256 requestId, bool supportOriginal) external override {
        AuditCase storage a = audits[requestId];
        require(a.exists && a.open, "DR: no open audit");

        // 检查是否在委员会里
        bool ok = false;
        for (uint256 i = 0; i < a.committee.length; i++) {
            if (a.committee[i] == msg.sender) {
                ok = true;
                break;
            }
        }
        require(ok, "DR: not in committee");
        require(!a.hasVoted[msg.sender], "DR: already voted");

        a.hasVoted[msg.sender] = true;
        if (supportOriginal) {
            a.supportCount++;
        } else {
            a.againstCount++;
        }

        emit AuditVoted(requestId, msg.sender, supportOriginal);
    }

    /// 由 owner 关单，并给出是否达成有效裁决、是否支持原结果
    function close(uint256 requestId) external override onlyOwner {
        AuditCase storage a = audits[requestId];
        require(a.exists && a.open, "DR: no open audit");

        a.open = false;

        uint256 committeeSize = a.committee.length;
        uint256 totalVotes = a.supportCount + a.againstCount;

        bool decisionReached = false;
        bool supportOriginalWin = false;

        if (committeeSize > 0) {
            // 按“委员会规模”计算超级多数阈值
            uint256 supportPctTimes10000 =
                (a.supportCount * 10000) / committeeSize;
            uint256 againstPctTimes10000 =
                (a.againstCount * 10000) / committeeSize;

            if (supportPctTimes10000 >= auditSuperMajorityTimes10000) {
                decisionReached = true;
                supportOriginalWin = true;
            } else if (againstPctTimes10000 >= auditSuperMajorityTimes10000) {
                decisionReached = true;
                supportOriginalWin = false;
            }
        }

        // unanimous 字段复用：true 表示“形成有效审计结论（达到超级多数阈值）”
        // supportOriginal：在形成结论时，是否支持原结果
        emit AuditClosed(
            requestId,
            decisionReached,
            decisionReached ? supportOriginalWin : false
        );

        // 目前合约只负责记录审计结果并发事件，
        // 具体惩罚/奖励由外部监听事件或后续版本的 IncentiveGovernance 实现。
        // 如果你后续要在这里直接调用 incentives.xxx，可以在 decisionReached 分支里加逻辑。
    }
}

