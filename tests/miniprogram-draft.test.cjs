const assert = require("node:assert/strict");
const { test } = require("node:test");

let definition;
global.Page = page => { definition = page; };
require("../miniprogram/pages/capture/capture");
const capturePage = definition;
require("../miniprogram/pages/index/index");
const indexPage = definition;
const { draftKey } = require("../miniprogram/utils/draft");

const recordId = "a".repeat(32);
const photoBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/N5kAAAAASUVORK5CYII=", "base64");
const processInput = { currentTarget: { dataset: {} } };

function page(definition) {
  return { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
}

function environment() {
  const settings = { origin: "http://127.0.0.1:8890", token: "test-token", auth: "account", username: "test.a" };
  const storage = new Map([["orchard-connection", settings]]);
  const files = new Map([["temporary-photo", photoBytes]]);
  const remote = {
    task: "trap", status: "draft", version: 0, turns: [], turn_count: 0, photo_count: 0,
    fields: {}, reviews: [], revisions: [], field_reviews: [], evidence_alerts: [],
  };
  const handlers = { offline: false, nextWrite: "", attempts: [], remote, files, storage };
  const record = () => ({ id: recordId, record: remote, pending: [], questions: [] });
  const sdk = {
    readFile({ filePath, success, fail }) {
      const data = files.get(filePath);
      if (data) success({ data: Uint8Array.from(data).buffer });
      else fail();
    },
    writeFile({ filePath, data, encoding, success }) { files.set(filePath, Buffer.from(data, encoding)); success(); },
    unlink({ filePath }) { files.delete(filePath); },
  };
  global.wx = {
    env: { USER_DATA_PATH: "wxfile://usr" },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => sdk,
    arrayBufferToBase64: bytes => Buffer.from(bytes).toString("base64"),
    chooseMedia: ({ success }) => success({ tempFiles: [{ size: photoBytes.length, tempFilePath: "temporary-photo" }] }),
    request(options) {
      const reply = (value, statusCode = 200) => options.success({ statusCode, data: structuredClone(value) });
      queueMicrotask(() => {
        if (handlers.offline) return options.fail({ errMsg: "offline" });
        const path = new URL(options.url).pathname;
        if (path === "/api/config") return reply({ access: "inspector", mode: "demo", tasks: { trap: { label: "诱捕监测", fields: {} } } });
        if (path === "/api/records") return reply({ records: [{ id: recordId, task: "trap", status: remote.status }] });
        if (path.endsWith("/review")) {
          remote.status = "pending";
          return options.fail({ errMsg: "timeout" });
        }
        if (!path.endsWith("/turn")) return reply(record());
        const data = structuredClone(options.data);
        handlers.attempts.push(data);
        const failure = handlers.nextWrite;
        handlers.nextWrite = "";
        if (failure === "before") return options.fail({ errMsg: "timeout" });
        if (failure === "model") return reply({ code: "model_unavailable", error: "模型不可用" }, 502);
        remote.version++;
        remote.turns.push({ id: remote.version, message: data.message, has_image: Boolean(data.image), submission_id: data.submission_id });
        remote.turn_count = remote.turns.length;
        remote.photo_count += Number(Boolean(data.image));
        if (failure === "after") return options.fail({ errMsg: "timeout" });
        return reply(record());
      });
      return { abort() {} };
    },
  };
  return handlers;
}

test("restores a scoped photo draft offline and recognizes a saved response after reopening", async () => {
  const env = environment();
  const first = page(capturePage);
  await first.onLoad({ id: recordId });
  first.editMessage({ detail: { value: "三号监测点看到两只疑似虫体" } });
  await first.attachPhoto();
  const savedPhoto = first.data.photo;
  assert.ok(env.files.has(savedPhoto));
  env.files.delete("temporary-photo");
  first.onUnload();

  env.offline = true;
  const home = page(indexPage);
  home.onLoad();
  assert.equal(home.data.offlineDraft, true);
  const reopened = page(capturePage);
  await reopened.onLoad({ id: recordId });
  assert.equal(reopened.data.message, first.data.message);
  assert.equal(reopened.data.photo, savedPhoto);
  assert.equal(reopened.data.editable, false);
  env.offline = false;
  await reopened.refresh();
  env.nextWrite = "after";
  await reopened.saveTurn(processInput);
  assert.equal(reopened.data.awaitingSave, true);
  assert.equal(env.remote.turn_count, 1);
  reopened.editMessage({ detail: { value: "覆盖" } });
  assert.equal(reopened.data.message, first.data.message);

  const original = env.storage.get("orchard-connection");
  env.storage.set("orchard-connection", { ...original, username: "test.b" });
  const other = page(capturePage);
  await other.onLoad({ id: recordId });
  assert.equal(other.data.message, "");
  assert.equal(other.data.photo, "");
  env.storage.set("orchard-connection", original);
  const synced = page(capturePage);
  await synced.onLoad({ id: recordId });
  assert.match(synced.data.notice, /此前已保存/);
  assert.equal(env.storage.has(draftKey(recordId)), false);
  assert.equal(env.files.has(savedPhoto), false);
  assert.equal(env.attempts.length, 1);
});

test("retries the exact same submission after a request is lost before saving", async () => {
  const env = environment();
  const capture = page(capturePage);
  await capture.onLoad({ id: recordId });
  capture.editMessage({ detail: { value: "本轮文字" } });
  env.nextWrite = "before";
  await capture.saveTurn(processInput);
  assert.equal(capture.data.awaitingSave, true);
  assert.equal(env.remote.turn_count, 0);
  await capture.refresh();
  assert.equal(capture.data.awaitingSave, true);
  await capture.saveTurn(processInput);
  assert.deepEqual(env.attempts[0], env.attempts[1]);
  assert.equal(env.remote.turn_count, 1);
  assert.equal(capture.data.awaitingSave, false);
  await capture.submitReview();
  assert.equal(capture.data.status, "pending");
  assert.match(capture.data.notice, /已提交/);
});

test("keeps the draft editable and allows rules fallback after a confirmed model failure", async () => {
  const env = environment();
  const capture = page(capturePage);
  await capture.onLoad({ id: recordId });
  capture.editMessage({ detail: { value: "本轮文字" } });
  env.nextWrite = "model";
  await capture.saveTurn(processInput);
  assert.equal(capture.data.awaitingSave, false);
  assert.equal(capture.data.rulesFallback, true);
  await capture.saveTurn({ currentTarget: { dataset: { rules: "yes" } } });
  assert.notEqual(env.attempts[0].submission_id, env.attempts[1].submission_id);
  assert.equal(env.attempts[1].rules_only, true);
  assert.equal(env.remote.turn_count, 1);
});

test("keeps text when a pending photo becomes unavailable and reconciles before replacing it", async () => {
  const env = environment();
  const capture = page(capturePage);
  await capture.onLoad({ id: recordId });
  capture.editMessage({ detail: { value: "本轮文字" } });
  await capture.attachPhoto();
  env.nextWrite = "before";
  await capture.saveTurn(processInput);
  env.files.delete(capture.data.photo);
  await capture.saveTurn(processInput);
  assert.equal(env.attempts.length, 1);
  assert.match(capture.data.error, /刷新核对/);
  await capture.refresh();
  assert.equal(capture.data.photo, "");
  assert.equal(capture.data.message, "本轮文字");
  assert.equal(capture.data.awaitingSave, false);
  await capture.attachPhoto();
  await capture.saveTurn(processInput);
  assert.equal(env.remote.turn_count, 1);
  assert.equal(env.remote.photo_count, 1);
});
