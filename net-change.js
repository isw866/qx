/**
 * Quantumult X 网络切换自动重测策略组 (带调试通知)
 */
const policyName = "自动选择"; 

if (typeof $configuration !== "undefined") {
    // 1. 发起测速指令
    $configuration.sendMessage({
        action: "benchmark",
        content: {
            policy_names: [policyName]
        }
    });

    // 2. 弹出系统通知（用于验证网络切换时脚本是否真的触发了）
    $notify("QX 自动化", "网络环境已变更", `正在重新对「${policyName}」策略组测速...`);
}

$done();
