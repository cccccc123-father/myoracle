// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract NodeManager {
    /* ============ Ownable ============ */
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner, "NM: not owner"); _; }

    constructor() { owner = msg.sender; }

    /* ============ Types ============ */
    enum Role { PROPOSER, OBSERVER, AUDITOR }

    struct Node {
        bool registered;
        Role role;
        uint256 stake;      // wei locked for eligibility
        uint256 reputation; // lightweight rep used only for selection (can be fed from Incentives later)
    }

    mapping(address => Node) public nodes;
    address[] public registry;

    uint256 public observerCount = 5;
    uint256 public auditorCount  = 3;

    /* ============ Events ============ */
    event NodeRegistered(address indexed node, Role role, uint256 stake);
    event StakeChanged(address indexed node, uint256 newStake);
    event ReputationSet(address indexed node, uint256 newRep);

    /* ============ Admin ============ */
    function setOwner(address _o) external onlyOwner { owner = _o; }
    function setCounts(uint256 obs, uint256 aud) external onlyOwner { 
        require(obs>0 && aud>0, "NM: bad counts");
        observerCount = obs; auditorCount = aud; 
    }

    /* ============ Register / Stake ============ */
    function register(Role role) external payable {
        require(!nodes[msg.sender].registered, "NM: registered");
        nodes[msg.sender] = Node(true, role, msg.value, 100); // init rep=100
        registry.push(msg.sender);
        emit NodeRegistered(msg.sender, role, msg.value);
    }

    function addStake() external payable {
        require(nodes[msg.sender].registered, "NM: not registered");
        nodes[msg.sender].stake += msg.value;
        emit StakeChanged(msg.sender, nodes[msg.sender].stake);
    }

    function withdrawStake(uint256 amount) external {
        Node storage n = nodes[msg.sender];
        require(n.registered, "NM: not registered");
        require(amount <= n.stake, "NM: insufficient");
        n.stake -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "NM: withdraw failed");
        emit StakeChanged(msg.sender, n.stake);
    }

    /* ============ Reputation (hook for Incentives) ============ */
    function setReputation(address who, uint256 rep) external onlyOwner {
        require(nodes[who].registered, "NM: unknown");
        nodes[who].reputation = rep;
        emit ReputationSet(who, rep);
    }

// 与 INodeManager / OracleCore 对齐：只接收 minStake，抽多少个由 observerCount 控制
function selectObservers(uint256 minStake) external view returns (address[] memory) {
    // 使用本合约里的默认 observerCount
    uint256 limit = observerCount;

    // 不要比当前注册节点还多
    if (limit > registry.length) {
        limit = registry.length;
    }

    address[] memory tmp = new address[](limit);
    uint256 c;
    for (uint i = 0; i < registry.length && c < limit; i++) {
        address a = registry[i];
        Node memory n = nodes[a];
        if (n.registered && n.role == Role.OBSERVER && n.stake >= minStake) {
            tmp[c++] = a;
        }
    }

    // shrink
    address[] memory out = new address[](c);
    for (uint j = 0; j < c; j++) {
        out[j] = tmp[j];
    }
    return out;
}


    function selectAuditors(uint256 minRep) external view returns (address[] memory) {
        address[] memory tmp = new address[](auditorCount);
        uint256 c;
        for (uint i=0; i<registry.length && c<auditorCount; i++) {
            address a = registry[i];
            Node memory n = nodes[a];
            if (n.registered && n.role == Role.AUDITOR && n.reputation >= minRep) {
                tmp[c++] = a;
            }
        }
        address[] memory out = new address[](c);
        for (uint j=0;j<c;j++) out[j]=tmp[j];
        return out;
    }

    /* ============ Views ============ */
    function getNode(address who) external view returns (bool, Role, uint256, uint256) {
        Node memory n = nodes[who];
        return (n.registered, n.role, n.stake, n.reputation);
    }

    receive() external payable {}
}

