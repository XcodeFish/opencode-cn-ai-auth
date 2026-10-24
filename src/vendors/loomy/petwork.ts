/**
 * 宠物每日打工（pet-work）：卡片上的那一行，以及签到时的领奖。
 *
 * ## 为什么领奖只挂在 `auth.checkin`
 *
 * 档位由服务端按**该账号当日在官方客户端的有效对话轮次**算（`sessionWeight ×
 * sessionIndex + depthWeight × depthIndex`，权重与基线都由快照下发）。本包是网关：
 * 它转发用户的对话请求，但不产生轮次归属，也拿不到官方客户端里的轮次统计 ——
 * 也就是说，这里每次领奖对「够不够档」毫无影响，只在用户当天已经攒够轮次时把分
 * 收下来。收益是用户的，动作就该落在用户按得下去的地方：`auth.checkin`
 * （卡片上的 `Check in now`、`magpie accounts checkin`、每日自动签到）。
 *
 * 卡片读到进度就顺手领（新手任务那套）在这里**不**合适：未达档位是常态，每次额度
 * 刷新都发一个注定被拒的 POST 只是白烧上游请求。
 *
 * 一次签到会把今天未领的档位逐档申请（最多档位数那么多），某档没达标就停手 ——
 * 用户当天在官方客户端聊够了却一直没按签到时，一档都不会漏掉。
 *
 * ## 为什么这一行会自己消失
 *
 * 封顶（`dailyRewardCapped`）说明今天的 1000 分已经收完，这一行没有可说的了 ——
 * 与新手任务 8/8 时不显示同一取舍。活动关闭时也不显示。
 *
 * 读数按账号缓存 `LOOMY_PETWORK_TTL_MS`：`usage` 每轮额度刷新都会跑到这里，而进度
 * 只在官方客户端产生新轮次、或本包领奖之后变化。
 */

import { SignInExpiredError } from "../../core/errors.ts"
import type { Fetcher } from "../../core/http.ts"
import { str } from "../../core/json.ts"
import type { StoredAuth, UsageWindow } from "../../core/types.ts"
import { claimPetWorkReward, fetchPetWork, type LoomyPetWork } from "./api.ts"
import {
  LOOMY_ID,
  LOOMY_PETWORK_CONFIG_VERSION,
  LOOMY_PETWORK_TTL_MS,
  LOOMY_SIGNED_OUT_CODE,
} from "./product.ts"

interface Reading {
  at: number
  data: LoomyPetWork
}

const readings = new Map<string, Reading>()

/**
 * 读数的键：厂商自己的 user id 优先（跨重新登录稳定），退回 session。
 * 宿主的账号存储里没有本包要的位置，所以缓存必须能从账号本身重建。
 */
function keyOf(auth: StoredAuth | undefined): string | undefined {
  return str(auth?.userid) ?? str(auth?.access) ?? str(auth?.key)
}

/** 忘掉所有读数；测试用，宿主不需要。 */
export function forgetPetWorkReadings(): void {
  readings.clear()
}

/**
 * 忘掉一个账号的读数，下一次 `usage` 重新读服务端。
 *
 * 领奖之后必须调用：缓存里那份是领奖前的状态，不丢就会在卡片上继续显示旧进度。
 */
export function forgetPetWorkReading(auth: StoredAuth | undefined): void {
  const key = keyOf(auth)
  if (key !== undefined) readings.delete(key)
}

/**
 * 该账号今天的宠物打工状态，缓存优先。
 *
 * 读失败返回 `undefined` 而不是抛错：卡片少一行不值得让整个额度读取失败。
 */
export async function petWorkStateFor(
  fetcher: Fetcher,
  auth: StoredAuth | undefined,
  access: string,
  now = Date.now(),
): Promise<LoomyPetWork | undefined> {
  const key = keyOf(auth)
  if (key !== undefined) {
    const cached = readings.get(key)
    if (cached !== undefined && now - cached.at <= LOOMY_PETWORK_TTL_MS) return cached.data
  }
  const result = await fetchPetWork(fetcher, access)
  if (!result.ok) return undefined
  if (key !== undefined) readings.set(key, { at: now, data: result.data })
  return result.data
}

