import { digest, nowIso, readState, updateState } from "./store.js";
import { nativeActionProvenance } from '../action-provenance.mjs';

export function decodeResult(result) {
  if (result?.isError) return { error: "tool_error" };
  if (result?.structuredContent) return result.structuredContent;
  // Native OpenClaw MCP keeps the server payload inside transport details.
  if (result?.details?.structuredContent) return result.details.structuredContent;
  if (result?.details) return result.details;
  const text = result?.content?.find(item => item.type === "text")?.text;
  if (text) { try { return JSON.parse(text); } catch { return null; } }
  return result && typeof result === "object" ? result : null;
}

export async function agentxRead(baseUrl, name, args, fetchImpl = fetch) {
  if (!["list_personal_tasks", "personal_briefing", "rag_search", "network_devices", "storage_summary", "find_files", "gpu_status"].includes(name)) throw new Error("Unsupported Nestor read");
  const response = await fetchImpl(new URL("/mcp", baseUrl), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "nestor-read", method: "tools/call", params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error("AgentX source unavailable");
  const body = await response.json();
  // A refused argument is the caller's to correct; it is not an outage.
  const refused = body.result?.isError ? body.result.structuredContent : null;
  if (refused?.error === "INVALID_ARGUMENTS") throw new Error(`Invalid request: ${String(refused.message || "").slice(0, 300)}`);
  const data = decodeResult(body.result);
  if (body.error || body.result?.isError || !data || data.error || data.ok === false) throw new Error("AgentX source unavailable");
  return data;
}

export async function contextFor(workspace, query, { includeMemory = false, includeTasks = false, sessionKey, readTasks, readNotes } = {}) {
  const state = await readState(workspace);
  const memoryConsulted = includeMemory;
  const memory = memoryConsulted ? await readNotes({ action: 'context', query, limit: 4 }) : { notes: [] };
  const notes = memory.notes.slice(0, 4).map(note => ({ id: note.id, kind: note.kind,
    sourceRef: 'agentx-note:' + note.id, text: note.text.slice(0, 800),
    textTruncated: note.text.length > 800, expiresAt: note.expiresAt }));
  // The continuity endpoint retains full evidence. Conversational context only
  // needs recent outcomes from this native session, never another chat's calls.
  const receipts = sessionKey ? state.receipts.filter(r => r.sessionKey === sessionKey).slice(-4)
    .map(({ id, tool, status, resultRef, observed, deliveryState, at, queueRequest }) =>
      ({ id, tool, status, resultRef, observed, deliveryState, at, ...(queueRequest && { queueRequest }) })) : [];
  const result = { generatedAt: nowIso(), notes,
    previousGoal: state.goal && Date.now() - Date.parse(state.goal.at) < 86400000 ? state.goal : null,
    receipts, sources: { personal_memory: memoryConsulted ? "available" : "not_consulted", calendar: "not_connected", ledger: "not_connected" } };
  if (includeTasks) {
    try {
      const data = await readTasks();
      if (!Array.isArray(data.tasks)) throw new Error("Invalid task response");
      result.tasks = data.tasks.slice(0, 12).map(({ id, title, status, dueAt, dueLocal, relevantUntilLocal,
        priority, lane, dueToday, overdue, recheck, expired }) =>
        ({ id, title, status, dueAt, dueLocal, relevantUntilLocal, priority, lane, dueToday, overdue, recheck, expired }));
      result.sources.personal_tasks = "available";
      result.taskCoverage = { returned: result.tasks.length,
        total: Number.isInteger(data.totalCount) ? data.totalCount : null,
        hasMore: data.hasMore === true || data.tasks.length > result.tasks.length,
        dueTodayCount: data.dueTodayCount, overdueCount: data.overdueCount,
        todayLocal: data.todayLocal, fullReadTool: 'list_personal_tasks' };
    } catch { result.sources.personal_tasks = "unavailable"; }
  }
  return result;
}

export async function recordTool(workspace, event, context, { config, pluginConfig } = {}) {
  const tool = String(event.toolName || "");
  if (!tool || ['tool_call', 'tool_search'].includes(tool)) return;
  const data = decodeResult(event.result);
  const healthTool = ['agentx__check_health', 'check_health'].includes(tool);
  const healthResult = healthTool && typeof data?.ok === 'boolean'
    && typeof data?.core?.mongodb === 'string' && typeof data?.core?.ollama === 'string'
    && typeof data?.rag?.ok === 'boolean';
  const failed = Boolean(event.error || event.result?.isError || data?.error || (data?.ok === false && !healthResult));
  const task = data?.task || data;
  const soundTool = ['agentx__get_sound', 'get_sound'].includes(tool);
  const soundId = !failed && soundTool && data?.status === 'available'
    && /^[a-z][a-z0-9-]{0,63}$/.test(data?.sound?.id || '') ? data.sound.id : null;
  const localImage = ['local_image', 'imagex'].includes(tool) && data?.ok === true && data?.operation?.id;
  const imageOperation = !failed && localImage && event.params?.action === 'create'
    && data.acceptedAction?.operationId === data.operation.id
    && /^[a-f0-9-]{36}$/.test(data.operation.id) && /^[a-f0-9]{64}$/.test(data.acceptedAction.actionKey || '')
    ? { id: data.operation.id, actionKey: data.acceptedAction.actionKey } : null;
  const queueRequest = tool === 'work_queue' && data?.authority === 'core.heavy-work-queue'
    && /^[a-f0-9-]{36}$/.test(data.id || '')
    && ['requested', 'reserved', 'dispatching', 'running', 'uncertain', 'completed', 'failed', 'cancelled'].includes(data.state)
    ? { id: data.id, state: data.state } : null;
  const queueRead = tool === 'work_queue' && ((data?.authority === 'core.heavy-work-queue'
    && Array.isArray(data.jobs) && Number.isInteger(data.count) && data.count >= data.jobs.length)
    || (data?.authority === 'core.alerts' && ((Array.isArray(data.notifications) && Number.isInteger(data.count))
      || (data.acknowledged === true && /^[a-f0-9]{24}$/.test(data.id || '')))));
  const proved = localImage ? data.operation.state === 'completed' && data.operation.runtimeRestored === true && Boolean(data.operation.artifact?.sha256)
    : tool === 'work_queue' ? Boolean(queueRequest || queueRead)
    : tool === "personal_memory" ? data?.ok === true
    : soundTool ? Boolean(soundId)
    : healthTool ? healthResult
    : /agentx__(add|update|complete)_personal_task/.test(tool) ? Boolean(task?.id && task?.status)
      : tool === "agentx__list_personal_tasks" ? Array.isArray(data?.tasks)
      : tool === "agentx__shopping_list" ? Array.isArray(data?.items) : false;
  const resultRef = localImage ? `local-image:${data.operation.id}`
    : queueRequest ? `heavy-work:${queueRequest.id}`
    : tool === "personal_memory" && data?.id ? `personal-note:${data.id}`
    : /agentx__(add|update|complete)_personal_task/.test(tool) && task?.id ? `personal-task:${task.id}` : null;
  const id = digest(`${context.runId || event.runId || ""}:${context.toolCallId || event.toolCallId || digest(JSON.stringify(event.params || {}))}:${tool}`).slice(0, 24);
  return updateState(workspace, state => ({ ...state, receipts: [...state.receipts.filter(r => r.id !== id),
    { id, tool, status: failed ? "failed" : proved ? "verified" : "unknown", resultRef,
      runId: context.runId || event.runId || null, sessionKey: context.sessionKey || null,
      observed: event.result !== undefined,
      provenance: nativeActionProvenance(context, config, pluginConfig),
      ...(soundId ? { soundId } : {}),
      ...(imageOperation ? { imageOperation } : {}),
      ...(queueRequest ? { queueRequest } : {}),
      deliveryState: "unknown", at: nowIso() }].slice(-40) }));
}

// Project native lifecycle evidence into the existing private receipt capsule.
// This does not execute, retry, schedule or retain another conversation.
export async function recordRun(workspace, event, context, { config, pluginConfig } = {}) {
  const runId = event.runId || context.runId;
  if (!runId) return;
  return updateState(workspace, state => ({ ...state,
    runs: [...(state.runs || []).filter(run => run.runId !== runId), {
      runId, sessionKey: context.sessionKey, status: event.success ? "completed" : "failed",
      model: context.modelId || null, provider: context.modelProviderId || null,
      provenance: nativeActionProvenance(context, config, pluginConfig),
      at: nowIso(), durationMs: event.durationMs || null
    }].slice(-40)
  }));
}

// Core composes the brief; this harness only relays it and states what it lacks.
export function briefingFromCore(data) {
  if (typeof data?.text !== "string" || !data.text) throw new Error("Personal briefing unavailable");
  return { ...data, calendar: "not_connected", deliveryState: "not_requested" };
}
