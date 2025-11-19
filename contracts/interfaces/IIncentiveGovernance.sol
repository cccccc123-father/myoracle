// contracts/interfaces/IIncentiveGovernance.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IIncentiveGovernance {
    function distributeRewards(
        uint256 requestId,
        address[] calldata payees,
        uint256[] calldata payoutsWei,
        address[] calldata repAddrs,
        int256[] calldata repDeltas
    ) external payable;

    function slashToTreasury(uint256 requestId) external payable;

    function reputation(address a) external view returns (int256);

    function oracleCore() external view returns (address);

    function setOracleCore(address core) external;

    function withdrawable(address a) external view returns (uint256);

    function claim() external;
}