/**
 * 卡片上的那一行，或什么都不显示。
 *
 * `aside: true` 且不带 `limit` / `amount`：这一行只解释今天有没有分可领，不该被
 * 画成「池子被花掉多少」的进度条，也不该参与选号（封顶与否不是路由依据）。
 *
 * ⚠️ `earnedToday == 0` 只说明**还没领过**，不说明「未达档位」：快照里没有「已达档位」
 * 这个字段（只有 `earnedPointsToday` / `rewardedTierIds` / `dailyRewardCapped`），
 * 够不够档只有领奖回执才会说。写「未达档位」是拿没证据的结论骗人 —— 实测过：卡片显示
 * 0/1000「未达档位」，紧接着签到领到 +1000，说明三档早就够了。
 */
export function petWorkWindow(state: LoomyPetWork | undefined): UsageWindow | undefined {
  if (state === undefined || !state.enabled || state.capped) return undefined
  const earned = state.earnedToday ?? 0
  const parts = [state.dailyMax === undefined ? `今日 ${earned} 分` : `今日 ${earned}/${state.dailyMax}`]
  if (earned > 0 && state.tiers.length > 0)
    parts.push(`已领 ${state.rewardedTiers.length}/${state.tiers.length} 档`)
  if (earned === 0) parts.push("未领取")
  return {
    name: "宠物打工",
    used: 0,
    aside: true,
    unit: "分",
    display: `宠物打工 ${parts.join(" · ")}`,
  }
}

/** 一次领奖尝试的结果。`message` 是给用户看的，`detail` 只进日志。 */
export interface PetWorkClaim {
  outcome: "claimed" | "done" | "inactive" | "notReached" | "failed"
  /** 本次实际拿到的分数；`done` / `notReached` 为 0。 */
  points: number
  /** 面向用户的一句话；读快照失败时为空（不把「读不到」说成结论）。 */
  message?: string
  /** 只进日志的细节，不拼进签到文案。 */
  detail?: string
}

function doneMessage(state: LoomyPetWork): string {
  return state.earnedToday === undefined
    ? "今日宠物打工积分已领取"
    : `今日宠物打工积分已领取（${state.earnedToday} 分）`
}

function notReachedMessage(earned: number | undefined): string {
  const head = "宠物打工未达档位（档位按官方客户端的有效对话轮次计算）"
  return earned !== undefined && earned > 0 ? `${head}，今日已获 ${earned} 分` : `${head}，本次没有可领积分`
}

/**
 * 今日还没领的档位，按档位表顺序。
 *
 * 拿不到档位表时只有快照给的那一档（兜底 `tier_1`）—— 不猜更高档。封顶由调用方先判。
 */
function pendingTiers(state: LoomyPetWork): string[] {
  const done = new Set(state.rewardedTiers)
  if (state.tiers.length === 0) return state.nextTier === undefined ? [] : [state.nextTier]
  return state.tiers.map((tier) => tier.id).filter((id) => !done.has(id))
}

/**
 * 领今天的宠物打工奖励：读快照 → 按档位顺序把未领的档逐档申请。
 *
 * 一次签到可能攒下不止一档（用户当天在官方客户端聊够了却一直没领），所以逐档申请；
 * 某档没达标就停手 —— 档位按分数单调，这一档没到，更高的更不可能到。回执里带回的
 * `grantedTierIds` 会并进「已领」，因此服务端若一次发多档也不会重复申请。
 *
 * 状态映射（每一步都有实测或既有实现的依据，见 `docs/vendors.md`）：
 *
 * ```
 * 快照读不到                  -> failed + detail（不拼进签到文案）
 * enabled=false               -> inactive
 * 封顶 / 没有未领档位          -> done（一个领奖请求都不发）
 * granted=true（或带回档位）   -> claimed，分数按 grantedPoints，缺失时用今日累计差分
 * duplicate                   -> done
 * granted=false 且无档位       -> 未达档位：停手；一档都没领到就报 notReached
 * 100002                      -> SignInExpiredError（宿主标记账号）
 * 其它业务码                   -> 停手；一档都没领到就报 failed + 厂商原话
 * ```
 */
