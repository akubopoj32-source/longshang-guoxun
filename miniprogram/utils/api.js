const storageKey = "orchard-connection";
const statusNames = { draft: "草稿", pending: "待复核", confirmed: "已复核", returned: "已退回" };

function connection() {
  return wx.getStorageSync(storageKey) || { origin: "", token: "" };
}

function saveConnection(origin, token) {
  wx.setStorageSync(storageKey, { origin, token });
}

function request(path, data, options = connection()) {
  if (!options.origin || !options.token) return Promise.reject(new Error("请先配置服务地址和联调令牌。"));
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
        } else {
          const message = result?.error || "巡查服务返回错误。";
          reject(Object.assign(new Error(message), { status: statusCode, code: result?.code }));
        }
      },
      fail() {
        reject(new Error("无法连接巡查服务，请检查网络或刷新记录确认提交状态。"));
      },
    });
  });
}

function recordPath(id, operation = "") {
  return `/api/records/${id}${operation ? `/${operation}` : ""}?view=mobile`;
}

module.exports = { connection, saveConnection, request, recordPath, statusNames };
