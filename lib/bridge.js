/**
 * DSHA 3090 桥客户端 —— 本插件唯一的出网口。
 *
 * DSHA（DeepSeek Harness 安卓端）在 App 进程里开了一个本地 HTTP 服务
 * （默认 127.0.0.1:3090），把「只有 Android 能做的事」（通知栏、震动、剪贴板、
 * 起应用、手电、传感器、导出文件…）暴露给容器里的 agent。宿主把凭据写到
 * /root/.dsh/.bridge_token 与 /root/.dsh/.bridge_headers，客户端用 X-Token 头认证。
 *
 * 设计要点：
 *   - 只用 Node 内建能力（fetch / fs），零原生依赖 —— 安卓容器是 Linux arm64，
 *     任何带原生模块的依赖都可能装不上。
 *   - token 只在内存里缓存，不落盘、不进 URL（URL 会进进程列表与日志）。
 *   - 所有失败都归一成 BridgeError(code)，让工具层能给出可执行的中文原因，
 *     而不是抛一个 stack trace 给模型看。
 */

import { readFile } from 'node:fs/promises'

/** 桥的默认地址：DSHA App 内的本机端口。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3090'

/** 宿主要写凭据的两个位置：token 文件优先，其次 curl 用的 headers 文件。 */
export const TOKEN_FILES = ['/root/.dsh/.bridge_token', '/root/.dsh/.bridge_headers']

/** 默认单次请求上限（毫秒）。交互类端点（ask / launch）会单独放宽。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 桥调用失败的统一错误类型。 */
export class BridgeError extends Error {
  /**
   * @param {string} code 机器可读错误码（BRIDGE_DOWN / BRIDGE_UNAUTHORIZED …）
   * @param {string} message 给人看的中文说明
   * @param {{ cause?: unknown, status?: number }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
    if (extra.cause !== undefined) this.cause = extra.cause
  }
}

/**
 * 从一个凭据文件内容里取出 token。
 * `.bridge_headers` 是 curl 用的头文件（`-H @file`），一行 `X-Token: xxx`。
 * @param {string} path 文件路径（只用来判断格式）
 * @param {string} raw 文件内容
 * @returns {string} token；取不到时返回空串
 */
export function parseTokenFile(path, raw) {
  const text = String(raw ?? '')
  if (/\.bridge_headers$/i.test(path) || /\bX-Token\s*:/i.test(text)) {
    const match = /^[ \t]*X-Token[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(text)
    return match ? match[1].replace(/^["']|["']$/g, '') : ''
  }
  return text.trim()
}

/**
 * 读出桥凭据。顺序：显式传入 > 环境变量 > 宿主要写的位置。
 * @param {{ token?: string, tokenPath?: string }} [options]
 * @returns {Promise<string>}
 * @throws {BridgeError} BRIDGE_UNAVAILABLE —— 找不到凭据（= 不在 DSHA 里跑）
 */
export async function resolveToken(options = {}) {
  if (options.token) return String(options.token)
  const fromEnv = process.env.DSHA_BRIDGE_TOKEN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const candidates = options.tokenPath ? [options.tokenPath, ...TOKEN_FILES] : TOKEN_FILES
  for (const path of candidates) {
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const token = parseTokenFile(path, raw)
    if (token) return token
  }
  throw new BridgeError(
    'BRIDGE_UNAVAILABLE',
    `读不到 DSHA 桥凭据（试过 ${candidates.join('、')}）。` +
      '本插件只在 DSHA 安卓端有意义：请确认 App 正在运行，并已启动设备桥（设置 → 设备能力）。',
  )
}

/** 把 fetch 抛出的底层错误翻译成可执行的说明。 */
function networkError(error, url) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new BridgeError(
      'BRIDGE_TIMEOUT',
      `桥在期限内没有回应（${url}）。如果是 /app/ask 或 /app/launch，用户可能正盯着弹窗没操作；否则重试一次。`,
      { cause: error },
    )
  }
  // undici 把真实原因包在 cause 里，且可能套好几层（fetch failed → connect ECONNREFUSED）。
  const codes = []
  const messages = []
  let current = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.code) codes.push(String(current.code))
    if (current.message) messages.push(String(current.message))
    current = current.cause
  }
  const downCodes = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']
  const joined = messages.join(' ')
  if (codes.some((code) => downCodes.includes(code)) || /ECONNREFUSED|bad port|socket hang up|other side closed/i.test(joined)) {
    return new BridgeError(
      'BRIDGE_DOWN',
      `连不上 DSHA 设备桥（${url}）。${joined ? `${joined.slice(0, 120)} —— ` : ''}` +
        'App 可能已退到后台或被系统回收；把 DSHA 切回前台再试。',
      { cause: error },
    )
  }
  const timeoutCodes = ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
  if (codes.some((code) => timeoutCodes.includes(code)) || /timed out/i.test(joined)) {
    return new BridgeError('BRIDGE_TIMEOUT', `连接设备桥超时（${url}）：${joined.slice(0, 120)}`, { cause: error })
  }
  return new BridgeError('BRIDGE_NETWORK', `访问设备桥失败：${error?.message || error}`, { cause: error })
}

