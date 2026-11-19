// Compare the same mocked upstream workload through two plugin checkouts.
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { performance } from "node:perf_hooks"

const target = resolve(process.argv[2] || ".")
const { default: createPlugin } = await import(pathToFileURL(resolve(target, "index.mjs")))
const auth = { uid: "benchmark-account", access: "synthetic", expires: Date.now() + 86400_000 }
const json = data => Response.json({ data })
const encoder = new TextEncoder()
const frame = (event, data) => encoder.encode("event:" + event + "\ndata:" + JSON.stringify(data) + "\n\n")
const delta = frame("component.content", {
  component_type: "reply", id: "r", payload: { content_delta: "测".repeat(120) },
})
const idle = frame("session.idle", {})
const sequenceSize = 1400
const counts = { agents: 0, models: 0, balance: 0, subscription: 0, sessions: 0, deletes: 0 }
let mode = "normal"
let pulled = 0
let peak = 0
let trackHeap = false
let sequenceChunks = 1
const perSessionDeletes = new Map()
const heldCount = 16
const held = Promise.withResolvers()
const finishHeld = Promise.withResolvers()
let holdReached = 0

function replies() {
  let index = 0
  return new Response(new ReadableStream({
    async pull(controller) {
      pulled += 1
      if (trackHeap && index % 50 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed)
      if (index < sequenceChunks) controller.enqueue(delta)
      else if (mode !== "cancel") {
        if (mode === "hold") {
          if (++holdReached === heldCount) held.resolve()
          await finishHeld.promise
        }
        controller.enqueue(idle)
        controller.close()
      }
      index += 1
    },
  }, { highWaterMark: 0 }))
}

const impl = async input => {
  const url = new URL(input)
  if (url.pathname.endsWith("/agents")) {
    counts.agents += 1
    await delay(10)
    return json({ agents: [{ agent_id: "a", channels: [{ channel_id: "c" }] }] })
  }
  if (url.pathname.endsWith("/sessions/models")) {
    counts.models += 1
    await delay(10)
    return json({ models: [{ key: "m" }] })
  }
  if (url.pathname.endsWith("/credits/balance")) {
    counts.balance += 1
    await delay(10)
    return json([{ credit_type: "daily", total_credits: 100, remaining_credits: 90 }])
  }
  if (url.pathname.endsWith("/subscription")) {
    counts.subscription += 1
    await delay(10)
    return json({ quota: { max_concurrent_tasks: 1, max_concurrent_sessions: 1 } })
  }
  if (url.pathname.endsWith("/sessions")) return json({ session_id: "s" + ++counts.sessions })
  if (url.pathname.endsWith("/delete")) {
    counts.deletes += 1
    if (mode === "cancel") perSessionDeletes.set(url.pathname, (perSessionDeletes.get(url.pathname) || 0) + 1)
    return json({})
  }
  if (url.pathname.endsWith("/chat/completions")) return replies()
  throw new Error("Undefined mock endpoint " + url.pathname)
}

const plugin = await createPlugin({}, { fetch: impl })
const getAuth = async () => auth
const loader = await plugin.auth.loader(getAuth)
const ask = (targetLoader, stream) => targetLoader.fetch("https://museai.im/api/v1/chat/completions", {
  method: "POST", body: JSON.stringify({ model: "m", stream, messages: [{ role: "user", content: "benchmark" }] }),
})
const call = stream => ask(loader, stream)

const burstStart = performance.now()
await Promise.all(Array.from({ length: 12 }, () => Promise.all([
  plugin.provider.models({}, { auth }),
  plugin.auth.usage(getAuth),
  call(false).then(response => response.json()),
])))
const burst = { ...counts, ms: Number((performance.now() - burstStart).toFixed(1)) }

mode = "cancel"
const open = await call(true)
await open.body.cancel()
await delay(20)
const duplicateDeletes = [...perSessionDeletes.values()].filter(n => n > 1).length
mode = "normal"

sequenceChunks = sequenceSize
let response = await call(true)
const reader = response.body.getReader()
await reader.read()
pulled = 0
await delay(40)
const extraPullsWhilePaused = pulled
await reader.cancel()
reader.releaseLock()
await delay(20)
response = undefined

for (let i = 0; i < 5; i += 1) await (await call(false)).json()
const samples = []
for (let sample = 0; sample < 5; sample += 1) {
  globalThis.gc?.()
  const base = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const start = performance.now()
  peak = base
  trackHeap = true
  for (let i = 0; i < 15; i += 1) {
    const result = await (await call(false)).json()
    if (result.choices[0].message.content.length !== sequenceSize * 120) throw new Error("Wrong reply length")
    peak = Math.max(peak, process.memoryUsage().heapUsed)
  }
  const wallMs = performance.now() - start
  const cpu = process.cpuUsage(cpuBefore)
  trackHeap = false
  globalThis.gc?.()
  samples.push({
    cpuMs: (cpu.user + cpu.system) / 1000,
    wallMs,
    heapPeakMiB: (peak - base) / 1024 ** 2,
    heapAfterMiB: process.memoryUsage().heapUsed / 1024 ** 2,
  })
}
const median = key => Number(samples.map(value => value[key]).sort((a,b) => a-b)[2].toFixed(2))

// Hold real payloads in-flight before their terminal event, then GC out
// transient allocations. This measures retained reply state under concurrency.
sequenceChunks = 1
const loaders = await Promise.all(Array.from({ length: heldCount }, (_, index) => plugin.auth.loader(
  async () => ({ ...auth, uid: "held-" + index }),
)))
await Promise.all(loaders.map(targetLoader => ask(targetLoader, false).then(response => response.json())))
globalThis.gc?.()
const beforeHeld = process.memoryUsage().heapUsed
sequenceChunks = sequenceSize
mode = "hold"
const pending = Promise.all(loaders.map(targetLoader => ask(targetLoader, false).then(response => response.json())))
await held.promise
globalThis.gc?.()
const retainedMiB = (process.memoryUsage().heapUsed - beforeHeld) / 1024 ** 2
finishHeld.resolve()
await pending

console.log(JSON.stringify({
  engine: process.version, burst, duplicateDeletes, extraPullsWhilePaused, sequenceSize,
  nonStream: Object.fromEntries(Object.keys(samples[0]).map(key => [key, median(key)])),
  heapAfterMiB: samples.map(value => Number(value.heapAfterMiB.toFixed(2))),
  inFlight: { accounts: heldCount, retainedMiB: Number(retainedMiB.toFixed(2)) },
}, null, 2))
