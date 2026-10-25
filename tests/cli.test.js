/**
 * 端到端测试：起一个假桥（真的监听端口），把 CLI 当子进程跑，验证
 * 「参数 → 请求 → 输出 / 退出码」整条链路，以及 401 时的表现。
 *
 * 这一层是为了证明 CLI 不是只对着假 fetch 通过 —— 它真的走 HTTP。
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'

import { startMockBridge } from '../tools/mock-bridge.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'tools', 'cli.js')

/** @type {{ port: number, close: () => Promise<void> }} */
let bridge

before(async () => {
  bridge = await startMockBridge(0)
})

after(async () => {
  await bridge?.close()
})

/** 跑 CLI，返回 stdout/stderr/exitCode（不抛非 0 退出）。 */
async function cli(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        DSHA_BRIDGE_URL: `http://127.0.0.1:${bridge.port}`,
        DSHA_BRIDGE_TOKEN: 'dev',
        ...env,
      },
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }
  }
}

test('status 打印版本', async () => {
  const { stdout, code } = await cli(['status'])
  assert.equal(code, 0)
  assert.match(stdout, /mock bridge/)
})

test('device 打印键值行', async () => {
  const { stdout, code } = await cli(['device'])
  assert.equal(code, 0)
  assert.match(stdout, /model=Mock Phone/)
})

test('apps 支持关键词筛选参数', async () => {
  const { stdout, code } = await cli(['apps', '微信', '--user', '--limit', '5'])
  assert.equal(code, 0)
  assert.match(stdout, /com\.tencent\.mm/)
})

test('notify 带中文正文与标题', async () => {
  const { code } = await cli(['notify', '构建完成', '--title', 'CI'])
  assert.equal(code, 0)
})

test('export 打印导出后的路径', async () => {
  const { stdout, code } = await cli(['export', '/root/report.md'])
  assert.equal(code, 0)
  assert.match(stdout, /Download\/DSHA\/report\.md/)
})

test('token 错时退出码 2，并说明是凭据问题', async () => {
  const { stderr, code } = await cli(['status'], { DSHA_BRIDGE_TOKEN: 'wrong' })
  assert.equal(code, 2)
  assert.match(stderr, /BRIDGE_UNAUTHORIZED|凭据/)
})

test('桥不可达时退出码 2，提示切回前台', async () => {
  // 先占一个端口再关掉，拿到「确定没人监听」的端口
  const { startMockBridge: _unused } = { startMockBridge }
  const free = await startMockBridge(0)
  const deadPort = free.port
  await free.close()
  const { stderr, code } = await cli(['status'], { DSHA_BRIDGE_URL: `http://127.0.0.1:${deadPort}` })
  assert.equal(code, 2)
  assert.match(stderr, /BRIDGE_DOWN|切回前台/)
})

test('失败码被翻译成中文建议', async () => {
  const { stderr, code } = await cli(['sensor', 'disabled'])
  assert.equal(code, 2)
  assert.match(stderr, /DISABLED/)
  assert.match(stderr, /设备能力/)
})

test('raw 能直接打端点', async () => {
  const { stdout, code } = await cli(['raw', '/app/device'])
  assert.equal(code, 0)
  assert.match(stdout, /battery=76/)
})

test('不认识的子命令给出用法', async () => {
  const { stderr, code } = await cli(['nonsense'])
  assert.notEqual(code, 0)
  assert.match(stderr, /BAD_COMMAND|不认识的子命令/)
})
