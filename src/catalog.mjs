// 模型目录与账号上下文（agent / channel / 套餐额度）。
//
// 目录端点：GET /api/v1/sessions/models[?locale=zh-CN]
//   返回 {data:{models:[{key,name,description,category,available,credit_usage_rate,
//          supports_images,reasoning_efforts,default_reasoning_effort,is_new}],
//          default_basic,default_advanced}}
//
// 对话前必须拿到 agent_id + channel_id：
//   GET /api/v1/agents?specialty=all → agents[].channels[].channel_id
// 免费账号的 quota.max_concurrent_tasks = 1（subscription）。

import { API_BASE, BASE, FALLBACK_MODELS, PATHS, PROVIDER, SDK } from "./constants.mjs"
import { httpError, upstreamError } from "./errors.mjs"
import { authHeaders, requestJson, unwrap } from "./http.mjs"

function effortsOf(raw) {
  const list = Array.isArray(raw?.reasoning_efforts) ? raw.reasoning_efforts : []
  const out = []
  for (const item of list) {
    const value = String(item ?? "").trim().toLowerCase()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

function variantsOf(efforts) {
  return efforts.length ? Object.fromEntries(efforts.map((level) => [level, {}])) : {}
}

function visionOf(raw) {
  return raw?.supports_images === true
}

/** 静态兜底表（config 钩子用；未登录也要有内容）。 */
export function staticModels() {
  return Object.fromEntries(FALLBACK_MODELS.map((model) => {
    const vision = model.vision === true
    const variants = variantsOf(model.efforts)
    return [model.id, {
      name: model.name,
      ...(Number.isFinite(model.rate) ? { rate: model.rate } : {}),
      tool_call: true,
      attachment: vision,
      ...(model.efforts.length ? { reasoning: true, variants } : {}),
      capabilities: {
        temperature: false,
        reasoning: model.efforts.length > 0,
        attachment: vision,
        toolcall: true,
        input: { text: true, image: vision, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
    }]
  }))
}

/** provider.models 返回的单条模型。 */
export function modelEntry(raw, providerId = PROVIDER) {
  const id = String(raw?.key ?? raw?.id ?? "").trim()
  if (!id) return null
  const efforts = effortsOf(raw)
  const vision = visionOf(raw)
  const rate = Number(raw?.credit_usage_rate)
  const variants = variantsOf(efforts)
  return {
    id,
    providerID: providerId,
    name: String(raw?.name ?? "").trim() || id,
    ...(String(raw?.description ?? "").trim() ? { description: String(raw.description).trim() } : {}),
    ...(Number.isFinite(rate) ? { rate } : {}),
    // MuseWork 没有「免费模型」：所有调用都扣积分（credit_usage_rate > 0）。
    free: false,
    api: { id, url: API_BASE, npm: SDK },
    status: "active",
    headers: {},
    options: {},
    limit: {},
    capabilities: {
      temperature: false,
      reasoning: efforts.length > 0,
      attachment: vision,
      toolcall: true,
      input: { text: true, image: vision, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    ...(Object.keys(variants).length ? { variants } : {}),
  }
}

export function modelMapOf(models) {
  const out = {}
  for (const raw of Array.isArray(models) ? models : []) {
    const entry = modelEntry(raw)
    if (entry) out[entry.id] = entry
  }
  return out
}

function localeOf(value) {
  const text = String(value ?? "").trim()
  if (!text) return ""
  // 上游用 BCP-47（zh-CN / en-US）；magpie 的 locale 也可能是 zh_CN。
  return text.replace(/_/gu, "-").slice(0, 32)
}

/** 实时目录：失败抛错，由调用方退回缓存/静态表。 */
export async function fetchCatalog(fetchImpl, { token, device, locale, signal } = {}) {
  const url = new URL(PATHS.models, BASE)
  const lang = localeOf(locale)
  if (lang) url.searchParams.set("locale", lang)
  const { response, body } = await requestJson(fetchImpl, url.toString(), {
    method: "GET",
    headers: authHeaders(token, device),
    signal,
    timeoutMs: 20_000,
    maxBytes: 2 * 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  // available:false 的模型会被服务端**静默降级**到默认模型（2026-11-15 实测：
  // Free 账号选 gpt-6-astra / gpt-6.1-terra / gpt-6.1-sol，会话的 model-selection
  // 与 model_timing 全是 deepseek-v4-1-flash-261017，billing 也按 deepseek 记）。
  // 列出来只会让用户以为在用高级模型，所以只保留可用的；全不可用时退回全部。
  const raw = Array.isArray(data?.models) ? data.models : []
  const usable = raw.filter((item) => item?.available !== false)
  const picked = usable.length ? usable : raw
  const models = modelMapOf(picked)
  if (Object.keys(models).length === 0) throw upstreamError("MuseWork 模型目录为空", 502, { internal: true })
  return {
    models,
    defaultBasic: typeof data?.default_basic === "string" ? data.default_basic : "",
    defaultAdvanced: typeof data?.default_advanced === "string" ? data.default_advanced : "",
  }
}

/** OpenAI /v1/models 的形状（chat.headers / 宿主探测用）。 */
export function modelsResponse(entries = staticModels()) {
  return new Response(JSON.stringify({
    object: "list",
    data: Object.entries(entries).map(([id, model]) => ({
      id,
      object: "model",
      created: 0,
      owned_by: PROVIDER,
      name: model.name,
    })),
  }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } })
}

/** 当前账号的 agent + channel。 */
export async function resolveAgentChannel(fetchImpl, { token, device, signal } = {}) {
  const url = new URL(PATHS.agents, BASE)
  url.searchParams.set("specialty", "all")
  const { response, body } = await requestJson(fetchImpl, url.toString(), {
    method: "GET",
    headers: authHeaders(token, device),
    signal,
    timeoutMs: 20_000,
    maxBytes: 4 * 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  const agents = Array.isArray(data?.agents) ? data.agents : []
  if (!agents.length) {
    throw upstreamError("MuseWork 账号下没有可用的智能体（agent）", 502, { code: "upstream_error" })
  }
  const agent = agents.find((item) => item?.agent_status === "active") || agents[0]
  const channels = Array.isArray(agent?.channels) ? agent.channels : []
  const channel = channels.find((item) => item?.channel_type === "web" && item?.channel_id)
    || channels.find((item) => item?.channel_id)
  if (!channel?.channel_id) {
    throw upstreamError("MuseWork 智能体没有可用的频道（channel）", 502, { internal: true })
  }
  const value = {
    agentId: String(agent.agent_id || ""),
    agentName: String(agent.name || ""),
    channelId: String(channel.channel_id),
  }
  if (!value.agentId) throw upstreamError("MuseWork 智能体缺少 agent_id", 502, { internal: true })
  return value
}

/** 套餐：GET /api/v1/subscription → quota.max_concurrent_tasks / tier_label / daily_credits */
export async function fetchSubscription(fetchImpl, { token, device, signal } = {}) {
  const { response, body } = await requestJson(fetchImpl, `${BASE}${PATHS.subscription}`, {
    method: "GET",
    headers: authHeaders(token, device),
    signal,
    timeoutMs: 20_000,
    maxBytes: 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  if (!data || typeof data !== "object") throw upstreamError("MuseWork 套餐响应为空", 502, { internal: true })
  const concurrency = Number(data?.quota?.max_concurrent_tasks)
  const sessions = Number(data?.quota?.max_concurrent_sessions)
  return {
    plan: typeof data.tier_label === "string" ? data.tier_label : "",
    maxConcurrentTasks: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 0,
    maxConcurrentSessions: Number.isInteger(sessions) && sessions > 0 ? sessions : 0,
  }
}

/** 余额：GET /api/v1/credits/balance → [{credit_type,total_credits,remaining_credits}] */
export async function fetchBalance(fetchImpl, { token, device, signal } = {}) {
  const { response, body } = await requestJson(fetchImpl, `${BASE}${PATHS.balance}`, {
    method: "GET",
    headers: authHeaders(token, device),
    signal,
    timeoutMs: 20_000,
    maxBytes: 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const list = unwrap(body)
  if (!Array.isArray(list)) throw upstreamError("MuseWork 余额响应不是数组（响应形状变了）", 502, { internal: true })
  return list.filter((item) => item && typeof item === "object")
}

/** 把 body.model 归一成上游的 model_key（去掉 provider 前缀）。 */
export function modelKeyOf(model, fallback = "") {
  const text = String(model ?? "").trim()
  if (!text) return fallback
  const stripped = text.replace(/^[^/]+\//u, "")
  return stripped || fallback
}
