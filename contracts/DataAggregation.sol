// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * 维持你原有接口的“等权聚合”函数 aggregate(...)，不改签名；
 * OracleCore 在“加权模式”下，会把输入 values[] 按权重“复制展开”，
 * 这样此处仍旧走等权逻辑，但统计上等价于加权。
 *
 * 这里给出一个“中位数 + MAD（中位绝对偏差）的 λ 截尾 + 内点均值”的稳健聚合流程示例：
 * 返回 (consensus, lower, upper)。如你本地已有自己的实现，可保留你的实现。
 */
contract DataAggregation {
    // ============== 可替换为你原来的排序/中位实现 ==============
    function _sort(uint256[] memory a) internal pure {
        // 简易插入排序（K 很小，gas 可控）
        for (uint256 i = 1; i < a.length; i++) {
            uint256 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = key;
        }
    }

    function _median(uint256[] memory a) internal pure returns (uint256) {
        require(a.length > 0, "empty");
        uint256[] memory b = new uint256[](a.length);
        for (uint256 i = 0; i < a.length; i++) b[i] = a[i];
        _sort(b);
        uint256 n = b.length;
        if (n % 2 == 1) return b[n / 2];
        return (b[n / 2 - 1] + b[n / 2]) / 2;
    }
    // ========================================================

    /**
     * 等权聚合：传入 values[], λ（×100）与 ε（ppm）。
     * 输出： 共识值、下界、上界。
     * —— 共识：对“|v - med| <= λ * MAD”的内点做均值
     * —— 区间：以 ε 为精度区间构造 [lower, upper]
     */
    function aggregate(
        uint256[] memory values,
        uint256 lambdaTimes100,
        uint256 epsilonPpm
    ) external pure returns (
        uint256 consensus,
        uint256 lower,
        uint256 upper
    ) {
        uint256 n = values.length;
        require(n > 0, "no value");

        // 1) 中位数与 MAD
        uint256 med = _median(values);
        uint256[] memory dev = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            dev[i] = values[i] > med ? (values[i] - med) : (med - values[i]);
        }
        uint256 MAD = _median(dev);

        // 2) 内点：|v - med| <= λ * MAD（注意 λ×100，所以右侧是 (λ * MAD)/100）
        uint256 inSum = 0;
        uint256 inCnt = 0;
        for (uint256 i = 0; i < n; i++) {
            if (dev[i] * 100 <= lambdaTimes100 * MAD) {
                inSum += values[i];
                inCnt += 1;
            }
        }
        if (inCnt == 0) {
            consensus = med; // 退化：全体都被当成外点时，取中位数
        } else {
            consensus = inSum / inCnt;
        }

        // 3) 区间：以 ε（ppm）构造 [lower, upper]
        lower = (consensus * (1_000_000 - epsilonPpm)) / 1_000_000;
        upper = (consensus * (1_000_000 + epsilonPpm)) / 1_000_000;
    }
}

