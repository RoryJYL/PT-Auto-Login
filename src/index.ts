import { runCookieTasks } from './task'
import type { SiteConfig } from './type'

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const siteConfigs = await env.PAL.get<SiteConfig[]>('config', 'json')
      if (!siteConfigs) {
        return new Response('No config found', { status: 404 })
      }

      await autoLogin(siteConfigs)

      return new Response('Login tasks completed.', { status: 200 })
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : JSON.stringify(error),
        { status: 500 },
      )
    }
  },
  async scheduled(event, env, ctx) {
    try {
      const siteConfigs = await env.PAL.get<SiteConfig[]>('config', 'json')
      if (!siteConfigs) {
        throw new Error('No config found')
      }
      await autoLogin(siteConfigs)
    } catch (error) {
      console.error(error)
    }
  },
} satisfies ExportedHandler<Env>

async function autoLogin(siteConfigs: SiteConfig[]) {
  const taskConfigs = siteConfigs.map((siteConfig) => ({
    ...siteConfig,
    delay: Math.floor(Math.random() * 100),
  }))

  console.log('[START] Start login tasks.')

  await runCookieTasks(taskConfigs)

  console.log('[COMPLETE] Tasks completed.')
}
