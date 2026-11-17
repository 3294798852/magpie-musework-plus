import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  accountNameOf,
  jwtPayload,
  maskPhone,
  parseTokenInput,
  readLocalAccount,
  readLocalAccounts,
  successPayload,
  tokenExpiresAt,
  userIdOf,
} from "../src/auth.mjs"
import { localUserDirName } from "../src/device.mjs"

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.signature`
}

const TOKEN = jwt({ user_id: "10000000001", exp: 1826223278, iat: 1794687278 })

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "musework-auth-"))
}

test("jwtPayload / userIdOf / tokenExpiresAt", () => {
  assert.equal(jwtPayload(TOKEN)?.user_id, "10000000001")
  assert.equal(userIdOf(TOKEN), "10000000001")
  assert.equal(userIdOf("not-a-jwt"), "")
  assert.equal(tokenExpiresAt(TOKEN), 1826223278 * 1000)
  assert.equal(tokenExpiresAt("bad"), 0)
})

test("localUserDirName 用 sha256 前 32 位，稳定不变", () => {
  // 固定向量：sha256("musa-browser-v1\0" + uid) 的十六进制前 32 位。
  assert.equal(localUserDirName("10000000001"), "d350f2897c0198f104ddd64b014b4786")
})

test("readLocalAccount 读 active-account → users/<hash>/auth-token.json", () => {
  const home = tempHome()
  fs.writeFileSync(path.join(home, "active-account.json"), JSON.stringify({
    accountId: "10000000001",
    localScopeId: "10000000001",
    kind: "personal",
  }))
  const dir = path.join(home, "users", localUserDirName("10000000001"))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "auth-token.json"), JSON.stringify({
    access_token: TOKEN,
    refresh_token: "refresh-1",
    expires_at: 1826223278000,
    credential_session: { version: 1, loggedIn: true },
  }))

  const cred = readLocalAccount({ MAGPIE_MUSEWORK_HOME: home })
  assert.equal(cred.access, TOKEN)
  assert.equal(cred.refresh, "refresh-1")
  assert.equal(cred.accountId, "10000000001")
})

test("readLocalAccount 忽略 loggedIn:false 的登出状态", () => {
  const home = tempHome()
  fs.writeFileSync(path.join(home, "active-account.json"), JSON.stringify({ accountId: "u", localScopeId: "u" }))
  const dir = path.join(home, "users", localUserDirName("u"))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "auth-token.json"), JSON.stringify({
    credential_session: { version: 1, loggedIn: false },
  }))
  assert.equal(readLocalAccount({ MAGPIE_MUSEWORK_HOME: home }), null)
})

test("readLocalAccount 兼容根目录旧布局", () => {
  const home = tempHome()
  fs.writeFileSync(path.join(home, "auth-token.json"), JSON.stringify({
    access_token: TOKEN,
    refresh_token: "legacy",
  }))
  const cred = readLocalAccount({ MAGPIE_MUSEWORK_HOME: home })
  assert.equal(cred.access, TOKEN)
  assert.equal(cred.refresh, "legacy")
})

test("readLocalAccounts 返回全部账号，active 优先且不重复", () => {
  const home = tempHome()
  const other = jwt({ user_id: "10000000002", exp: 1826223278 })
  fs.writeFileSync(path.join(home, "active-account.json"), JSON.stringify({
    accountId: "10000000001",
    localScopeId: "10000000001",
    kind: "personal",
  }))
  const activeDir = path.join(home, "users", localUserDirName("10000000001"))
  const otherDir = path.join(home, "users", localUserDirName("10000000002"))
  fs.mkdirSync(activeDir, { recursive: true })
  fs.mkdirSync(otherDir, { recursive: true })
  const tokenFile = { credential_session: { version: 1, loggedIn: true } }
  fs.writeFileSync(path.join(activeDir, "auth-token.json"), JSON.stringify({ ...tokenFile, access_token: TOKEN, refresh_token: "r1" }))
  fs.writeFileSync(path.join(otherDir, "auth-token.json"), JSON.stringify({ ...tokenFile, access_token: other, refresh_token: "r2" }))

  const list = readLocalAccounts({ MAGPIE_MUSEWORK_HOME: home })
  assert.equal(list.length, 2)
  assert.equal(userIdOf(list[0].access), "10000000001") // active-account 优先
  assert.equal(userIdOf(list[1].access), "10000000002")
})

test("parseTokenInput 认裸 token / Bearer / JSON", () => {
  assert.equal(parseTokenInput(TOKEN).access, TOKEN)
  assert.equal(parseTokenInput(`Bearer ${TOKEN}`).access, TOKEN)
  const json = parseTokenInput(JSON.stringify({ access_token: TOKEN, refresh_token: "r" }))
  assert.equal(json.access, TOKEN)
  assert.equal(json.refresh, "r")
})

test("parseTokenInput 拒绝空值与非 JWT", () => {
  assert.throws(() => parseTokenInput(""), /登录凭据为空/)
  assert.throws(() => parseTokenInput("abc"), /不像 MuseWork 的 access_token/)
})

test("maskPhone / accountNameOf", () => {
  assert.equal(maskPhone("13812345678"), "138****5678")
  assert.equal(maskPhone("+86 138-1234-5678"), "138****5678")
  assert.equal(accountNameOf({ email: "a@b.com", nickname: "nick" }), "a@b.com")
  assert.equal(accountNameOf({ nickname: "nick" }), "nick")
  assert.equal(accountNameOf({ username: "13812345678" }), "138****5678")
  assert.equal(accountNameOf({}), "")
})

test("successPayload 把资料映射成 magpie 登录态", () => {
  const payload = successPayload(
    { id: "10000000001", email: "user@example.com", nickname: "user1" },
    { access: TOKEN, refresh: "r", expires: 1826223278000, source: "pasted" },
  )
  assert.equal(payload.type, "success")
  assert.equal(payload.access, TOKEN)
  assert.equal(payload.refresh, "r")
  assert.equal(payload.accountId, "user@example.com")
  assert.equal(payload.uid, "10000000001")
  assert.equal(payload.metadata.email, "user@example.com")
  assert.equal(payload.metadata.source, "pasted")
})
