/**
 * 单元测试：不起真桥，用一个假的 fetch 记录请求并回放 DSHA 的响应格式。
 * 这样能在任何平台（含 Windows 开发机）验证参数编码、凭据读取、错误码归类。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BridgeError, classifyResult, createBridge, parseTokenFile } from '../lib/bridge.js'
import { buildTools, explainCode } from '../lib/tools.js'

/** 造一个假 fetch：记录每次调用，按 route 回放 `{"result":"..."}`。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), init })
    const outcome = handler(parsed, init)
    const status = outcome?.status ?? 200
    const result = outcome?.result ?? 'OK'
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify({ result }),
    }
  }
  impl.calls = calls
  return impl
}

const TOKEN = 'tok-abc'

/** 常用桥：凭据直接给，避免读文件。 */
function bridgeWith(fetchImpl, extra = {}) {
  return createBridge({ token: TOKEN, fetchImpl, ...extra })
}

/** 按名字取工具，顺便断言它存在。 */
function toolNamed(tools, name) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `工具 ${name} 应该存在`)
  return tool
}

test('classifyResult 认出各种码', () => {
  assert.deepEqual(classifyResult('OK'), { ok: true, code: 'OK', text: 'OK' })
  assert.equal(classifyResult('').ok, true)
  assert.equal(classifyResult('已通知').code, 'OK')

  const disabled = classifyResult('DISABLED')
  assert.equal(disabled.ok, false)
  assert.equal(disabled.code, 'DISABLED')

  const forbidden = classifyResult('FORBIDDEN: 只能分享 /sdcard 下的文件')
  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.code, 'FORBIDDEN')

  const bracketed = classifyResult('[APP_BACKGROUND] DSHA 不在前台')
  assert.equal(bracketed.ok, false)
  assert.equal(bracketed.code, 'APP_BACKGROUND')

  // `[ERR] SOME_CODE: …` 里真正有用的是括号后那个码
  const nested = classifyResult('[ERR] CAPABILITY_NOT_AUTHORIZED')
  assert.equal(nested.ok, false)
  assert.equal(nested.code, 'CAPABILITY_NOT_AUTHORIZED')
  const nested2 = classifyResult('[RESULT_UNKNOWN] APP_LAUNCH_RESULT_UNKNOWN: 已发出')
  assert.equal(nested2.code, 'APP_LAUNCH_RESULT_UNKNOWN')

  // 正常英文句子不能被误判成码
  assert.equal(classifyResult('Galaxy S23').code, 'OK')
})

test('renderResult 剥掉成功响应里的 "OK: " 前缀', async () => {
  const { renderResult } = await import('../lib/tools.js')
  const shown = (value) => renderResult(value)[0].text
  assert.equal(shown({ ok: true, code: 'OK', text: 'OK' }), '✅ OK')
  assert.equal(shown({ ok: true, code: 'OK', text: 'OK: /sdcard/Download/a.md' }), '/sdcard/Download/a.md')
  assert.equal(shown({ ok: false, code: 'DISABLED', text: 'DISABLED' }), '⚠️ DISABLED：DISABLED')
})

test('parseTokenFile 支持 token 原文与 curl headers 两种格式', () => {
  assert.equal(parseTokenFile('/root/.dsh/.bridge_token', '  abc123\n'), 'abc123')
  assert.equal(parseTokenFile('/root/.dsh/.bridge_headers', 'X-Token: abc123\n'), 'abc123')
  assert.equal(parseTokenFile('/root/.dsh/.bridge_headers', "X-Token:  \"abc123\"\n"), 'abc123')
  assert.equal(parseTokenFile('/root/.dsh/.whatever', 'X-Token: zzz\n'), 'zzz')
  assert.equal(parseTokenFile('/root/.dsh/.bridge_headers', 'nothing here'), '')
})

test('bridge.call 拼 query、带 X-Token、解析 result', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'pixel=8' }))
  const bridge = bridgeWith(fetchImpl)
  const result = await bridge.call('/app/device', { a: 1, skip: undefined, empty: '' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'pixel=8')
  assert.equal(fetchImpl.calls.length, 1)
  const [call] = fetchImpl.calls
  assert.equal(call.path, '/app/device')
  assert.deepEqual(call.params, { a: '1' })
  assert.equal(call.init.headers['X-Token'], TOKEN)
})

