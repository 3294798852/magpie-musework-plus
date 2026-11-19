// One isolated MuseWork session per OpenAI turn. The client supplies the full
// conversation, so retries and tool result turns do not need remote history.
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { BASE, PATHS, REASONING_EFFORTS } from "./constants.mjs"
import { chatErrorStatus, errorCode, httpError, upstreamError } from "./errors.mjs"
import { authHeaders, jsonHeaders, readLimitedText, requestJson, unwrap, withTimeout } from "./http.mjs"
import { prepareTools } from "./tools.mjs"
import { MuseTranslator } from "./translate.mjs"

const LABELS = Object.freeze({
  system: "【系统提示】",
  developer: "【系统提示】",
  user: "【用户】",
  assistant: "【助手】",
  tool: "【工具结果】",
  function: "【工具结果】",
})

const MAX_CONTENT_CHARS = 1_000_000
const MAX_ATTEMPTS = 3
const DELETE_TIMEOUT_MS = 5_000
const encoder = new TextEncoder()

function parseImageUrl(url) {
  const text = String(url ?? "").trim()
  if (!text) return null
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(text)
  if (match) return { data: match[2].replace(/\s+/gu, ""), media_type: match[1].toLowerCase() }
  return /^https?:\/\//iu.test(text) ? { url: text } : null
}

/** OpenAI messages → MuseWork text and image blocks. */
export function buildContent(messages, toolPrompt) {
  const list = Array.isArray(messages) ? messages.filter(item => item && typeof item === "object") : []
  const blocks = []
  let pendingText = []
  let total = 0

  const addLength = length => {
    total += length
    if (total > MAX_CONTENT_CHARS) {
      throw upstreamError("对话内容超过 MuseWork 单轮上限（约 100 万字符），请开启新会话", 400, {
        code: "invalid_request",
      })
    }
  }
  const flushText = () => {
    if (!pendingText.length) return
    blocks.push({ id: "text-" + (blocks.length + 1), type: "text", text: pendingText.join("\n\n") })
    pendingText = []
  }
  const pushText = text => {
    if (!text.trim()) return
    addLength(text.length + (pendingText.length ? 2 : 0))
    pendingText.push(text)
  }

  const onlyUser = list.length === 1 && String(list[0].role ?? "").toLowerCase() === "user"
  for (const message of list) {
    const role = String(message.role ?? "user").toLowerCase()
    const label = onlyUser ? "" : (LABELS[role] ?? "【" + role + "】")
    const textChunks = []
    const images = []
    const content = message.content

    if (typeof content === "string") {
      textChunks.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue
        if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") textChunks.push(part.text)
        else if (part.type === "image_url") {
          images.push(typeof part.image_url === "string" ? part.image_url : part.image_url?.url)
        } else if (part.type === "input_image" && typeof part.image_url === "string") {
          images.push(part.image_url)
        } else if (part.type === "image" && typeof part.image === "string") {
          images.push(part.image)
        }
      }
    } else if (content && typeof content === "object" && typeof content.text === "string") {
      textChunks.push(content.text)
    }

    let text = textChunks.join("\n").trim()
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.map(call => ({
        id: call?.id, name: call?.function?.name, arguments: call?.function?.arguments,
      }))
      text += (text ? "\n" : "") + "已发出的客户端函数调用 " + JSON.stringify(calls)
    } else if (role === "tool" && typeof message.tool_call_id === "string") {
      text = JSON.stringify({ tool_call_id: message.tool_call_id, name: message.name, content: text })
    }
    if (text) pushText(label ? label + "\n" + text : text)
    for (const url of images) {
      const source = parseImageUrl(url)
      if (!source) continue
      addLength(256)
      flushText()
      blocks.push({ id: "image-" + (blocks.length + 1), type: "image", image: { source, title: "image" } })
    }
  }

  if (total && toolPrompt) pushText(toolPrompt)
  flushText()
  return blocks
}

export function prepareChat(body) {
  const toolPlan = prepareTools(body)
  const content = buildContent(body?.messages, toolPlan?.prompt)
  if (!content.length) throw upstreamError("messages 不能为空", 400, { code: "invalid_request" })
  return { content, toolPlan }
}

export function reasoningEffortOf(body, fallback = "medium") {
  const raw = body?.reasoning_effort
    ?? body?.reasoning?.effort
    ?? body?.providerOptions?.musework?.reasoningEffort
    ?? body?.provider_options?.musework?.reasoning_effort
  const text = String(raw ?? "").trim().toLowerCase().replace(/-/gu, "_")
  return REASONING_EFFORTS.includes(text) ? text : fallback
}

