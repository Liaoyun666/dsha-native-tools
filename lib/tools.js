/**
 * 工具面 —— 把 DSHA 3090 桥的设备能力包成 agent 可直接调用的工具。
 *
 * 为什么要有这一层：DSHA 的桥本身是 HTTP + query 参数，模型要自己拼 URL、
 * 自己处理 X-Token、自己认 `DISABLED` / `NO_PERMISSION` / `FORBIDDEN` 这些码。
 * 每个会话都这么干既费 token 又容易错。这里把「端点 → 类型化参数 → 结构化结果」
 * 一次固化下来，模型只需要说「给我发个通知」。
 *
 * 约定：
 *   - 每个工具都返回 `{ ok, code, text, ... }`；`code` 是桥的原始码。
 *   - 失败不抛异常（除参数错），而是 `ok:false` + 可执行的中文解释 ——
 *     抛异常会让模型看到 stack，而不是「去设置里打开某个开关」。
 */

import { classifyResult } from './bridge.js'

/** 结果里最常见的字段。 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['ok', 'code', 'text'],
}

/** 把 bridge.call 的结果渲染成一行给人看的文本。 */
function renderResult(value) {
  if (!value) return [{ type: 'text', text: '（桥没有返回内容）' }]
  if (value.ok) {
    // 桥的成功响应有两种：裸 `OK`，和 `OK: 细节`（如导出后的路径）。
    // 后者把 "OK: " 剥掉再显示，模型和用户都只关心细节。
    const body = String(value.text ?? '').trim().replace(/^OK:\s*/, '')
    if (!body || body === 'OK') return [{ type: 'text', text: `✅ ${value.code}` }]
    return [{ type: 'text', text: body }]
  }
  return [{ type: 'text', text: `⚠️ ${value.code}${value.text ? `：${String(value.text).trim()}` : ''}` }]
}

/**
 * 把常见失败码翻译成「下一步该做什么」。模型最容易犯的错是原地重试，
 * 而这些码里有几个重试一万次也不会变（用户没开开关）。
 */
export function explainCode(code, text) {
  const map = {
    // ── 桥自身（不是 Android 的错，先修连接）
    BRIDGE_UNAVAILABLE:
      '读不到桥凭据 —— 基本等于「这里不是 DSHA 安卓端」。本插件只在 DSHA 里有用，桌面端装了也不该调它。',
    BRIDGE_DOWN: 'App 退到后台或被系统回收了。把 DSHA 切回前台再试，别在原地重试。',
    BRIDGE_UNAUTHORIZED: '凭据被拒（App 重启后 token 会换）。让 DSHA 重新把桥起一次，下次调用会自动重读凭据。',
    BRIDGE_TIMEOUT: '桥没在期限内回应。用户可能正盯着弹窗；否则等一会儿重试一次。',
    BRIDGE_HTTP: '桥返回了非 2xx。这通常是 DSHA 版本与本插件不匹配，把版本号告诉用户。',
    // ── Android 侧的能力开关
    DISABLED: '用户在 DSHA 设置里没打开这类能力。请让用户去「设置 → 设备能力」勾选，重试无效。',
    NO_PERMISSION: 'Android 系统没给 App 这个权限。请让用户在系统设置里授权，重试无效。',
    FOREGROUND_SKIP: 'DSHA 正在前台，桥按设计不打扰用户（不弹通知）。这不是失败。',
    NO_VIBRATOR: '这台设备没有可用的震动马达。',
    NO_TEXT: '缺少要显示的文本。',
    NO_PKG: '缺少包名。',
    NO_PATH: '缺少文件路径。',
    NO_URL: '缺少链接。',
    NO_QUESTION: '缺少问题文本。',
    NO_CONTENT: 'text 与 path 至少要给一个。',
    APP_BACKGROUND: 'DSHA 不在前台，弹不出界面。先用 dsha_notify 提醒用户切回来。',
    TIMEOUT: '等用户回答超时了。别自动重问，先问用户还要不要继续。',
    DISMISSED: '用户关掉了提问框 —— 视为没有回答，不要当成同意。',
    BUSY: '已有一个提问正等着用户回答，等它结束再问。',
    FORBIDDEN: '桥的安全策略拒绝了这次操作（不是 bug，是设计）。别再换参数硬试。',
    // ── 屏幕授权（/app/launch 之类要用户点确认的动作）
    USER_REJECTED: '用户点「拒绝」了这次操作。不要重试 —— 除非用户后来改主意并明确提出。',
    USER_NO_ANSWER: '确认框没人理，超时了。先问用户现在方不方便，别自动弹第二次。',
    USER_CONFIRM_UNAVAILABLE: '现在弹不出确认框（DSHA 不在前台/没在跑）。用 dsha_notify 提醒用户切回来再试。',
    CAPABILITY_NOT_AUTHORIZED: '设备能力还没授权。请用户去 DSHA「设置 → 设备能力」授权屏幕操作，重试无效。',
    CAPABILITY_TARGET_CHANGED: '授权的是另一个目标（比如另一次启动），本次被作废。重新发一次请求即可。',
    SCREEN_RUN_CHANGED: '期间 DSH 会话或页面变了，这次操作作废。重新发一次请求。',
    EXPLICIT_CAPABILITY_REQUEST_REQUIRED: '这个端点必须先由用户显式请求屏幕能力。别自己反复试。',
    // ── 文件
    NOT_FOUND: '路径不存在（或不在 App 能看到的范围里）。先确认路径再试，别猜。',
    TOO_LARGE: '文件超过 64 MiB。换成更小的文件，或者先切分。',
    BAD_NAME: '导出文件名非法（不能含 / 或 ..）。换个名字。',
    NO_SERVICE: '系统服务拿不到（系统级异常）。这台设备可能不常见，把原话告诉用户。',
    // ── 结果不确定：绝不能自动重放
    INTERRUPTED: '操作被打断了，可能没执行完。先核对设备现状再决定要不要重试。',
    RESULT_UNKNOWN: '桥已经发出动作但没等到结果 —— 可能已生效。**先核对现状**，不要盲目重放。',
    ERROR: '桥内部报错。把原文交给用户，并附上 DSHA 版本号。',
  }
  if (map[code]) return map[code]
  if (/^FORBIDDEN/.test(String(text ?? '').trim())) return map.FORBIDDEN
  return null
}

