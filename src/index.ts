import { notifyError, notifyRun } from './alert'
import { hktDate, loadRuns, saveRun } from './history'
import { runCookieTasks } from './task'
import type { AppEnv, RunRecord, SiteConfig } from './type'

const DEFAULT_DAYS = 14
/** 和 KV 的 90 天 TTL 对齐，读更早的也没意义 */
const MAX_DAYS = 90

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    // 静态资源在进到这里之前已经被 assets 接走了，这里只剩 API
    if (url.pathname === '/api/history') {
      const days = parseDays(url.searchParams.get('days'))
      const runs = await loadRuns(env.PAL, days)
      return Response.json(
        { today: hktDate(), days, runs },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    return new Response('Not found', { status: 404 })
  },

  async scheduled(_event, env, ctx) {
    const startedAt = new Date().toISOString()

    try {
      const siteConfigs = await env.PAL.get<SiteConfig[]>('config', 'json')
      if (!siteConfigs?.length) {
        throw new Error('KV 里没有 config，没有任何站点可跑')
      }

      const results = await runCookieTasks(
        siteConfigs.map((siteConfig) => ({
          ...siteConfig,
          delay: Math.floor(Math.random() * 100),
        })),
      )

      const record: RunRecord = {
        date: hktDate(),
        startedAt,
        finishedAt: new Date().toISOString(),
        results,
      }

      // 先落库再推送：推送要等网络，别让 KV 写在这之后被掐掉
      await saveRun(env.PAL, record)
      ctx.waitUntil(notifyRun(env, record))
    } catch (error) {
      // 传 Error 对象本身，Workers Logs / Issues 才能拿到堆栈并正确分组
      console.error(error)
      ctx.waitUntil(
        notifyError(
          env,
          error instanceof Error ? error.message : String(error),
        ),
      )
    }
  },
} satisfies ExportedHandler<AppEnv>

function parseDays(value: string | null): number {
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1) {
    return DEFAULT_DAYS
  }
  return Math.min(days, MAX_DAYS)
}
