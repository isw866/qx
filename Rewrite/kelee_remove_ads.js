/*
 * 去广告合集（多屏互动 + 小白智慧打印）—— Quantumult X
 * https://github.com/isw866/qx/blob/main/Rewrite/kelee_remove_ads.js
 *
 * 由可莉（https://github.com/luestr/ProxyResource）的 Loon 插件转换，已去掉夸克部分。
 * 配套配置：Rewrite/kelee.conf
 *
 * 处理两个接口（对应原 Surge 的 5 条 http-response-jq）：
 *   1. 多屏互动 tcast  /tcast/v{n}/config/function → .data 只保留 module == "tools"
 *   2. 小白打印 epbox  /graphql                    → 删 4 类推广字段（含楼层过滤）
 * 原 [Map Local] 那 9 条直接返回 {} 的规则不需要脚本，在 kelee.conf 里用 reject-dict 实现。
 *
 * 运行环境：Quantumult X（$request / $response / $done）
 */

/* ---------- 工具函数 ---------- */

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/* ---------- 1. 多屏互动 tcast：只保留 tools 模块 ---------- */
/* 原 jq：'.data |= map(select(.module == "tools"))' */
function keepToolsOnly(root) {
  if (!Array.isArray(root.data)) {
    return false;
  }
  var kept = root.data.filter(function (item) {
    return item && item.module === "tools";
  });
  if (kept.length === root.data.length) {
    return false;
  }
  root.data = kept;
  return true;
}

/* ---------- 2. 小白智慧打印 epbox graphql ---------- */
/*
 * 原 jq（4 条，同一 URL）：
 *   delpaths([["data","mallConsumables"]])
 *   delpaths([["data","currentUser","goodsCoupons"]])
 *   if .data.systemConfig.searchHotTags? then del(.data.systemConfig) else . end
 *   if (.data.page.__typename=="Page" and .data.page.name=="场景化改版 2024")
 *   then .data.page.firstTabDetail.floors |= map(select(.numType=="row")) else . end
 */
function cleanGongfudou(root) {
  var data = root.data;
  if (!data || typeof data !== "object") {
    return false;
  }
  var changed = false;

  if (hasOwn(data, "mallConsumables")) {
    delete data.mallConsumables;
    changed = true;
  }

  if (data.currentUser && typeof data.currentUser === "object" &&
      hasOwn(data.currentUser, "goodsCoupons")) {
    delete data.currentUser.goodsCoupons;
    changed = true;
  }

  var systemConfig = data.systemConfig;
  if (systemConfig && typeof systemConfig === "object") {
    // jq 里只有 false 和 null 为假，其余（含 0、""、[]）都算真，这里保持一致
    var hotTags = systemConfig.searchHotTags;
    if (hotTags !== undefined && hotTags !== null && hotTags !== false) {
      delete data.systemConfig;
      changed = true;
    }
  }

  var page = data.page;
  if (page && typeof page === "object" &&
      page.__typename === "Page" && page.name === "场景化改版 2024") {
    var detail = page.firstTabDetail;
    if (detail && typeof detail === "object" && Array.isArray(detail.floors)) {
      var rows = detail.floors.filter(function (floor) {
        return floor && floor.numType === "row";
      });
      if (rows.length !== detail.floors.length) {
        detail.floors = rows;
        changed = true;
      }
    }
  }

  return changed;
}

/* ---------- 入口 ---------- */
function main() {
  var url = ($request && $request.url) ? $request.url : "";
  var body = $response ? $response.body : null;

  if (typeof body !== "string" || body.length === 0) {
    $done({});
    return;
  }

  var root;
  try {
    root = JSON.parse(body);
  } catch (error) {
    $done({});
    return;
  }

  if (!root || typeof root !== "object") {
    $done({});
    return;
  }

  var changed = false;

  if (/tcast-o\.api\.leiniao\.com\/tcast\/v\d+\/config\/function/i.test(url)) {
    changed = keepToolsOnly(root);
  } else if (/epbox\.gongfudou\.com\/graphql/i.test(url)) {
    changed = cleanGongfudou(root);
  }

  if (!changed) {
    $done({});
    return;
  }

  $done({ body: JSON.stringify(root) });
}

main();
