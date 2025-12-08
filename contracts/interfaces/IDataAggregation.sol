// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IDataAggregation {
    // commitment = keccak256(abi.encodePacked(value, nonce, observer))
    function storeCommitment(uint256 requestId, address observer, bytes32 commitment) external;
    function verifyReveal(uint256 requestId, address observer, uint256 value, uint256 nonce)
        external view returns (bool);

    // 旧的无权接口（保留以兼容老代码）
    function calculateWeightedConsensus(uint256 requestId, uint256[] calldata values)
        external pure returns (uint256 consensus, uint256 lower, uint256 upper);

    // 新增：加权接口（OracleCore 新版会调用这个）
    function calculateWeightedConsensusWeighted(
        uint256 requestId,
        uint256[] calldata values,
        uint256[] calldata weights
    ) external pure returns (uint256 consensus, uint256 lower, uint256 upper);

    function detectAnomalies(
        uint256 requestId,
        uint256[] calldata values,
        uint256 consensus,
        uint256 lambdaTimes100
    ) external pure returns (uint256 count);
}

