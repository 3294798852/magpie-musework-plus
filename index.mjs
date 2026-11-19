// magpie 插件：MuseWork（Muse AI 的 AI 工作伙伴）
//
// 上游是 MuseWork 桌面端（musa-bridge 10.0.3）自己的私有后端：
//   · 登录：浏览器登录 / 本机客户端导入 / 粘贴 access_token；Bearer + refresh_token Cookie
//   · 目录：GET /api/v1/sessions/models
//   · 对话：POST /api/v1/chat/completions（有状态智能体，SSE）
//   · 额度：GET /api/v1/credits/balance + /api/v1/subscription
//
// 协议取证：解包 MuseWork-10.0.3-x64.exe → app.asar → dist-electron/main.cjs 与
// dist/assets/*.js。端点、请求体字段、SSE 事件名都能在客户端自己的代码里逐字找到。

import { createHash } from "node:crypto"
import {
  API_BASE,
  BASE,
  DEFAULT_MAX_CONCURRENCY,
  FALLBACK_MODELS,
  ICON,
  PROVIDER,
  PROVIDER_NAME,
  SDK,
} from "./src/constants.mjs"
import {
  accountNameOf,
  fetchSelf,
  parseTokenInput,
  readLocalAccounts,
  refreshAccess,
  successPayload,
  userIdOf,
} from "./src/auth.mjs"
import { chromiumLogin, findBrowser } from "./src/browser.mjs"
import { createAccountCache } from "./src/cache.mjs"
import {
  fetchBalance,
  fetchCatalog,
  fetchSubscription,
  modelKeyOf,
  modelsResponse,
  resolveAgentChannel,
  staticModels,
} from "./src/catalog.mjs"
import { museChat, prepareChat, reasoningEffortOf } from "./src/chat.mjs"
import { loadDevice } from "./src/device.mjs"
import { createAccountLimiters } from "./src/semaphore.mjs"
import {
  CODES,
  chatErrorStatus,
  errorCode,
  errorResponse,
  isAuthFailure,
  signInHeaders,
  upstreamError,
} from "./src/errors.mjs"
import {
  claimDailyReward,
  fetchDailyRewardStatus,
  usageOf,
} from "./src/usage.mjs"

const CATALOG_TTL = 10 * 60_000
const AGENT_TTL = 5 * 60_000
const BALANCE_TTL = 60_000
const SUBSCRIPTION_TTL = 10 * 60_000
const DEFAULT_TTL_MS = 365 * 24 * 3600_000

function cacheKeyOf(auth) {
  const uid = auth?.uid || auth?.metadata?.userId
  if (uid) return "uid:" + uid
  if (auth?.accountId) return "account:" + auth.accountId
  return createHash("sha256").update(auth?.access || "").digest("hex")
}

function concurrencyOf({ maxConcurrentSessions, maxConcurrentTasks } = {}) {
  const sessions = Number(maxConcurrentSessions)
  const tasks = Number(maxConcurrentTasks)
  const limits = [sessions, tasks].filter(value => Number.isInteger(value) && value > 0)
  return limits.length ? Math.min(...limits, 1000) : DEFAULT_MAX_CONCURRENCY
}

function loginErrorText(error) {
  const status = Number(error?.status) || 0
  const code = String(error?.upstreamCode || "").toUpperCase()
  if (code === "USER_INVALID_TOKEN" || status === 401) return "access_token 无效或已过期，请重新获取"
  if (code === "ACCOUNT_BANNED") return "该 MuseWork 账号已被封禁"
  if (code === "ACCOUNT_DISABLED") return "该 MuseWork 账号已被禁用"
  if (code === "USER_LOGIN_LOCKED") return "登录尝试过于频繁，账号已临时锁定，请稍后再试"
  if (code === "TOO_MANY_REQUESTS" || status === 429) return "请求过于频繁，请稍后再试"
  return String(error?.message || error)
}

async function readJsonBody(input, init) {
  if (typeof init?.body === "string") return JSON.parse(init.body)
  if (init?.body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(init.body))
  if (init?.body && typeof init.body.getReader === "function") return JSON.parse(await new Response(init.body).text())
  if (input instanceof Request) return JSON.parse(await input.text())
  return {}
}

