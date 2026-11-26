import type { AppEnv, RunRecord } from './type'

const BARK_DEFAULT_SERVER = 'https://api.day.app'
/** 带上分组，Bark 里能折叠成一组，不会把通知列表刷乱 */
const NOTIFICATION_GROUP = 'PT 签到'
const PUSH_TIMEOUT_MS = 10_000

/** 一次运行最多一条通知，全成功就不发 */
export async function notifyRun(env: AppEnv, record: RunRecord): Promise<void> {
  const failed = record.results.filter((result) => !result.ok)
  if (failed.length === 0) {
    return
  }

  const body = failed
    .map((result) => `${result.name}：${result.message ?? '未知错误'}`)
    .join('\n')
  await push(env, `签到失败 ${failed.length}/${record.results.length}`, body)
}

/** 整条任务链挂掉时（比如 KV 读不到 config）也得喊一声 */
export async function notifyError(env: AppEnv, message: string): Promise<void> {
  await push(env, '签到脚本异常', message)
}

/** Bark 路径式接口：/{key}/{title}/{body}，POST 和 GET 参数一致 */
async function push(env: AppEnv, title: string, body: string): Promise<void> {
  const key = env.BARK_KEY
  if (!key) {
    console.warn('[ALERT] 没配 BARK_KEY，跳过推送')
    return
  }

  const server = (env.BARK_SERVER ?? BARK_DEFAULT_SERVER).replace(/\/+$/, '')
  const path = [
    encodeURIComponent(key),
    encodeURIComponent(title),
    encodeURIComponent(body),
  ].join('/')
  const url = `${server}/${path}?group=${encodeURIComponent(NOTIFICATION_GROUP)}`

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.error(
        `[ALERT FAILED] Bark HTTP ${response.status} ${await response.text()}`,
      )
    }
  } catch (error) {
    // 推送挂了不能反过来把主流程弄崩，最坏情况是丢一条通知
    console.error('[ALERT FAILED] 推送 Bark 失败', error)
  }
}
