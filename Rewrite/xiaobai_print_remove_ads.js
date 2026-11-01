
try {
  var body = JSON.parse($response.body);

  if (body && body.data) {
    var data = body.data;

    // 1) response.json.delete(["data.mallConsumables", "data.currentUser.goodsCoupons"])
    delete data.mallConsumables;
    if (data.currentUser) {
      delete data.currentUser.goodsCoupons;
    }

    // 2) jq: if .data.systemConfig.searchHotTags? then del(.data.systemConfig) else . end
    //    存在搜索热词时, 整个 systemConfig(搜索填充词/搜索发现)都不要
    if (data.systemConfig && data.systemConfig.searchHotTags) {
      delete data.systemConfig;
    }

    // 3) jq: 场景化改版 2024 页面只保留 numType == "row" 的楼层(去掉推广楼层)
    var page = data.page;
    if (
      page &&
      page.__typename === "Page" &&
      page.name === "场景化改版 2024" &&
      page.firstTabDetail &&
      Array.isArray(page.firstTabDetail.floors)
    ) {
      page.firstTabDetail.floors = page.firstTabDetail.floors.filter(function (f) {
        return f && f.numType === "row";
      });
    }
  }

  $done({ body: JSON.stringify(body) });
} catch (e) {
  // 解析失败时放行原始响应, 避免影响正常功能
  $done({});
}
