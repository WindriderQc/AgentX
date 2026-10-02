import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const queues = new Map();
export const digest = value => createHash("sha256").update(String(value)).digest("hex");
export const nowIso = () => new Date().toISOString();

export function privateOwnerContext(context, config) {
  if (context.agentId !== "main" || context.sandboxed) return false;
  // Household fixes this key server-side on its private route. The Gateway's
  // existing owner authentication remains authoritative; children never use it.
  if (/^agent:main:household:direct:[a-f0-9-]{36}$/.test(context.sessionKey || "")) return true;
  const match = /^agent:main:telegram:direct:([0-9]+)(?::thread:[0-9]+)?$/.exec(context.sessionKey || "");
  const owners = (config.channels?.telegram?.allowFrom || []).map(value => String(value).replace(/^telegram:/, "").trim());
  return Boolean(match && owners.includes(match[1]) && (!context.senderId || String(context.senderId) === match[1]));
}

function checkWorkspace(workspace) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error("Nestor workspace unavailable");
}

export async function serial(workspace, action) {
  checkWorkspace(workspace);
  const next = (queues.get(workspace) || Promise.resolve()).catch(() => {}).then(action);
  queues.set(workspace, next);
  try { return await next; }
  finally { if (queues.get(workspace) === next) queues.delete(workspace); }
}

export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

const freshState = () => ({ schemaVersion: 1, goal: null, receipts: [] });
const statePath = workspace => path.join(workspace, ".nestor", "context.json");
export async function readState(workspace) {
  checkWorkspace(workspace);
  try {
    const data = JSON.parse(await readFile(statePath(workspace), "utf8"));
    if (data.schemaVersion !== 1 || !Array.isArray(data.receipts)) throw new Error("Invalid Nestor context state");
    return data;
  } catch (error) { if (error.code === "ENOENT") return freshState(); throw error; }
}
export async function updateState(workspace, update) {
  return serial(workspace, async () => {
    const data = await update(await readState(workspace));
    await atomicWrite(statePath(workspace), JSON.stringify(data) + "\n");
    return data;
  });
}
