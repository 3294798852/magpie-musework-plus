import assert from "node:assert/strict"
import test from "node:test"
import { prepareChat } from "../src/chat.mjs"
import { prepareTools, ToolReply } from "../src/tools.mjs"

const tools = ["one", "two"].map(name => ({ type: "function", function: { name, parameters: { type: "object" } } }))
const encode = calls => JSON.stringify(calls.map(name => ({ name, arguments: {} })))

test("tool choice none omits definitions, preserving the existing call and result", () => {
  const chat = prepareChat({
    tools, tool_choice: "none",
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_previous", type: "function", function: {
        name: "one", arguments: '{"code":"x"}',
      } }] },
      { role: "tool", tool_call_id: "call_previous", content: "result" },
    ],
  })
  assert.equal(chat.toolPlan, null)
  assert.doesNotMatch(chat.content[0].text, /客户端函数协议/)
  assert.match(chat.content[0].text, /"name":"one","arguments":"\{\\"code\\":\\"x\\"\}"/)
  assert.match(chat.content[0].text, /"tool_call_id":"call_previous","content":"result"/)
})

test("named choice includes only the chosen function and requests it", () => {
  const plan = prepareTools({ tools, tool_choice: { type: "function", function: { name: "two" } } })
  assert.equal(plan.required, true)
  assert.deepEqual([...plan.names], ["two"])
  assert.doesNotMatch(plan.prompt, /"name":"one"/)
  assert.throws(() => {
    const reply = new ToolReply(plan)
    reply.push(plan.marker + encode(["one"]))
    reply.finish(true)
  }, { code: "invalid_tool_reply" })
})

test("parallel disabled permits one call, while enabled preserves order and distinct IDs", () => {
  for (const parallel of [false, true]) {
    const plan = prepareTools({ tools, parallel_tool_calls: parallel })
    const reply = new ToolReply(plan)
    reply.push(plan.marker + encode(["one", "two"]))
    if (parallel) {
      const { calls } = reply.finish(true)
      assert.deepEqual(calls.map(call => call.function.name), ["one", "two"])
      assert.notEqual(calls[0].id, calls[1].id)
    } else {
      assert.throws(() => reply.finish(true), { code: "invalid_tool_reply" })
    }
  }
})

test("rejects unsupported request modes and mismatched choices", () => {
  assert.equal(prepareTools({ tools: [] }), null)
  for (const invalid of [
    { tools: [], tool_choice: "required" }, { tools, tool_choice: { type: "function", function: { name: "other" } } },
    { tools: [{ type: "custom" }] }, { tools, parallel_tool_calls: "false" }, { functions: [] },
    { tools: [{ type: "function", function: { name: "one", strict: true } }] },
  ]) assert.throws(() => prepareTools(invalid), { status: 400, code: "invalid_request" })
})
