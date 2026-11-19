// Use one in-flight read per account and expire results without a sweeping timer.
export const METADATA_ACCOUNTS = 256

function waitFor(pending, signal) {
  if (!signal) return pending
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    pending.then(
      value => { signal.removeEventListener("abort", abort); resolve(value) },
      error => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

export function createAccountCache(ttl, capacity = METADATA_ACCOUNTS) {
  const values = new Map()
  const inFlight = new Map()

  return {
    get size() { return values.size },
    peek(key) { return values.get(key)?.value },
    async get(key, load, signal) {
      signal?.throwIfAborted()
      const cached = values.get(key)
      if (cached && cached.until > Date.now()) {
        values.delete(key)
        values.set(key, cached)
        return cached.value
      }
      let pending = inFlight.get(key)
      if (!pending) {
        pending = Promise.resolve().then(load).then(value => {
          if (inFlight.get(key) === pending) {
            values.delete(key)
            values.set(key, { value, until: Date.now() + ttl })
            if (values.size > capacity) values.delete(values.keys().next().value)
          }
          return value
        }).finally(() => {
          if (inFlight.get(key) === pending) inFlight.delete(key)
        })
        inFlight.set(key, pending)
      }
      return waitFor(pending, signal)
    },
    invalidate(key) {
      values.delete(key)
      inFlight.delete(key)
    },
  }
}
