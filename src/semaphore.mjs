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
  const waiters = new Set()

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
    while (active < limit && waiters.size) {
      const waiter = waiters.values().next().value
      waiters.delete(waiter)
      active += 1
      waiter()
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
      return waiters.size
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
        const onAbort = () => {
          waiters.delete(grant)
          reject(abortError())
        }
        const grant = () => {
          signal?.removeEventListener("abort", onAbort)
          resolve(makeRelease())
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        waiters.add(grant)
      })
    },
  }
}

export function createAccountLimiters() {
  const accounts = new Map()

  return {
    get size() { return accounts.size },
    update(key, limit) { accounts.get(key)?.setLimit(limit) },
    async acquire(key, limit, signal) {
      let limiter = accounts.get(key)
      if (!limiter) {
        limiter = createLimiter(limit)
        accounts.set(key, limiter)
      } else {
        limiter.setLimit(limit)
      }
      const collectIdle = () => {
        if (!limiter.active && !limiter.pending && accounts.get(key) === limiter) accounts.delete(key)
      }
      try {
        const release = await limiter.acquire(signal)
        return () => { release(); collectIdle() }
      } catch (error) {
        collectIdle()
        throw error
      }
    },
  }
}
