// 登录 / 续期 / 本机客户端导入。
//
// 三条登录路径（按省事程度排序）：
//   ① 从本机 MuseWork 客户端导入：读 ~/.musa/users/<hash>/auth-token.json（零输入）
//   ② 浏览器登录：打开 museai.im，从 CDP 读 refresh_token / localStorage（src/browser.mjs）
//   ③ 粘贴 access_token（DevTools / 客户端存储里取）
//
// 续期：POST /api/v1/auth/tokens/refresh，Cookie: refresh_token=…
// 上游会换发 access_token（旧的立即失效），refresh_token 不轮转。

import fs from "node:fs"
import path from "node:path"

import { BASE, PATHS } from "./constants.mjs"
import { httpError, upstreamError } from "./errors.mjs"
import { authHeaders, cookieValue, jsonHeaders, requestJson, unwrap } from "./http.mjs"
import { localAppHome, localUserDirName } from "./device.mjs"

/** 解 JWT 的 payload（不验签，只读声明）。 */
export function jwtPayload(token) {
  const text = String(token ?? "").trim()
  const part = text.split(".")[1]
  if (!part) return null
  try {
    const json = Buffer.from(part, "base64url").toString("utf8")
    const value = JSON.parse(json)
    return value && typeof value === "object" ? value : null
  } catch {
    return null
  }
}

