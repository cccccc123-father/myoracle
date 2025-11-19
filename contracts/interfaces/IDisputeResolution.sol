// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IDisputeResolution {
    function initiateAudit(uint256 requestId) external;
    function getDisputedValue(uint256 requestId) external view returns (uint256);
    function submitAuditVote(uint256 requestId, bool supportOriginal) external;
    function close(uint256 requestId) external;
}

