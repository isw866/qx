/**
 * 全能扫描王 (CamScanner) 解锁超级会员
 * 适配 Quantumult X
 */

let obj = JSON.parse($response.body);

if (obj.data) {
    obj.data.psnl_vip_property = {
        "expiry": 4102415999,      // 过期时间 2099-12-31
        "svip": 1,                 // 1 为开启超级会员
        "nxt_renew_tm": 4102415999,
        "level": 1,
        "last_pay_tm": 1600000000
    };
    // 额外解锁云空间（可选）
    if (obj.data.cloud_property) {
        obj.data.cloud_property.total = 107374182400; // 100GB
    }
}

$done({body: JSON.stringify(obj)});
