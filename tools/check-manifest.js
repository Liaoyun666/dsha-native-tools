#!/usr/bin/env node
/**
 * 校验插件包契约 —— 按 DSHA 的 `docs/plugins.md` 那几条硬性要求自己查一遍。
 *
 * 为什么要单独一个脚本：这些错（补丁文件路径写错、入口不存在、声明了不存在的
 * 原生依赖）在本地全都「看起来正常」，只有真正 `dsha-plugin install` 时才炸，
 * 而那时候用户已经在手机上了。放进 CI 就能在推之前拦住。
 *
 * 退出码 0 = 通过，1 = 有错。
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

/** 记录一条错误。 */
function fail(message) {
  problems.push(message)
}

/** 记录一条提示（不影响退出码）。 */
function note(message) {
  notes.push(message)
}

// ── package.json 本身
const packagePath = join(root, 'package.json')
if (!existsSync(packagePath)) {
  console.error('✗ 找不到 package.json')
  process.exit(1)
}
let pkg
try {
  pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
} catch (error) {
  console.error(`✗ package.json 不是合法 JSON：${error.message}`)
  process.exit(1)
}

// ── 名字与版本：必须是合法 npm 名与 semver
if (typeof pkg.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) {
  fail(`name 不是合法的 npm 包名：${JSON.stringify(pkg.name)}`)
}
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  fail(`version 不是合法 semver：${JSON.stringify(pkg.version)}`)
}

// ── bundle 补丁：契约要求它存在且指向真文件
const patch = pkg?.dsh?.bundle?.patch
if (typeof patch !== 'string' || !patch) {
  fail('缺少 dsh.bundle.patch —— DSHA 不会把这个包当插件')
} else {
  const patchPath = join(root, patch)
  if (!existsSync(patchPath)) fail(`dsh.bundle.patch 指向的文件不存在：${patch}`)
  else {
    const text = readFileSync(patchPath, 'utf8')
    if (!/^\s*-\s*insert:/m.test(text)) fail(`${patch} 里没有 - insert: 段，loader 不会有任何动作`)
    if (!text.includes(pkg.name)) fail(`${patch} 里没有出现包名 ${pkg.name}，插进去的行可能是错的`)
    note(`${patch} 正常（${statSync(patchPath).size} 字节）`)
  }
}

// ── 入口
const entry = pkg.main || pkg?.cordis?.entry
if (typeof entry !== 'string' || !entry) {
  fail('缺少 main（或 cordis.entry）')
} else if (!existsSync(join(root, entry))) {
  fail(`入口文件不存在：${entry}`)
} else {
  note(`入口 ${entry} 存在`)
}

// ── exports 里列的每个路径都得存在
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value !== 'string') continue
  if (!existsSync(join(root, value))) fail(`exports["${key}"] 指向的文件不存在：${value}`)
}

// ── 依赖：零依赖是设计目标；真有运行时依赖时必须能装上（不能有原生模块）
const deps = { ...pkg.dependencies }
const depCount = Object.keys(deps).length
if (depCount === 0) {
  note('零运行时依赖（安卓 arm64 上最稳）')
} else {
  for (const [name, range] of Object.entries(deps)) {
    if (/^(node-|@?.*(sharp|canvas|sqlite|better-sqlite3|bcrypt|node-gyp))/.test(name)) {
      fail(`依赖 ${name}@${range} 很可能带原生模块，安卓 arm64 装不上`)
    } else {
      note(`运行时依赖：${name}@${range}（确认它有纯 JS 版本）`)
    }
  }
}

// ── files 白名单：漏了 lib 的话装完是空的
if (Array.isArray(pkg.files)) {
  if (!pkg.files.includes('lib')) fail('files 里没有 lib/ —— 装完会缺代码')
  if (!pkg.files.includes('cordis.patch.yml')) fail('files 里没有 cordis.patch.yml —— 装完应用不了补丁')
} else {
  note('没有 files 白名单（会发布全部文件）')
}

// ── type: module，因为源码全是 ESM
if (pkg.type !== 'module') fail(`type 应为 "module"（当前 ${JSON.stringify(pkg.type)}），源码是 ESM`)

// ── dshhub 元数据（可省，但省了用户就看不到描述）
if (pkg?.dsh?.dshhub) {
  const hub = pkg.dsh.dshhub
  if (hub.schemaVersion !== 1) fail('dsh.dshhub.schemaVersion 应为 1')
  for (const field of ['displayName', 'summary']) {
    if (typeof hub[field] !== 'string' || !hub[field].trim()) fail(`dsh.dshhub.${field} 缺失`)
  }
  const network = hub?.capabilities?.network
  if (Array.isArray(network)) {
    for (const url of network) {
      if (!/^https?:\/\//.test(url)) fail(`capabilities.network 里的 ${url} 不是 http(s) 地址`)
    }
    note(`声明了 ${network.length} 个网络目标：${network.join('、')}`)
  }
} else {
  note('没有 dsh.dshhub 元数据（能用，但商店里没有简介）')
}

// ── 输出
for (const message of notes) console.log(`  · ${message}`)
if (problems.length > 0) {
  console.error('')
  for (const message of problems) console.error(`✗ ${message}`)
  console.error(`\n${problems.length} 个问题`)
  process.exit(1)
}
console.log('\n✓ 插件包契约通过')
