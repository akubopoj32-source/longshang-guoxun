const {
  connection, saveConnection, clearConnection, lastRecord, saveLastRecord,
  request, statusNames,
} = require("../../utils/api");
const { formatTime } = require("../../utils/present");
const { hasLocalDraft } = require("../../utils/draft");

const filters = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待复核" },
  { key: "confirmed", label: "已复核" },
  { key: "returned", label: "已退回" },
];

const connectionTimeout = 10000;

Page({
  data: {
    origin: "", token: "", showSettings: false, busy: false, connectionStage: "", error: "", notice: "",
    authMode: "account", username: "", password: "", currentUser: null,
    connected: false, tasks: [], taskIndex: 0, filter: "", query: "",
    filters, records: [], visibleRecords: [], totalCount: 0, mode: "", resumeId: "", resumeShort: "", offlineDraft: false,
  },

  onLoad() {
    const saved = connection();
    this.allRecords = [];
    this.config = null;
    this.loadedOnce = false;
    const resumeId = lastRecord();
    this.setData({
      origin: saved.origin,
      token: saved.auth === "account" ? "" : saved.token,
      username: saved.username || "",
      authMode: saved.auth || (saved.token ? "legacy" : "account"),
      showSettings: !saved.token,
      resumeId,
      resumeShort: resumeId.slice(0, 8),
      offlineDraft: Boolean(saved.token && resumeId && hasLocalDraft(resumeId)),
    });
    if (saved.origin && saved.token) this.refresh();
  },

  onShow() {
    // Returning from the capture page: refresh so status changes show up.
    if (connection().token && this.loadedOnce) this.refresh();
    this.loadedOnce = true;
  },

  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh());
  },

  toggleSettings() { this.setData({ showSettings: !this.data.showSettings }); },
  editOrigin(event) { this.setData({ origin: event.detail.value.trim() }); },
  editToken(event) { this.setData({ token: event.detail.value.trim() }); },
  editUsername(event) { this.setData({ username: event.detail.value.trim() }); },
  editPassword(event) { this.setData({ password: event.detail.value }); },
  chooseAuthMode(event) {
    this.setData({ authMode: event.currentTarget.dataset.mode, password: "", error: "" });
  },
  chooseTask(event) { this.setData({ taskIndex: Number(event.detail.value) }); },
  editQuery(event) { this.setData({ query: event.detail.value }); this.renderRecords(); },

  chooseFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.key });
    this.renderRecords();
  },

  async loadRecords(options) {
    const config = await this.loadConnectionData("/api/config", "读取任务配置", options);
    if (!config || !config.tasks || typeof config.tasks !== "object" || Array.isArray(config.tasks)) {
      throw new Error("巡查服务返回的任务配置格式无效。");
    }
    const result = await this.loadConnectionData("/api/records", "读取巡查列表", options);
    if (!Array.isArray(result?.records)) {
      throw new Error("巡查服务返回的记录列表格式无效。");
    }
    const tasks = Object.entries(config.tasks).map(([key, task]) => ({ key, label: task.label }));
    this.config = config;
    this.allRecords = result.records.map((record) => ({
      id: record.id,
      shortId: record.id.slice(0, 8),
      status: record.status,
      taskKey: record.task,
      taskLabel: (config.tasks[record.task] && config.tasks[record.task].label) || "巡查记录",
      location: record.location || "点位待补充",
      statusLabel: statusNames[record.status] || record.status,
      activity: formatTime(record.activity_at),
    }));
    const previousId = lastRecord();
    const resumeId = this.allRecords.some((record) => record.id === previousId) ? previousId : "";
    this.renderRecords({ tasks, mode: config.mode, connected: true, totalCount: this.allRecords.length,
      currentUser: config.user || null, resumeId, resumeShort: resumeId.slice(0, 8) });
  },

  async loadConnectionData(path, label, options) {
    this.setData({ connectionStage: `正在${label}…` });
    try {
      return await request(path, undefined, options, connectionTimeout);
    } catch (error) {
      if (["unauthorized", "no_connection", "session_required", "session_expired"].includes(error.code)) throw error;
      throw new Error(`${label}失败。${error.message}`);
    }
  },

  renderRecords(pageData = {}) {
    const { filter, query } = this.data;
    const needle = query.trim().replace(/^#/, "").toLowerCase();
    const visible = this.allRecords.filter((record) => {
      if (filter && record.status !== filter) return false;
      if (!needle) return true;
      return [record.location, record.taskLabel, record.id]
        .some((value) => value && String(value).toLowerCase().includes(needle));
    });
    this.setData({ visibleRecords: visible, records: visible, ...pageData });
  },

  refresh() {
    if (!connection().token) return Promise.resolve();
    return this.run(() => this.loadRecords());
  },

  async connect() {
    const origin = this.data.origin.trim().replace(/\/$/, "");
    const { authMode, username, password, token } = this.data;
    if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(origin)) {
      this.setData({ error: "请输入完整的服务地址。" });
      return;
    }
    if (authMode === "account" ? !username || !password : !token) {
      this.setData({ error: authMode === "account" ? "请输入巡查账号和密码。" : "请输入联调令牌。" });
      return;
    }
    await this.run(async () => {
      if (authMode === "account") {
        this.setData({ connectionStage: "正在登录…", password: "" });
        const result = await request("/api/session/login", { username, password }, { origin }, connectionTimeout);
        if (!/^[A-Za-z0-9_-]{43}$/.test(result?.token || "") || !result?.user?.username) {
          throw new Error("巡查服务返回的登录信息无效。");
        }
        saveConnection(origin, result.token, "account", result.user.username);
        this.setData({ username: result.user.username, token: "" });
        await this.loadRecords();
      } else {
        await this.loadRecords({ origin, token });
        saveConnection(origin, token);
      }
      this.setData({ origin, showSettings: false, taskIndex: 0 });
      wx.showToast({ title: authMode === "account" ? "登录成功" : "已连接巡查服务", icon: "success" });
    });
  },

  resetSession() {
    this.allRecords = [];
    this.config = null;
    this.setData({ connected: false, showSettings: true, currentUser: null, token: "", password: "",
      records: [], visibleRecords: [], totalCount: 0, resumeId: "", resumeShort: "", offlineDraft: false });
  },

  logout() {
    return this.run(async () => {
      const { origin, username } = connection();
      let notice = "已退出登录。";
      try {
        await request("/api/session/logout", {}, connection(), connectionTimeout);
      } catch (error) {
        if (error.code !== "session_expired" && error.code !== "session_required") {
          notice = "已退出本机。服务暂不可用，原会话将按有效期失效。";
        }
      }
      saveConnection(origin, "", "account", username);
      this.resetSession();
      this.setData({ notice });
    });
  },

  forgetService() {
    wx.showModal({
      title: "清除连接设置",
      content: "将清除本机保存的服务地址和连接信息。",
      success: ({ confirm }) => {
        if (!confirm) return;
        clearConnection();
        this.resetSession();
        this.setData({
          origin: "", username: "", mode: "", error: "", notice: "",
        });
      },
    });
  },

  createRecord() {
    return this.run(async () => {
      const task = this.data.tasks[this.data.taskIndex];
      if (!task) throw new Error("请选择巡查类型。");
      const result = await request("/api/records?view=mobile", { task: task.key });
      this.goToRecord(result.id);
    });
  },

  openRecord(event) {
    if (this.data.busy) return;
    this.goToRecord(event.currentTarget.dataset.id);
  },

  resumeRecord() {
    if (this.data.resumeId) this.goToRecord(this.data.resumeId);
  },

  goToRecord(id) {
    saveLastRecord(id);
    wx.navigateTo({ url: `/pages/capture/capture?id=${encodeURIComponent(id)}` });
  },

  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "", notice: "" });
    try {
      await action();
    } catch (error) {
      this.setData({ error: error.message });
      if (error.code === "unauthorized") this.setData({ showSettings: true, offlineDraft: false });
      if (error.code === "session_required" || error.code === "session_expired") {
        saveConnection(this.data.origin, "", "account", this.data.username);
        this.resetSession();
        this.setData({ authMode: "account" });
      }
    } finally {
      this.setData({ busy: false, connectionStage: "" });
    }
  },
});