test('中文参数走 URL 编码', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'OK' }))
  const bridge = bridgeWith(fetchImpl)
  await bridge.call('/app/notify', { title: '构建完成', text: '报告在这里' })
  assert.equal(fetchImpl.calls[0].params.title, '构建完成')
  assert.equal(fetchImpl.calls[0].params.text, '报告在这里')
})

test('401 归一成 BRIDGE_UNAUTHORIZED 并清缓存', async () => {
  let seen = 0
  const fetchImpl = async () => {
    seen += 1
    return { ok: false, status: 401, text: async () => 'nope' }
  }
  const bridge = bridgeWith(fetchImpl, { token: '' })
  process.env.DSHA_BRIDGE_TOKEN = TOKEN
  try {
    await assert.rejects(() => bridge.call('/app/device'), (error) => {
      assert.ok(error instanceof BridgeError)
      assert.equal(error.code, 'BRIDGE_UNAUTHORIZED')
      return true
    })
    assert.equal(seen, 1)
  } finally {
    delete process.env.DSHA_BRIDGE_TOKEN
  }
})

test('连不上归一成 BRIDGE_DOWN', async () => {
  const fetchImpl = async () => {
    const error = new TypeError('fetch failed')
    error.cause = { code: 'ECONNREFUSED' }
    throw error
  }
  const bridge = bridgeWith(fetchImpl)
  await assert.rejects(() => bridge.call('/app/device'), (error) => {
    assert.equal(error.code, 'BRIDGE_DOWN')
    assert.match(error.message, /切回前台/)
    return true
  })
})

test('超时归一成 BRIDGE_TIMEOUT', async () => {
  const fetchImpl = async () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  }
  const bridge = bridgeWith(fetchImpl)
  await assert.rejects(() => bridge.call('/app/ask'), (error) => {
    assert.equal(error.code, 'BRIDGE_TIMEOUT')
    return true
  })
})

test('找不到凭据时抛 BRIDGE_UNAVAILABLE，且信息里列出试过的路径', async () => {
  const bridge = createBridge({
    tokenPath: '/root/.dsh/definitely-not-here',
    fetchImpl: async () => {
      throw new Error('不该被调用')
    },
  })
  delete process.env.DSHA_BRIDGE_TOKEN
  await assert.rejects(() => bridge.token(), (error) => {
    assert.equal(error.code, 'BRIDGE_UNAVAILABLE')
    assert.match(error.message, /\.bridge_token/)
    return true
  })
})

