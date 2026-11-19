const { saveLastRecord, request, recordPath, downloadPhoto, statusNames } = require("../../utils/api");
const { presentRecord } = require("../../utils/present");
const { checklist, jsonReport, fileName, shareFile, copyText } = require("../../utils/export");
const { choosePhoto, readPhoto } = require("../../utils/photo");
const voice = require("../../utils/voice");

Page({
  data: {
    id: "", title: "", status: "", statusLabel: "", version: 0, mode: "",
    fields: [], pending: [], turns: [], alerts: [], revisions: [], reviews: [], fieldReviews: [],
    editable: false, canSubmit: false, photoCount: 0, question: "", reviewNote: "",
    message: "", photo: "", busy: false, busyLabel: "", error: "", notice: "",
    rulesFallback: false, showHistory: false,
    recording: false, recordSeconds: 0, voice: "", voiceDuration: "", transcribing: false, voiceTranscribed: false,
    canRecord: false, voiceReady: false, voiceNote: "",
    reviewField: "", reviewAction: "confirm", reviewValue: "", reviewNoteInput: "",
    reviewFieldLabel: "", reviewFieldValue: "", reviewFieldState: "", reviewEvidence: [],
    canConfirm: false, needsValue: false, fieldOptions: [],
  },

  onLoad({ id }) {
    this.tasks = null;
    if (!/^[a-f0-9]{32}$/.test(id || "")) {
      this.setData({ error: "记录编号无效。" });
      return null;
    }
    saveLastRecord(id);
    this.setData({ id });
    return this.refresh();
  },

  onPullDownRefresh() {
    return this.refresh().then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh());
  },

  onUnload() {
    this.unloaded = true;
    this.clearTimer();
    if (this.data.recording) voice.stop();
  },

  onHide() {
    // Leaving the page mid-recording would otherwise keep the mic open.
    if (this.data.recording) {
      voice.stop();
      this.clearTimer();
    }
  },

  /** Reload config + record; used on entry, refresh, and after a stale write. */
  async load() {
    const [config, result] = await Promise.all([
      request("/api/config"), request(recordPath(this.data.id)),
    ]);
    this.tasks = config.tasks;
    const canRecord = voice.canRecord();
    this.setData({
      mode: config.mode,
      voiceReady: Boolean(config.voice),
      canRecord,
      voiceNote: !canRecord ? ""
        : config.voice ? "" : "服务端未配置语音转写，可手动补充文字。",
    });
    this.apply(result);
  },

  refresh() {
    if (!this.data.id) return Promise.resolve();
    return this.run(() => this.load());
  },

  apply(result) {
    const record = result.record;
    const task = this.tasks[record.task];
    const view = presentRecord(record, task);
    const editable = ["draft", "returned"].includes(record.status);
    this.setData({
      title: task.label,
      status: record.status,
      statusLabel: statusNames[record.status] || record.status,
      version: record.version,
      fields: view.fields,
      turns: view.turns,
      alerts: view.alerts,
      revisions: view.revisions,
      reviews: view.reviews,
      fieldReviews: view.fieldReviews,
      pending: result.pending || [],
      editable,
      canSubmit: editable && record.turn_count > 0,
      question: (result.questions && result.questions[0])
        || (record.turn_count ? "可继续补充，或提交复核。" : "请描述现场观察。"),
      reviewNote: record.review_note || "",
      photoCount: record.photo_count,
      fieldOptions: Object.entries(task.fields).map(([key, label]) => ({ key, label })),
      reviewField: "",
      reviewValue: "",
      reviewNoteInput: "",
      reviewAction: "confirm",
      reviewEvidence: [],
      canConfirm: false,
      needsValue: false,
    });
  },

  editMessage(event) { this.setData({ message: event.detail.value }); },
  removePhoto() { this.setData({ photo: "" }); },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }); },
  editReviewValue(event) { this.setData({ reviewValue: event.detail.value }); },
  editReviewNote(event) { this.setData({ reviewNoteInput: event.detail.value }); },

  attachPhoto() {
    return this.run(async () => {
      const photo = await choosePhoto();
      if (photo) this.setData({ photo });
    }, "正在读取照片…");
  },

  /** Start or stop recording, whichever the button is doing right now. */
  toggleRecord() {
    if (this.data.recording) {
      voice.stop();
      return Promise.resolve();
    }
    return this.startRecord();
  },

  async startRecord() {
    if (this.data.busy || this.data.transcribing) return;
    if (!this.data.canRecord) {
      this.setData({ error: "当前环境不支持录音。" });
      return;
    }
    this.setData({ error: "", notice: "", recording: true, recordSeconds: 0 });
    this.timer = setInterval(() => {
      this.setData({ recordSeconds: this.data.recordSeconds + 1 });
    }, 1000);
    try {
      const clip = await voice.record();
      this.clearTimer();
      if (this.unloaded) return;
      this.setData({ recording: false });
      if (!clip) return;
      this.setData({
        voice: clip.tempFilePath,
        voiceDuration: voice.formatDuration(clip.duration || this.data.recordSeconds * 1000),
        voiceTranscribed: false,
      });
      await this.transcribeVoice();
    } catch (error) {
      this.clearTimer();
      if (!this.unloaded) this.setData({ recording: false, error: error.message });
    }
  },

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  /** Transcribe the current clip and append it to the description. */
  transcribeVoice() {
    if (!this.data.voice || this.data.voiceTranscribed) return Promise.resolve();
    if (!this.data.voiceReady) {
      this.setData({ notice: "录音保留在当前页面，请手动补充文字。" });
      return Promise.resolve();
    }
    return this.run(async () => {
      this.setData({ transcribing: true });
      const transcript = await voice.transcribe(this.data.voice, this.data.title);
      const merged = [this.data.message.trim(), transcript].filter(Boolean).join(" ");
      if (merged.length > 2000) throw new Error("描述与转写合计超过 2000 字，请缩短描述后重试。");
      this.setData({ message: merged, voiceTranscribed: true, notice: "语音已转写，请核对文字后再保存。" });
    }, "正在转写语音…").finally(() => this.setData({ transcribing: false }));
  },

  removeVoice() {
    if (this.data.transcribing) return;
    voice.stop();
    this.clearTimer();
    this.setData({ voice: "", voiceDuration: "", voiceTranscribed: false, recording: false, recordSeconds: 0 });
  },

  /** Re-run transcription for the current clip. */
  retryTranscribe() {
    return this.transcribeVoice();
  },

  saveTurn(event) {
    if (this.data.recording) return;
    const rulesOnly = event.currentTarget.dataset.rules === "yes";
    return this.run(async () => {
      const { id, version, status, message, photo } = this.data;
      if (!message.trim() && !photo) throw new Error("请先输入描述或选择照片。");
      const image = await readPhoto(photo);
      const result = await request(recordPath(id, "turn"), {
        version, status, message, image, rules_only: rulesOnly,
      });
      this.apply(result);
      this.setData({
        message: "", photo: "", rulesFallback: false,
        voice: "", voiceDuration: "", voiceTranscribed: false, recordSeconds: 0,
        notice: "本轮输入已保存。",
      });
    }, "正在处理本轮输入…", true);
  },

  submitReview() {
    if (this.data.recording) return;
    return this.run(async () => {
      const { id, version, status, message, photo } = this.data;
      if (message.trim() || photo) throw new Error("请先处理本轮输入，再提交复核。");
      this.apply(await request(recordPath(id, "review"), { version, status, action: "submit" }));
      this.setData({ notice: "已提交电脑端复核。" });
    }, "正在提交复核…");
  },

  chooseReviewField(event) {
    const key = event.currentTarget.dataset.key;
    const field = this.data.fields.find((item) => item.key === key);
    const recorded = Boolean(field && field.status === "recorded");
    this.setData({
      reviewField: key,
      reviewFieldLabel: field ? field.label : "",
      reviewFieldValue: field ? field.value : "待补充",
      reviewFieldState: field ? field.state : "",
      reviewEvidence: field ? field.evidence : [],
      canConfirm: recorded,
      reviewAction: recorded ? "confirm" : "mark_unknown",
      needsValue: false,
      reviewValue: "",
    });
  },

  chooseReviewAction(event) {
    const action = event.detail.value;
    this.setData({ reviewAction: action, needsValue: action === "correct" });
  },

  setReviewAction(event) {
    const action = event.currentTarget.dataset.action;
    if (action === "confirm" && !this.data.canConfirm) return;
    this.setData({ reviewAction: action, needsValue: action === "correct" });
  },

  /** Jump to the turn an evidence link points at. */
  scrollToEvidence(event) {
    const anchor = event.currentTarget.dataset.anchor;
    if (!anchor) return;
    this.setData({ notice: "" });
    wx.pageScrollTo({
      selector: `#${anchor}`,
      duration: 250,
      fail() { wx.showToast({ title: "该轮证据暂不可见", icon: "none" }); },
    });
  },

  previewImage(event) {
    const turn = Number(event.currentTarget.dataset.turn);
    if (!Number.isSafeInteger(turn) || turn < 1) return;
    return this.run(async () => {
      const path = await downloadPhoto(this.data.id, turn);
      wx.previewImage({ urls: [path], current: path });
    }, "正在读取原图…");
  },

  saveFieldReview() {
    const fieldKey = this.data.reviewField;
    return this.run(async () => {
      const { id, version, status, reviewAction, reviewValue, reviewNoteInput } = this.data;
      if (!fieldKey) throw new Error("请选择要复核的字段。");
      if (reviewAction === "correct") {
        if (!reviewValue.trim()) throw new Error("请填写更正值。");
        if (!reviewNoteInput.trim()) throw new Error("请填写更正依据。");
      }
      const label = this.data.reviewFieldLabel || fieldKey;
      this.apply(await request(recordPath(id, "field-review"), {
        version, status, field: fieldKey, action: reviewAction,
        value: reviewAction === "correct" ? reviewValue : "",
        note: reviewNoteInput,
      }));
      this.setData({ notice: `已保存「${label}」的复核判断。` });
    }, "正在保存字段判断…");
  },

  exportChecklist() {
    return this.run(async () => {
      const data = await request(recordPath(this.data.id));
      const name = fileName(data.id, data.record.version, "md");
      const message = await shareFile(name, checklist(data, this.tasks[data.record.task]));
      if (message) this.setData({ notice: message });
    }, "正在生成复查单…");
  },

  exportJson() {
    return this.run(async () => {
      const data = await request(`/api/records/${this.data.id}`);
      const name = fileName(data.id, data.record.version, "json");
      const message = await shareFile(name, jsonReport(data, this.tasks[data.record.task]));
      if (message) this.setData({ notice: message });
    }, "正在导出记录…");
  },

  copyChecklist() {
    return this.run(async () => {
      const data = await request(recordPath(this.data.id));
      const message = await copyText(checklist(data, this.tasks[data.record.task]));
      this.setData({ notice: message });
    }, "正在生成复查单…");
  },

  async run(action, label = "正在处理…", allowRulesFallback = false) {
    if (this.data.busy) return;
    this.setData({ busy: true, busyLabel: label, error: "", notice: "" });
    try {
      await action();
    } catch (error) {
      this.setData({ error: error.message });
      if (allowRulesFallback && error.code === "model_unavailable") this.setData({ rulesFallback: true });
      // A stale write means another page changed the record; reload so the
      // user works against the current version instead of retrying blindly.
      if (error.code === "stale") {
        try { await this.load(); } catch (ignored) { /* keep the stale message. */ }
      }
      if (error.code === "not_found" || error.code === "unauthorized") {
        this.setData({ editable: false, canSubmit: false });
      }
    } finally {
      this.setData({ busy: false, busyLabel: "" });
    }
  },
});
