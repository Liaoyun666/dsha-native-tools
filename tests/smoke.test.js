/**
 * 冒烟测试：真的 import 插件入口，用一个假的 cordis ctx 跑 apply()。
 *
 * 单元测试只证明内部函数对；这一条证明**包本身能被 DSH 装上**：导出契约合法、
 * 16 个工具都注册上、effect 的 dispose 真的撤销注册、没有凭据时只提醒不炸
 * （Windows / 桌面端装了也不该出事）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

/** 假 ctx：记录 effect 与 tools.register，收集 warn。 */
function fakeContext() {
  const registered = []
  const disposed = []
  const warnings = []
  const effectDisposers = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        let live = true
        return () => {
          if (!live) return
          live = false
          disposed.push(tool.name)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return dispose
    },
    logger: {
      warn: (message) => warnings.push(message),
      info: () => {},
      error: () => {},
    },
  }
  return { ctx, registered, disposed, warnings, effectDisposers }
}

/** 让 apply 里那个异步 token() 检查跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('入口导出符合 DSH 插件契约', () => {
  assert.equal(plugin.name, 'dsha-native-tools')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'object')
})

test('apply() 注册 16 个工具，名字唯一', async () => {
  const { ctx, registered } = fakeContext()
  plugin.apply(ctx, {})
  await settle()
  assert.equal(registered.length, 16)
  assert.equal(new Set(registered.map((tool) => tool.name)).size, 16)
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('effect 的 dispose 会撤销注册（loader 热更新依赖这个）', async () => {
  const { ctx, registered, disposed, effectDisposers } = fakeContext()
  plugin.apply(ctx, {})
  await settle()
  assert.equal(effectDisposers.length, 16)
  for (const dispose of effectDisposers) dispose()
  assert.equal(disposed.length, 16)
  assert.deepEqual(disposed.sort(), registered.map((tool) => tool.name).sort())
})

test('没凭据时只提醒一条，不抛异常（桌面端也能装）', async () => {
  const { ctx, warnings } = fakeContext()
  const saved = process.env.DSHA_BRIDGE_TOKEN
  delete process.env.DSHA_BRIDGE_TOKEN
  try {
    assert.doesNotThrow(() => plugin.apply(ctx, { tokenPath: '/nonexistent/path/.bridge_token' }))
    await settle()
    assert.equal(warnings.length, 1, `应当只有一条提示，实际 ${warnings.length}`)
    assert.match(warnings[0], /dsha-native-tools/)
    assert.match(warnings[0], /凭据|BRIDGE_UNAVAILABLE|设备桥/)
  } finally {
    if (saved !== undefined) process.env.DSHA_BRIDGE_TOKEN = saved
  }
})

test('config 里的 baseUrl 与 token 真的被用上', async () => {
  const { ctx, registered } = fakeContext()
  const seen = []
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers })
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: '0.2.1-rc.2' }) }
  }
  try {
    plugin.apply(ctx, { baseUrl: 'http://127.0.0.1:9999/', token: 'cfg-token' })
    await settle()
    const status = registered.find((tool) => tool.name === 'dsha_bridge_status')
    assert.ok(status, '应该注册了 dsha_bridge_status')
    const value = await status.execute({})
    assert.equal(value.baseUrl, 'http://127.0.0.1:9999')
    assert.ok(seen.length > 0)
    assert.ok(seen[0].url.startsWith('http://127.0.0.1:9999/app/version'))
    assert.equal(seen[0].headers['X-Token'], 'cfg-token')
  } finally {
    globalThis.fetch = savedFetch
  }
})