export const MuseWorkAuthPlugin = async (_ctx = {}, options = {}) => {
  const fetchImpl = typeof options?.fetch === "function" ? options.fetch : fetch
  const findBrowserImpl = typeof options?.findBrowser === "function" ? options.findBrowser : findBrowser
  const device = loadDevice()

  let maxConcurrency = DEFAULT_MAX_CONCURRENCY
  let lastTtlMs = DEFAULT_TTL_MS
  const catalogs = createAccountCache(CATALOG_TTL)
  const agents = createAccountCache(AGENT_TTL)
  const balances = createAccountCache(BALANCE_TTL)
  const subscriptions = createAccountCache(SUBSCRIPTION_TTL)
  const fallbackModels = staticModels()
  // 本机导入的游标：本机有多个账号时，每次登录导入下一个。
  const importedLocalAccounts = new Set()
  const limiters = createAccountLimiters()

  const syncTtl = (auth) => {
    const meta = Number(auth?.metadata?.ttlMs)
    if (Number.isFinite(meta) && meta > 0) { lastTtlMs = meta; return }
    const expires = Number(auth?.expires) || 0
    const remaining = expires - Date.now()
    if (remaining > 0) lastTtlMs = remaining
  }

  const syncConcurrency = (auth, key) => {
    const subscription = subscriptions.peek(key)
    const source = subscription?.maxConcurrentSessions || subscription?.maxConcurrentTasks ? subscription : auth.metadata
    const limit = concurrencyOf(source)
    limiters.update(key, limit)
    maxConcurrency = Math.max(maxConcurrency, limit)
    return limit
  }

  /** 用 token 换 magpie 登录态；token 过期但有 refresh 时自动续一次。 */
  async function completeLogin(cred, { signal } = {}) {
    const current = {
      access: String(cred?.access ?? "").trim(),
      refresh: String(cred?.refresh ?? "").trim(),
      expires: Number(cred?.expires) || 0,
      source: cred?.source || "",
    }
    if (!current.access) throw upstreamError("登录凭据为空", 400, { code: CODES.invalidRequest })
    try {
      const profile = await fetchSelf(fetchImpl, current.access, device, { signal })
      return successPayload(profile, current)
    } catch (error) {
      if (!isAuthFailure(error) || !current.refresh) throw error
      const renewed = await refreshAccess(fetchImpl, current.refresh, device, { signal })
      const profile = await fetchSelf(fetchImpl, renewed.access, device, { signal })
      return successPayload(profile, { ...renewed, source: current.source || "refresh" })
    }
  }

  async function loadCatalog(auth, key, signal) {
    try {
      return await catalogs.get(key, async () => {
        const { models } = await fetchCatalog(fetchImpl, { token: auth.access, device, locale: "zh-CN" })
        return models
      }, signal)
    } catch {
      signal?.throwIfAborted()
      return catalogs.peek(key) ?? fallbackModels
    }
  }

  return {
    // ═══ ① provider + 静态模型表 ═════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: API_BASE,
        // 未登录也要有内容，否则显示 "0 models"
        models: fallbackModels,
        searches: false,
        // 上游自己回答 web_search 吗？MuseWork 是智能体，会自己联网；
        // 但 magpie 的 web_search 工具是另一套，交给宿主即可。
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      get maxConcurrency() {
        return maxConcurrency
      },
      // 续期提前量 = token 寿命的一半，最少 1 分钟、最多 24 小时。
      get refreshLead() {
        return Math.min(Math.max(Math.floor(lastTtlMs / 2), 60_000), 24 * 3600_000)
      },

      // ═══ ② 登录 ═══════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: "从本机 MuseWork 客户端导入",
          async authorize() {
            // authorize 里不能 await 用户/网络：读文件放 callback。
            // 本机有多个账号时，每次点这个登录方式导入下一个；全部导入后再点会提示。
            const probe = Promise.resolve()
              .then(async () => {
                const locals = readLocalAccounts()
                if (!locals.length) {
                  throw new Error(
                    "没有找到本机 MuseWork 登录态。请先打开 MuseWork 客户端登录一次，"
                    + "或改用「浏览器登录」/「粘贴 Access Token」。",
                  )
                }
                for (const cred of locals) {
                  const key = userIdOf(cred.access) || cred.access.slice(-24)
                  if (importedLocalAccounts.has(key)) continue
                  const result = await completeLogin(cred)
                  importedLocalAccounts.add(key)
                  return result
                }
                throw new Error(`本机 ${locals.length} 个 MuseWork 账号都已导入`)
              })
            probe.catch(() => {})
            return {
              url: BASE,
              opened: true,
              method: "auto",
              instructions: "正在读取本机 MuseWork 登录态（有多个账号时会逐个导入）…",
              async callback() {
                try {
                  return await probe
                } catch (error) {
                  return { type: "failed", error: String(error?.message ?? error) }
                }
              },
            }
          },
        },

        {
          // 官方网页版登录：密码 / Google / Apple / 人机验证全部交给 museai.im 自己处理。
          type: "oauth",
          label: "浏览器登录（打开 museai.im）",
          async authorize() {
            // authorize 必须立刻返回；找浏览器 / 等登录都放在 callback 里。
            const controller = new AbortController()
            const login = Promise.resolve()
              .then(() => {
                const browser = findBrowserImpl()
                if (!browser) {
                  throw new Error(
                    "没有找到 Chromium 内核浏览器（Chrome / Edge / 360极速 / QQ 等）。"
                    + "装一个，或用 MAGPIE_MUSEWORK_BROWSER 指向它的 exe；"
                    + "也可以改用「从本机 MuseWork 客户端导入」/「粘贴 Access Token」。",
                  )
                }
                return chromiumLogin({
                  browser,
                  url: `${BASE}/chat`,
                  timeoutMs: 5 * 60_000,
                  signal: controller.signal,
                  fetchImpl,
                })
              })
              .then((cred) => completeLogin(cred, { signal: controller.signal }))
            login.catch(() => {})
            return {
              url: `${BASE}/chat`,
              opened: true,
              method: "auto",
              instructions:
                "已打开一个临时浏览器窗口，请在 museai.im 完成登录（密码 / Google / Apple 都行）。"
                + "若弹出「安全验证」，请等它自动完成或点一下复选框，再点「登录」；"
                + "登录成功后会自动完成，不需要复制任何东西。",
              close: () => controller.abort(),
              async callback(_value, { signal } = {}) {
                const onAbort = () => controller.abort()
                if (signal?.aborted) onAbort()
                else signal?.addEventListener("abort", onAbort, { once: true })
                try {
                  return await login
                } catch (error) {
                  return { type: "failed", error: String(error?.message ?? error) }
                } finally {
                  signal?.removeEventListener("abort", onAbort)
                  controller.abort()
                }
              },
            }
          },
        },

        {
          type: "oauth",
          label: "粘贴 Access Token",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "MuseWork 的 access_token（也可粘 auth-token.json 全文）",
              placeholder: "eyJhbGciOi…",
            },
          ],
          async authorize(inputs) {
            const cred = parseTokenInput(inputs?.token ?? inputs?.access_token ?? "")
            return {
              url: BASE,
              opened: true,
              method: "auto",
              instructions: "正在校验 MuseWork 登录态…",
              async callback() {
                try {
                  return await completeLogin(cred)
                } catch (error) {
                  return { type: "failed", error: loginErrorText(error) }
                }
              },
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      async refresh(auth) {
        const refreshToken = String(auth?.refresh || "").trim()
        if (!refreshToken) return undefined
        try {
          const renewed = await refreshAccess(fetchImpl, refreshToken, device)
          lastTtlMs = Math.max(60_000, renewed.expires - Date.now())
          return {
            access: renewed.access,
            refresh: renewed.refresh || refreshToken,
            expires: renewed.expires,
          }
        } catch (error) {
          if (isAuthFailure(error)) {
            throw Object.assign(new Error("MuseWork 登录已失效，请重新登录"), { signIn: "expired" })
          }
          return undefined
        }
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return {}
        syncTtl(auth)
        syncConcurrency(auth, cacheKeyOf(auth))

        return {
          baseURL: API_BASE,
          apiKey: "",
          headers: {},

          async fetch(input, init = {}) {
            const fresh = await getAuth()
            if (!fresh?.access) {
              return errorResponse("MuseWork 未登录：请重新登录", 401, CODES.signInRequired)
            }
            syncTtl(fresh)
            const key = cacheKeyOf(fresh)
            const request = input instanceof Request ? input : null
            const signal = init?.signal ?? request?.signal
            const url = typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : (request?.url ?? "")
            const method = String(init?.method ?? request?.method ?? "GET").toUpperCase()
            const path = url.split("?")[0]

            if (method === "GET" && /\/models$/u.test(path)) {
              return modelsResponse(await loadCatalog(fresh, key, signal))
            }
            if (!/\/chat\/completions$/u.test(path)) {
              return errorResponse(
                `该端点没有实现：${method} ${url}。本插件只提供 /chat/completions 与 /models。`,
                501,
                CODES.notImplemented,
              )
            }

            let body
            try {
              body = await readJsonBody(input, init)
            } catch {
              return errorResponse("请求体不是合法的 JSON", 400, CODES.invalidRequest)
            }

            const stream = body?.stream !== false
            const modelKey = modelKeyOf(body?.model, FALLBACK_MODELS[0].id)
            const reasoningEffort = reasoningEffortOf(body)

            try {
              const prepared = prepareChat(body)
              const agent = await agents.get(key, () => resolveAgentChannel(fetchImpl, {
                token: fresh.access, device,
              }), signal)
              return await museChat({
                fetchImpl,
                token: fresh.access,
                device,
                ...agent,
                modelKey,
                reasoningEffort,
                prepared,
                stream,
                signal,
                acquire: turnSignal => limiters.acquire(key, syncConcurrency(fresh, key), turnSignal),
              })
            } catch (error) {
              signal?.throwIfAborted?.()
              return errorResponse(
                error?.message || String(error),
                chatErrorStatus(error),
                errorCode(error),
                signInHeaders(error),
              )
            }
          },
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return { error: "未登录", windows: [] }
        try {
          const key = cacheKeyOf(auth)
          const info = { token: auth.access, device }
          const [usage, subscription] = await Promise.all([
            balances.get(key, async () => usageOf(await fetchBalance(fetchImpl, info), auth.uid || auth.accountId)),
            subscriptions.get(key, () => fetchSubscription(fetchImpl, info)).catch(() => subscriptions.peek(key)),
          ])
          syncConcurrency(auth, key)
          return subscription?.plan ? { ...usage, plan: subscription.plan } : usage
        } catch (error) {
          if (isAuthFailure(error)) {
            return { error: "MuseWork 登录已失效，请重新登录", windows: [], signIn: "expired" }
          }
          return { error: String(error?.message ?? error), windows: [] }
        }
      },

      // ═══ ⑥ 签到：每日奖励（D1 50 → D2 100 → … → D5+ 300）══════════
      async checkin(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return { outcome: "failed", message: "未登录" }
        try {
          const status = await fetchDailyRewardStatus(fetchImpl, { token: auth.access, device })
          if (status.claimedToday) {
            return {
              outcome: "done",
              ...(status.continuousDays > 0 ? { streak: status.continuousDays } : {}),
              message: `今天已签到（连续 ${status.continuousDays} 天，本月已领 ${status.monthlyClaimed} 积分）`,
            }
          }
          if (!status.claimable) {
            return { outcome: "inactive", message: "当前没有可领取的每日奖励（活动未开启或已结束）" }
          }

          const claimed = await claimDailyReward(fetchImpl, { token: auth.access, device })
          balances.invalidate(cacheKeyOf(auth))
          if (claimed.alreadyClaimed || (claimed.claimedToday && claimed.grantedCredits === 0)) {
            return {
              outcome: "done",
              ...(claimed.continuousDays > 0 ? { streak: claimed.continuousDays } : {}),
              message: "今天已签到",
            }
          }
          if (claimed.grantedCredits > 0) {
            return {
              outcome: "claimed",
              credit: claimed.grantedCredits,
              ...(claimed.continuousDays > 0 ? { streak: claimed.continuousDays } : {}),
              message: `签到成功，+${claimed.grantedCredits} 积分（连续 ${claimed.continuousDays} 天）`,
            }
          }
          return { outcome: "failed", message: "领取请求已发送，但服务端没有返回 granted_credits" }
        } catch (error) {
          if (isAuthFailure(error)) {
            return { outcome: "failed", message: "MuseWork 登录已失效，请重新登录" }
          }
          return { outcome: "failed", message: String(error?.message ?? error) }
        }
      },
    },

    // ═══ ⑦ 每账号模型目录 ═══════════════════════════════════════════
    provider: {
      id: PROVIDER,
      async models(_fallback, { auth } = {}) {
        if (!auth?.access) return fallbackModels
        syncTtl(auth)
        const key = cacheKeyOf(auth)
        syncConcurrency(auth, key)
        return loadCatalog(auth, key)
      },
    },

    // ═══ ⑧ 每请求加会话头（诊断用；本轮不依赖它做会话复用）════════
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID && input.model.providerID !== PROVIDER) return
      const sessionId = String(input?.sessionID ?? "").trim()
      if (!sessionId) return
      output.headers ??= {}
      output.headers["x-magpie-session-id"] = sessionId
    },
  }
}

export default MuseWorkAuthPlugin

// 诊断口：脚本 / 测试可以复用这些内部件，但不会改变插件行为。
export const _internal = Object.freeze({
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  API_BASE,
  SDK,
  ICON,
  FALLBACK_MODELS,
  staticModels,
  accountNameOf,
  userIdOf,
  cacheKeyOf,
})