test('16 个工具齐全，且都带 output.render', () => {
  const bridge = bridgeWith(fakeFetch(() => ({ result: 'OK' })))
  const tools = buildTools(bridge)
  const names = tools.map((tool) => tool.name)
  assert.equal(tools.length, 16, `工具数应为 16，实际 ${tools.length}`)
  for (const expected of [
    'dsha_bridge_status',
    'dsha_device_info',
    'dsha_list_apps',
    'dsha_launch_app',
    'dsha_clipboard',
    'dsha_notify',
    'dsha_toast',
    'dsha_vibrate',
    'dsha_share',
    'dsha_open_url',
    'dsha_export_file',
    'dsha_read_device_file',
    'dsha_sensor',
    'dsha_location',
    'dsha_torch',
    'dsha_ask_user',
  ]) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`)
  }
  assert.equal(new Set(names).size, names.length, '工具名不能重复')
  for (const tool of tools) {
    assert.ok(tool.description.length > 20, `${tool.name} 的描述太短，模型看不出该不该用`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('dsha_device_info 解析出结构化字段', async () => {
  const fetchImpl = fakeFetch(() => ({
    result: 'model=Pixel 8\nandroid=14\nbattery=76\nnetwork=wifi',
  }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_device_info')
  const value = await tool.execute({})
  assert.equal(value.ok, true)
  assert.deepEqual(value.fields, { model: 'Pixel 8', android: '14', battery: '76', network: 'wifi' })
})

test('dsha_notify 拒绝空文本且不发请求', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'OK' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_notify')
  const value = await tool.execute({ text: '   ' })
  assert.equal(value.ok, false)
  assert.equal(value.code, 'NO_TEXT')
  assert.equal(fetchImpl.calls.length, 0)
})

test('dsha_launch_app 用 pkg 参数名（不是 package）', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'LAUNCHED' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_launch_app')
  await tool.execute({ package: 'com.tencent.mm' })
  assert.equal(fetchImpl.calls[0].path, '/app/launch')
  assert.deepEqual(fetchImpl.calls[0].params, { pkg: 'com.tencent.mm' })
})

test('dsha_list_apps 把 user_only 映射成 user=1', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'com.x\tX' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_list_apps')
  await tool.execute({ query: '微信', limit: 5, user_only: true })
  assert.deepEqual(fetchImpl.calls[0].params, { q: '微信', limit: '5', user: '1' })
})

test('dsha_ask_user 把选项用 | 连起来，返回用户点中的原文', async () => {
  const fetchImpl = fakeFetch((url) => {
    const options = url.searchParams.get('options')
    return { result: options.split('|')[1] }
  })
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_ask_user')
  const value = await tool.execute({ question: '要删吗？', options: ['删', '别删', '再说'] })
  assert.equal(value.ok, true)
  assert.equal(value.answer, '别删')
  assert.equal(fetchImpl.calls[0].params.q, '要删吗？')
  assert.equal(fetchImpl.calls[0].params.options, '删|别删|再说')
})

test('dsha_ask_user 最多三个选项', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'OK' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_ask_user')
  await tool.execute({ question: 'q', options: ['a', 'b', 'c', 'd', 'e'] })
  assert.equal(fetchImpl.calls[0].params.options, 'a|b|c')
})

test('dsha_ask_user 超时给 BRIDGE_TIMEOUT（不抛异常，交结构化结果）', async () => {
  const fetchImpl = async () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  }
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_ask_user')
  const value = await tool.execute({ question: 'q' })
  assert.equal(value.ok, false)
  assert.equal(value.code, 'BRIDGE_TIMEOUT')
  assert.match(value.hint, /重试|弹窗/)
})

test('网络层异常被包成结构化结果，模型看不到 stack', async () => {
  const fetchImpl = async () => {
    const error = new TypeError('fetch failed')
    error.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }
    throw error
  }
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_device_info')
  const value = await tool.execute({})
  assert.equal(value.ok, false)
  assert.equal(value.code, 'BRIDGE_DOWN')
  assert.match(value.hint, /切回前台/)
})

test('失败结果带上 hint（重试无效的码要说清楚）', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'DISABLED' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_sensor')
  const value = await tool.execute({ name: 'light' })
  assert.equal(value.ok, false)
  assert.equal(value.code, 'DISABLED')
  assert.match(value.hint, /重试无效/)
})

test('dsha_sensor 不带 name 走列表端点', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'light\naccel' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_sensor')
  await tool.execute({})
  assert.equal(fetchImpl.calls[0].path, '/app/sensors')
  await tool.execute({ name: 'light' })
  assert.equal(fetchImpl.calls[1].path, '/app/sensor')
  assert.deepEqual(fetchImpl.calls[1].params, { name: 'light' })
})

test('dsha_torch 缺省是开，显式 false 才是关', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'OK' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_torch')
  await tool.execute({})
  assert.deepEqual(fetchImpl.calls[0].params, { on: '1' })
  await tool.execute({ on: false })
  assert.deepEqual(fetchImpl.calls[1].params, { on: '0' })
})

test('dsha_share 要求 text 或 path 至少一个', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'OK' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_share')
  const value = await tool.execute({})
  assert.equal(value.code, 'NO_CONTENT')
  assert.equal(fetchImpl.calls.length, 0)
  await tool.execute({ path: '/sdcard/a.pdf' })
  assert.deepEqual(fetchImpl.calls[0].params, { path: '/sdcard/a.pdf' })
})

test('dsha_export_file 缺 path 时不发请求', async () => {
  const fetchImpl = fakeFetch(() => ({ result: 'OK' }))
  const tool = toolNamed(buildTools(bridgeWith(fetchImpl)), 'dsha_export_file')
  const value = await tool.execute({})
  assert.equal(value.code, 'NO_PATH')
  assert.equal(fetchImpl.calls.length, 0)
})

test('explainCode 覆盖关键码，未知码返回 null', () => {
  assert.match(explainCode('DISABLED'), /设备能力/)
  assert.match(explainCode('FOREGROUND_SKIP'), /不是失败/)
  assert.match(explainCode('DISMISSED'), /不要当成同意/)
  assert.match(explainCode('TIMEOUT'), /别自动重问/)
  assert.equal(explainCode('SOMETHING_NEW'), null)
  // 码里没命中，但文本是 FORBIDDEN 开头也要给出解释
  assert.match(explainCode('OK', 'FORBIDDEN: 凭据区不可导出'), /安全策略/)
})
