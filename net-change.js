/**
 * Quantumult X 网络切换自动重测策略组
 */
const policyName = "自动选择"; // 必须对应你 [policy] 中的策略组名称

if (typeof $configuration !== "undefined") {
    $configuration.sendMessage({
        action: "benchmark",
        content: {
            policy_names: [policyName]
        }
    });
}
$done();