export function userIdOf(token) {
  const payload = jwtPayload(token)
  for (const key of ["user_id", "sub", "uid"]) {
    const value = payload?.[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

export function tokenExpiresAt(token) {
  const exp = Number(jwtPayload(token)?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8")
    if (!text.trim()) return null
    const value = JSON.parse(text)
    return value && typeof value === "object" ? value : null
  } catch {
    return null
  }
}

function normalizeTokenFile(value, source) {
  if (!value) return null
  const access = typeof value.access_token === "string" ? value.access_token.trim() : ""
  if (!access) return null
  const session = value.credential_session
  if (session && typeof session === "object" && session.loggedIn === false) return null
  return {
    access,
    refresh: typeof value.refresh_token === "string" ? value.refresh_token.trim() : "",
    expires: Number.isFinite(Number(value.expires_at)) && Number(value.expires_at) > 0
      ? Number(value.expires_at)
      : tokenExpiresAt(access),
    accountId: userIdOf(access),
    source,
  }
}

/**
 * 读取本机 MuseWork 客户端的**全部**登录态（active-account 优先，其余按 mtime 从新到旧）。
 * 目录口径：~/.musa/active-account.json → users/<sha256("musa-browser-v1\0"+uid)>/auth-token.json
 * 兼容两种旧布局：~/.musa/auth-token.json 与 users/* 下的 auth-token。
 */
export function readLocalAccounts(env = process.env) {
  const home = localAppHome(env)
  const active = readJson(path.join(home, "active-account.json"))
  const scope = typeof active?.localScopeId === "string" && active.localScopeId.trim()
    ? active.localScopeId.trim()
    : typeof active?.accountId === "string" && active.accountId.trim()
      ? active.accountId.trim()
      : ""

  const out = []
  const seen = new Set()
  const push = (cred) => {
    if (!cred) return
    const key = userIdOf(cred.access) || cred.access.slice(-24)
    if (seen.has(key)) return
    seen.add(key)
    out.push(cred)
  }

  if (scope) {
    const dir = localUserDirName(scope)
    if (dir) push(normalizeTokenFile(readJson(path.join(home, "users", dir, "auth-token.json")), "active"))
  }
  push(normalizeTokenFile(readJson(path.join(home, "auth-token.json")), "legacy"))

  // 其余账号：users/* 按 auth-token.json 的 mtime 从新到旧。
  try {
    const usersDir = path.join(home, "users")
    const names = fs.readdirSync(usersDir).filter((name) => /^[a-f0-9]{32}$/.test(name))
    const ranked = names.map((name) => {
      const file = path.join(usersDir, name, "auth-token.json")
      let mtime = 0
      try { mtime = fs.statSync(file).mtimeMs } catch {}
      return { file, mtime }
    }).sort((a, b) => b.mtime - a.mtime)
    for (const { file } of ranked) push(normalizeTokenFile(readJson(file), "users"))
  } catch {
    // 没有客户端数据目录：走浏览器 / token 登录
  }
  return out
}

/** 单个账号的便捷入口（第一个，通常是 active-account）。 */
export function readLocalAccount(env = process.env) {
  return readLocalAccounts(env)[0] || null
}

/** 解析用户粘贴的凭据：裸 access_token、Bearer 头、或 auth-token.json 全文。 */
export function parseTokenInput(raw) {
  const text = String(raw ?? "").trim()
  if (!text) throw upstreamError("登录凭据为空", 400, { code: "invalid_request" })
  if (text.startsWith("{")) {
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    const cred = normalizeTokenFile(json, "pasted-json")
    if (!cred) throw upstreamError("粘贴的 auth-token.json 里没有 access_token", 400, { code: "invalid_request" })
    return cred
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(text)
  const access = (bearer ? bearer[1] : text).trim()
  if (!access || !access.includes(".")) {
    throw upstreamError("这不像 MuseWork 的 access_token（应为 JWT，形如 xxx.yyy.zzz）", 400, { code: "invalid_request" })
  }
  return {
    access,
    refresh: "",
    expires: tokenExpiresAt(access),
    accountId: userIdOf(access),
    source: "pasted",
  }
}

/** 当前账号资料：GET /api/v1/users/self */
export async function fetchSelf(fetchImpl, token, device, { signal, timeoutMs } = {}) {
  const { response, body } = await requestJson(fetchImpl, `${BASE}${PATHS.self}`, {
    method: "GET",
    headers: authHeaders(token, device),
    signal,
    timeoutMs,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  if (!data || typeof data.id !== "string" || !data.id.trim()) {
    throw upstreamError("MuseWork 用户资料缺少 id（响应形状变了）", 502, { internal: true })
  }
  return data
}

/** 续期：POST /api/v1/auth/tokens/refresh */
export async function refreshAccess(fetchImpl, refreshToken, device, { signal, timeoutMs = 30_000 } = {}) {
  const token = String(refreshToken ?? "").trim()
  if (!token) throw upstreamError("没有 refresh_token，无法续期", 401, { code: "session_expired" })

  const { response, body } = await requestJson(fetchImpl, `${BASE}${PATHS.refresh}`, {
    method: "POST",
    headers: {
      ...jsonHeaders("", device),
      Cookie: `refresh_token=${token}`,
    },
    signal,
    timeoutMs,
  })
  if (response.status === 401) {
    throw upstreamError("MuseWork refresh_token 已失效，请重新登录", 401, { code: "session_expired" })
  }
  if (!response.ok) throw httpError(response.status, body)

  const data = unwrap(body)
  const access = typeof data?.access_token === "string" ? data.access_token.trim() : ""
  const expiresIn = Number(data?.expires_in)
  if (!access || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw upstreamError("MuseWork 续期响应缺少 access_token / expires_in（响应形状变了）", 502, { internal: true })
  }
  return {
    access,
    // refresh_token 不轮转；万一服务端给了新的，优先用新的。
    refresh: cookieValue(response.headers, "refresh_token") || token,
    expires: Date.now() + expiresIn * 1000,
    accountId: userIdOf(access),
  }
}

/** 手机号打码：138****8000（认 0086 / +86 前缀，已打码的值保持原样）。 */
export function maskPhone(value) {
  let digits = String(value ?? "").trim().replace(/\D/gu, "")
  if (!digits) return ""
  if (digits.startsWith("0086")) digits = digits.slice(4)
  else if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2)
  if (digits.length < 7) return String(value ?? "").trim()
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** 卡片显示名：邮箱 > 昵称 > 用户名；纯手机号打码。 */
export function accountNameOf(profile) {
  const email = typeof profile?.email === "string" ? profile.email.trim() : ""
  if (email) return email
  const nickname = typeof profile?.nickname === "string" ? profile.nickname.trim() : ""
  if (nickname) return nickname
  const username = typeof profile?.username === "string" ? profile.username.trim() : ""
  return /^\+?\d[\d\s-]{5,}$/u.test(username) ? maskPhone(username) : username
}

/** 登录成功 → magpie 的 {type:"success", …}。 */
export function successPayload(profile, cred) {
  const name = accountNameOf(profile)
  const uid = profile?.id || userIdOf(cred.access) || ""
  return {
    type: "success",
    access: cred.access,
    refresh: cred.refresh || "",
    expires: cred.expires || tokenExpiresAt(cred.access) || 0,
    ...(name ? { accountId: name } : {}),
    ...(uid ? { uid } : {}),
    metadata: {
      ...(profile?.email ? { email: profile.email } : {}),
      ...(profile?.nickname ? { name: profile.nickname } : {}),
      ...(profile?.id ? { userId: profile.id } : {}),
      ...(cred.source ? { source: cred.source } : {}),
    },
  }
}
