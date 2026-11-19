// 浏览器 CDP 登录：打开一个临时 Chromium profile，用户在官方页面登录，
// 插件从 DevTools 协议读登录态。不复制粘贴、不读用户日常浏览器配置。
//
// MuseWork 网页版的登录态在：
//   Cookie: refresh_token=…（HttpOnly）
//   localStorage["musa_auth"] = {"access_token":"eyJ…","expires_at":1794…}（兜底）
// 优先读 **浏览器级** Storage.getCookies（不 attach 页面、不碰 Runtime 域，最不容易被风控），
// 拿到 refresh_token 后换 access_token；只有拿不到 cookie 时才回退到 Runtime.evaluate 读 localStorage。

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { BASE, PATHS } from "./constants.mjs"
import { userIdOf } from "./auth.mjs"
import { requestJson, unwrap, withTimeout } from "./http.mjs"

const WIN_REGISTRY_BROWSERS = [
  "chrome.exe",
  "msedge.exe",
  "360ChromeX.exe",
  "360chrome.exe",
  "360se.exe",
  "QQBrowser.exe",
  "brave.exe",
  "vivaldi.exe",
  "opera.exe",
  "SogouExplorer.exe",
  "2345Explorer.exe",
  "liebao.exe",
  "Maxthon.exe",
  "UCBrowser.exe",
  "Quark.exe",
]

