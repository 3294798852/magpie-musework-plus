import assert from "node:assert/strict"
import test from "node:test"

import { chatErrorStatus, errorCode, httpError, upstreamStatus } from "../src/errors.mjs"

test("upstreamStatus：登录/额度/限流/超时映射", () => {
  assert.equal(upstreamStatus("USER_INVALID_TOKEN"), 401)
  assert.equal(upstreamStatus("INSUFFICIENT_CREDITS"), 402)
  assert.equal(upstreamStatus("CONCURRENT_SESSION_LIMIT_EXCEEDED"), 409)
  assert.equal(upstreamStatus("TOO_MANY_REQUESTS"), 429)
  assert.equal(upstreamStatus("DEADLINE_EXCEEDED"), 504)
  assert.equal(upstreamStatus("INTERNAL_ERROR"), 503)
  assert.equal(upstreamStatus("BAD_REQUEST"), 400)
})

test("upstreamStatus：404 只给模型不存在，通用 NOT_FOUND 不当模型", () => {
  assert.equal(upstreamStatus("MODEL_NOT_FOUND"), 404)
  assert.equal(upstreamStatus("NO_SUCH_MODEL"), 404)
  assert.equal(upstreamStatus("SESSION_NOT_FOUND"), 502)
  assert.equal(upstreamStatus("NOT_FOUND"), 502)
})

test("upstreamStatus：未知 code 按 HTTP status 兜底", () => {
  assert.equal(upstreamStatus("", 400), 400)
  assert.equal(upstreamStatus("", 429), 429)
  assert.equal(upstreamStatus("", 500), 503)
  assert.equal(upstreamStatus("", 418), 502)
})

test("errorCode / chatErrorStatus 的关键分支", () => {
  assert.equal(errorCode({ status: 401 }), "session_expired")
  assert.equal(errorCode({ status: 402 }), "quota_exhausted")
  assert.equal(errorCode({ status: 409 }), "concurrency_conflict")
  assert.equal(errorCode({ internal: true }), "internal_error")
  assert.equal(errorCode({ idle: true }), "upstream_timeout")
  assert.equal(chatErrorStatus({ status: 403 }), 401)
  assert.equal(chatErrorStatus({ status: 404 }), 404)
  assert.equal(chatErrorStatus({ status: 504 }), 504)
  assert.equal(chatErrorStatus({ status: 0 }), 502)
})

test("httpError：端点 404 不是模型不存在", () => {
  const endpoint = httpError(404, { code: "NOT_FOUND", message: "404 page not found" })
  assert.equal(endpoint.status, 502)
  const model = httpError(404, { code: "MODEL_NOT_FOUND", message: "no such model" })
  assert.equal(model.status, 404)
})
