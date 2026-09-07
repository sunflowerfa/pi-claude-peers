# pi-claude-peers

*[English](README.md)*

让同一台机器上的 [pi](https://pi.dev) 与 [Claude Code](https://claude.com/claude-code) 会话互相发消息。

Claude Code 的会话之间本来就能互相发现和通信——它的 `ListAgents` 和 `SendMessage` 用的就是一份本地注册表加每会话一个 Unix socket。这个扩展让 pi 会话成为其中的一员：pi 会出现在 Claude Code 的会话列表里、能收到发给它的消息，同时获得两个自己的工具用来列举和消息其他 agent。

不需要打补丁、不需要 fork、不需要包一层进程。协议是 Claude Code 自己公开的——用 `--verbose` 运行，它会把帧格式打印出来。

```
Claude Code ──SendMessage──▶ pi          （作为一轮用户输入送达，可设审批闸门）
pi          ──send_message─▶ Claude Code
```

## 环境要求

- pi，启用扩展（默认即启用）
- 同一台机器、同一用户账号下的 Claude Code 2.1.x
- macOS 或 Linux —— Windows 用的是命名管道，本扩展尚未支持

## 安装

```bash
pi install npm:pi-claude-peers
```

也可以从 git 安装，或只在单次运行中试用：

```bash
pi install git:github.com/sunflowerfa/pi-claude-peers
pi -e npm:pi-claude-peers
```

此外无需任何配置。扩展在会话启动时自行注册，会话结束时自行注销。

> pi package 以完整系统权限运行。这个包会让本机其他进程能向你的会话投递消息、并触发一轮对话——安装前请先读[安全](#安全)一节。

## 配置

| 变量 | 默认值 | 作用 |
|---|---|---|
| `PI_CLAUDE_PEERS_AUTO_ACCEPT` | 未设置 | 设为 `1` 时收到消息直接投递，不弹确认 |
| `PI_CLAUDE_PEERS_FROM_MODE` | `prompting` | 向对端声明的权限模式类：`prompting` 或 `bypass` |
| `PI_CLAUDE_PEERS_DEBUG` | 未设置 | 记录每一帧的文件路径（auth token 会被脱敏） |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 配置根目录，与 Claude Code 的处理方式一致 |
| `CLAUDE_CODE_TMPDIR` | `/tmp` | socket 目录的父目录 |

环境变量取自启动 pi 的那个进程。把变量写进 shell 配置文件只对**新开的终端**生效——已经在运行的 shell 保留它启动时的环境。

## 工具

| 工具 | 行为 |
|---|---|
| `list_agents` | 列出存活的对端会话及其名称、状态、工作目录 |
| `send_message` | 按名称发送（全名，或不产生歧义的前缀） |

消息在对方会话里表现为一轮用户输入。对方看不到你这边的上下文，所以消息必须自带完整背景。

## 安全

一切都限定在同一台机器的同一个用户账号内。socket 是 `0700` 目录下的 `0600` 文件，认证密钥同为 `0600`，因此只有你自己的 uid 能触达一个收件箱——与你的 shell 是同一个信任边界。

在这个边界之内，有两道闸门决定消息能否抵达 agent：

**投向 pi 的消息。** 送达必然触发一轮对话，所以默认先询问。没有对话框能力的会话（`pi -p`）无法询问，于是选择拒收而不是把发送方挂住。`PI_CLAUDE_PEERS_AUTO_ACCEPT=1` 去掉这道闸门以便无人值守运行——一旦设置，任何以你身份运行的进程都能驱使那个 pi 会话。

**投向 Claude Code 的消息。** 由 Claude Code 自行决定，依据是它自己的 `crossSessionInbound` 设置，以及本扩展声明的 `from-mode`。由于 pi 不是 Claude Code 会话、也没有 Claude Code 的权限模式，默认声明的是保守的那一档 `prompting`：一个正在免提示运行的 Claude Code 会话会把 pi 的消息扣留下来交给它的用户审阅，而不是在用户不知情的情况下直接执行。设成 `PI_CLAUDE_PEERS_FROM_MODE=bypass` 等于替**别人的**会话关掉这道审阅——只有在两端都属于你、且你确实想让它们无人值守时才这么做。

两道闸门彼此独立。关掉一道不会关掉另一道。

## 协议

`AF_UNIX` 上的换行分隔 JSON。三样东西让一个会话可被寻址：

| 构件 | 路径 | 内容 |
|---|---|---|
| 注册项 | `~/.claude/sessions/<pid>.json` | `pid`、`sessionId`、`cwd`、`name`、`status`、`messagingSocketPath`、`peerProtocol: 1`、`procStart` |
| 认证密钥 | `~/.claude/sessions/<pid>.<sha256(socketPath)>.key` | `peerToken`、`procStart`、`pidDomain` |
| 收件箱 | `<CLAUDE_CODE_TMPDIR>/cc-socks/<pid>.sock` | 监听中的 socket |

一条连接先发认证行，再发若干帧：

```json
{"type":"auth","token":"<对方的 peerToken>"}
{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"…"},"priority":"next","from":"uds:/tmp/cc-socks/<发送方 pid>.sock"}
```

有四处细节是承重的，而且**每一处弄错都不会报错**，只会静默降级。这也是这个扩展没法压缩成十几行 socket 代码的原因。

### 1. `procStart` 记录的是 UTC

它是防 pid 复用的凭据：记录的启动时刻与存活进程对不上，说明这个 pid 已被回收。但 `ps -o lstart=` 输出的是当前时区，而 Claude Code 存的是 UTC，两者按字符串比较。读注册表时不锁定 `TZ=UTC`，在非 UTC 时区下**所有 peer 都会被判定为死进程**——注册表看上去是空的，谁也联系不上。

### 2. 投递状态是回连，不是回复

结果不会沿入站连接返回。接收方要向发送方自己的收件箱（消息里 `from` 指明的地址）**新建一条连接**，在那上面发控制帧：

```json
{"type":"control","action":"peer_message_status","status":"delivered","reason":"…","from":"uds:…","orig_msg_id":"<发送方的 msg_id>"}
```

状态取值为 `delivered`、`held`、`denied`、`expired`、`refused`、`dropped`。若改为在入站连接上回复，在发送方看来等同于毫无回应：它会把这次发送报告为失败，尽管消息其实已经送到。

Claude Code 只在扣留、拒绝或丢弃时上报状态；直接送达的消息不产生任何状态帧。

### 3. 信封是必需的，而且要逐字节一致

消息正文被包在一个标明发送方的信封里：

```
<cross-session-message from="uds:…" from-name="pi-demo-a1" from-mode="prompting">
…
</cross-session-message>
```

接收方解析它，**再把解析结果重新序列化，只有当结果与收到的内容逐字节相同才保留来源信息**。属性顺序是固定的——`from`、`from-session`、`hop-chain`、`from-name`、`from-mode`——而不匹配时并不会被拒收，只是被静默降级：消息照样送达，但没有归属、没有 `[verified pid]`、也没有审阅扣留。直接发一个裸字符串而不是信封，结果正是如此。

有三件事会破坏这次往返，都在 `wire.ts` 里处理了：

- `from-mode` 会被对照一个封闭集合校验——只有 `bypass` 和 `prompting`。
- `from-name` 会被接收方归一化并截断到 64 字符，所以过长或未归一化的名字必须在发送前处理好。
- 正文中出现的信封标签会被接收方改写，所以发送前要先转义。

一条格式正确的消息在 Claude Code 中显示为：

```
Held peer message — from uds:/tmp/cc-socks/<pid>.sock [verified pid <pid>]
(peer claims name: pi-…); preview: «…» — not delivered to Claude (1 held).
```

批准之后则归属到发送方名下：`@ pi-… ❯ <正文>`。

### 4. 渲染出来的样子和模型收到的内容不是一回事

Claude Code 渲染上面那种带归属的行，但交给模型的是信封原文。在对话记录里看到标签，并不能说明解析失败——要看渲染出来的那一行。

## 测试

信封校验在 `wire.ts` 中被复刻出来并用于检验构造逻辑，因为静默损坏正是出在那里：

```bash
npm test    # node --test --experimental-strip-types
```

包结构遵循 pi 的约定：

```
extensions/pi-claude-peers/   index.ts、registry.ts、wire.ts
test/                         wire.test.ts
```

## 已知限制

- **不支持 Windows。** Claude Code 在那里用的是命名管道，本扩展只会 `AF_UNIX`。欢迎贡献。
- **除投递状态外的控制帧未实现**——空闲通知（`notify_when_idle`）、文件附件、artifact 移交都会回 `dropped`，以免发送方空等。
- **这不是一份公开 API。** Claude Code 会在 verbose 输出中打印这套 socket 契约，注册表格式在实践中也稳定，但它可能随版本变化。本扩展针对 Claude Code 2.1.261 验证。

## 许可

MIT