/**
 * 造一个桥客户端。
 * @param {{
 *   baseUrl?: string, token?: string, tokenPath?: string, timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export function createBridge(options = {}) {
  const baseUrl = String(options.baseUrl || process.env.DSHA_BRIDGE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl || globalThis.fetch
  /** @type {string | null} */
  let cachedToken = null

  async function token() {
    if (cachedToken) return cachedToken
    cachedToken = await resolveToken(options)
    return cachedToken
  }

  /**
   * 调一个桥端点。GET，参数走 query（中文由 URLSearchParams 编码）。
   * @param {string} route 形如 `/app/device`
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number }} [callOptions]
   * @returns {Promise<{ ok: boolean, code: string, text: string, status: number }>}
   */
  async function call(route, params = {}, callOptions = {}) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue
      query.set(key, String(value))
    }
    const qs = query.toString()
    const url = `${baseUrl}${route}${qs ? `?${qs}` : ''}`
    const auth = await token()

    let response
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { 'X-Token': auth, accept: 'application/json' },
        signal: AbortSignal.timeout(callOptions.timeoutMs ?? timeoutMs),
      })
    } catch (error) {
      throw networkError(error, url)
    }

    const body = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) {
      cachedToken = null
      throw new BridgeError(
        'BRIDGE_UNAUTHORIZED',
        `设备桥拒绝了凭据（HTTP ${response.status}）。token 可能已轮换：让 DSHA 重启一次桥，本插件下次调用会重新读取。`,
        { status: response.status },
      )
    }
    if (!response.ok) {
      throw new BridgeError(
        'BRIDGE_HTTP',
        `设备桥返回 HTTP ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`,
        { status: response.status },
      )
    }

    // 桥的统一响应是 {"result":"<文本>"}（result 一定是字符串，见 HttpShellService）
    let text = body
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') text = parsed.result
    } catch {
      /* 不是 JSON 就按原文处理：老版本桥或错误页 */
    }
    return { ...classifyResult(text), status: response.status }
  }

  return { baseUrl, call, token }
}

/**
 * 把桥返回的文本归类。约定：以大写码开头就是「码」，否则就是正常结果。
 * 例：`DISABLED`、`NO_TEXT`、`FORBIDDEN: 只能分享 /sdcard 下的文件`、
 *     `[APP_BACKGROUND] App 不在前台…`。
 * @param {unknown} raw
 * @returns {{ ok: boolean, code: string, text: string }}
 */
export function classifyResult(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return { ok: true, code: 'OK', text: '' }
  const bracketed = /^\s*\[([A-Z][A-Z0-9_]+)\]\s*([\s\S]*)$/.exec(text)
  if (bracketed) {
    let code = bracketed[1]
    // DSHA 有一类响应用 `[ERR] SOME_CODE: …` / `[RESULT_UNKNOWN] SOME_CODE: …`
    // 把细则放在括号后面；这时真正有用的是后面那个码，不是笼统的 ERR。
    if (code === 'ERR' || code === 'RESULT_UNKNOWN') {
      const inner = /^\s*([A-Z][A-Z0-9_]{2,})(?::|\s*$)/.exec(bracketed[2])
      if (inner) code = inner[1]
    }
    return { ok: false, code, text }
  }
  const bare = /^\s*([A-Z][A-Z0-9_]{2,})(?::|\s*$)/.exec(text)
  if (bare) {
    const code = bare[1]
    return { ok: code === 'OK', code, text }
  }
  return { ok: true, code: 'OK', text }
}
