import type { TaskConfig, TaskResult } from './type'

const MAX_ATTEMPTS = 3
/** 首次重试等 5s，之后按 3 倍退避；站点给了 Retry-After 就以它为准 */
const RETRY_BASE_DELAY = 5_000
/** 再久就不该在 cron 里等了，宁可报失败 */
const MAX_RETRY_DELAY = 60_000
/** NexusPHP 未登录时统一跳转到 login.php */
const LOGIN_URL = 'login.php'
/** HAIDAN 首页在服务端渲染的“今天已打卡”标记 */
const HAIDAN_SIGNED_MARKER = '已经打卡'
/** 只带 Cookie 的裸请求在 Cloudflare 眼里就是脚本，补一套浏览器头能少挨些 bot 分 */
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

export async function runCookieTasks(
  taskConfigs: TaskConfig[],
): Promise<TaskResult[]> {
  const results = await Promise.allSettled(
    taskConfigs.map(async (taskConfig) => {
      // 按配置里的 name 分发，不再拿 URL 猜站点：站点换域名时只改 KV，不用改代码
      switch (normalizeSiteName(taskConfig.name)) {
        case 'HDFANS':
        case 'BTSCHOOL':
          return visitTask(taskConfig)
        case 'HAIDAN':
          return haidanSignInTask(taskConfig)
        default:
          throw new Error(
            `[UNSUPPORTED SITE] name=${taskConfig.name} url=${taskConfig.url}，目前只支持 HDFans / BTSCHOOL / HAIDAN`,
          )
      }
    }),
  )

  // 单个站失败不影响其他站，所以这里只回收结果，不往外抛
  return results.map((result, index) => {
    const { name } = taskConfigs[index]
    if (result.status === 'fulfilled') {
      return { name, ok: true }
    }

    // 自己拼成一条字符串：直接把 Error 当参数传时线上日志只剩堆栈，message 会丢
    console.error(`[TASK FAILED] ${name}: ${formatReason(result.reason)}`)
    // 存进历史记录的只留 message，堆栈太长，也没必要给前端看
    return { name, ok: false, message: formatMessage(result.reason) }
  })
}

function normalizeSiteName(name: string) {
  return name.trim().toUpperCase()
}

/**
 * 直接访问页面，用于只需要保持活跃度的站点（HDFans / BTSCHOOL）
 */
async function visitTask({ name, url, cookies, delay }: TaskConfig) {
  await sleep(delay)
  const statuses: number[] = []

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 手动处理重定向：cookie 失效会 302 到 login.php，自动跟随之后是 200 的登录页，会被误判成成功
    const response = await fetch(url, {
      headers: requestHeaders(cookies),
      redirect: 'manual',
    })
    statuses.push(response.status)
    const location = response.headers.get('location') ?? ''

    if (response.status === 200) {
      const body = await response.text()
      if (body.includes('takelogin.php')) {
        throw new Error(
          `[VISIT FAILED] ${name} ${url} 拿到的是登录页，cookie 已失效`,
        )
      }
      console.log(`[VISIT SUCCESS] ${name} ${url}`)
      return
    }

    if (location.includes(LOGIN_URL)) {
      throw new Error(
        `[VISIT FAILED] ${name} ${url} cookie 已失效，被重定向到 ${location}`,
      )
    }

    // 403/404 重试也没用，早点把真正的错误抛出来
    if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(
        `[VISIT FAILED] ${name} ${url} HTTP ${response.status}${statusHint(response.status)}${location ? ` -> ${location}` : ''}，${await describe(response)}${attemptsHint(statuses)}`,
      )
    }

    const wait = retryDelay(response, attempt)
    console.warn(
      `[VISIT RETRY] ${name} HTTP ${response.status}${statusHint(response.status)}，${Math.round(wait / 1000)}s 后重试（${attempt}/${MAX_ATTEMPTS}）`,
    )
    await sleep(wait)
  }
}

/**
 * HAIDAN 的每日打卡就是首页按钮发起的 GET /signin.php，不需要浏览器
 */
async function haidanSignInTask({ name, url, cookies, delay }: TaskConfig) {
  const signinUrl = new URL('/signin.php', url)
  await sleep(delay)

  const response = await fetch(signinUrl, {
    headers: requestHeaders(cookies),
    redirect: 'manual',
  })
  const location = response.headers.get('location') ?? ''

  if (location.includes(LOGIN_URL)) {
    throw new Error(
      `[SIGNIN FAILED] ${name} ${url} cookie 已失效，被重定向到 ${location}`,
    )
  }
  if (response.status !== 200 && !isRedirect(response.status)) {
    throw new Error(
      `[SIGNIN FAILED] ${name} ${signinUrl} HTTP ${response.status}，${await describe(response)}`,
    )
  }

  // 打卡接口只回一个 302，复查首页确认服务端确实记录了今天的打卡
  const page = await fetch(url, {
    headers: requestHeaders(cookies),
    redirect: 'manual',
  })
  const body = await page.text()
  if (!body.includes(HAIDAN_SIGNED_MARKER)) {
    throw new Error(
      `[SIGNIN FAILED] ${name} ${url} 打卡后首页没有出现“${HAIDAN_SIGNED_MARKER}”，HTTP ${page.status}`,
    )
  }

  console.log(`[SIGNIN SUCCESS] ${name} 每日打卡完成`)
}

/** 失败时把能判断原因的信息都打出来：cf-ray 定位边缘，retry-after 是站点自己给的限流窗口 */
async function describe(response: Response) {
  const body = await response.text()
  const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '无标题'
  const header = (name: string) => response.headers.get(name) ?? '-'
  return [
    `cf-mitigated=${header('cf-mitigated')}`,
    `cf-ray=${header('cf-ray')}`,
    `retry-after=${header('retry-after')}`,
    `content-type=${header('content-type')}`,
    `title="${title}"`,
  ].join(' ')
}

function requestHeaders(cookies: string) {
  return { ...BROWSER_HEADERS, cookie: cookies }
}

/** 只有限流和服务端错误值得重试，其他状态码再试也是同一个结果 */
function isRetryable(status: number) {
  return status === 429 || status >= 500
}

function retryDelay(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_DELAY)
  }
  // 指数退避加一点抖动，别让几个站点卡在同一秒重试
  const backoff = RETRY_BASE_DELAY * 3 ** (attempt - 1)
  return Math.min(backoff, MAX_RETRY_DELAY) + Math.random() * 1000
}

/** 429 是限流，不是 cookie 挂了，别让人往错的方向查 */
function statusHint(status: number) {
  return status === 429 ? '（被限流，不是 cookie 问题）' : ''
}

/** 前几次的状态也带上，否则只看最后一次 429 会误判成一直在被限流 */
function attemptsHint(statuses: number[]) {
  return statuses.length > 1 ? `（各次状态：${statuses.join(' -> ')}）` : ''
}

function isRedirect(status: number) {
  return status >= 300 && status < 400
}

function formatReason(reason: unknown) {
  if (!(reason instanceof Error)) {
    return String(reason)
  }
  // stack 第一行就是 "Name: message"，去掉它，避免和上面的 message 重复
  const frames = reason.stack?.split('\n').slice(1).join('\n') ?? ''
  return `${reason.name}: ${reason.message}${frames ? `\n${frames}` : ''}`
}

function formatMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