export async function claimPetWork(
  fetcher: Fetcher,
  access: string,
  auth: StoredAuth | undefined,
): Promise<PetWorkClaim> {
  const state = await fetchPetWork(fetcher, access)
  if (!state.ok) {
    if (state.code === LOOMY_SIGNED_OUT_CODE) {
      throw new SignInExpiredError(LOOMY_ID, `宠物打工被拒绝：${state.message}`)
    }
    return { outcome: "failed", points: 0, detail: `读 pet-work 快照失败：${state.message}` }
  }
  const pet = state.data
  if (!pet.enabled) return { outcome: "inactive", points: 0, message: "宠物打工活动当前未开启" }
  const businessDate = pet.businessDate
  if (businessDate === undefined) {
    // 没有业务日就不发领奖请求：服务端会以必填校验拒绝，白发一次只消耗上游风控。
    return { outcome: "failed", points: 0, detail: "pet-work 快照里没有 businessDate，跳过领奖" }
  }
  const pending = pendingTiers(pet)
  if (pet.capped || pending.length === 0) {
    return { outcome: "done", points: 0, message: doneMessage(pet) }
  }
  const attempt = await claimTiers(fetcher, access, pet, businessDate, pending)
  // 回执已经改变了当日状态，卡片那份读数作废。
  forgetPetWorkReading(auth)
  return petWorkOutcome(attempt)
}

/** 一轮领奖跑下来的账：发了多少分、领到几档、为什么停下。 */
interface PetWorkAttempt {
  points: number
  granted: number
  /** 至少有一档没回填 `grantedPoints`，分数是按今日累计差分算的。 */
  usedDiff: boolean
  duplicate: boolean
  earned?: number
  /** 让循环停下的厂商原话（业务码失败时）。 */
  failure?: string
}

/**
 * 按档位顺序逐档申请，直到某档未达标、已领过、被拒或封顶。
 *
 * 单独成函数是为了让 `claimPetWork` 的判定链读得下来（每个 `if` 都是对外状态）。
 */
async function claimTiers(
  fetcher: Fetcher,
  access: string,
  pet: LoomyPetWork,
  businessDate: string,
  pending: readonly string[],
): Promise<PetWorkAttempt> {
  const attempt: PetWorkAttempt = {
    points: 0,
    granted: 0,
    usedDiff: false,
    duplicate: false,
    ...(pet.earnedToday === undefined ? {} : { earned: pet.earnedToday }),
  }
  const done = new Set(pet.rewardedTiers)
  for (const tierId of pending) {
    if (done.has(tierId)) continue
    const before = attempt.earned
    const result = await claimPetWorkReward(fetcher, access, {
      businessDate,
      configVersion: pet.configVersion ?? LOOMY_PETWORK_CONFIG_VERSION,
      tierId,
    })
    if (!result.ok) {
      if (result.code === LOOMY_SIGNED_OUT_CODE) {
        throw new SignInExpiredError(LOOMY_ID, `宠物打工被拒绝：${result.message}`)
      }
      attempt.failure = result.message
      break
    }
    const grant = result.data
    if (grant.earnedToday !== undefined) attempt.earned = grant.earnedToday
    for (const id of grant.grantedTiers) done.add(id)
    if (!grant.granted && grant.grantedTiers.length === 0) {
      // granted=false 且没有档位：这一档没达标，更高的档更不可能达标；duplicate 则是今天已领过。
      attempt.duplicate = grant.duplicate
      break
    }
    attempt.points += grantPoints(grant.points, grant.earnedToday, before)
    if (grant.points === undefined || grant.points <= 0) attempt.usedDiff = true
    attempt.granted += 1
    if (grant.capped) break
  }
  return attempt
}

function petWorkOutcome(attempt: PetWorkAttempt): PetWorkClaim {
  if (attempt.granted > 0) {
    return {
      outcome: "claimed",
      points: attempt.points,
      message: claimedMessage(attempt),
      ...(attempt.failure === undefined ? {} : { detail: `部分档位未领：${attempt.failure}` }),
    }
  }
  if (attempt.failure !== undefined) {
    return { outcome: "failed", points: 0, message: `宠物打工领取失败：${attempt.failure}` }
  }
  if (attempt.duplicate) {
    return {
      outcome: "done",
      points: 0,
      message:
        attempt.earned === undefined
          ? "今日宠物打工积分已领取"
          : `今日宠物打工积分已领取（${attempt.earned} 分）`,
    }
  }
  return { outcome: "notReached", points: 0, message: notReachedMessage(attempt.earned) }
}

function claimedMessage(attempt: PetWorkAttempt): string {
  if (attempt.points <= 0) return "宠物打工奖励已发放（上游未回填金额）"
  return `宠物打工奖励 +${attempt.points} 分${attempt.usedDiff ? "（按今日累计差分）" : ""}`
}

/** 本次发放额：回执明说的优先，否则用今日累计的差分。 */
function grantPoints(
  stated: number | undefined,
  after: number | undefined,
  before: number | undefined,
): number {
  if (stated !== undefined && stated > 0) return stated
  if (after === undefined || before === undefined) return 0
  return Math.max(0, after - before)
}
