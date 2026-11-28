import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCookieTasks } from '../src/task'

const BTSCHOOL = {
  name: 'BTSCHOOL',
  url: 'https://pt.btschool.club/index.php?action=addbonus',
  cookies: 'c_secure_pass=abc',
  delay: 0,
}

function page(status: number, headers: Record<string, string> = {}) {
  return new Response(status === 200 ? '<html>ok</html>' : '', {
    status,
    headers,
  })
}

function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response)
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('runCookieTasks', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('429 时按 Retry-After 退避，而不是固定 5s 连打', async () => {
    vi.useFakeTimers()
    const fetchMock = mockFetch(page(429, { 'retry-after': '2' }), page(200))

    const pending = runCookieTasks([BTSCHOOL])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await expect(pending).resolves.toEqual([{ name: 'BTSCHOOL', ok: true }])
  })

  it('重试三次仍然 429 时把每次状态都写进结果', async () => {
    vi.useFakeTimers()
    mockFetch(page(429), page(429), page(429))

    const pending = runCookieTasks([BTSCHOOL])
    await vi.runAllTimersAsync()

    const [result] = await pending
    expect(result.ok).toBe(false)
    expect(result.message).toContain('被限流')
    expect(result.message).toContain('各次状态：429 -> 429 -> 429')
  })

  it('403 不重试，直接失败', async () => {
    const fetchMock = mockFetch(page(403))

    await expect(runCookieTasks([BTSCHOOL])).resolves.toMatchObject([
      { ok: false },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
