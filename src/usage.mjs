// 额度卡片 + 每日奖励（签到）。
//
// 余额是数组（daily / bonus 两个池）：
//   [{credit_type:"daily", total_credits:100, remaining_credits:91},
//    {credit_type:"bonus", total_credits:200, remaining_credits:200}]
//
// 卡片只画一条「积分」：已用 = Σ(total-remaining)，总量 = Σtotal。
// daily 池每天 00:00（北京时间）重置，所以带上 resetsAt。
//
// 每日奖励（网页版「每日奖励」面板，2026-11-15 真机实测）：
//   GET  /api/v1/daily-rewards/status → {claimed_today,claimable,continuous_days,
//        today_reward,monthly_claimed,next_claim_at,reward_steps}
//   POST /api/v1/daily-rewards/claim  → 同样的字段 + {already_claimed,granted_credits}
// 领取后 today_reward 变成「下一次」的奖励（D1 50 → D2 100）。

import { BASE, PATHS } from "./constants.mjs"
import { httpError, upstreamError } from "./errors.mjs"
import { authHeaders, jsonHeaders, requestJson, unwrap } from "./http.mjs"

const creditFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

function number(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function format(value) {
  const n = Math.round(number(value) * 100) / 100
  return creditFormat.format(n)
}

/** 下一个北京时间 00:00（ISO 字符串；magpie 只认 ISO / 数字）。 */
function nextBeijingMidnight(now = Date.now()) {
  const beijing = new Date(now + 8 * 3600_000)
  const next = Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate() + 1,
    0, 0, 0, 0,
  ) - 8 * 3600_000
  return new Date(next).toISOString()
}

export function usageOf(balance, accountId = "") {
  let total = 0
  let remaining = 0
  let hasDaily = false
  for (const item of balance) {
    total += number(item.total_credits)
    remaining += number(item.remaining_credits)
    hasDaily ||= item.credit_type === "daily"
  }
  const used = Math.max(0, total - remaining)

  const windows = []
  if (total > 0) {
    windows.push({
      name: "积分",
      // used 是路由排序输入：必须给有限数字；超额时允许 >100。
      used: (used / total) * 100,
      amount: used,
      limit: total,
      unit: "积分",
      display: `${format(remaining)} / ${format(total)} 积分`,
      ...(hasDaily ? { resetsAt: nextBeijingMidnight() } : {}),
    })
  } else {
    // 上限拿不到（没有 total）：只展示剩余，标 aside 不参与路由。
    windows.push({
      name: "积分",
      used: 0,
      aside: true,
      unit: "积分",
      display: `${format(remaining)} 积分`,
    })
  }

  return {
    ...(accountId ? { user: String(accountId) } : {}),
    windows,
  }
}

/** 每日奖励状态：GET /api/v1/daily-rewards/status */
export async function fetchDailyRewardStatus(fetchImpl, { token, device, signal } = {}) {
  const { response, body } = await requestJson(fetchImpl, `${BASE}${PATHS.dailyStatus}`, {
    method: "GET",
    headers: authHeaders(token, device),
    signal,
    timeoutMs: 20_000,
    maxBytes: 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  if (!data || typeof data !== "object") {
    throw upstreamError("MuseWork 每日奖励响应为空", 502, { internal: true })
  }
  return {
    claimedToday: data.claimed_today === true,
    claimable: data.claimable !== false,
    continuousDays: number(data.continuous_days),
    todayReward: number(data.today_reward),
    monthlyClaimed: number(data.monthly_claimed),
    nextClaimAt: number(data.next_claim_at),
    rewardSteps: Array.isArray(data.reward_steps)
      ? data.reward_steps.map((item) => number(item)).filter((item) => item > 0)
      : [],
  }
}

/** 领取每日奖励：POST /api/v1/daily-rewards/claim */
export async function claimDailyReward(fetchImpl, { token, device, signal } = {}) {
  const { response, body } = await requestJson(fetchImpl, `${BASE}${PATHS.dailyClaim}`, {
    method: "POST",
    headers: jsonHeaders(token, device),
    body: "{}",
    signal,
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  if (!data || typeof data !== "object") {
    throw upstreamError("MuseWork 每日奖励领取响应为空", 502, { internal: true })
  }
  return {
    claimedToday: data.claimed_today === true,
    alreadyClaimed: data.already_claimed === true,
    grantedCredits: number(data.granted_credits),
    continuousDays: number(data.continuous_days),
    monthlyClaimed: number(data.monthly_claimed),
    todayReward: number(data.today_reward),
    nextClaimAt: number(data.next_claim_at),
  }
}
