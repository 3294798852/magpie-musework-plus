import assert from "node:assert/strict"
import test from "node:test"

import { browserCandidates, findBrowser, parseMusaAuth, refreshTokenOf } from "../src/browser.mjs"

const ACCESS = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiOTI3OTQ3Mjk0ODMifQ.sig"

test("parseMusaAuth 解析 localStorage.musa_auth", () => {
  const cred = parseMusaAuth(JSON.stringify({ access_token: ACCESS, expires_at: 1826223278000 }), "10000000001")
  assert.equal(cred.access, ACCESS)
  assert.equal(cred.expires, 1826223278000)
  assert.equal(cred.uid, "10000000001")
  assert.equal(cred.source, "browser")
  assert.equal(cred.refresh, "")
})

test("parseMusaAuth 拒绝空值 / 非法 / 非 JWT", () => {
  assert.equal(parseMusaAuth(null), null)
  assert.equal(parseMusaAuth(""), null)
  assert.equal(parseMusaAuth("not-json"), null)
  assert.equal(parseMusaAuth(JSON.stringify({})), null)
  assert.equal(parseMusaAuth(JSON.stringify({ access_token: "abc" })), null)
  assert.equal(parseMusaAuth(JSON.stringify({ access_token: "" })), null)
  assert.equal(parseMusaAuth(JSON.stringify([1, 2])), null)
})

test("parseMusaAuth 缺 expires_at 时给 0（交给 token 自己兜底）", () => {
  const cred = parseMusaAuth(JSON.stringify({ access_token: ACCESS }))
  assert.equal(cred.expires, 0)
})

test("MAGPIE_MUSEWORK_BROWSER 覆盖候选列表", () => {
  const candidates = browserCandidates("linux", { MAGPIE_MUSEWORK_BROWSER: "/opt/custom/chrome" }, () => "")
  assert.equal(candidates[0], "/opt/custom/chrome")
})

test("findBrowser 返回字符串（找不到也不能抛）", () => {
  const found = findBrowser()
  assert.equal(typeof found, "string")
})

test("refreshTokenOf 只认 museai.im 的 refresh_token", () => {
  const cookies = [
    { name: "refresh_token", value: "r1", domain: ".museai.im", httpOnly: true },
    { name: "refresh_token", value: "r2", domain: "evil-museai.im" },
    { name: "access_token", value: "a1", domain: ".museai.im" },
    { name: "refresh_token", value: "", domain: ".museai.im" },
  ]
  assert.equal(refreshTokenOf(cookies), "r1")
  assert.equal(refreshTokenOf([{ name: "refresh_token", value: "r2", domain: "evil-museai.im" }]), "")
  assert.equal(refreshTokenOf(null), "")
  assert.equal(refreshTokenOf([]), "")
})
