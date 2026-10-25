/**
 * 假桥：一个最小 HTTP 服务，按 DSHA 的真实响应格式（{"result":"..."}）回话，
 * 用来在本机（Windows / 桌面 Linux）端到端验证 CLI 与工具层，不需要真的手机。
 *
 * 用法：node tools/mock-bridge.js [port]
 * 然后用 DSHA_BRIDGE_URL=http://127.0.0.1:<port> DSHA_BRIDGE_TOKEN=dev 跑 CLI。
 */

import { createServer } from 'node:http'

/** 各端点的假响应。故意包含成功、失败码、带冒号的失败三种形态。 */
const RESPONSES = {
  '/app/version': 'DSHA 0.2.1-rc.2 (build 190) / mock bridge',
  '/app/help': '/app/device  设备信息\n/app/notify?text=  通知\n/app/toast?text=  Toast',
  '/app/plugins': 'loaded=dsha-native-tools\nfailed=\npending=',
  '/app/device': 'model=Mock Phone\nandroid=14\nbattery=76\nnetwork=wifi\nscreen=1080x2400\nstorage=64G (31G free)\nmemory=8G (3.2G free)',
  '/app/apps': 'com.tencent.mm\t微信 uid=10123\ncom.example.demo\t演示 uid=10124',
  '/app/clip': 'OK',
  '/app/notify': 'OK',
  '/app/toast': 'OK',
  '/app/vibrate': 'OK',
  '/app/torch': 'OK',
  '/app/share': 'OK',
  '/app/open': 'OK',
  '/app/export': 'OK: /storage/emulated/0/Download/DSHA/report.md',
  '/app/readfile': '# 报告\n\n这是假桥返回的内容。',
  '/app/launch': 'OK: 已启动 com.tencent.mm',
  '/app/ask': '继续',
  '/app/sensors': 'light\naccel\ngyro\npressure',
  '/app/sensor': 'light=123.4 lux',
  '/app/location': 'lat=31.2304 lon=121.4737 acc=12m',
}

export function startMockBridge(port = 0) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const send = (result, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
      response.end(JSON.stringify({ result }))
    }
    if (request.headers['x-token'] !== 'dev') return send('UNAUTHORIZED', 401)
    if (url.pathname === '/health') return send('OK')
    // 特例放在查表之前：这个假桥要用传感器路径演示 DISABLED 失败码
    if (url.pathname === '/app/sensor' && url.searchParams.get('name') === 'disabled') return send('DISABLED')
    const canned = RESPONSES[url.pathname]
    if (canned !== undefined) return send(canned)
    return send('NOT_FOUND', 404)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

// 直接运行时就把桥挂起来，方便手工 curl 试探
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const wanted = Number(process.argv[2] || 3091)
  const { port } = await startMockBridge(wanted)
  console.log(`mock bridge on http://127.0.0.1:${port} (token: dev)`)
}