let timezone
export function timezoneOf() {
  if (timezone === undefined) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    timezone = typeof tz === "string" && tz.length <= 64 && !/[\r\n]/u.test(tz) ? tz : ""
  }
  return timezone
}

export async function createSession(fetchImpl, { token, device, agentId, channelId, modelKey, reasoningEffort, signal } = {}) {
  const { response, body } = await requestJson(fetchImpl, BASE + PATHS.sessions, {
    method: "POST",
    headers: jsonHeaders(token, device),
    body: JSON.stringify({
      agent_id: agentId,
      channel_id: channelId,
      ...(modelKey ? { model_key: modelKey } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
    signal,
    maxBytes: 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  const sessionId = typeof data?.session_id === "string" ? data.session_id.trim() : ""
  if (!sessionId) throw upstreamError("MuseWork 建会话没有返回 session_id（响应形状变了）", 502, { internal: true })
  return {
    sessionId,
    channelId: typeof data?.channel_id === "string" && data.channel_id ? data.channel_id : channelId,
    agentId: typeof data?.agent_id === "string" && data.agent_id ? data.agent_id : agentId,
  }
}

export async function deleteSession(fetchImpl, { token, device, sessionId } = {}) {
  if (!sessionId) return
  const { signal, cleanup } = withTimeout(undefined, DELETE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(BASE + PATHS.sessions + "/" + encodeURIComponent(sessionId) + "/delete", {
      method: "POST",
      headers: authHeaders(token, device),
      signal,
      redirect: "error",
    })
    void response.body?.cancel().catch(() => {})
    if (!response.ok) console.warn("[MuseWork] 删除上游会话失败，HTTP " + response.status)
  } catch {
    console.warn("[MuseWork] 删除上游会话时连接失败或超时")
  } finally {
    cleanup()
  }
}

export function isConcurrencyLimit(error) {
  return error?.status === 409 || /CONCURRENT_SESSION|CONCURRENT_LIMIT|CONCURRENT/i.test(
    String(error?.upstreamCode || error?.code || error?.message || ""),
  )
}

export async function requestChat(fetchImpl, { token, device, payload, signal } = {}) {
  const response = await fetchImpl(BASE + PATHS.chat, {
    method: "POST",
    headers: { ...jsonHeaders(token, device), Accept: "text/event-stream" },
    body: JSON.stringify(payload),
    signal,
    redirect: "error",
  })
  if (!response.ok) {
    const text = await readLimitedText(response, 1024 * 1024)
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    throw httpError(response.status, parsed)
  }
  if (!response.body) throw upstreamError("MuseWork 上游没有返回响应体", 503)
  return response
}

function stopReading(turn) {
  const reader = turn?.reader
  if (!reader) return
  turn.reader = null
  void reader.cancel().catch(() => {})
  reader.releaseLock()
}

const sse = value => "data: " + JSON.stringify(value) + "\n\n"

function encodeBatch(meta, batch, first) {
  const frame = (delta, finishReason = null) => sse({
    ...meta, object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
  let text = first ? frame({ role: "assistant", content: "" }) : ""
  for (const { delta, finishReason } of batch) {
    if (finishReason) text += frame({}, finishReason) + "data: [DONE]\n\n"
    else if (delta.tool_calls) text += frame({
      tool_calls: delta.tool_calls.map((call, index) => ({ index, ...call })),
    })
    else text += frame(delta)
  }
  return encoder.encode(text)
}

async function completion(meta, readBatch) {
  let content = ""
  let reasoning = ""
  let calls
  let finish
  for (let batch; (batch = await readBatch());) {
    for (const { delta, finishReason } of batch) {
      if (finishReason) finish = finishReason
      else if (delta.content) content += delta.content
      else if (delta.reasoning_content) reasoning += delta.reasoning_content
      else if (delta.tool_calls) calls = delta.tool_calls
    }
  }
  return Response.json({
    ...meta, object: "chat.completion",
    choices: [{
      index: 0, finish_reason: finish,
      message: {
        role: "assistant", content: calls && !content ? null : content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls ? { tool_calls: calls } : {}),
      },
    }],
  })
}

export async function museChat({
  fetchImpl, token, device, agentId, channelId, modelKey, reasoningEffort, prepared, stream, signal, acquire,
}) {
  const downstream = stream ? new AbortController() : null
  const upstreamSignal = downstream && signal ? AbortSignal.any([downstream.signal, signal]) : downstream?.signal ?? signal
  const release = await acquire(upstreamSignal)
  let turn
  let attempts = 0
  let cleanup
  let closeOnAbort

  const onAbort = () => {
    stopReading(turn)
    closeOnAbort?.()
  }
  upstreamSignal?.addEventListener("abort", onAbort, { once: true })

  const closeTurn = async () => {
    const current = turn
    turn = null
    if (current) {
      stopReading(current)
      await deleteSession(fetchImpl, { token, device, sessionId: current.session.sessionId })
    }
  }
  const finish = () => {
    if (!cleanup) {
      upstreamSignal?.removeEventListener("abort", onAbort)
      closeOnAbort = undefined
      cleanup = closeTurn().finally(release)
    }
    return cleanup
  }

  const canRetry = error => !upstreamSignal?.aborted && attempts < MAX_ATTEMPTS && isConcurrencyLimit(error)
  const retry = async () => {
    await closeTurn()
    await delay(1000 * attempts, undefined, { signal: upstreamSignal })
  }

  const open = async () => {
    for (;;) {
      upstreamSignal?.throwIfAborted()
      attempts += 1
      try {
        const session = await createSession(fetchImpl, { token, device, agentId, channelId, modelKey, reasoningEffort, signal: upstreamSignal })
        turn = { session }
        const userTimezone = timezoneOf()
        const response = await requestChat(fetchImpl, {
          token, device, signal: upstreamSignal,
          payload: {
            session_id: session.sessionId, channel_id: session.channelId, agent_id: session.agentId,
            content: prepared.content, subscribe_stream: true,
            ...(modelKey ? { model_key: modelKey } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            ...(userTimezone ? { user_timezone: userTimezone } : {}),
          },
        })
        turn.reader = response.body.getReader()
        turn.decoder = new TextDecoder()
        turn.translator = new MuseTranslator(prepared.toolPlan)
        upstreamSignal?.throwIfAborted()
        return
      } catch (error) {
        if (!canRetry(error)) throw error
      }
      await retry()
    }
  }

  const readBatch = async () => {
    for (;;) {
      try {
        const { translator, decoder, reader } = turn
        while (!translator.done) {
          upstreamSignal?.throwIfAborted()
          const { done, value } = await reader.read()
          upstreamSignal?.throwIfAborted()
          const batch = translator.push(decoder.decode(value, { stream: !done }))
          if (done && !translator.done) batch.push(...translator.finish())
          if (batch.length) return batch
        }
        if (translator.error) throw translator.error
        return null
      } catch (error) {
        if (turn?.translator?.started || !canRetry(error)) throw error
      }
      await retry()
      await open()
    }
  }

  const created = Math.floor(Date.now() / 1000)
  const meta = { id: "chatcmpl-musework-" + randomUUID(), created, model: modelKey }
  try {
    await open() // Retain HTTP errors before committing downstream headers.
    if (!stream) {
      try { return await completion(meta, readBatch) } finally { void finish() }
    }
  } catch (error) {
    void finish()
    throw error
  }

  let first = true
  let stopped = false
  let pending
  const afterPull = () => pending ? pending.then(finish, finish) : finish()
  const body = new ReadableStream({
    start(controller) {
      closeOnAbort = () => {
        if (stopped) return
        stopped = true
        controller.error(upstreamSignal.reason)
        void afterPull()
      }
      if (upstreamSignal.aborted) closeOnAbort()
    },
    async pull(controller) {
      pending = readBatch()
      try {
        const batch = await pending
        if (stopped) return
        controller.enqueue(encodeBatch(meta, batch, first))
        first = false
        if (batch.at(-1).finishReason) {
          void finish()
          controller.close()
        }
      } catch (error) {
        if (stopped) return
        const status = chatErrorStatus(error)
        const type = status >= 500 ? "upstream_error" : "invalid_request_error"
        controller.enqueue(encoder.encode(sse({
          error: { message: error?.message || String(error), type, code: errorCode(error), status },
        })))
        void finish()
        controller.close()
      } finally {
        pending = undefined
      }
    },
    cancel(reason) {
      stopped = true
      downstream.abort(reason)
      return afterPull()
    },
  }, { highWaterMark: 0 })

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
