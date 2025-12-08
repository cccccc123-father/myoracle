// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DataAggregation
/// @dev 工具合约：对一组无权值 v_i 做 trimmed mean + trimmed std + 区间
contract DataAggregation {
    /// @dev 聚合：等权 trimmed mean
    /// @param values 观测值数组
    /// @param lambdaTimes100 λ*100
    /// @param trimLowPpm 左裁剪（ppm）
    /// @param trimHighPpm 右裁剪（ppm）
    function aggregate(
        uint256[] memory values,
        uint256 lambdaTimes100,
        uint256 trimLowPpm,
        uint256 trimHighPpm
    )
        public
        pure
        returns (
            uint256 vTrim,
            uint256 sigmaTrim,
            uint256 lower,
            uint256 upper
        )
    {
        uint256 n = values.length;
        require(n > 0, "no values");

        // 1. 排序
        uint256[] memory sorted = _sort(values);

        // 2. 等权前缀权重：每个权重 = 1
        uint256 totalWeight = n;
        uint256 lowWeight = (totalWeight * trimLowPpm) / 1_000_000;
        uint256 highWeight = (totalWeight * (1_000_000 - trimHighPpm)) / 1_000_000;
        if (lowWeight > highWeight) {
            lowWeight = 0;
            highWeight = totalWeight;
        }

        uint256 keptCount = 0;
        for (uint256 k = 0; k < n; k++) {
            uint256 wk = k + 1; // 前缀和
            if (wk >= lowWeight && wk <= highWeight) {
                keptCount++;
            }
        }
        if (keptCount == 0) {
            keptCount = n;
            lowWeight = 0;
            highWeight = totalWeight;
        }

        uint256[] memory tVals = new uint256[](keptCount);
        uint256 idx = 0;
        for (uint256 k = 0; k < n; k++) {
            uint256 wk = k + 1;
            if ((wk >= lowWeight && wk <= highWeight) || keptCount == n) {
                tVals[idx++] = sorted[k];
                if (idx == keptCount) break;
            }
        }

        // trimmed mean
        uint256 sum = 0;
        for (uint256 i = 0; i < keptCount; i++) {
            sum += tVals[i];
        }
        vTrim = sum / keptCount;

        // trimmed std
        uint256 varNum = 0;
        for (uint256 i = 0; i < keptCount; i++) {
            uint256 diff = tVals[i] >= vTrim ? (tVals[i] - vTrim) : (vTrim - tVals[i]);
            varNum += diff * diff;
        }
        uint256 variance = varNum / keptCount;
        sigmaTrim = _sqrt(variance);

        if (sigmaTrim == 0 || lambdaTimes100 == 0) {
            lower = vTrim;
            upper = vTrim;
        } else {
            uint256 delta = (sigmaTrim * lambdaTimes100) / 100;
            lower = delta > vTrim ? 0 : (vTrim - delta);
            upper = vTrim + delta;
        }
    }

    function _sort(uint256[] memory arr) internal pure returns (uint256[] memory) {
        uint256 n = arr.length;
        uint256[] memory out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) out[i] = arr[i];

        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                if (out[j] < out[i]) {
                    (out[i], out[j]) = (out[j], out[i]);
                }
            }
        }
        return out;
    }

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
}

