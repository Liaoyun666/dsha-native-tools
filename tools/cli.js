#!/usr/bin/env node
/**
 * 终端侧的命令行入口 —— 同一个桥，不经过 agent。
 *
 * 为什么还要一个 CLI：插件只在 DSH 会话里可用，但在 DSHA 的终端里（或写脚本、
 * 写 cron、排查桥到底通不通时）也需要直接按一下设备能力。两者共用 lib/bridge.js，
 * 所以参数名、错误码、认证方式不会漂移。
 *
 * 用法：
 *   node tools/cli.js status
 *   node tools/cli.js device
 *   node tools/cli.js apps 微信 --user --limit 20
 *   node tools/cli.js launch com.tencent.mm
 *   node tools/cli.js notify "编译完了" --title 构建
 *   node tools/cli.js clip --set 一段文字
 *   node tools/cli.js ask "继续吗？" 继续 取消
 *   node tools/cli.js raw /app/help
 */

import { BridgeError, classifyResult, createBridge } from '../lib/bridge.js'
import { buildTools, explainCode } from '../lib/tools.js'

const USAGE = `dsha-native-tools CLI — 直接调 DSHA 设备桥

  status                          桥是否在线、App 版本、插件加载状态
  device                          设备信息（型号 / 电量 / 网络 / 存储 / 内存）
  apps [关键词] [--user] [--limit N]
                                  列出已安装应用
  launch <包名>                   把应用拉到前台
  clip                            读剪贴板
  clip --set <文本>               写剪贴板
  notify <正文> [--title 标题]    发通知
  toast <文本>                    弹 Toast
  vibrate [毫秒]                  震动
  share --text <文本> | --path <文件>
                                  系统分享
  open <链接>                     http/https/geo/tel/mailto/market
  export <容器内路径> [--name 名] 导出到手机 Download/DSHA
  read <Android 路径>             读手机侧文件（≤256 KiB）
  sensor [名字]                   传感器列表 / 读一个
  location [--fresh]              定位
  torch on|off                    手电
  ask <问题> [选项…]              弹原生选择框（最多 3 个选项）
  raw <端点> [k=v …]              直接打桥端点，调试用

环境变量：DSHA_BRIDGE_URL（默认 http://127.0.0.1:3090）、DSHA_BRIDGE_TOKEN
`

/** 从 argv 里摘出 `--flag` 与 `--key value`，剩下的按位置参数。 */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      positional.push(item)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

/** 输出：成功打正文，失败打码 + 怎么办，并以非 0 退出。 */
function report(result) {
  if (result.ok) {
    const body = String(result.text ?? '').trim().replace(/^OK:\s*/, '')
    if (body && body !== 'OK') console.log(body)
    return 0
  }
  console.error(`✗ ${result.code}${result.text ? `：${result.text.trim()}` : ''}`)
  const hint = result.hint || explainCode(result.code, result.text)
  if (hint) console.error(`  → ${hint}`)
  return 2
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv)
  const [command, ...rest] = positional
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE)
    return 0
  }

  const bridge = createBridge({ baseUrl: flags.url ? String(flags.url) : undefined })
  const tools = new Map(buildTools(bridge).map((tool) => [tool.name, tool]))

  const run = async (name, args) => report(await tools.get(name).execute(args))

  switch (command) {
    case 'status':
      return run('dsha_bridge_status', {})

    case 'device': {
      const value = await tools.get('dsha_device_info').execute({})
      if (!value.ok) return report(value)
      console.log(value.text.trim())
      return 0
    }

    case 'apps':
      return run('dsha_list_apps', {
        query: rest[0],
        user_only: Boolean(flags.user),
        limit: flags.limit ? Number(flags.limit) : undefined,
      })

    case 'launch':
      if (!rest[0]) throw new BridgeError('NO_PKG', '用法：launch <包名>')
      return run('dsha_launch_app', { package: rest[0] })

    case 'clip':
      return run('dsha_clipboard', flags.set === undefined ? {} : { text: String(flags.set) })

    case 'notify':
      return run('dsha_notify', { text: rest.join(' '), title: flags.title ? String(flags.title) : undefined })

    case 'toast':
      return run('dsha_toast', { text: rest.join(' ') })

    case 'vibrate':
      return run('dsha_vibrate', { ms: rest[0] ? Number(rest[0]) : undefined })

    case 'share':
      return run('dsha_share', {
        text: flags.text === undefined ? undefined : String(flags.text),
        path: flags.path === undefined ? undefined : String(flags.path),
      })

    case 'open':
      return run('dsha_open_url', { url: rest[0] })

    case 'export':
      return run('dsha_export_file', { path: rest[0], name: flags.name ? String(flags.name) : undefined })

    case 'read':
      return run('dsha_read_device_file', { path: rest[0] })

    case 'sensor':
      return run('dsha_sensor', { name: rest[0] })

    case 'location':
      return run('dsha_location', { fresh: Boolean(flags.fresh) })

    case 'torch':
      if (!['on', 'off'].includes(rest[0])) throw new BridgeError('BAD_ARG', '用法：torch on|off')
      return run('dsha_torch', { on: rest[0] === 'on' })

    case 'ask':
      return run('dsha_ask_user', { question: rest[0], options: rest.slice(1) })

    case 'raw': {
      const route = rest[0]
      if (!route || !route.startsWith('/')) throw new BridgeError('BAD_ARG', '用法：raw /app/xxx [k=v …]')
      const params = {}
      for (const pair of rest.slice(1)) {
        const at = pair.indexOf('=')
        if (at > 0) params[pair.slice(0, at)] = pair.slice(at + 1)
      }
      const result = await bridge.call(route, params)
      console.log(result.text.trim() || JSON.stringify(result))
      return result.ok ? 0 : 2
    }

    default:
      throw new BridgeError('BAD_COMMAND', `不认识的子命令：${command}\n\n${USAGE}`)
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    if (error instanceof BridgeError) {
      console.error(`✗ ${error.code}：${error.message}`)
      process.exitCode = 2
      return
    }
    const classified = classifyResult(error?.message || String(error))
    console.error(`✗ ${classified.text}`)
    process.exitCode = 3
  },
)
