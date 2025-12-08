// contracts/IncentiveGovernance.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IIncentiveGovernance.sol";

contract IncentiveGovernance is IIncentiveGovernance {
    address public override oracleCore;
    address public treasury;

    mapping(address => uint256) public override withdrawable;
    mapping(address => int256)  public override reputation;

    modifier onlyCore() {
        require(msg.sender == oracleCore, "only core");
        _;
    }

    constructor() {
        treasury = msg.sender;
    }

    function setOracleCore(address core) external override {
        // 首次可由任意人设置；之后只能由 treasury 重指（稳妥起见）
        require(oracleCore == address(0) || msg.sender == treasury, "only treasury");
        oracleCore = core;
    }

    function distributeRewards(
        uint256 /*requestId*/,
        address[] calldata payees,
        uint256[] calldata payoutsWei,
        address[] calldata repAddrs,
        int256[] calldata repDeltas
    ) external payable override onlyCore {
        require(payees.length == payoutsWei.length, "len mismatch");
        require(repAddrs.length == repDeltas.length, "rep len mismatch");

        uint256 total = msg.value;
        uint256 acc   = 0;
        for (uint256 i = 0; i < payees.length; i++) {
            withdrawable[payees[i]] += payoutsWei[i];
            acc += payoutsWei[i];
        }
        require(acc == total, "value mismatch");

        for (uint256 i = 0; i < repAddrs.length; i++) {
            reputation[repAddrs[i]] += repDeltas[i];
        }
    }

    function slashToTreasury(uint256 /*requestId*/) external payable override onlyCore {
        (bool ok, ) = payable(treasury).call{value: msg.value}("");
        require(ok, "slash xfer fail");
    }

    function claim() external override {
        uint256 amt = withdrawable[msg.sender];
        require(amt > 0, "zero");
        withdrawable[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amt}("");
        require(ok, "claim xfer fail");
    }
}

