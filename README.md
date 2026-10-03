# Computer Board

手工维护机器与软件清单、周期性探活、只读查询的后台服务，同时以 HTTP MCP 和 pi extension 两种方式提供给 agent。

服务只回答「现在有哪些机器和软件可用、怎么接入」；它不执行任何业务操作，不做 SSH 转发或端口转发，不代理远程调用，也不修改配置。

## 安装与运行

要求 Node.js 22+。

```bash
npm install -g @black942026/computer-board
computer-board init        # 按样例创建 ~/.computer/config.json，已存在则不改动
$EDITOR ~/.computer/config.json
computer-board validate    # 校验配置
computer-board             # 启动服务，默认 http://127.0.0.1:3000
```

源码调试：

```bash
npm install
npm run dev                # 页面 http://127.0.0.1:5173，服务端 http://127.0.0.1:3000
npm run build && npm start # 页面与 HTTP MCP 都由 127.0.0.1:3000 提供
```

服务没有登录和权限控制，默认只监听 `server.host` 指定的回环地址，不要直接暴露公网。

## 配置

配置文件默认在 `~/.computer/config.json`，样例见 [`config.example.json`](config.example.json)；服务与 pi extension 都读同一路径，用 `COMPUTER_BOARD_CONFIG=/absolute/path/config.json` 覆盖。修改配置的流程是停服务、编辑、`computer-board validate`、重启；探活结果只在内存，重启后重新检查。

| 字段 | 机器 | 软件 |
| --- | --- | --- |
| `id` | 全局唯一标识 | 全局唯一标识 |
| `name` | 展示名称，可重复 | 展示名称，可重复 |
| `host` | `localhost` 或 `account@ip:port`（IPv6 用 `[addr]`） | — |
| `desc` | 用途、使用场景 | 能力、使用场景 |
| `instruction` | 使用、登录说明 | 如何接入（bash、http、mcp、acp 等自由文本） |
| `tips` | 注意事项，字符串或字符串数组 | 同左 |
| `dependOn` | 依赖说明（文本，不做依赖解析） | 同左 |
| `enabled` | 是否进入列表与探活 | 同左 |
| `healthChecks` | 探活配置数组 | 同左 |
| `software` | 软件数组 | — |

配置顶层的 `server` 决定服务监听地址与 HTTP MCP 路径（`host`、`port`、`path`），`defaults` 决定探活间隔、超时、失败阈值与并发上限（`intervalSeconds`、`timeoutSeconds`、`failureThreshold`、`maxConcurrency`），单条检查可以用同名字段覆盖间隔、超时和阈值。

约定：

- 机器与软件的 `id` 全局唯一（包含停用项），空白 ID 不合法；最多一台 `localhost` 机器，`local` 类型探活只能配在它身上。
- 账户、地址、端口只写在 `host` 里，不单独重复配置。
- `desc`、`instruction`、`tips`、`dependOn` 和探活命令、参数都会返回给 agent，不要在这些字符串里写 secret；凭据应由各软件自己的配置管理，不放进本服务。
- `instruction`、`tips`、`dependOn` 是给 agent 看的说明，不会被执行，也不参与探活。

## 探活

服务启动后按配置的间隔周期性执行 `healthChecks`：

- `local`：Board 进程所在机器本身即视为在线，只能配在 `localhost` 机器上。
- `bash`：在 Board 上执行的固定命令与参数，退出码为 0 记为成功，带 `--version` 或 `-v` 时还会从输出里观测版本号。命令可以是 `ping`、`curl`、`ssh` 等只读命令；需要检查远端时写成一次性的 `ssh host <命令>`，服务本身不做端口转发或驻留会话。

结果为 `healthy`（最近一次成功）、`degraded`（失败但未达阈值）、`unhealthy`（失败达到阈值）、`unknown`（未检查或未配置检查）、`disabled`（已停用）。机器状态由其必需检查聚合而成；默认列表严格按 `healthy` 过滤，不使用宽限期。

## Agent 接入

### HTTP MCP

地址为 `http://<server.host>:<server.port><server.path>`（默认 `http://127.0.0.1:3000/mcp`），Streamable HTTP、JSON 响应、无会话，无权限控制。

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `list_machines` | `{ showAll?: boolean }` | 机器简要列表：`name`、`host` 与软件名，`showAll=true` 时每项带 `status` |
| `get_machine` | `{ machine: { machineId } \| { host } }` | 单台机器详情：描述、使用说明、注意事项、依赖、探活与软件索引 |
| `get_software` | `{ machine, software: { softwareId } \| { name } }` | 软件详情：描述、接入方式、注意事项、依赖、观测版本、探活与所属机器 |

接口说明随 MCP 协议一并给出，不额外提供 describe 之类的工具：每个工具自带描述与入参 schema，`initialize` 返回的 instructions 说明服务边界、返回约定、状态含义与错误码。

### pi extension

同一个包提供 pi extension，把该服务的 HTTP MCP 按原样注册进 pi（工具名、入参、返回与错误完全一致）：

```bash
pi install npm:@black942026/computer-board
```

扩展加载时读取 `~/.computer/config.json`，用其中的 `server` 段推导服务地址；文件缺失或 `server` 段不完整时回落到 `http://127.0.0.1:3000/mcp`。配置路径与端口变化后重启 pi 会话生效。

### 返回约定

- 只返回配置里确实存在的字段：空字符串、空数组、未设置的字段一律省略，不用 `null` 占位。
- 列表只返回定位用的简单字段，说明文本与探活细节由 `get_machine`、`get_software` 提供。
- 默认只列出探活成功的机器和软件；`showAll=true` 返回全部并附 `status`。
- 查询只读内存缓存，不触发探活；被默认列表隐藏的资源仍可按 ID 查询详情。
- 错误统一为 `{ error: { code, message } }`，`code` 为 `INVALID_ARGUMENT`、`NOT_FOUND`、`AMBIGUOUS`、`INTERNAL_ERROR`；同名软件或相同 host 命中多个资源时返回 `AMBIGUOUS` 与候选 ID。

列表形状（省略了不存在的字段）：

```json
[
  { "name": "本机", "host": "localhost", "software": [{ "name": "Node.js" }] },
  { "name": "remote-example", "host": "root@192.168.0.1:22", "software": [{ "name": "comfyui" }] }
]
```

## 页面

`computer-board` 启动后，`dist/web` 存在时会在 `/` 提供只读页面，展示机器、软件、接入说明与探活状态，页面数据来自同一服务的只读内部接口（`/api/discovery`、`/api/query/*`、`/api/health/refresh`），仅供页面使用。

## 开发与发布

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run     # 确认发布内容
npm publish            # 发布前自动跑 check 与 build
```

发布内容由 `files` 白名单限定为 `dist`、`extension`、`config.example.json`、`README.md`、`LICENSE`；`git` 忽略 `dist`、`node_modules`、`.computer` 与本地运行数据，配置与探活状态不会进入仓库。
