// HTTP 小工具：请求头、JSON 请求、Set-Cookie 解析。
//
// 桌面端的请求头顺序（main.cjs 的 chat stream service）：
//   config.headers（默认空） → X-Device-Type: desktop → X-Device-ID → X-Environment-ID
//   → X-Language → X-Timezone → Accept: text/event-stream
// 缺任何一个都不影响鉴权（2026-11-15 实测），但保持一致可以少踩风控。

import { ApiError, upstreamError } from "./errors.mjs"

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** 设备头：X-Device-ID 必填时由调用方保证非空。 */
export function deviceHeaders(device = {}) {
  const headers = {}
  const id = String(device.id ?? "").trim()
  if (id) headers["X-Device-ID"] = id
  headers["X-Device-Type"] = "desktop"
  return headers
}

/** 鉴权头：Bearer access_token。 */
export function authHeaders(token, device = {}) {
  return {
    ...deviceHeaders(device),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export function jsonHeaders(token, device = {}) {
  return { ...authHeaders(token, device), "Content-Type": "application/json" }
}

/** 读 Set-Cookie 里的某个 cookie（Node 18+ 的 getSetCookie 兼容写法）。 */
export function cookieValue(headers, name) {
  if (!headers) return ""
  let list = []
  try {
    if (typeof headers.getSetCookie === "function") list = headers.getSetCookie()
    else if (typeof headers.get === "function") {
      const raw = headers.get("set-cookie")
      if (raw) list = [raw]
    }
  } catch {
    list = []
  }
  for (const item of list) {
    const pair = String(item || "").split(";")[0]?.trim() || ""
    if (!pair.startsWith(`${name}=`)) continue
    const value = pair.slice(name.length + 1)
    try { return decodeURIComponent(value) } catch { return value }
  }
  return ""
}

export function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs)
  timer.unref?.()
  const abort = () => controller.abort(signal?.reason instanceof Error ? signal.reason : new Error("请求已取消"))
  if (signal) {
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", abort)
    },
  }
}

export async function readLimitedText(response, maxBytes) {
  if (!response.body) return ""
  const tooLarge = () => upstreamError("MuseWork 响应超过 " + Math.round(maxBytes / 1024) + " KiB 上限", 502, { internal: true })
  const declared = Number(response.headers.get("content-length"))
  if (declared > maxBytes) {
    void response.body.cancel().catch(() => {})
    throw tooLarge()
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > maxBytes) throw tooLarge()
      text += decoder.decode(value, { stream: true })
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

/** 发出 JSON 请求。HTTP 非 2xx 留给调用方映射。 */
export async function requestJson(fetchImpl, url, {
  method = "GET",
  headers = {},
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  redirect = "error",
} = {}) {
  const { signal: timed, cleanup } = withTimeout(signal, timeoutMs)
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: timed, redirect })
    const raw = await readLimitedText(response, maxBytes)
    let json = null
    if (raw) {
      try { json = JSON.parse(raw) } catch { json = null }
    }
    return { response, body: json }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw Object.assign(new Error("请求已取消"), { name: "AbortError" })
    const reason = error?.name === "AbortError" ? "请求超时" : (error?.message || String(error))
    throw upstreamError(`MuseWork 网络请求失败：${reason}`, 504, { idle: true })
  } finally {
    cleanup()
  }
}

/** 解包 {data,result:"ok"} 或裸对象。 */
export function unwrap(body) {
  if (body && typeof body === "object" && "data" in body) return body.data
  return body
}