/** 统一收口：调桥 → 归类 → 失败时补一句怎么办。 */
async function invoke(bridge, route, params, callOptions) {
  const result = await bridge.call(route, params, callOptions)
  if (!result.ok) {
    const hint = explainCode(result.code, result.text)
    return { ...result, hint: hint || undefined }
  }
  return result
}

/**
 * 包住 execute：网络层失败（桥没起、token 被换）也变成结构化结果。
 * 不包的话模型看到的是 `Error: ...` 而不是 `{ok:false, code, hint}` ——
 * 这两种在 agent 眼里信息量差很多。
 */
function guard(executor) {
  return async (args, exec) => {
    try {
      return await executor(args, exec)
    } catch (error) {
      const code = error?.code || 'BRIDGE_ERROR'
      return {
        ok: false,
        code,
        text: error?.message || String(error),
        hint: explainCode(code, error?.message) || undefined,
      }
    }
  }
}

/**
 * 造工具定义数组。
 * @param {ReturnType<import('./bridge.js').createBridge>} bridge
 * @param {{ askTimeoutMs?: number }} [config]
 */
export function buildTools(bridge, config = {}) {
  const askTimeoutMs = Number(config.askTimeoutMs) > 0 ? Number(config.askTimeoutMs) : 130_000

  /** @type {any[]} */
  const tools = []

  /** 小工具：省掉每条重复的 output/timeout 样板，并统一兜住网络层异常。 */
  const push = (definition) =>
    tools.push({ output: { schema: RESULT_SCHEMA, render: renderResult }, ...definition, execute: guard(definition.execute) })

  push({
    name: 'dsha_bridge_status',
    description:
      '检查 DSHA 设备桥是否在线：返回桥协议版本、App 版本、以及上次上报的插件加载状态（LOADED/FAILED/PENDING）。' +
      '任何 device 工具报 BRIDGE_DOWN / BRIDGE_UNAUTHORIZED 时先用它确认桥本身的状态，别靠猜。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute() {
      const version = await bridge.call('/app/version')
      if (!version.ok) {
        return { ok: false, code: version.code, text: version.text, hint: explainCode(version.code, version.text) || undefined }
      }
      const plugins = await bridge.call('/app/plugins').catch(() => null)
      const lines = [version.text.trim()]
      if (plugins?.text) lines.push(plugins.text.trim())
      return { ok: true, code: 'OK', text: lines.join('\n'), baseUrl: bridge.baseUrl }
    },
  })

  push({
    name: 'dsha_device_info',
    description:
      '读这台手机的身份和状态：厂商型号、Android 版本、电量、网络、屏幕、存储、内存。' +
      '要「设备是什么情况」时用它，不要去执行 dumpsys / getprop 之类的 shell 命令。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute() {
      const result = await invoke(bridge, '/app/device')
      if (!result.ok) return result
      // 桥返回的是 `key=value` 逐行文本，顺手解析一份结构化视图给模型省 token
      /** @type {Record<string,string>} */
      const fields = {}
      for (const line of result.text.split('\n')) {
        const match = /^([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(line.trim())
        if (match) fields[match[1]] = match[2]
      }
      return { ...result, fields }
    },
  })

  push({
    name: 'dsha_list_apps',
    description:
      '列出手机里已安装的应用（包名 + 应用名），可筛选。用户说「打开微信」「装了哪些软件」时先用它拿到准确包名，' +
      '再把包名交给 dsha_launch_app —— 别凭记忆猜包名。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按包名或应用名筛选，不区分大小写（如 微信 / tencent）' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回多少个' },
        user_only: { type: 'boolean', description: 'true = 只看用户自己装的应用，不要系统应用' },
      },
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      return invoke(bridge, '/app/apps', {
        q: args.query,
        limit: args.limit,
        user: args.user_only ? 1 : undefined,
      })
    },
  })

  push({
    name: 'dsha_launch_app',
    description:
      '按包名把已安装的应用拉到前台。包名要先用 dsha_list_apps 查准（如 com.tencent.mm 是微信）。' +
      '这会打断用户正在做的事，没有明确要求不要调用。若返回 POLICY_BLOCKED / 需要用户确认，照原话转告用户，别重试。',
    parameters: {
      type: 'object',
      properties: { package: { type: 'string', description: '完整包名，如 com.tencent.mm' } },
      required: ['package'],
      additionalProperties: false,
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const pkg = String(args.package ?? '').trim()
      if (!pkg) return { ok: false, code: 'NO_PKG', text: '缺少 package' }
      return invoke(bridge, '/app/launch', { pkg })
    },
  })

  push({
    name: 'dsha_clipboard',
    description:
      '读写手机剪贴板。不给 text 就是读（读需要 DSHA 在前台，否则返回 FOREGROUND_SKIP 一类结果）；' +
      '给 text 就是写。用户说「复制到剪贴板」「刚才复制的是什么」时用它。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入剪贴板的文本；省略=读取当前剪贴板' },
      },
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      return invoke(bridge, '/app/clip', { text: args.text })
    },
  })

  push({
    name: 'dsha_notify',
    description:
      '发一条通知栏消息。DSHA 在前台时桥会跳过（FOREGROUND_SKIP，不算失败，用户正看着屏幕）。' +
      '长任务结束、需要用户回来看结果时用；不要用它刷屏。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '通知正文' },
        title: { type: 'string', description: '通知标题，缺省「DSHA 通知」' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, code: 'NO_TEXT', text: '缺少 text' }
      return invoke(bridge, '/app/notify', { text, title: args.title })
    },
  })

  push({
    name: 'dsha_toast',
    description: '在 App 里弹一个一闪而过的提示（Toast）。只适合「已生效」这类轻确认，救不了需要用户读的长文本 —— 长内容用 dsha_notify。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '提示文字' } },
      required: ['text'],
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, code: 'NO_TEXT', text: '缺少 text' }
      return invoke(bridge, '/app/toast', { text })
    },
  })

  push({
    name: 'dsha_vibrate',
    description: '让手机震一下（30–2000 毫秒）。长任务跑完叫醒用户，或者需要用户在口袋里察觉时用。',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 30, maximum: 2000, description: '震动时长，默认 300' } },
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      return invoke(bridge, '/app/vibrate', { ms: args.ms })
    },
  })

  push({
    name: 'dsha_share',
    description:
      '调起系统分享面板：分享一段文本（text）或一个 /sdcard 下的文件（path）。' +
      '文件必须是外部存储里的（App 私有目录会被 FORBIDDEN 拒掉）。把结果交给用户手上的其它 App 时用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要分享的文本（与 path 二选一）' },
        path: { type: 'string', description: '/sdcard 或 /storage/emulated/0 下的文件绝对路径（与 text 二选一）' },
      },
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const text = args.text === undefined ? undefined : String(args.text)
      const path = args.path === undefined ? undefined : String(args.path)
      if (!text && !path) return { ok: false, code: 'NO_CONTENT', text: 'text 与 path 至少给一个' }
      return invoke(bridge, '/app/share', { text, path })
    },
  })

  push({
    name: 'dsha_open_url',
    description:
      '用系统默认应用打开一个链接 / 深链：http、https、geo、tel、mailto、market 六种 scheme，其余一律 FORBIDDEN。' +
      '用户说「打开这个网页」「拨这个号」时用它，不要去执行 am start。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整链接，如 https://example.com' } },
      required: ['url'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const url = String(args.url ?? '').trim()
      if (!url) return { ok: false, code: 'NO_URL', text: '缺少 url' }
      return invoke(bridge, '/app/open', { url })
    },
  })

  push({
    name: 'dsha_export_file',
    description:
      '把容器里的文件交给用户：复制到手机的 Download/DSHA 目录（用户能在文件管理器里直接看到）。' +
      '交付报告、图片、安装包时用它 —— 别只把路径印在回复里，用户看不到容器内部。' +
      '凭据区（.dsh/.ssh/.android）不可导出，会被 FORBIDDEN 拒绝。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '容器内绝对路径，如 /root/report.md' },
        name: { type: 'string', description: '导出后的文件名（缺省沿用原文件名）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const path = String(args.path ?? '').trim()
      if (!path) return { ok: false, code: 'NO_PATH', text: '缺少 path' }
      return invoke(bridge, '/app/export', { path, name: args.name })
    },
  })

  push({
    name: 'dsha_read_device_file',
    description:
      '按绝对路径读 Android 侧（不是容器侧）的目录或文本文件，上限 256 KiB，权限仍由 Android 决定。' +
      '要看手机上的文件（/sdcard/Download/x.txt）时用它；容器内的文件用普通读文件工具，别绕这一圈。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Android 侧绝对路径，如 /sdcard/Download/note.txt' } },
      required: ['path'],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const path = String(args.path ?? '').trim()
      if (!path) return { ok: false, code: 'NO_PATH', text: '缺少 path' }
      return invoke(bridge, '/app/readfile', { path })
    },
  })

  push({
    name: 'dsha_sensor',
    description:
      '读传感器。不给 name 就列出设备上有哪些传感器；给 name 就读当前值（light 环境光 lux / accel / gyro / magnet / pressure / proximity / gravity / rotation / steps 等）。' +
      '默认关闭：返回 DISABLED 说明用户没在设置里勾选，照原话告诉他去哪开，不要重试。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '传感器名（light/accel/gyro/magnet/pressure/proximity/gravity/rotation/steps）；省略=列出全部' },
      },
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const name = String(args.name ?? '').trim()
      if (!name) return invoke(bridge, '/app/sensors')
      return invoke(bridge, '/app/sensor', { name })
    },
  })

  push({
    name: 'dsha_location',
    description: '读当前位置。默认用缓存的最近一次定位；fresh=true 强制重新定位（可能要等几秒、也更费电）。默认关闭，DISABLED 就转告用户去设置里开。',
    parameters: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: 'true = 强制重新定位' } },
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      return invoke(bridge, '/app/location', { fresh: args.fresh ? 1 : undefined })
    },
  })

  push({
    name: 'dsha_torch',
    description: '开关手电筒。用完记得关掉，别把用户的电筒留在开着的状态。',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true=开，false=关（默认开）' } },
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      return invoke(bridge, '/app/torch', { on: args.on === false ? 0 : 1 })
    },
  })

  push({
    name: 'dsha_ask_user',
    description:
      '在手机屏幕上弹一个原生选择框，阻塞等用户点（最多三个选项，默认 120 秒超时）。' +
      '需要用户拍板、而他可能已经切到别的应用里时用这个 —— 比干等着强。' +
      'DSH 自己的提问工具在 Web UI 里更好用；只有在需要「把用户从别的应用叫回来」时才选它。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题' },
        options: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 3,
          description: '最多三个选项（如 ["继续","取消"]）；省略=只有一个「好」',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    timeoutMs: askTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const question = String(args.question ?? '').trim()
      if (!question) return { ok: false, code: 'NO_QUESTION', text: '缺少 question' }
      const options = Array.isArray(args.options) ? args.options.map((item) => String(item)).slice(0, 3) : []
      const result = await invoke(bridge, '/app/ask', { q: question, options: options.join('|') }, { timeoutMs: askTimeoutMs })
      if (!result.ok) return result
      // 成功时桥返回的是用户点中的那个选项原文
      return { ...result, answer: result.text.trim() }
    },
  })

  return tools
}

export { renderResult, RESULT_SCHEMA, classifyResult }
