const storageKey = "orchard-connection";
const lastRecordKey = "orchard-last-record";
const statusNames = { draft: "草稿", pending: "待复核", confirmed: "已复核", returned: "已退回" };
const fieldStates = { recorded: "已记录", unknown: "待核实", conflict: "待核对" };
const reviewNames = { submit: "提交复核", confirm: "确认记录", return: "退回补充" };
const fieldReviewNames = { confirm: "确认现值", correct: "人工更正", mark_unknown: "标记为待核实" };

function connection() {
  const saved = wx.getStorageSync(storageKey);
  return saved && typeof saved === "object" ? saved : { origin: "", token: "" };
}

function saveConnection(origin, token) {
  wx.setStorageSync(storageKey, { origin, token });
}

function clearConnection() {
  wx.removeStorageSync(storageKey);
}

function lastRecord() {
  return wx.getStorageSync(lastRecordKey) || "";
}

function saveLastRecord(id) {
  wx.setStorageSync(lastRecordKey, id);
}

function request(path, data, options = connection()) {
  if (!options.origin || !options.token) {
    return Promise.reject(Object.assign(new Error("请先配置服务地址和联调令牌。"), { code: "no_connection" }));
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${options.origin}${path}`,
      method: data ? "POST" : "GET",
      data,
      timeout: 30000,
      header: { "content-type": "application/json", "X-Orchard-Token": options.token },
      success({ statusCode, data: result }) {
        if (statusCode >= 200 && statusCode < 300) {
          resolve(result);
          return;
        }
        const message = (result && result.error) || "巡查服务返回错误。";
        const code = (result && result.code)
          || ({ 400: "bad_request", 403: "unauthorized", 404: "not_found", 409: "stale" }[statusCode])
          || "server_error";
        reject(Object.assign(new Error(message), { status: statusCode, code }));
      },
      fail(detail) {
        const timedOut = /timeout/i.test((detail && detail.errMsg) || "");
        reject(Object.assign(
          new Error(timedOut ? "等待巡查服务响应超时，请稍后重试。" : "无法连接巡查服务，请检查网络或刷新记录确认提交状态。"),
          { code: "network" },
        ));
      },
    });
  });
}

function recordPath(id, operation = "") {
  return `/api/records/${id}${operation ? `/${operation}` : ""}?view=mobile`;
}

module.exports = {
  connection, saveConnection, clearConnection, lastRecord, saveLastRecord,
  request, recordPath,
  statusNames, fieldStates, reviewNames, fieldReviewNames,
};