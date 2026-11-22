import type { TaskConfig } from './type'

const MAX_ATTEMPTS = 3
const RETRY_DELAY = 5_000
/** NexusPHP 未登录时统一跳转到 login.php */
const LOGIN_URL = 'login.php'
/** HAIDAN 首页在服务端渲染的“今天已打卡”标记 */
const HAIDAN_SIGNED_MARKER = '已经打卡'

export async function runCookieTasks(taskConfigs: TaskConfig[]) {
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

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      // 自己拼成一条字符串：直接把 Error 当参数传时线上日志只剩堆栈，message 会丢
      console.error(
        `[TASK FAILED] ${taskConfigs[index].name}: ${formatReason(result.reason)}`,
      )
    }
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 手动处理重定向：cookie 失效会 302 到 login.php，自动跟随之后是 200 的登录页，会被误判成成功
    const response = await fetch(url, {
      headers: { Cookie: cookies },
      redirect: 'manual',
    })
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

    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `[VISIT FAILED] ${name} ${url} HTTP ${response.status}${location ? ` -> ${location}` : ''}，${await describe(response)}`,
      )
    }

    console.warn(
      `[VISIT RETRY] ${name} HTTP ${response.status}${location ? ` -> ${location}` : ''}，${RETRY_DELAY}ms 后重试（${attempt}/${MAX_ATTEMPTS}）`,
    )
    await sleep(RETRY_DELAY)
  }
}

/**
 * HAIDAN 的每日打卡就是首页按钮发起的 GET /signin.php，不需要浏览器
 */
async function haidanSignInTask({ name, url, cookies, delay }: TaskConfig) {
  const signinUrl = new URL('/signin.php', url)
  await sleep(delay)

  const response = await fetch(signinUrl, {
    headers: { Cookie: cookies },
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
    headers: { Cookie: cookies },
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

/** 失败时把能判断原因的信息都打出来，Cloudflare 拦截表现为 cf-mitigated + 挑战页标题 */
async function describe(response: Response) {
  const body = await response.text()
  const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '无标题'
  const mitigated = response.headers.get('cf-mitigated')
  return `cf-mitigated=${mitigated ?? '-'} title="${title}"`
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
