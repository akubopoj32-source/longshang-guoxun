const { connection, saveConnection, request, statusNames } = require("../../utils/api");

Page({
  data: {
    origin: "", token: "", showSettings: true, busy: false, error: "",
    connected: false, tasks: [], taskIndex: 0, records: [], mode: "",
  },

  onLoad() {
    const saved = connection();
    this.setData({ ...saved, showSettings: !saved.origin });
  },

  onShow() {
    if (connection().origin) return this.refresh();
  },

  toggleSettings() { this.setData({ showSettings: !this.data.showSettings }); },
  editOrigin(event) { this.setData({ origin: event.detail.value }); },
  editToken(event) { this.setData({ token: event.detail.value }); },
  chooseTask(event) { this.setData({ taskIndex: Number(event.detail.value) }); },

  async loadRecords(options) {
    const [config, result] = await Promise.all([
      request("/api/config", undefined, options), request("/api/records", undefined, options),
    ]);
    const tasks = Object.entries(config.tasks).map(([key, task]) => ({ key, label: task.label }));
    const records = result.records.map((record) => ({
      id: record.id, shortId: record.id.slice(0, 8), status: record.status,
      taskLabel: config.tasks[record.task]?.label || "巡查记录",
      location: record.location || "点位待补充", statusLabel: statusNames[record.status],
    }));
    this.setData({ tasks, records, mode: config.mode, connected: true });
  },

  refresh() {
    return this.run(() => this.loadRecords());
  },

  connect() {
    return this.run(async () => {
      const origin = this.data.origin.trim().replace(/\/$/, "");
      const token = this.data.token.trim();
      if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(origin) || !token) {
        throw new Error("请输入完整的服务地址和联调令牌。");
      }
      await this.loadRecords({ origin, token });
      saveConnection(origin, token);
      this.setData({ origin, token, showSettings: false, taskIndex: 0 });
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
    if (!this.data.busy) this.goToRecord(event.currentTarget.dataset.id);
  },

  goToRecord(id) {
    wx.navigateTo({ url: `/pages/capture/capture?id=${encodeURIComponent(id)}` });
  },

  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      await action();
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
});
