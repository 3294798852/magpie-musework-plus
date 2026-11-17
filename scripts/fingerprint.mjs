// 模型指纹：抓「真实上游模型 id」+ 跑身份/行为探针。
//
//   MAGPIE_MUSEWORK_TOKEN_FILE=token.txt node scripts/fingerprint.mjs
//   MAGPIE_MUSEWORK_TOKEN_FILE=token.txt node scripts/fingerprint.mjs gpt-6-astra
//
// 最有价值的是 model_request 的 component.end 里的 model_timing.model ——
// 那是服务端实际调用的上游模型 id（例如 deepseek-v4-1-flash-261017）。
// 再配合身份问答 / 知识截止 / 行为探针，可以判断「GPT-6 Astra」是不是真的。

import fs from "node:fs"

import { MuseWorkAuthPlugin } from "../index.mjs"
import { buildContent, createSession, deleteSession, requestChat, timezoneOf } from "../src/chat.mjs"
import { resolveAgentChannel } from "../src/catalog.mjs"
import { loadDevice } from "../src/device.mjs"

const tokenFile = String(process.env.MAGPIE_MUSEWORK_TOKEN_FILE || "").trim()
if (!tokenFile) {
  console.error("需要 MAGPIE_MUSEWORK_TOKEN_FILE 指向 access_token 文件")
  process.exit(1)
}
const token = fs.readFileSync(tokenFile, "utf8").trim()
const device = loadDevice()
const plugin = await MuseWorkAuthPlugin({}, {})
const method = plugin.auth.methods.find((m) => m.label.includes("粘贴"))
const flow = await method.authorize({ token })
const auth = await flow.callback()
if (auth.type !== "success") throw new Error(`登录失败：${auth.error || "unknown"}`)
const getAuth = async () => auth

const models = process.argv.slice(2).filter((arg) => !arg.startsWith("-"))
const idOnly = process.argv.includes("--id-only")
const targets = models.length ? models : ["gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna", "deepseek-v4-1-flash"]

const agent = await resolveAgentChannel(fetch, { token, device, cacheKey: auth.uid })

/** 发一轮，返回 { reply, timing, error }；保留原始 SSE 里的 model_timing。 */
async function run(model, prompt, effort = "medium") {
  const session = await createSession(fetch, {
    token, device, agentId: agent.agentId, channelId: agent.channelId, modelKey: model, reasoningEffort: effort,
  })
  try {
    const response = await requestChat(fetch, {
      token,
      device,
      payload: {
        session_id: session.sessionId,
        channel_id: session.channelId,
        agent_id: session.agentId,
        content: buildContent([{ role: "user", content: prompt }]),
        subscribe_stream: true,
        model_key: model,
        reasoning_effort: effort,
        user_timezone: timezoneOf(),
      },
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let reply = ""
    let reasoning = ""
    let timing = null
    let error = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = /event:(\S+)/.exec(block)?.[1] || ""
        const dataLine = /data:(.*)/s.exec(block)?.[1]?.trim()
        if (!dataLine) continue
        let json
        try { json = JSON.parse(dataLine) } catch { continue }
        if (event === "component.content" && json.component_type === "reply") reply += json.payload?.content_delta || ""
        if (event === "component.content" && json.component_type === "reasoning") reasoning += json.payload?.delta || ""
        if (event === "component.end" && json.component_type === "model_request") timing = json.payload?.model_timing || null
        if (event === "error") error = json
        if (event === "session.idle") break
      }
      if (error) break
    }
    return { reply, reasoning, timing, error }
  } finally {
    await deleteSession(fetch, { token, device, sessionId: session.sessionId })
  }
}

const IDENTITY_PROMPT = "你是什么模型？请只回答：模型名称 + 版本 + 开发商。不要客套。"
const CUTOFF_PROMPT = "你的训练数据截止到哪一天？只回答日期。"
const PROBES = [
  ["strawberry-r", "strawberry 这个单词里有几个字母 r？只回答数字。"],
  ["9.11-vs-9.9", "9.11 和 9.9 哪个大？只回答一个。"],
  ["count-50", "请从 1 数到 30，用逗号分隔，不要省略。"],
  ["zh-idiom", "用一个四字成语形容「雨后春笋」，只回答成语。"],
]

console.log("=".repeat(70))
console.log("模型目录（/api/v1/sessions/models）")
const catalog = await plugin.provider.models({}, { auth })
for (const [id, entry] of Object.entries(catalog)) {
  console.log(`  ${id.padEnd(22)} ${String(entry.name).padEnd(24)} rate=${entry.rate ?? "-"} efforts=${Object.keys(entry.variants || {}).join("/") || "-"}`)
}

console.log("\n" + "=".repeat(70))
console.log("① 真实上游模型 id（model_timing.model）")
const upstream = new Map()
for (const model of targets) {
  const result = await run(model, "只回答一个字：好")
  if (result.error) {
    console.log(`  ${model.padEnd(22)} ERROR ${result.error.code || ""} ${result.error.message || ""}`)
    continue
  }
  const real = result.timing?.model || "(未返回)"
  upstream.set(model, real)
  console.log(`  ${model.padEnd(22)} → ${real}   (status=${result.timing?.status || "?"}, first_token=${result.timing?.first_token_ms ?? "?"}ms)`)
}

if (idOnly) {
  console.log("\n(--id-only：跳过身份/行为探针)")
  process.exit(0)
}

console.log("\n" + "=".repeat(70))
console.log("② 身份问答（每个模型）")
for (const model of targets) {
  const result = await run(model, IDENTITY_PROMPT)
  if (result.error) { console.log(`  [${model}] ERROR ${result.error.code}: ${result.error.message}`); continue }
  console.log(`  [${model}] → ${result.reply.trim().replace(/\s+/g, " ").slice(0, 200)}`)
}

console.log("\n" + "=".repeat(70))
console.log("③ 知识截止 + 行为探针（重点看 gpt-6-astra）")
for (const model of targets) {
  const cutoff = await run(model, CUTOFF_PROMPT)
  console.log(`\n  ── ${model} (${upstream.get(model) || "?"}) ──`)
  console.log(`  截止: ${cutoff.error ? `ERROR ${cutoff.error.code}` : cutoff.reply.trim().replace(/\s+/g, " ").slice(0, 160)}`)
  for (const [name, prompt] of PROBES) {
    const probe = await run(model, prompt)
    const text = probe.error ? `ERROR ${probe.error.code}` : probe.reply.trim().replace(/\s+/g, " ").slice(0, 120)
    console.log(`  ${name.padEnd(14)} ${text}`)
  }
}

console.log("\n" + "=".repeat(70))
console.log("④ 积分账本里的资源摘要（最近 5 条）")
const ledger = await fetch("https://museai.im/api/v1/credits/ledger?page=1&page_size=5", {
  headers: { Authorization: `Bearer ${auth.access}`, "X-Device-ID": device.id, "X-Device-Type": "desktop" },
}).then((response) => response.json())
for (const item of ledger?.data?.items || []) {
  console.log(`  ${String(item.resource_summary || "").padEnd(48)} ${item.title || ""}`)
  for (const detail of item.resource_details || []) console.log(`      → ${detail.type}: ${detail.model} ×${detail.count}`)
}