function which(name) {
  const path = String(process.env.PATH || "")
  const sep = process.platform === "win32" ? ";" : ":"
  for (const dir of path.split(sep)) {
    if (!dir) continue
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return ""
}

function registryAppPath(exe) {
  const roots = ["HKCU", "HKLM"]
  const tails = [
    `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ]
  // 用绝对路径，避免 Git Bash PATH 里的 reg 包装吃掉反斜杠。
  const reg = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe")
  for (const root of roots) {
    for (const tail of tails) {
      try {
        const out = execFileSync(reg, ["query", `${root}\\${tail}`, "/ve"], {
          encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        })
        const match = /REG_SZ\s+(.+?)\s*$/m.exec(out)
        const file = match?.[1]?.trim().replace(/^"|"$/g, "")
        if (file && existsSync(file)) return file
      } catch {}
    }
  }
  return ""
}

function winBrowserPaths(env) {
  const local = env.LOCALAPPDATA || ""
  const roaming = env.APPDATA || ""
  const pf = env.PROGRAMFILES || "C:\\Program Files"
  const pf86 = env["PROGRAMFILES(X86)"] || env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
  const under = (root, parts) => (root ? join(root, ...parts) : "")
  return [
    under(pf, ["Google", "Chrome", "Application", "chrome.exe"]),
    under(pf86, ["Google", "Chrome", "Application", "chrome.exe"]),
    under(local, ["Google", "Chrome", "Application", "chrome.exe"]),
    under(local, ["Chromium", "Application", "chrome.exe"]),
    under(pf, ["Chromium", "Application", "chrome.exe"]),
    under(pf86, ["Chromium", "Application", "chrome.exe"]),
    under(pf, ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
    under(local, ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"]),
    under(local, ["Vivaldi", "Application", "vivaldi.exe"]),
    under(local, ["Programs", "Opera", "opera.exe"]),
    under(local, ["360ChromeX", "Chrome", "Application", "360ChromeX.exe"]),
    under(local, ["360Chrome", "Chrome", "Application", "360chrome.exe"]),
    under(pf, ["360Chrome", "Chrome", "Application", "360chrome.exe"]),
    under(roaming, ["secoresdk", "360se6", "Application", "360se.exe"]),
    under(local, ["360se", "Application", "360se.exe"]),
    under(local, ["Tencent", "QQBrowser", "Application", "QQBrowser.exe"]),
    under(pf, ["Tencent", "QQBrowser", "QQBrowser.exe"]),
    under(local, ["SogouExplorer", "SogouExplorer.exe"]),
    under(local, ["2345Explorer", "2345Explorer.exe"]),
    under(local, ["liebao", "liebao.exe"]),
    under(local, ["UCBrowser", "Application", "UCBrowser.exe"]),
    under(local, ["Quark", "Quark.exe"]),
    under(pf86, ["Microsoft", "Edge", "Application", "msedge.exe"]),
    under(pf, ["Microsoft", "Edge", "Application", "msedge.exe"]),
  ].filter(Boolean)
}

export function browserCandidates(platformName = process.platform, env = process.env, lookup = registryAppPath) {
  const candidates = []
  const override = String(env.MAGPIE_MUSEWORK_BROWSER || "").trim()
  if (override) candidates.push(override)
  if (platformName === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    )
  } else if (platformName === "win32") {
    candidates.push(...winBrowserPaths(env))
    for (const exe of WIN_REGISTRY_BROWSERS) {
      const found = lookup(exe)
      if (found) candidates.push(found)
    }
  } else {
    for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      const found = which(name)
      if (found) candidates.push(found)
    }
  }
  return [...new Set(candidates)]
}

/** 先查常见安装路径（快），都没有再翻注册表。 */
export function findBrowser() {
  const plain = browserCandidates(process.platform, process.env, () => "")
  const hit = plain.find((file) => existsSync(file))
  if (hit) return hit
  if (process.platform === "win32") {
    for (const exe of WIN_REGISTRY_BROWSERS) {
      const found = registryAppPath(exe)
      if (found) return found
    }
  }
  return ""
}

/** 解析 localStorage.musa_auth（纯函数，方便测试）。 */
export function parseMusaAuth(raw, uidHint = "") {
  let value = raw
  if (typeof value === "string") {
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const access = typeof value.access_token === "string" ? value.access_token.trim() : ""
  if (!access || !access.includes(".")) return null
  const expires = Number(value.expires_at)
  return {
    access,
    refresh: "",
    expires: Number.isFinite(expires) && expires > 0 ? expires : 0,
    uid: String(uidHint || "").trim(),
    source: "browser",
  }
}

async function waitForFile(file, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await delay(200, undefined, { signal })
  }
  return false
}

export function cdpConnect(url, signal, openSocket = address => new WebSocket(address)) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const socket = openSocket(url)
    const pending = new Map()
    let next = 1
    let closed = false
    const stop = (error) => {
      if (closed) return
      closed = true
      signal?.removeEventListener("abort", abort)
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      reject(error)
      for (const waiter of pending.values()) waiter.rej(error)
      pending.clear()
      try { socket.close() } catch {}
    }
    const abort = () => stop(signal.reason)
    signal?.addEventListener("abort", abort, { once: true })
    socket.onopen = () => resolve({
      send(method, params) {
        if (closed) return Promise.reject(new Error("浏览器调试连接已关闭"))
        const id = next++
        return new Promise((res, rej) => {
          pending.set(id, { res, rej })
          try {
            socket.send(JSON.stringify({ id, method, params: params ?? {} }))
          } catch (error) {
            stop(error)
          }
        })
      },
      close() { stop(new Error("浏览器调试连接已关闭")) },
    })
    socket.onmessage = (event) => {
      let message
      try { message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) } catch { return }
      const waiter = message?.id ? pending.get(message.id) : null
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.rej(new Error(message.error.message || "CDP 错误"))
      else waiter.res(message.result)
    }
    socket.onerror = () => stop(new Error("连不上浏览器的调试端口"))
    socket.onclose = () => stop(new Error("浏览器调试连接已断开"))
  })
}

async function localCDP(port, listPages, signal) {
  const lookup = "http://127.0.0.1:" + port + (listPages ? "/json/list" : "/json/version")
  const localSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)])
  const response = await fetch(lookup, { signal: localSignal, redirect: "error" })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    return null
  }
  const body = await response.json()
  const target = listPages && Array.isArray(body) ? body.find(item => item.type === "page") : body
  return target?.webSocketDebuggerUrl ? cdpConnect(target.webSocketDebuggerUrl, localSignal) : null
}

export function refreshTokenOf(cookies) {
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (String(cookie?.name || "") !== "refresh_token") continue
    const domain = String(cookie?.domain || "").replace(/^\./u, "").toLowerCase()
    const value = String(cookie?.value || "").trim()
    if (value && (domain === "museai.im" || domain.endsWith(".museai.im"))) return value
  }
  return ""
}

/** 用 refresh_token 换 access_token（服务端会作废旧 access_token）。 */
async function exchangeRefreshToken(refreshToken, fetchImpl, signal) {
  if (!refreshToken) return null
  try {
    const { response, body } = await requestJson(fetchImpl, BASE + PATHS.refresh, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `refresh_token=${refreshToken}` },
      signal,
      timeoutMs: 20_000,
    })
    if (!response.ok) return null
    const data = unwrap(body)
    const access = typeof data?.access_token === "string" ? data.access_token.trim() : ""
    const expiresIn = Number(data?.expires_in)
    if (!access || !Number.isFinite(expiresIn) || expiresIn <= 0) return null
    return { access, refresh: refreshToken, expires: Date.now() + expiresIn * 1000, uid: userIdOf(access), source: "browser" }
  } catch {
    return null
  }
}

/**
 * 读登录态；没有就返回 null。
 * 优先 **浏览器级** Storage.getCookies（不 attach 页面、不碰 Runtime 域），
 * 拿不到 refresh_token 再回退到页面里读 localStorage.musa_auth。
 */
async function readLoginState(port, fetchImpl, signal) {
  // ① 浏览器级 cookie（最稳，也最不容易被 Turnstile 风控盯上）
  let browser = null
  try {
    browser = await localCDP(port, false, signal)
    if (browser) {
      const result = await browser.send("Storage.getCookies", {})
      const cred = await exchangeRefreshToken(refreshTokenOf(result?.cookies), fetchImpl, signal)
      if (cred) return cred
    }
  } catch {
    // 浏览器级读不到就回退
  } finally {
    browser?.close()
  }

  // ② 兜底：页面 localStorage.musa_auth
  const client = await localCDP(port, true, signal)
  if (!client) return null
  try {
    const evaluated = await client.send("Runtime.evaluate", {
      expression: "JSON.stringify({auth: localStorage.getItem('musa_auth'), uid: localStorage.getItem('musa_uid') || ''})",
      returnByValue: true,
      awaitPromise: false,
    })
    if (evaluated?.exceptionDetails) return null
    const raw = evaluated?.result?.value
    if (typeof raw !== "string" || !raw) return null
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { return null }
    const cred = parseMusaAuth(parsed?.auth, parsed?.uid)
    if (!cred) return null
    try {
      await client.send("Network.enable")
      const cookies = await client.send("Network.getAllCookies")
      cred.refresh = refreshTokenOf(cookies?.cookies)
    } catch {}
    return cred
  } finally {
    client.close()
  }
}

/** 打开临时浏览器登录，返回 {access, refresh, expires, uid}；超时/取消会抛错。 */
export async function chromiumLogin({ browser, url, timeoutMs = 5 * 60 * 1000, signal, fetchImpl = fetch } = {}) {
  signal?.throwIfAborted()
  const exe = browser || findBrowser()
  if (!exe) throw new Error("没有找到 Chromium 内核浏览器（Chrome / Edge / 360极速 / QQ 等）")
  const profile = mkdtempSync(join(tmpdir(), "magpie-musework-"))
  const login = withTimeout(signal, timeoutMs)
  const spawnFailure = new AbortController()
  const loginSignal = AbortSignal.any([login.signal, spawnFailure.signal])
  let child
  try {
    child = spawn(exe, [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      // 关掉 AutomationControlled 的 Blink 特性，降低被 Turnstile 判成自动化的概率。
      "--disable-blink-features=AutomationControlled",
      url,
    ], { stdio: "ignore" })
    child.once("error", error => spawnFailure.abort(error))
    const portFile = join(profile, "DevToolsActivePort")
    if (!(await waitForFile(portFile, 15_000, loginSignal))) throw new Error("浏览器没有打开调试端口")
    const port = Number(readFileSync(portFile, "utf8").split(/\r?\n/)[0])
    if (!Number.isFinite(port) || port <= 0) throw new Error("浏览器调试端口无效")

    // 给页面一点时间加载（Turnstile / 登录页脚本）
    await delay(2000, undefined, { signal: loginSignal })
    for (;;) {
      loginSignal.throwIfAborted()
      let cred = null
      try { cred = await readLoginState(port, fetchImpl, loginSignal) } catch {}
      loginSignal.throwIfAborted()
      if (cred) return cred
      await delay(2000, undefined, { signal: loginSignal })
    }
  } catch (error) {
    if (loginSignal.aborted) throw loginSignal.reason
    throw error
  } finally {
    login.cleanup()
    try { child?.kill("SIGTERM") } catch {}
    const cleanup = (attempt = 0) => {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch (error) {
        if (attempt < 2) setTimeout(() => cleanup(attempt + 1), 800).unref?.()
        else console.warn(`[magpie-musework] 临时浏览器 profile 清理失败（已重试 3 次）：${error.message}`)
      }
    }
    setTimeout(() => cleanup(), 1500).unref?.()
  }
}
