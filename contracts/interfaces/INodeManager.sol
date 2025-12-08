// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface INodeManager {
    /// @notice 选择观察者：内部根据 NodeManager.observerCount，返回满足最小质押的前 K 个
    function selectObservers(uint256 minStake) external view returns (address[] memory);

    /// @notice 选择审计者：内部根据 NodeManager.auditorCount，返回满足最小声誉的前 L 个
    function selectAuditors(uint256 minRep) external view returns (address[] memory);
}

