/**
 * dsha-native-tools — 让 DeepSeek​ Harness 的 agent 真正能操作那台安卓手机。
 *
 * DSHA（Harness 安卓端）在 App 进程里跑了一个本地桥（默认 127.0.0.1:3090），
 * 把「只有 Android 能做」的事暴露出来：通知栏、震动、剪贴板、拉起应用、手电、
 * 传感器、定位、导出文件、系统分享。桥是 HTTP + query 参数 + X-Token 头。
 *
 * 在没装本插件的 DSHA 里，模型得自己拼 URL、自己读 /root/.dsh/.bridge_headers、
 * 自己记住 DISABLED / NO_PERMISSION / FORBIDDEN 这些码各自的含义 —— 每个会话
 * 都重来一遍，既费 token 又常错（尤其是「用户没开开关」时会原地重试）。
 *
 * 本插件把这些端点固化成一等公民工具：类型化参数、结构化结果、失败码翻译成人话，
 * 并把「重试无效」这件事直接写进工具描述里。
 *
 * 纯插件：只用公开接缝 `tools`，零运行时依赖（安卓容器是 Linux arm64，
 * 任何原生模块都可能装不上）。
 *
 * @module dsha-native-tools
 */

import { BridgeError, TOKEN_FILES, createBridge } from './bridge.js'
import { buildTools } from './tools.js'

/** 插件名（loader 用它给 row 编号）。 */
export const name = 'dsha-native-tools'

/** 只依赖工具面：没有工具注册表就不该启动。 */
export const inject = ['tools']

/** 给 `dsh plugin` 的配置 schema 提示（DSH 不一定读，但写上便于人看）。 */
export const Config = {
  baseUrl: { type: 'string', default: 'http://127.0.0.1:3090', description: '设备桥地址' },
  token: { type: 'string', description: '显式指定桥 token（一般留空，自动读宿主写入的凭据）' },
  tokenPath: { type: 'string', description: '自定义凭据文件路径' },
  timeoutMs: { type: 'number', default: 15_000, description: '单次请求超时' },
  askTimeoutMs: { type: 'number', default: 130_000, description: 'dsha_ask_user 等待用户回答的上限' },
}

/**
 * 归一配置：字符串化的布尔/数字也接受（环境变量经 YAML 传进来时常是字符串）。
 * @param {Record<string, unknown>} [raw]
 */
function resolveConfig(raw = {}) {
  const asNumber = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }
  return {
    baseUrl: raw.baseUrl ? String(raw.baseUrl) : undefined,
    token: raw.token ? String(raw.token) : undefined,
    tokenPath: raw.tokenPath ? String(raw.tokenPath) : undefined,
    timeoutMs: asNumber(raw.timeoutMs, 15_000),
    askTimeoutMs: asNumber(raw.askTimeoutMs, 130_000),
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const bridge = createBridge({
    baseUrl: config.baseUrl,
    token: config.token,
    tokenPath: config.tokenPath,
    timeoutMs: config.timeoutMs,
  })
  const tools = buildTools(bridge, { askTimeoutMs: config.askTimeoutMs })

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `dsha-native-tools: ${tool.name}`)
  }

  // 不在 DSHA 里跑时别把整个会话吓坏：只留一条能看懂的提示，工具本身照常注册
  // （调用时才报 BRIDGE_UNAVAILABLE，并告诉你缺什么）。
  bridge.token().catch((error) => {
    const hint =
      error instanceof BridgeError && error.code === 'BRIDGE_UNAVAILABLE'
        ? `dsha-native-tools：没找到设备桥凭据（找过 ${TOKEN_FILES.join('、')}）。不在 DSHA 安卓端时这是正常的，工具会在调用时说明原因。`
        : `dsha-native-tools：读取设备桥凭据失败 —— ${error?.message || error}`
    ctx.logger?.warn?.(hint)
  })
}
