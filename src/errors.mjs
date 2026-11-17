// 错误词表与出口（与 magpie 的 ERROR-CODES.md v1.2 对齐）。
//
// 一条错误必须同时说清三件事：HTTP status（宿主怎么路由）、code（程序怎么分支）、
// message（人和 agent 看到的原文）。三者缺一，用户只会看到「服务异常」。

export const CODES = Object.freeze({
  signInRequired: "sign_in_required",
  sessionExpired: "session_expired",
  auditBlocked: "audit_blocked",
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  concurrencyConflict: "concurrency_conflict",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
  deviceBindingConflict: "device_binding_conflict",
  quotaExhausted: "quota_exhausted",
  planRequired: "plan_required",
  accountDisabled: "account_disabled",
})

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", ...extra } = {}) {
    super(String(message ?? ""))
    this.name = "ApiError"
    if (status) this.status = status
    if (code) this.code = code
    Object.assign(this, extra)
  }
}

/** 上游/插件错误统一入口：status 决定宿主换号还是退避。 */
export function upstreamError(message, status = 0, extra = {}) {
  return new ApiError(message, { status, ...extra })
}

export function isAuthFailure(error) {
  const status = Number(error?.status) || 0
  if (status === 401 || status === 403) return true
  const code = String(error?.upstreamCode || error?.code || "").toUpperCase()
  return /INVALID_TOKEN|TOKEN_EXPIRED|UNAUTHORIZED|SESSION_EXPIRED/.test(code)
}

/**
 * MuseWork 的业务错误码 → HTTP status。
 * 上游错误体形如 {"code":"BAD_REQUEST","message":"Invalid request. Please check your input."}，
 * 或 {"code":"USER_INVALID_TOKEN","message":"Invalid or expired token. Please sign in again"}。
 */
export function upstreamStatus(code, status = 0) {
  const declared = Number(status) || 0
  const key = String(code || "").toUpperCase()
  if (key) {
    if (/INVALID_TOKEN|TOKEN_EXPIRED|UNAUTHORIZED|SESSION_EXPIRED|LOGIN_REQUIRED/.test(key)) return 401
    if (/INVALID_CREDENTIALS|WRONG_PASSWORD/.test(key)) return 401
    if (/ACCOUNT_BANNED|ACCOUNT_DISABLED|FORBIDDEN|PERMISSION_DENIED|NO_PERMISSION/.test(key)) return 403
    if (/PLAN_REQUIRED|SUBSCRIPTION_REQUIRED/.test(key)) return 403
    if (/INSUFFICIENT_CREDITS|QUOTA_EXHAUSTED|BALANCE_NOT_ENOUGH/.test(key)) return 402
    if (/MODEL_NOT_FOUND|NO_SUCH_MODEL|MODEL_UNAVAILABLE/.test(key)) return 404
    // 通用 NOT_FOUND（会话/资源不存在）不能当「模型不存在」：404 会让宿主只搁置模型。
    // 落进最后的 502 桶。
    if (/CONCURRENT|CONFLICT|ALREADY_EXISTS/.test(key)) return 409
    if (/TOO_MANY_REQUESTS|RATE_LIMIT|RATE_LIMITED|THROTTL/.test(key)) return 429
    if (/TIMEOUT|DEADLINE_EXCEEDED/.test(key)) return 504
    if (/BAD_REQUEST|INVALID_ARGUMENT|INVALID_REQUEST|VALIDATION|AUDIT|CONTENT/.test(key)) return 400
    if (/INTERNAL|UNAVAILABLE|SERVICE_ERROR|SERVER_ERROR/.test(key)) return 503
  }
  if (declared === 400 || declared === 401 || declared === 402 || declared === 403 ||
      declared === 404 || declared === 409 || declared === 429 || declared === 504) return declared
  if (declared >= 500) return 503
  return 502
}

export function errorCode(error) {
  if (error?.audit) return CODES.auditBlocked
  if (error?.internal) return CODES.internalError
  if (error?.idle || error?.truncated) return CODES.upstreamTimeout
  const status = Number(error?.status) || 0
  if (status === 400) return CODES.invalidRequest
  if (status === 401) return CODES.sessionExpired
  if (status === 402) return CODES.quotaExhausted
  if (status === 403) return CODES.planRequired
  if (status === 404) return CODES.modelNotFound
  if (status === 409) return CODES.concurrencyConflict
  if (status === 429) return CODES.rateLimited
  if (status === 501) return CODES.notImplemented
  if (status === 503) return CODES.upstreamUnavailable
  if (status === 504) return CODES.upstreamTimeout
  return CODES.upstreamError
}

/** 宿主判据：插件内部的语义 → magpie 认识的状态码。 */
export function chatErrorStatus(error) {
  const status = Number(error?.status) || 0
  if (error?.audit) return 400
  if (status === 401 || status === 403) return 401
  if (status === 402) return 402
  if (status === 409) return 409
  if (status === 429) return 429
  if (status === 400 || status === 404 || status === 422) return status === 404 ? 404 : 400
  return status >= 500 ? status : 502
}

/** 非登录问题的 401：告诉宿主「别标账号」。 */
export function signInHeaders(error) {
  const status = Number(error?.status) || 0
  if (status !== 401 && status !== 403) return {}
  const text = String(error?.message || "")
  const authish = /unauthor|登录|凭据|credential|token|session|expired/i.test(text)
  return authish ? {} : { "X-Magpie-Sign-In": "kept" }
}

export function errorResponse(message, status, code, headers = {}) {
  return new Response(JSON.stringify({
    error: {
      message: String(message ?? "MuseWork 请求失败"),
      type: status === 401 ? "authentication_error" : status >= 500 ? "upstream_error" : "invalid_request_error",
      code: code || errorCode({ status }),
      status,
    },
  }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  })
}

/** 上游 HTTP 错误体 → ApiError（保留上游原文，R7）。 */
export function httpError(status, body, prefix = "MuseWork") {
  const info = body && typeof body === "object" ? body : {}
  const code = typeof info.code === "string" ? info.code : ""
  const message = typeof info.message === "string" && info.message
    ? info.message
    : typeof info.error === "string" && info.error
      ? info.error
      : `HTTP ${status}`
  let mapped = upstreamStatus(code, status)
  // 端点 404（API 改路径）不是「模型不存在」；404 会让宿主只搁置模型，改成上游故障。
  if (mapped === 404 && !/MODEL_NOT_FOUND|NO_SUCH_MODEL|MODEL_UNAVAILABLE/i.test(code)) mapped = 502
  const error = upstreamError(`${prefix} 上游返回 ${code || status}：${message}`, mapped, { upstreamCode: code })
  if (mapped === 401) error.sessionExpired = true
  if (mapped === 403) error.permissionDenied = true
  return error
}
