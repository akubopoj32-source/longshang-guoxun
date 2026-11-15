const {
  connection, saveConnection, clearConnection, lastRecord, saveLastRecord,
  request, statusNames,
} = require("../../utils/api");
const { formatTime } = require("../../utils/present");

const filters = [
  { key: "", label: "全部" },
  { key: "draft", label: "草稿" },
  { key: "pending", label: "待复核" },
  { key: "confirmed", label: "已复核" },
  { key: "returned", label: "已退回" },
];

Page({
  data: {
    origin: "", token: "", showSettings: false, busy: false, error: "", notice: "",
    connected: false, tasks: [], taskIndex: 0, filter: "", query: "",
    filters, records: [], visibleRecords: [], totalCount: 0, mode: "", resumeId: "", resumeShort: "",
  },

  onLoad() {
    const saved = connection();
    this.allRecords = [];
    this.config = null;
    this.loadedOnce = false;
    const resumeId = lastRecord();
    this.setData({
      ...saved,
      showSettings: !saved.origin,
      resumeId,
      resumeShort: resumeId.slice(0, 8),
    });
    if (saved.origin) this.refresh();
  },

  onShow() {
    // Returning from the capture page: refresh so status changes show up.
    if (connection().origin && this.loadedOnce) this.refresh();
    this.loadedOnce = true;
  },

  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh());
  },

  toggleSettings() { this.setData({ showSettings: !this.data.showSettings }); },
  editOrigin(event) { this.setData({ origin: event.detail.value.trim() }); },
  editToken(event) { this.setData({ token: event.detail.value.trim() }); },
  chooseTask(event) { this.setData({ taskIndex: Number(event.detail.value) }); },
  editQuery(event) { this.setData({ query: event.detail.value }); this.renderRecords(); },

  chooseFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.key });
    this.renderRecords();
  },

  async loadRecords(options) {
    const [config, result] = await Promise.all([
      request("/api/config", undefined, options), request("/api/records", undefined, options),
    ]);
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
    this.setData({ tasks, mode: config.mode, connected: true, totalCount: this.allRecords.length });
    this.renderRecords();
  },

  renderRecords() {
    const { filter, query } = this.data;
    const needle = query.trim().replace(/^#/, "").toLowerCase();
    const visible = this.allRecords.filter((record) => {
      if (filter && record.status !== filter) return false;
      if (!needle) return true;
      return [record.location, record.taskLabel, record.id]
        .some((value) => value && String(value).toLowerCase().includes(needle));
    });
    this.setData({ visibleRecords: visible, records: visible });
  },

  refresh() {
    return this.run(() => this.loadRecords());
  },

  async connect() {
    const origin = this.data.origin.trim().replace(/\/$/, "");
    const token = this.data.token.trim();
    if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(origin) || !token) {
      this.setData({ error: "请输入完整的服务地址和联调令牌。" });
      return;
    }
    await this.run(async () => {
      await this.loadRecords({ origin, token });
      saveConnection(origin, token);
      const resumeId = lastRecord();
      this.setData({
        origin, token, showSettings: false, taskIndex: 0,
        resumeId, resumeShort: resumeId.slice(0, 8),
      });
      wx.showToast({ title: "已连接巡查服务", icon: "success" });
    });
  },

  forgetService() {
    wx.showModal({
      title: "清除连接设置",
      content: "将清除本机保存的服务地址和联调令牌。",
      success: ({ confirm }) => {
        if (!confirm) return;
        clearConnection();
        this.allRecords = [];
        this.setData({
          origin: "", token: "", connected: false, showSettings: true, mode: "",
          records: [], visibleRecords: [], totalCount: 0, error: "", notice: "",
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
      if (error.code === "unauthorized") this.setData({ showSettings: true });
    } finally {
      this.setData({ busy: false });
    }
  },
});