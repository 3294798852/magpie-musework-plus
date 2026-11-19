import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = process.env.MUSEWORK_TEST_URL
if (!root) throw new Error("Set MUSEWORK_TEST_URL to an authorized Magpie gateway before running the tool smoke test.")
const models = process.argv.slice(2)
if (!models.length) models.push("musework/deepseek-v4-1-flash", "musework/gpt-6-luna")
const apiKey = process.env.MUSEWORK_TEST_KEY
const headers = { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) }

async function complete(body) {
  const start = performance.now()
  const response = await fetch(new URL("/v1/chat/completions", root), {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  if (!response.ok) {
    let code
    try { code = JSON.parse(raw)?.error?.code } catch {}
    throw new Error(body.model + " returned HTTP " + response.status + " (" + (code || "no code") + ")")
  }
  const ms = Math.round(performance.now() - start)
  if (!body.stream) {
    const result = JSON.parse(raw).choices?.[0]
    assert.ok(result, "Missing completion choice")
    return { calls: result.message.tool_calls || [], content: result.message.content, finish: result.finish_reason, ms }
  }
  let content = ""
  let finish
  const calls = []
  let done = false
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload === "[DONE]") { done = true; continue }
    const parsed = JSON.parse(payload)
    if (parsed.error) throw new Error(body.model + " SSE error " + (parsed.error.code || parsed.error.type))
    const choice = parsed.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    content += delta.content || ""
    if (choice.finish_reason) finish = choice.finish_reason
    for (const call of delta.tool_calls || []) {
      const stored = calls[call.index] ||= { id: "", type: "function", function: { name: "", arguments: "" } }
      if (call.id) stored.id = call.id
      stored.function.name += call.function?.name || ""
      stored.function.arguments += call.function?.arguments || ""
    }
  }
  assert.ok(done, "SSE did not reach [DONE]")
  return { calls, content, finish, ms }
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "musework-tool-"))
try {
  const testFile = path.join(directory, "probe.txt")
  const secret = "MUSE_PROBE_" + randomUUID().replace(/-/g, "")
  await fs.writeFile(testFile, secret, { mode: 0o600 })
  const tool = {
    type: "function",
    function: {
      name: "read_local_probe",
      description: "读取客户端保管的探针文件，返回其完整内容。",
      parameters: {
        type: "object", properties: { key: { type: "string", enum: ["probe"] } },
        required: ["key"], additionalProperties: false,
      },
    },
  }
  const user = {
    role: "user",
    content: '请调用客户端函数 read_local_probe，传入 key 为 "probe"。拿到客户端结果后，只回复结果的 value 字段内容。',
  }
  for (const [index, model] of models.entries()) {
    const stream = index % 2 === 0
    const choice = stream ? { type: "function", function: { name: tool.function.name } } : "auto"
    const base = { model, tools: [tool], parallel_tool_calls: false, reasoning_effort: "low" }
    const first = await complete({ ...base, messages: [user], tool_choice: choice, stream })
    assert.equal(first.finish, "tool_calls", model + " first turn finish reason")
    assert.equal(first.calls.length, 1, model + " should request exactly one call")
    const call = first.calls[0]
    assert.ok(call.id, "Missing call ID")
    assert.equal(call.function.name, tool.function.name)
    assert.deepEqual(JSON.parse(call.function.arguments), { key: "probe" })
    const value = await fs.readFile(testFile, "utf8")
    const last = await complete({
      ...base, tool_choice: "auto", stream: !stream,
      messages: [
        user, { role: "assistant", content: first.content || null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: JSON.stringify({ value }) },
      ],
    })
    assert.equal(last.finish, "stop", model + " result turn finish reason")
    assert.match(last.content || "", new RegExp(secret), model + " did not use the tool output")
    console.log(JSON.stringify({ model, first: stream ? "sse" : "json", choice: stream ? "specific" : "auto",
      toolsExecuted: 1, preservedToolCallId: true, usedClientValue: true, requestMs: first.ms, resultMs: last.ms }))
  }
} finally {
  await fs.rm(path.join(directory, "probe.txt"), { force: true })
  await fs.rmdir(directory)
}
