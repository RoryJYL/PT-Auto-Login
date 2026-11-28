export type SiteConfig = {
  name: string
  url: string
  cookies: string
}

export type TaskConfig = SiteConfig & {
  /** 启动前随机等待的毫秒数，把各站散开，避免整点撞限流 */
  delay: number
}

/** 单站运行结果，同一份数据既进历史记录也进告警 */
export type TaskResult = {
  name: string
  ok: boolean
  /** 失败原因，成功时为空 */
  message?: string
}

/** 一次 cron 运行的快照，KV 里一天一个 key */
export type RunRecord = {
  /** 香港时区的 YYYY-MM-DD，cron 跑在 UTC 16:00，正好是本地 0 点 */
  date: string
  startedAt: string
  finishedAt: string
  results: TaskResult[]
}

/** worker-configuration.d.ts 由 wrangler types 生成，密钥不在里面，这里手动补 */
export type AppEnv = Env & {
  /** Bark 的 device key，用 wrangler secret put BARK_KEY 配置 */
  BARK_KEY?: string
  /** 自建 Bark 服务器时覆盖，默认 https://api.day.app */
  BARK_SERVER?: string
}
