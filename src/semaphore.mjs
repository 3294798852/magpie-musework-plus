// 账号级并发闸门。
//
// MuseWork 免费套餐的 quota 里有两条并发上限（2026-11-15 实测）：
//   max_concurrent_tasks    = 1   同时在跑的任务
//   max_concurrent_sessions = 1   同时活跃的会话
// 「测试模型」会一次并发打 5 个请求，超出后上游回
// CONCURRENT_SESSION_LIMIT_EXCEEDED（HTTP 200 + SSE error 帧）。
// 这个闸门保证同一个账号同时只有一个 turn 在飞，多出来的请求排队。

function normalizeLimit(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 1
}

function abortError() {
  return Object.assign(new Error("请求已取消"), { name: "AbortError" })
}

export function createLimiter(initial = 1) {
  let limit = normalizeLimit(initial)
  let active = 0
  const waiters = []

  function makeRelease() {
    let released = false
    return () => {
      if (released) return
      released = true
      active = Math.max(0, active - 1)
      pump()
    }
  }

  function pump() {
    while (active < limit && waiters.length) {
      const waiter = waiters.shift()
      if (waiter.aborted) continue
      active += 1
      waiter.grant()
    }
  }

  return {
    get limit() {
      return limit
    },
    get active() {
      return active
    },
    get pending() {
      return waiters.length
    },
    setLimit(value) {
      const next = normalizeLimit(value)
      if (next === limit) return
      limit = next
      pump()
    },
    /** 拿到一个释放函数；signal 取消时排队中的请求直接失败。 */
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError())
      if (active < limit) {
        active += 1
        return Promise.resolve(makeRelease())
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          aborted: false,
          onAbort: null,
          grant: () => {
            signal?.removeEventListener?.("abort", waiter.onAbort)
            resolve(makeRelease())
          },
        }
        waiter.onAbort = () => {
          if (waiter.aborted) return
          waiter.aborted = true
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(abortError())
        }
        signal?.addEventListener?.("abort", waiter.onAbort, { once: true })
        waiters.push(waiter)
      })
    },
  }
}
