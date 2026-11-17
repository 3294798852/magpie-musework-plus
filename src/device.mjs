// 设备身份：MuseWork 的 X-Device-ID。
//
// 桌面端的 device.id 是 6 位字母数字（config.json 的 device.id，实测 "ZAXfJF"）。
// 服务端只把它当「同一个客户端」的标记，不校验格式；插件自己生成并持久化一份，
// 保证同一台机器每次登录都是同一个设备（换设备会影响会话归属与风控画像）。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"

import { LOCAL_APP_DIR, LOCAL_SCOPE_PREFIX } from "./constants.mjs"

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

export function magpieConfigDir(env = process.env) {
  return env.MAGPIE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".config", "magpie")
}

/** 本机 MuseWork 客户端的数据目录（支持 MAGPIE_MUSEWORK_HOME 覆盖）。 */
export function localAppHome(env = process.env) {
  const override = env.MAGPIE_MUSEWORK_HOME?.trim()
  return override || path.join(os.homedir(), LOCAL_APP_DIR)
}

/** 用户目录名（main.cjs 的 Nr()：sha256("musa-browser-v1\0"+uid).slice(0,32)）。 */
export function localUserDirName(uid) {
  const text = String(uid ?? "").trim()
  if (!text) return ""
  return createHash("sha256").update(`${LOCAL_SCOPE_PREFIX}${text}`).digest("hex").slice(0, 32)
}

function randomId(length = 12) {
  const bytes = randomBytes(length * 2)
  let out = ""
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    // 取模偏差可以忽略：只用于设备标记，不用于安全随机。
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return out
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

/**
 * 读取（或创建）插件自己的设备身份。
 * 文件：~/.config/magpie/musework-device.json
 */
export function loadDevice(env = process.env) {
  const dir = magpieConfigDir(env)
  const file = path.join(dir, "musework-device.json")
  const existing = readJson(file)
  const id = typeof existing?.id === "string" ? existing.id.trim() : ""
  if (id && id.length <= 128 && !/[\r\n]/.test(id)) {
    return {
      id,
      name: typeof existing?.name === "string" ? existing.name : os.hostname(),
      username: typeof existing?.username === "string" ? existing.username : safeUsername(),
      created: existing?.created ?? 0,
    }
  }

  const device = {
    id: randomId(12),
    name: safeHostname(),
    username: safeUsername(),
    created: Date.now(),
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(device, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // 写不进去也照常返回：设备标记丢了只会换一个 id，不影响登录。
  }
  return device
}

function safeHostname() {
  try { return os.hostname() } catch { return "magpie" }
}

function safeUsername() {
  try { return os.userInfo().username } catch { return "" }
}
