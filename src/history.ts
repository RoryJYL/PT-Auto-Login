import type { RunRecord } from './type'

const KEY_PREFIX = 'run:'
/** 靠 KV 自己的 TTL 清理，不用写定时删除 */
const RETENTION_SECONDS = 90 * 24 * 60 * 60
/** 香港没有冬令时，固定 UTC+8 */
const HKT_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 按香港时区切日。cron 是 UTC 16:00，本地正好 0 点，
 * 用 toISOString() 直接取日期会把今天的记录写成昨天。
 */
export function hktDate(at: Date = new Date()): string {
  return new Date(at.getTime() + HKT_OFFSET_MS).toISOString().slice(0, 10)
}

export async function saveRun(
  kv: KVNamespace,
  record: RunRecord,
): Promise<void> {
  await kv.put(KEY_PREFIX + record.date, JSON.stringify(record), {
    expirationTtl: RETENTION_SECONDS,
  })
}

/**
 * 返回最近 days 天的记录，日期倒序。
 * 中间缺失的日子不补，前端按日期对齐后自己画空档。
 */
export async function loadRuns(
  kv: KVNamespace,
  days: number,
): Promise<RunRecord[]> {
  const since = hktDate(new Date(Date.now() - Math.max(days - 1, 0) * DAY_MS))
  const { keys } = await kv.list({ prefix: KEY_PREFIX })
  // run:YYYY-MM-DD 定长，字符串比较就是日期比较
  const recent = keys.filter((key) => key.name >= KEY_PREFIX + since)

  const records = await Promise.all(
    recent.map((key) => kv.get<RunRecord>(key.name, 'json')),
  )

  return records
    .filter((record): record is RunRecord => record !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
}
