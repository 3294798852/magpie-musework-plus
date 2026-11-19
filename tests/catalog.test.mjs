import assert from "node:assert/strict"
import test from "node:test"

import {
  fetchCatalog,
  modelEntry,
  modelKeyOf,
  modelMapOf,
  modelsResponse,
  staticModels,
} from "../src/catalog.mjs"

const RAW = {
  key: "deepseek-v4-1-flash",
  name: "DeepSeek V4.1 Flash",
  description: "Fast, efficient, and economical",
  category: "basic",
  available: true,
  credit_usage_rate: 0.3,
  supports_images: true,
  reasoning_efforts: ["low", "medium", "high"],
  default_reasoning_effort: "medium",
}

test("modelEntry 保留 key/name/rate 与能力字段", () => {
  const entry = modelEntry(RAW)
  assert.equal(entry.id, "deepseek-v4-1-flash")
  assert.equal(entry.name, "DeepSeek V4.1 Flash")
  assert.equal(entry.rate, 0.3)
  assert.equal(entry.free, false)
  assert.equal(entry.capabilities.reasoning, true)
  assert.equal(entry.capabilities.attachment, true)
  assert.equal(entry.capabilities.toolcall, true)
  assert.equal(entry.capabilities.input.image, true)
  assert.deepEqual(Object.keys(entry.variants), ["low", "medium", "high"])
})

test("supports_images=false 时关闭图片能力", () => {
  const entry = modelEntry({ ...RAW, supports_images: false })
  assert.equal(entry.capabilities.attachment, false)
  assert.equal(entry.capabilities.input.image, false)
})

test("没有 reasoning_efforts 时不开思考档位", () => {
  const entry = modelEntry({ ...RAW, reasoning_efforts: [] })
  assert.equal(entry.capabilities.reasoning, false)
  assert.equal(entry.variants, undefined)
})

test("缺少 key 的条目被丢弃", () => {
  assert.equal(modelEntry({ name: "no key" }), null)
  assert.deepEqual(Object.keys(modelMapOf([RAW, { name: "x" }])), ["deepseek-v4-1-flash"])
})

test("staticModels 覆盖全部 5 个模型", () => {
  const models = staticModels()
  assert.deepEqual(Object.keys(models).sort(), [
    "deepseek-v4-1-flash",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
  ])
  for (const entry of Object.values(models)) {
    assert.equal(entry.attachment, true)
    assert.equal(entry.tool_call, true)
  }
})

test("modelsResponse 是 OpenAI /v1/models 形状", async () => {
  const response = modelsResponse(staticModels())
  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(json.object, "list")
  assert.equal(json.data.length, 5)
  assert.ok(json.data.every((item) => item.object === "model" && item.owned_by === "musework"))
})

test("modelKeyOf 去掉 provider 前缀", () => {
  assert.equal(modelKeyOf("musework/deepseek-v4-1-flash"), "deepseek-v4-1-flash")
  assert.equal(modelKeyOf("deepseek-v4-1-flash"), "deepseek-v4-1-flash")
  assert.equal(modelKeyOf("", "fallback"), "fallback")
  assert.equal(modelKeyOf(undefined, "fallback"), "fallback")
})

test("fetchCatalog 过滤 available:false 的模型（会被服务端静默降级）", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    data: {
      models: [
        { key: "gpt-6-astra", name: "GPT-6 Astra", available: false, credit_usage_rate: 5, supports_images: true, reasoning_efforts: ["medium"] },
        { key: "gpt-6-luna", name: "GPT-6 Luna", available: true, credit_usage_rate: 0.3, supports_images: true, reasoning_efforts: ["medium"] },
      ],
      default_basic: "gpt-6-luna",
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } })

  const { models } = await fetchCatalog(fetchImpl, { token: "t", device: { id: "d" }, locale: "zh-CN" })
  assert.deepEqual(Object.keys(models), ["gpt-6-luna"])
})

test("fetchCatalog 全部不可用时退回全部（避免 0 models）", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    data: {
      models: [
        { key: "gpt-6-astra", name: "GPT-6 Astra", available: false, credit_usage_rate: 5, supports_images: true, reasoning_efforts: ["medium"] },
      ],
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } })

  const { models } = await fetchCatalog(fetchImpl, { token: "t", device: { id: "d" } })
  assert.deepEqual(Object.keys(models), ["gpt-6-astra"])
})
