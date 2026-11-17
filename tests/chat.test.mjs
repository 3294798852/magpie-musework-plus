import assert from "node:assert/strict"
import test from "node:test"

import { buildContent, reasoningEffortOf, timezoneOf } from "../src/chat.mjs"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

test("单条 user 消息保持原文（不加角色标记）", () => {
  const content = buildContent([{ role: "user", content: "你好" }])
  assert.deepEqual(content.map((block) => block.type), ["text"])
  assert.equal(content[0].text, "你好")
})

test("多轮对话带角色标记，且相邻文本合并", () => {
  const content = buildContent([
    { role: "system", content: "你是助手" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ])
  assert.equal(content.length, 1)
  assert.match(content[0].text, /【系统提示】\n你是助手/)
  assert.match(content[0].text, /【用户】\n第一问/)
  assert.match(content[0].text, /【助手】\n第一答/)
  assert.match(content[0].text, /【用户】\n第二问/)
})

test("data URL 图片 → image 块（base64 + media_type）", () => {
  const content = buildContent([{
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ],
  }])
  assert.equal(content.length, 2)
  assert.equal(content[1].type, "image")
  assert.equal(content[1].image.source.data, PNG)
  assert.equal(content[1].image.source.media_type, "image/png")
})

test("http(s) 图片 → image.source.url", () => {
  const content = buildContent([{
    role: "user",
    content: [{ type: "image_url", image_url: "https://example.com/a.png" }],
  }])
  assert.equal(content[0].image.source.url, "https://example.com/a.png")
})

test("tool 消息带【工具结果】", () => {
  const content = buildContent([
    { role: "user", content: "查天气" },
    { role: "assistant", content: "" },
    { role: "tool", content: "晴 25℃" },
  ])
  assert.match(content[0].text, /【工具结果】\n晴 25℃/)
})

test("空 messages → 空数组", () => {
  assert.deepEqual(buildContent([]), [])
  assert.deepEqual(buildContent(null), [])
})

test("单条 user 消息（数组形式）也不加角色标记", () => {
  const content = buildContent([{
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ],
  }])
  assert.equal(content[0].text, "看图")
  assert.equal(content[1].type, "image")
})

test("reasoningEffortOf 认多种写法", () => {
  assert.equal(reasoningEffortOf({ reasoning_effort: "high" }), "high")
  assert.equal(reasoningEffortOf({ reasoning: { effort: "low" } }), "low")
  assert.equal(reasoningEffortOf({ providerOptions: { musework: { reasoningEffort: "extra-high" } } }), "extra_high")
  assert.equal(reasoningEffortOf({}), "medium")
  assert.equal(reasoningEffortOf({ reasoning_effort: "unknown" }), "medium")
})

test("timezoneOf 返回合法 IANA 名称或空串", () => {
  const tz = timezoneOf()
  assert.equal(typeof tz, "string")
  if (tz) assert.doesNotMatch(tz, /[\r\n]/)
})
