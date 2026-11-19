// Decode MuseWork SSE into structured OpenAI deltas. The HTTP layer serializes
// them for a streaming client or aggregates them for a regular JSON response.
import { upstreamError, upstreamStatus } from "./errors.mjs"
import { ToolReply } from "./tools.mjs"

const JSON_EVENTS = new Set(["component.content", "component.end", "error"])
const MAX_EVENT_CHARS = 8 * 1024 * 1024
const textOf = value => typeof value === "string" ? value : ""
const oversized = () => upstreamError("MuseWork 上游 SSE 事件超出大小上限。", 502)

function finishReasonOf(value) {
  switch (value) {
    case "length":
    case "max_tokens": return "length"
    case "content_filter": return "content_filter"
    default: return "stop"
  }
}

export class MuseTranslator {
  constructor(toolPlan) {
    this.tools = toolPlan ? new ToolReply(toolPlan) : null
    this.event = ""
    this.data = ""
    this.tail = ""
    this.skipLine = false
    this.repliesWithDeltas = new Set()
    this.started = false
    this.done = false
    this.runEnded = false
    this.finishReason = "stop"
    this.error = null
  }

  push(text) {
    const out = []
    try {
      let offset = 0
      while (!this.done && offset < text.length) {
        const end = text.indexOf("\n", offset)
        if (end === -1) {
          if (!this.skipLine) {
            this.tail += text.slice(offset)
            if (this.event && !JSON_EVENTS.has(this.event) && this.tail.startsWith("data:")) {
              // The ignored user.content event can echo an attached image.
              this.tail = ""
              this.skipLine = true
            }
            if (this.tail.length > MAX_EVENT_CHARS) throw oversized()
          }
          break
        }
        if (this.skipLine) {
          this.skipLine = false
        } else {
          const line = this.tail + text.slice(offset, end)
          this.tail = ""
          this.line(line, out)
        }
        offset = end + 1
      }
    } catch (error) {
      this.error = error
      this.done = true
    }
    return out
  }

  finish() {
    const out = []
    if (this.done) return out
    try {
      if (this.tail) this.line(this.tail, out)
      this.tail = ""
      this.dispatch(out)
      this.finalize(out, this.runEnded)
    } catch (error) {
      this.error = error
      this.done = true
    }
    return out
  }

  line(raw, out) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!line) {
      this.dispatch(out)
    } else if (line.startsWith("event:")) {
      this.event = line.slice(6).trim()
    } else if (line.startsWith("data:") && (!this.event || JSON_EVENTS.has(this.event))) {
      if (line.length + this.data.length > MAX_EVENT_CHARS) throw oversized()
      const part = line[5] === " " ? line.slice(6) : line.slice(5)
      this.data = this.data ? this.data + "\n" + part : part
    }
  }

  dispatch(out) {
    const { event, data: raw } = this
    this.event = ""
    this.data = ""
    if (event === "run.end") {
      this.runEnded = true
      return
    }
    if (event === "session.idle") {
      this.finalize(out, true)
      return
    }
    if (!JSON_EVENTS.has(event)) return

    let data
    try { data = JSON.parse(raw) } catch { throw upstreamError("MuseWork 上游返回了无法解析的 SSE 数据帧。", 502) }

    if (event === "error") {
      const code = textOf(data?.code)
      const message = textOf(data?.message) || "上游错误"
      const status = upstreamStatus(code)
      const error = upstreamError("MuseWork 上游返回 " + (code || "错误") + "：" + message, status, { upstreamCode: code })
      if (status === 401) error.sessionExpired = true
      if (status === 403) error.permissionDenied = true
      throw error
    }

    if (data?.component_type === "reply") {
      const payload = data.payload
      const id = data.id ?? ""
      if (event === "component.content") {
        const text = textOf(payload?.content_delta) || textOf(payload?.content) || textOf(payload?.delta)
        if (text) {
          this.repliesWithDeltas.add(id)
          this.reply(text, out)
        }
      } else {
        const hadDeltas = this.repliesWithDeltas.delete(id)
        if (payload?.finish_reason) this.finishReason = finishReasonOf(payload.finish_reason)
        const full = textOf(payload?.content)
        if (full && !hadDeltas) this.reply(full, out)
      }
    } else if (event === "component.content" && data?.component_type === "reasoning") {
      const payload = data.payload
      const text = textOf(payload?.delta) || textOf(payload?.content) || textOf(payload?.content_delta)
      if (text) this.delta({ reasoning_content: text }, out)
    }
  }

  delta(delta, out) {
    this.started = true
    out.push({ delta })
  }

  reply(text, out) {
    const content = this.tools ? this.tools.push(text) : text
    if (content) this.delta({ content }, out)
  }

  finalize(out, complete) {
    if (this.done) return
    if (this.tools) {
      const { text, calls } = this.tools.finish(complete && this.finishReason === "stop")
      if (calls) {
        this.delta({ tool_calls: calls }, out)
        this.finishReason = "tool_calls"
      }
      if (text) this.delta({ content: text }, out)
    }
    this.done = true
    out.push({ finishReason: this.finishReason })
  }
}
