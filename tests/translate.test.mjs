import assert from "node:assert/strict"
import test from "node:test"

import { prepareTools } from "../src/tools.mjs"
import { MuseTranslator } from "../src/translate.mjs"

const sse = (event, data) => "event:" + event + "\r\ndata:" + JSON.stringify(data) + "\r\n\r\n"
const delta = (text, id = "r1") => sse("component.content", { component_type: "reply", id, payload: { content_delta: text } })
const full = (text, id = "r1") => sse("component.end", { component_type: "reply", id, payload: { content: text } })
const idle = sse("session.idle", {})
const exampleTool = { type: "function", function: { name: "probe", parameters: { type: "object" } } }

test("reply and reasoning yield structured deltas and one terminal event", () => {
  const translator = new MuseTranslator()
  assert.deepEqual(translator.push(
    sse("component.start", { component_type: "reply", id: "r1" })
    + sse("component.content", { component_type: "reasoning", payload: { delta: "思考" } })
    + delta("你好") + delta("世界") + full("你好世界") + idle,
  ), [
    { delta: { reasoning_content: "思考" } },
    { delta: { content: "你好" } },
    { delta: { content: "世界" } },
    { finishReason: "stop" },
  ])
  assert.equal(translator.done, true)
  assert.deepEqual(translator.finish(), [])
})

test("only uses a full reply if that component had no deltas", () => {
  const translator = new MuseTranslator()
  assert.deepEqual(translator.push(delta("一") + full("一") + full("二", "r2") + idle), [
    { delta: { content: "一" } }, { delta: { content: "二" } }, { finishReason: "stop" },
  ])
})

test("extracts CRLF SSE events across arbitrary line boundaries", () => {
  const translator = new MuseTranslator()
  const frames = []
  for (const char of delta("hello") + idle) frames.push(...translator.push(char))
  assert.deepEqual(frames, [{ delta: { content: "hello" } }, { finishReason: "stop" }])
})

test("ignores native agent functions and splits large user.content without retaining the echo", () => {
  const translator = new MuseTranslator()
  assert.deepEqual(translator.push("event:user.content\ndata:" + "x".repeat(8 * 1024 * 1024)), [])
  assert.equal(translator.tail.length, 0)
  const frames = translator.push("x\n\n" + sse("component.content", {
    component_type: "tool_call", payload: { delta: "native" },
  }) + idle)
  assert.deepEqual(frames, [{ finishReason: "stop" }])
})

test("an SSE error keeps any valid deltas in the same fetch chunk", () => {
  const translator = new MuseTranslator()
  assert.deepEqual(translator.push(delta("partial") + sse("error", {
    code: "USER_INVALID_TOKEN", message: "expired",
  })), [{ delta: { content: "partial" } }])
  assert.equal(translator.error.status, 401)
  assert.equal(translator.error.sessionExpired, true)
  assert.equal(translator.done, true)
})

test("a tool marker can be split across reply deltas and emits only after the run completes", () => {
  const plan = prepareTools({ tools: [exampleTool], tool_choice: "required" })
  const translator = new MuseTranslator(plan)
  const reply = plan.marker + '[{"name":"probe","arguments":{"nested":{"value":"括号 ]"}}}]'
  assert.deepEqual(translator.push(delta(reply.slice(0, 18))), [])
  assert.deepEqual(translator.push(delta(reply.slice(18))), [])
  const output = translator.push(idle)
  assert.equal(output[0].delta.tool_calls[0].id, "call_" + plan.nonce + "_0")
  assert.deepEqual(JSON.parse(output[0].delta.tool_calls[0].function.arguments), { nested: { value: "括号 ]" } })
  assert.deepEqual(output[1], { finishReason: "tool_calls" })
})

test("tools enabled still streams ordinary text and keeps foreign markers as text", () => {
  const plan = prepareTools({ tools: [exampleTool] })
  const translator = new MuseTranslator(plan)
  const text = "MUSEWORK_CALL_stale: is ordinary text"
  assert.deepEqual(translator.push(delta(text)), [{ delta: { content: text } }])
  assert.deepEqual(translator.push(idle), [{ finishReason: "stop" }])
})

test("unterminated, malformed and unlisted tools fail without any tool delta", () => {
  const plan = prepareTools({ tools: [exampleTool] })
  for (const [suffix, completed] of [
    ['[{"name":"probe","arguments":{}}]', false],
    ["malformed", true],
    ['[{"name":"unlisted","arguments":{}}]', true],
    ['[{"name":"probe","arguments":[]}]', true],
  ]) {
    const translator = new MuseTranslator(plan)
    assert.deepEqual(translator.push(delta(plan.marker + suffix)), [])
    assert.deepEqual(completed ? translator.push(idle) : translator.finish(), [])
    assert.equal(translator.error.code, "invalid_tool_reply")
  }
})

test("required choice fails if MuseWork sends normal text only", () => {
  const plan = prepareTools({ tools: [exampleTool], tool_choice: "required" })
  const translator = new MuseTranslator(plan)
  assert.deepEqual(translator.push(delta("ordinary") + idle), [{ delta: { content: "ordinary" } }])
  assert.equal(translator.error.code, "invalid_tool_reply")
})
