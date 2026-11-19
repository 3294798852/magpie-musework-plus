import assert from "node:assert/strict"
import test from "node:test"
import { createAccountCache } from "../src/cache.mjs"

test("shares in-flight metadata across callers and keeps one caller's cancellation isolated", async () => {
  const cache = createAccountCache(60_000)
  const cancel = new AbortController()
  const result = Promise.withResolvers()
  let loads = 0
  const load = () => { loads += 1; return result.promise }
  const first = cache.get("a", load, cancel.signal)
  const second = cache.get("a", load)
  cancel.abort()
  await assert.rejects(first, { name: "AbortError" })
  result.resolve("shared")
  assert.equal(await second, "shared")
  assert.equal(await cache.get("a", load), "shared")
  assert.equal(loads, 1)
})

test("uses LRU capacity and retries failed reads", async () => {
  const cache = createAccountCache(60_000, 2)
  const visit = key => cache.get(key, () => key)
  await visit("a")
  await visit("b")
  await visit("a")
  await visit("c")
  assert.equal(cache.size, 2)
  assert.equal(cache.peek("b"), undefined)
  await assert.rejects(cache.get("b", () => { throw new Error("failed") }), /failed/)
  assert.equal(await visit("b"), "b")
})

test("invalidation prevents an older in-flight value from repopulating the cache", async () => {
  const cache = createAccountCache(60_000)
  const result = Promise.withResolvers()
  const pending = cache.get("a", () => result.promise)
  await cache.get("b", () => "other account")
  cache.invalidate("a")
  assert.equal(await cache.get("a", () => "new balance"), "new balance")
  result.resolve("old balance")
  assert.equal(await pending, "old balance")
  assert.equal(cache.peek("a"), "new balance")
  assert.equal(cache.peek("b"), "other account")
})

test("refreshes expired entries", async () => {
  const cache = createAccountCache(0)
  assert.equal(await cache.get("a", () => 1), 1)
  assert.equal(await cache.get("a", () => 2), 2)
})
