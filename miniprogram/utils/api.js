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

function saveConnection(origin, token, auth = "legacy", username = "") {
  wx.setStorageSync(storageKey, { origin, token, auth, username });
}

function clearConnection() {
  wx.removeStorageSync(storageKey);
}

function recordStorageKey() {
  const { auth, origin, username } = connection();
  return auth === "account" ? `${lastRecordKey}:${origin}:${username}` : lastRecordKey;
}

function lastRecord() {
  return wx.getStorageSync(recordStorageKey()) || "";
}

function saveLastRecord(id) {
  wx.setStorageSync(recordStorageKey(), id);
}

function authHeader(options) {
  if (!options.token) return {};
  return options.auth === "account"
    ? { Authorization: `Bearer ${options.token}` }
    : { "X-Orchard-Token": options.token };
}

function request(path, data, options = connection(), connectionTimeout) {
  if (!options.origin || (!options.token && path !== "/api/session/login")) {
    return Promise.reject(Object.assign(new Error("请先登录巡查服务。"), { code: "no_connection" }));
  }
  return new Promise((resolve, reject) => {
    const timeoutError = () => Object.assign(new Error("等待巡查服务响应超时，请稍后重试。"), { code: "network" });
    const requestOptions = {
      url: `${options.origin}${path}`,
      method: data ? "POST" : "GET",
      data,
      timeout: connectionTimeout ?? (path === "/api/transcribe" ? 65000 : 30000),
      header: { "content-type": "application/json", ...authHeader(options) },
      success({ statusCode, data: raw }) {
        clearTimeout(deadline);
        const ok = statusCode >= 200 && statusCode < 300;
        let result = raw;
        if (typeof raw === "string") {
          try {
            result = JSON.parse(raw);
          } catch {
            if (ok) {
              reject(new Error("巡查服务返回的内容无法解析。"));
              return;
            }
            result = undefined;
          }
        }
        if (ok) {
          resolve(result);
          return;
        }
        const message = (result && result.error) || "巡查服务返回错误。";
        const code = (result && result.code)
          || ({ 400: "bad_request", 401: "session_expired", 403: "unauthorized", 404: "not_found", 409: "stale" }[statusCode])
          || "server_error";
        reject(Object.assign(new Error(message), { status: statusCode, code }));
      },
      fail(detail) {
        clearTimeout(deadline);
        const timedOut = /timeout/i.test((detail && detail.errMsg) || "");
        reject(timedOut ? timeoutError() : Object.assign(
          new Error("无法连接巡查服务，请检查网络或刷新记录确认提交状态。"), { code: "network" },
        ));
      },
    };
    let task;
    const deadline = connectionTimeout ? setTimeout(() => {
      reject(timeoutError());
      task?.abort();
    }, connectionTimeout) : undefined;
    try {
      task = wx.request(requestOptions);
    } catch (error) {
      clearTimeout(deadline);
      reject(error);
    }
  });
}

function recordPath(id, operation = "") {
  return `/api/records/${id}${operation ? `/${operation}` : ""}?view=mobile`;
}

function downloadPhoto(id, turn) {
  const options = connection();
  if (!options.origin || !options.token) return Promise.reject(new Error("请先登录巡查服务。"));
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: `${options.origin}/api/records/${id}/turns/${turn}/photo`,
      header: authHeader(options),
      success({statusCode, tempFilePath}) {
        if (statusCode === 200 && tempFilePath) resolve(tempFilePath);
        else if (statusCode === 401) reject(Object.assign(new Error("登录已失效，请重新登录。"), { code: "session_expired" }));
        else reject(new Error("无法读取该轮原图，请刷新记录后重试。"));
      },
      fail() { reject(new Error("无法下载原图，请检查网络后重试。")); },
    });
  });
}

module.exports = {
  connection, saveConnection, clearConnection, lastRecord, saveLastRecord,
  request, recordPath, downloadPhoto,
  statusNames, fieldStates, reviewNames, fieldReviewNames,
};
