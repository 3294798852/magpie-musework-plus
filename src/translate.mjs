// 上游 SSE → OpenAI chat.completion.chunk。
//
// MuseWork 的事件（2026-11-15 真机抓取）：
//   event: user.content      回显用户消息（忽略）
//   event: run.start         {run_id, group_id}
//   event: turn.start        {id, parent_id}
//   event: component.start   {component_type:"reply"|"reasoning"|"model_request"|"tool_call"|…}
//   event: component.content {component_type, payload:{content_delta|delta, …}}
//   event: component.end     {component_type:"reply", payload:{content, finish_reason?}}
//   event: turn.end          {component_type:"AGENT_TURN"}
//   event: run.end           {run_id}
//   event: session.idle      {session_id, stats_delta:{credits,…}}
//   event: error             {code:"BAD_REQUEST", message:"…"}
//
// 正文在 reply 的 content_delta；思考在 reasoning 的 delta。tool_call / model_request
// 是智能体自己的内部活动，不往外发（宿主拿到也执行不了）。

import { upstreamError, upstreamStatus } from "./errors.mjs"

const KNOWN_FINISH = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"])

function finishReasonOf(value) {
  const text = String(value ?? "").trim().toLowerCase()
  if (!text) return ""
  return KNOWN_FINISH.has(text) ? text : text === "max_tokens" ? "length" : "stop"
}

function textOf(value) {
  return typeof value === "string" ? value : ""
}

export class MuseTranslator {
  constructor(model, { id, created } = {}) {
    this.model = String(model || "")
    this.created = Number.isFinite(created) ? created : Math.floor(Date.now() / 1000)
    this.id = id || `chatcmpl-musework-${this.created}-${Math.random().toString(36).slice(2, 8)}`
    this.buffer = ""
    this.eventName = ""
    this.dataLines = []
    this.started = false
    this.finished = false
    this.finishEmitted = false
    this.finishReason = ""
    this.contentChars = 0
  }

  frame(value) {
    return `data: ${JSON.stringify(value)}\n\n`
  }

  delta(delta) {
    return this.frame({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })
  }

  start(out) {
    if (this.started) return
    this.started = true
    out.push(this.delta({ role: "assistant", content: "" }))
  }

  /** 喂一段字节解码后的文本，返回已经转好的 OpenAI 帧。 */
  push(text) {
    const out = []
    if (this.finished) return out
    this.buffer += String(text ?? "")
    let index
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/u, "")
      this.buffer = this.buffer.slice(index + 1)
      try {
        this.line(line, out)
      } catch (error) {
        error.frames = out
        throw error
      }
      if (this.finished) break
    }
    return out
  }

  /** 上游断流/结束时收尾（幂等）。 */
  finish() {
    const out = []
    if (this.finished) return out
    if (this.buffer.trim()) {
      try {
        this.line(this.buffer.replace(/\r$/u, ""), out)
      } catch (error) {
        error.frames = out
        throw error
      }
      this.buffer = ""
    }
    try {
      this.dispatch(out)
    } catch (error) {
      error.frames = out
      throw error
    }
    this.finalize(out)
    return out
  }

  line(line, out) {
    if (this.finished) return
    if (!line) { this.dispatch(out); return }
    if (line.startsWith(":")) return
    if (line.startsWith("id:")) return
    if (line.startsWith("event:")) { this.eventName = line.slice(6).trim(); return }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).trimStart())
    }
  }

  dispatch(out) {
    const event = this.eventName
    const payloadText = this.dataLines.join("\n")
    this.eventName = ""
    this.dataLines = []
    if (!event && !payloadText) return

    let data = null
    if (payloadText) {
      try {
        data = JSON.parse(payloadText)
      } catch {
        throw upstreamError(`MuseWork 上游返回了无法解析的 SSE 数据帧：${payloadText.slice(0, 120)}`, 502)
      }
    }

    if (event === "error") {
      this.finished = true
      const code = typeof data?.code === "string" ? data.code : ""
      const message = typeof data?.message === "string" && data.message ? data.message : "上游错误"
      const status = upstreamStatus(code)
      const error = upstreamError(`MuseWork 上游返回 ${code || "错误"}：${message}`, status, { upstreamCode: code })
      if (status === 401) error.sessionExpired = true
      if (status === 403) error.permissionDenied = true
      throw error
    }

    if (event === "component.start") {
      if (data?.component_type === "reply") this.start(out)
      return
    }

    if (event === "component.content") {
      const type = data?.component_type
      const payload = data?.payload && typeof data.payload === "object" ? data.payload : {}
      if (type === "reply") {
        const text = textOf(payload.content_delta) || textOf(payload.content) || textOf(payload.delta)
        if (text) {
          this.start(out)
          this.contentChars += text.length
          out.push(this.delta({ content: text }))
        }
      } else if (type === "reasoning") {
        const text = textOf(payload.delta) || textOf(payload.content) || textOf(payload.content_delta)
        if (text) {
          this.start(out)
          out.push(this.delta({ reasoning_content: text }))
        }
      }
      return
    }

    if (event === "component.end") {
      if (data?.component_type === "reply") {
        const reason = finishReasonOf(data?.payload?.finish_reason)
        if (reason) this.finishReason = reason
        // component.end 的 payload.content 是完整正文；如果前面没收到增量，补一帧。
        const full = textOf(data?.payload?.content)
        if (full && this.contentChars === 0) {
          this.start(out)
          this.contentChars += full.length
          out.push(this.delta({ content: full }))
        }
      }
      return
    }

    if (event === "run.end") return
    if (event === "session.idle") { this.finalize(out); return }
    // user.content / turn.start / turn.end / 其他：忽略
  }

  finalize(out) {
    if (this.finished) return out
    this.finished = true
    this.start(out)
    if (!this.finishEmitted) {
      this.finishEmitted = true
      out.push(this.frame({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: this.finishReason || "stop",
        }],
      }))
    }
    out.push("data: [DONE]\n\n")
    return out
  }

  get done() {
    return this.finished
  }
}

/** 非流式：把同一套帧折叠成一个 chat.completion 对象。 */
export function foldFrames(frames, model = "") {
  let id = ""
  let created = 0
  let resolvedModel = model
  let content = ""
  let reasoning = ""
  let finish = "stop"
  for (const raw of frames) {
    const line = String(raw).trim()
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload === "[DONE]") continue
    let frame
    try { frame = JSON.parse(payload) } catch { continue }
    id ||= typeof frame.id === "string" ? frame.id : ""
    created ||= Number(frame.created) || 0
    resolvedModel ||= typeof frame.model === "string" ? frame.model : ""
    const choice = frame.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (typeof delta.content === "string") content += delta.content
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason
  }
  const message = { role: "assistant", content: content || "" }
  if (reasoning) message.reasoning_content = reasoning
  return {
    id: id || `chatcmpl-musework-${Math.floor(Date.now() / 1000)}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
  }
}

