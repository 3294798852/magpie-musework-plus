// 真机探针：用本机 MuseWork 登录态跑一遍插件自己的链路。
//
//   node scripts/probe.mjs            # 模型目录 + 流式对话
//   node scripts/probe.mjs --image    # 带一张 1×1 PNG，验证图片块
//   node scripts/probe.mjs --plain    # 非流式（折叠成 chat.completion）
//   node scripts/probe.mjs --usage    # 额度卡片
//
// 只读本机客户端登录态，不写回任何文件。

import fs from "node:fs"

import { MuseWorkAuthPlugin } from "../index.mjs"

const args = new Set(process.argv.slice(2))
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const plugin = await MuseWorkAuthPlugin({}, {})
const tokenFile = String(process.env.MAGPIE_MUSEWORK_TOKEN_FILE || "").trim()
const method = tokenFile
  ? plugin.auth.methods.find((item) => item.label.includes("粘贴"))
  : plugin.auth.methods.find((item) => item.label.includes("本机"))
if (!method) throw new Error("没有可用的登录方式")

const inputs = tokenFile ? { token: fs.readFileSync(tokenFile, "utf8").trim() } : undefined
const flow = await method.authorize(inputs)
const auth = await flow.callback()
if (auth.type !== "success") {
  console.error("登录失败：", auth)
  process.exit(1)
}
console.log("登录：", { accountId: auth.accountId, uid: auth.uid, expires: new Date(auth.expires).toISOString() })

const getAuth = async () => auth
const loader = await plugin.auth.loader(getAuth)

const modelsRes = await loader.fetch("https://museai.im/api/v1/models", { method: "GET" })
console.log("模型：", (await modelsRes.json()).data.map((m) => `${m.id} (${m.name})`).join(", "))

const providerModels = await plugin.provider.models({}, { auth })
console.log("provider.models：", Object.keys(providerModels).join(", "))

if (args.has("--usage")) {
  const usage = await plugin.auth.usage(getAuth)
  console.log("额度：", JSON.stringify(usage, null, 2))
}

const messages = [{ role: "user", content: "Say hi in one word." }]
if (args.has("--image")) {
  messages[0] = {
    role: "user",
    content: [
      { type: "text", text: "What color is this image? Answer in one word." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
    ],
  }
}

const body = {
  model: "deepseek-v4-1-flash",
  stream: !args.has("--plain"),
  messages,
  reasoning_effort: "medium",
}

const response = await loader.fetch("https://museai.im/api/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
console.log("HTTP", response.status, response.headers.get("content-type"))
if (args.has("--plain")) {
  const text = await response.text()
  console.log("非流式：", text.slice(0, 2000))
} else {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let content = ""
  let reasoning = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    process.stdout.write(chunk)
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue
      const payload = line.slice(6).trim()
      if (!payload || payload === "[DONE]") continue
      try {
        const frame = JSON.parse(payload)
        const delta = frame.choices?.[0]?.delta || {}
        if (typeof delta.content === "string") content += delta.content
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
      } catch {}
    }
  }
  console.log("\n\n正文：", JSON.stringify(content))
  console.log("思考：", JSON.stringify(reasoning.slice(0, 200)))
}
