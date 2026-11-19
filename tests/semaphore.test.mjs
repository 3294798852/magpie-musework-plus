import assert from "node:assert/strict"
import test from "node:test"

import { createAccountLimiters, createLimiter } from "../src/semaphore.mjs"

test("并发 1：第二个 acquire 排队，release 后放行", async () => {
  const limiter = createLimiter(1)
  const first = await limiter.acquire()
  assert.equal(limiter.active, 1)

  let secondDone = false
  const second = limiter.acquire().then((release) => {
    secondDone = true
    return release
  })
  await Promise.resolve()
  assert.equal(secondDone, false)
  assert.equal(limiter.pending, 1)

  first()
  const releaseSecond = await second
  assert.equal(secondDone, true)
  assert.equal(limiter.active, 1)
  releaseSecond()
  assert.equal(limiter.active, 0)
})

test("release 幂等", () => {
  const limiter = createLimiter(2)
  return limiter.acquire().then((release) => {
    release()
    release()
    assert.equal(limiter.active, 0)
  })
})

test("signal 取消排队中的 acquire", async () => {
  const limiter = createLimiter(1)
  const release = await limiter.acquire()
  const controller = new AbortController()
  const pending = limiter.acquire(controller.signal)
  controller.abort()
  await assert.rejects(pending, (error) => error.name === "AbortError")
  assert.equal(limiter.pending, 0)
  release()
})

test("setLimit 调大后可放行排队请求", async () => {
  const limiter = createLimiter(1)
  const release = await limiter.acquire()
  let granted = false
  const pending = limiter.acquire().then((fn) => {
    granted = true
    return fn
  })
  await Promise.resolve()
  assert.equal(granted, false)
  limiter.setLimit(2)
  const release2 = await pending
  assert.equal(granted, true)
  release()
  release2()
  assert.equal(limiter.active, 0)
})

test("默认与非法值回落 1", () => {
  assert.equal(createLimiter().limit, 1)
  assert.equal(createLimiter(0).limit, 1)
  assert.equal(createLimiter("x").limit, 1)
  assert.equal(createLimiter(5000).limit, 1000)
})

test("account limiters isolate concurrent IDs and remove idle queues", async () => {
  const accounts = createAccountLimiters()
  const first = await accounts.acquire("free", 1)
  const controller = new AbortController()
  const queued = accounts.acquire("free", 1, controller.signal)
  const paidOne = await accounts.acquire("paid", 2)
  const paidTwo = await accounts.acquire("paid", 2)
  assert.equal(accounts.size, 2)
  controller.abort()
  await assert.rejects(queued, { name: "AbortError" })
  first()
  assert.equal(accounts.size, 1)
  paidOne()
  paidTwo()
  assert.equal(accounts.size, 0)
})
