# dsha-native-tools

> 让 DeepSeek​ Harness 的 agent 真正能操作那台安卓手机。
> 16 个一等公民工具：通知、震动、剪贴板、拉起应用、手电、传感器、定位、导出文件、系统分享……

[DSHA](https://github.com/DSH-APP/DSHA)（DeepSeek​ Harness 安卓端）在 App 进程里跑着一个本地桥
（默认 `127.0.0.1:3090`），把「只有 Android 能做」的事暴露成 HTTP 端点。桥本身很好用，但它长得是这样：

```bash
# 你得自己读凭据、自己拼 URL、自己记住这个码是什么意思
curl -H @/root/.dsh/.bridge_headers "http://127.0.0.1:3090/app/notify?text=..."
# → {"result":"FOREGROUND_SKIP"}
```

每个会话都这么来一遍，既费 token 又容易错 —— 最常见的错是**用户根本没开那个开关，模型却以为
重试就会好**。本插件把 16 个端点固化成工具：类型化参数、结构化结果、失败码直接翻译成
「下一步该做什么」，并把「重试无效」这四个字写进工具描述里。

---

## 装

DSHA 里一条命令：

```bash
dsha-plugin install Liaoyun666/dsha-native-tools
```

或者用 DSH 自己的插件命令（桌面端 / 容器内都行）：

```bash
dsh plugin add Liaoyun666/dsha-native-tools
```

装完新开一个会话，工具表里就多出 `dsha_*` 这 16 个。**不需要重启 App**，也不需要在设置里
额外打开什么（每个能力第一次用的时候，Android 会按它自己的规矩要权限）。

> 桌面端也能装、不会报错 —— 只是调用时会明确告诉你「这里读不到桥凭据，本插件只在 DSHA 里有用」。
> 这是故意的：一个插件不该因为被装错地方就把会话搞崩。

---

## 16 个工具

| 工具 | 干什么 | 什么时候会用上 |
| --- | --- | --- |
| `dsha_bridge_status` | 桥是否在线、App 版本、插件加载状态 | 别的工具报 `BRIDGE_DOWN` 时先查这个 |
| `dsha_device_info` | 型号、Android 版本、电量、网络、屏幕、存储、内存 | 用户问「手机什么情况」 |
| `dsha_list_apps` | 列出已装应用（可按关键词/只看用户应用筛） | 需要准确包名时 |
| `dsha_launch_app` | 按包名把应用拉到前台 | 「帮我打开微信」 |
| `dsha_clipboard` | 读 / 写剪贴板 | 「刚才复制的是什么」「复制到剪贴板」 |
| `dsha_notify` | 发通知栏消息 | 长任务跑完叫用户回来 |
| `dsha_toast` | 弹个一闪而过的提示 | 轻确认 |
| `dsha_vibrate` | 震动 30–2000 ms | 需要用户在口袋里察觉 |
| `dsha_share` | 调系统分享面板（文本或 `/sdcard` 文件） | 把结果递给别的 App |
| `dsha_open_url` | 打开 http/https/geo/tel/mailto/market 链接 | 「打开这个网页」「拨这个号」 |
| `dsha_export_file` | 把容器里的文件复制到 `Download/DSHA` | 交付报告、图片、安装包 |
| `dsha_read_device_file` | 读 Android 侧文件（≤256 KiB） | 看 `/sdcard/Download/x.txt` |
| `dsha_sensor` | 传感器列表 / 读一个（light、accel、gyro…） | 读环境光、判断设备姿态 |
| `dsha_location` | 定位（可用缓存，也可强制刷新） | 需要坐标 |
| `dsha_torch` | 开关手电 | — |
| `dsha_ask_user` | 手机屏幕上弹原生选择框，阻塞等用户点 | 需要把用户从别的应用叫回来 |

所有工具都返回同一套结构：

```json
{ "ok": false, "code": "DISABLED", "text": "DISABLED", "hint": "用户在 DSHA 设置里没打开这类能力。请让用户去「设置 → 设备能力」勾选，重试无效。" }
```

`ok` 为假时**不会抛异常** —— 网络层失败（桥没起、token 被换）也一样包成结构化结果。
模型看到的是「怎么办」，不是一段 stack trace。

---

## 失败码词典

这些码来自 DSHA 的桥，插件负责把它们的含义固化下来。标了「重试无效」的，是真的无效。

### 桥自身

| 码 | 意思 |
| --- | --- |
| `BRIDGE_UNAVAILABLE` | 读不到桥凭据 —— 基本等于「这里不是 DSHA 安卓端」 |
| `BRIDGE_DOWN` | App 退到后台或被系统回收，把 DSHA 切回前台 |
| `BRIDGE_UNAUTHORIZED` | 凭据被拒（App 重启后 token 会换），下次调用自动重读 |
| `BRIDGE_TIMEOUT` | 桥没在期限内回应；`ask` / `launch` 可能是用户正盯着弹窗 |

### 能力开关（重试无效）

| 码 | 意思 |
| --- | --- |
| `DISABLED` | 用户没在「设置 → 设备能力」里勾选 |
| `NO_PERMISSION` | Android 系统没给 App 这个权限 |
| `FORBIDDEN: …` | 桥的安全策略拒绝（如分享容器私有目录、导出凭据区），换参数也没用 |
| `CAPABILITY_NOT_AUTHORIZED` | 屏幕操作能力未授权 |

### 用户交互

| 码 | 意思 |
| --- | --- |
| `FOREGROUND_SKIP` | DSHA 正在前台，桥按设计不打扰用户 —— **这不是失败** |
| `USER_REJECTED` | 用户点了「拒绝」，不要重试 |
| `USER_NO_ANSWER` | 确认框没人理，先问用户方不方便 |
| `APP_BACKGROUND` | DSHA 不在前台，弹不出界面 |
| `DISMISSED` | 用户关掉了提问框 —— 视为没回答，**不要当成同意** |
| `TIMEOUT` / `BUSY` | 等回答超时 / 已有提问占着 |
| `NOT_FOUND` / `TOO_LARGE` / `BAD_NAME` | 文件路径不存在 / 超过 64 MiB / 文件名非法 |

### 结果不确定（绝不能自动重放）

| 码 | 意思 |
| --- | --- |
| `RESULT_UNKNOWN` | 动作已发出但没等到结果，**可能已生效**，先核对现状 |
| `INTERRUPTED` | 操作被打断，可能没执行完 |

---

## 命令行

同一个桥，不经过 agent —— 在 DSHA 的终端里排查、写脚本、上 cron 时用：

```bash
node tools/cli.js status                     # 桥通不通
node tools/cli.js device                     # 设备信息
node tools/cli.js apps 微信 --user --limit 5  # 查包名
node tools/cli.js launch com.tencent.mm
node tools/cli.js notify "编译完了" --title 构建
node tools/cli.js clip --set "一段文字"
node tools/cli.js export /root/report.md
node tools/cli.js ask "继续吗？" 继续 取消
node tools/cli.js raw /app/help              # 直接打端点，调试用
```

CLI 与插件共用 `lib/bridge.js`，所以参数名、错误码、认证方式不会漂移。
成功退出码 `0`，失败 `2`（并打印中文建议）。

```bash
node tools/cli.js help    # 全部子命令
```

---

## 开发

```bash
npm test        # 39 个测试，不需要真手机
```

三层验证，都不依赖 Android：

1. **单元**（`tests/plugin.test.js`）—— 假 fetch，验证参数编码（中文、`pkg` 而非 `package`、
   `options` 用 `|` 连接）、凭据读取（token 原文与 curl headers 两种格式）、错误归类。
2. **冒烟**（`tests/smoke.test.js`）—— 真 import 入口，假 cordis ctx 跑 `apply()`：
   16 个工具都注册上、`effect` 的 dispose 真能撤销、没凭据时只 warn 不炸。
3. **端到端**（`tests/cli.test.js`）—— 起一个真监听端口的假桥（`tools/mock-bridge.js`），
   把 CLI 当子进程跑，验证「参数 → 请求 → 输出 / 退出码」整条链路。

```bash
# 手工玩假桥
node tools/mock-bridge.js 3091
DSHA_BRIDGE_URL=http://127.0.0.1:3091 DSHA_BRIDGE_TOKEN=dev node tools/cli.js device
```

### 目录

```
lib/bridge.js      桥客户端：token 读取、X-Token 认证、错误归一、结果归类
lib/tools.js       16 个工具定义 + 失败码词典（explainCode）
lib/index.js       插件入口：apply(ctx) 注册工具
tools/cli.js       CLI（与插件共用 bridge.js）
tools/mock-bridge.js  假桥，测试与手工试探用
cordis.patch.yml   bundle 补丁：把 host row 插进插件名册
```

### 配置

```yaml
# profile patch 里传（一般不用改）
- id: dsha-native-tools
  name: dsha-native-tools
  config:
    baseUrl: http://127.0.0.1:3090   # 桥地址
    timeoutMs: 15000                  # 单次请求上限
    askTimeoutMs: 130000              # dsha_ask_user 等用户回答的上限
    # token / tokenPath 一般留空：自动读宿主写入的凭据
```

顺序：显式 `token` > 环境变量 `DSHA_BRIDGE_TOKEN` > `/root/.dsh/.bridge_token` >
`/root/.dsh/.bridge_headers`。

---

## 设计取舍

**为什么不用现成的 MCP？** 桥是 HTTP + query 参数 + 自定义头，包成 16 个工具比包成一个
「能发任意 HTTP 请求」的工具更安全也更好用 —— 后者等于把整个桥的鉴权面直接交给模型。

**为什么零依赖？** DSHA 的容器是 Linux arm64/glibc。任何带原生模块的依赖都可能装不上，
而装不上就等于插件崩了。只用 Node 内建 `fetch` / `fs`，`>=20` 即可。

**为什么失败也返回 `ok:false` 而不是抛异常？** 抛异常时模型看到的是
`Error: fetch failed`，它能做的只有重试；返回 `{ok:false, code:'BRIDGE_DOWN', hint:'把 DSHA 切回前台'}`
时它知道该干什么。工具是给模型看的 API，错误信息本身就是 API 的一部分。

**为什么不实现屏幕点击 / 读屏？** DSHA 有 `/app/ui/*` 那一套（无障碍），但它要求
`observationId` 凭据 + 用户逐步授权，语义比设备能力复杂得多，和本插件的定位（无争议的
设备能力封装）不同。混在一起会让「发个通知」也需要理解屏幕授权模型。

**为什么不缓存结果？** 设备状态（电量、前台应用、剪贴板）随时在变，缓存只会让模型拿着
过期数据做决定。每次调用都真的打桥。

---

## 安全

- token 只在内存缓存，**不进 URL**（URL 会出现在进程列表和日志里），只走 `X-Token` 头。
- 凭据区（`/root/.dsh/`、`.ssh`、`.android`）不可导出也读不到 —— 这是 DSHA 的
  `BridgePathPolicy`，插件不绕过、不重试。
- 插件本身不联网：唯一的网络目标是 `http://127.0.0.1:3090`。
- `dsha_launch_app` / `dsha_ask_user` / `dsha_share` / `dsha_open_url` 会打断用户，
  标了 `isConcurrencySafe: false`，且工具描述里写了「没有明确要求不要调用」。

---

## License

MIT
