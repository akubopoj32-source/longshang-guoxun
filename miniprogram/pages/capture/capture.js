const { request, recordPath, statusNames } = require("../../utils/api");
const { choosePhoto, readPhoto } = require("../../utils/photo");

const fieldStates = { recorded: "已记录", unknown: "待核实", conflict: "待核对" };

Page({
  data: {
    id: "", title: "", status: "", statusLabel: "", version: 0, fields: [], pending: [],
    editable: false, canSubmit: false, photoCount: 0, question: "", reviewNote: "",
    message: "", photo: "", busy: false, error: "", rulesFallback: false,
  },

  onLoad({ id }) {
    if (!/^[a-f0-9]{32}$/.test(id || "")) {
      this.setData({ error: "记录编号无效。" });
      return;
    }
    this.setData({ id });
    return this.refresh();
  },

  refresh() {
    if (!this.data.id) return;
    return this.run(async () => {
      const [config, result] = await Promise.all([
        request("/api/config"), request(recordPath(this.data.id)),
      ]);
      this.tasks = config.tasks;
      this.update(result);
    });
  },

  update({ record, pending, questions }) {
    const task = this.tasks[record.task];
    const editable = ["draft", "returned"].includes(record.status);
    const fields = Object.entries(task.fields).map(([key, label]) => ({
      key, label, value: record.fields[key]?.value || "待补充",
      state: fieldStates[record.fields[key]?.status] || "",
    }));
    this.setData({
      title: task.label, status: record.status, statusLabel: statusNames[record.status],
      version: record.version, fields, pending, editable, canSubmit: editable && record.turn_count > 0,
      question: questions[0] || (record.turn_count ? "可继续补充或提交复核。" : "请描述现场观察。"),
      reviewNote: record.review_note, photoCount: record.photo_count,
    });
  },

  editMessage(event) { this.setData({ message: event.detail.value }); },
  removePhoto() { this.setData({ photo: "" }); },

  attachPhoto() {
    return this.run(async () => {
      const photo = await choosePhoto();
      if (photo) this.setData({ photo });
    });
  },

  saveTurn(event) {
    return this.run(async () => {
      const { id, version, status, message, photo } = this.data;
      if (!message.trim() && !photo) throw new Error("请先输入描述或选择照片。");
      const image = await readPhoto(photo);
      const rulesOnly = event.currentTarget.dataset.rules === "yes";
      const result = await request(recordPath(id, "turn"), {
        version, status, message, image, rules_only: rulesOnly,
      });
      this.update(result);
      this.setData({ message: "", photo: "", rulesFallback: false });
    });
  },

  submitReview() {
    return this.run(async () => {
      const { id, version, status, message, photo } = this.data;
      if (message.trim() || photo) throw new Error("请先处理本轮输入，再提交复核。");
      this.update(await request(recordPath(id, "review"), { version, status, action: "submit" }));
    });
  },

  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      await action();
    } catch (error) {
      this.setData({ error: error.message });
      if (error.code === "model_unavailable") this.setData({ rulesFallback: true });
    } finally {
      this.setData({ busy: false });
    }
  },
});
