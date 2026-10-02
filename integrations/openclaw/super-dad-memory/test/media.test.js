import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { mediaFile, mediaHttpHandler, mediaRoot } from "../media.js";

function fixture() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-media-"));
  const root = path.join(state, "media");
  fs.mkdirSync(path.join(root, "tool-image-generation"), { recursive: true });
  fs.writeFileSync(path.join(root, "tool-image-generation", "mind.png"), "png-bytes");
  fs.writeFileSync(path.join(root, "tool-image-generation", "voice.mp3"), "audio");
  fs.writeFileSync(path.join(state, "outside.png"), "outside");
  // Windows refuses symbolic links without Developer Mode; the escape is then covered on Linux.
  let linked = true;
  try { fs.symlinkSync(path.join(state, "outside.png"), path.join(root, "link.png")); }
  catch (error) { if (process.platform !== "win32" || error.code !== "EPERM") throw error; linked = false; }
  return { state, root, linked };
}

async function call(handler, method, url) {
  const res = new PassThrough();
  const chunks = [];
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.on("data", chunk => chunks.push(chunk));
  await handler({ method, url }, res);
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() };
}

test("the media root follows the OpenClaw state directory unless configured", () => {
  const state = path.resolve("srv", "example", "state"), pictures = path.resolve("srv", "example", "pictures");
  assert.equal(mediaRoot({ OPENCLAW_STATE_DIR: state }), path.join(state, "media"));
  assert.equal(mediaRoot({}, pictures), pictures);
  assert.equal(mediaRoot({ OPENCLAW_STATE_DIR: "" }), path.join(os.homedir(), ".openclaw", "media"));
});

test("only an image inside the media directory is served", async () => {
  const { state, root, linked } = fixture();
  const handler = mediaHttpHandler(root);
  const image = path.join(root, "tool-image-generation", "mind.png");
  const ok = await call(handler, "GET", "/api/nestor/media?path=" + encodeURIComponent(image));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "image/png");
  assert.equal(ok.body, "png-bytes");
  for (const requested of [path.join(root, "tool-image-generation", "voice.mp3"), path.join(state, "outside.png"),
    ...(linked ? [path.join(root, "link.png")] : []), path.join(root, "tool-image-generation", "..", "..", "outside.png"), "relative.png", ""]) {
    assert.equal(mediaFile(root, requested), null, requested);
    assert.equal((await call(handler, "GET", "/api/nestor/media?path=" + encodeURIComponent(requested))).status, 404, requested);
  }
  assert.equal((await call(handler, "POST", "/api/nestor/media?path=" + encodeURIComponent(image))).status, 405);
});
