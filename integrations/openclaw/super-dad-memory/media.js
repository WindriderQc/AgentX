import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Household shows a picture an OpenClaw tool produced (its reply cites it as
// MEDIA:<path>). Only an image file inside OpenClaw's own media directory is
// served, to the gateway-authenticated caller, read-only. No listing, no other
// directory, no other file type.
const IMAGE_TYPES = Object.freeze({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" });
const MAX_BYTES = 20 * 1024 * 1024;

export function mediaRoot(env = process.env, configured = "") {
  return path.resolve(configured || path.join(env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "media"));
}

export function mediaFile(root, requested) {
  const value = String(requested || "");
  const type = IMAGE_TYPES[path.extname(value).toLowerCase()];
  if (!type || value.includes("\0") || !path.isAbsolute(value)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const file = fs.realpathSync(value);
    const stat = fs.statSync(file);
    if (!file.startsWith(realRoot + path.sep) || !stat.isFile() || stat.size > MAX_BYTES) return null;
    return { file, type, size: stat.size };
  } catch { return null; }
}

export function mediaHttpHandler(root) {
  return async (req, res) => {
    const fail = status => { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify({ ok: false })); return true; };
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return fail(405); }
    const requested = new URL(req.url || "/", "http://gateway.local").searchParams.get("path");
    const media = mediaFile(root, requested);
    if (!media) return fail(404);
    res.statusCode = 200;
    res.setHeader("Content-Type", media.type);
    res.setHeader("Content-Length", String(media.size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await new Promise(resolve => fs.createReadStream(media.file).on("error", () => { res.destroy(); resolve(); }).on("end", resolve).pipe(res));
    return true;
  };
}
