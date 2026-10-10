# Computer Board

手工维护机器与软件清单、周期性探活、只读查询的后台服务，同时以 HTTP MCP 和 pi extension（四个同名只读工具）提供给 agent。

服务只回答「现在有哪些机器和软件可用、怎么接入」；它不执行任何业务操作，不做 SSH 转发或端口转发，不代理远程调用，也不修改配置。

## 安装与运行

要求 Node.js 22+。

```bash
npm install -g @black942026/computer-board
computer-board init        # 按样例创建 ~/.computer/config.json，已存在则不改动
$EDITOR ~/.computer/config.json
computer-board validate    # 校验配置
computer-board             # 前台启动服务，默认 http://127.0.0.1:3000
computer-board ensure      # 后台启动服务，已在运行则复用；pi extension 用它自动拉起
computer-board stop        # 停止后台服务
```

同一份配置下服务是单例：`ensure` 用配置目录下的 `daemon.lock` 串行化并发启动，服务端独占 `server.port` 并记录自己的 pid，所以重复调用、多个 pi 会话同时拉起都只会得到一个实例；换 `COMPUTER_BOARD_CONFIG` 或改端口则是另一个实例，两者不共享探活结果。后台实例的地址与 pid 记在 `daemon.json`，输出写 `daemon.log`，两者都与配置同目录。

源码调试：

```bash
npm install
npm run dev                # 页面 http://127.0.0.1:5173，服务端 http://127.0.0.1:3000
npm run build && npm start # 页面与 HTTP MCP 都由 127.0.0.1:3000 提供（被后台实例占用时先 computer-board stop）
```

服务没有登录和权限控制，默认只监听 `server.host` 指定的回环地址，不要直接暴露公网。

## 配置

配置文件默认在 `~/.computer/config.json`，样例见 [`config.example.json`](config.example.json)；服务与 pi extension 都读同一路径，用 `COMPUTER_BOARD_CONFIG=/absolute/path/config.json` 覆盖。

服务运行期间监听配置文件，保存后自动重新解析校验并生效（`revision`、`machines`、`defaults` 都包括），搜索索引也随新配置同步重建，不需要重启；切换立即生效，重新探活接着在后台跑，不阻塞查询；解析或校验不通过时保留上一份可用配置与对应索引继续服务，只在前台输出或 `daemon.log` 里给出原因，改好保存即恢复。`server.host`、`server.port` 决定监听地址，无法在运行中变更，改动后要 `computer-board stop && computer-board ensure` 才生效（服务日志会提示）。探活结果只在内存，重启后重新检查。

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

配置热重载后会立即按新配置重跑一轮探活，未改动项沿用已有结果与失败计数，因此不会先掉回 `unknown` 再恢复。

结果为 `healthy`（最近一次成功）、`degraded`（失败但未达阈值）、`unhealthy`（失败达到阈值）、`unknown`（未检查或未配置检查）、`disabled`（已停用）。机器状态由其必需检查聚合而成；默认列表严格按 `healthy` 过滤，不使用宽限期。

## Agent 接入

### HTTP MCP

地址为 `http://<server.host>:<server.port><server.path>`（默认 `http://127.0.0.1:3000/mcp`），Streamable HTTP、JSON 响应、无会话，无权限控制。

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `list_machines` | `{ showAll?: boolean }` | 机器简要列表：`name`、`host` 与软件名，`showAll=true` 时每项带 `status` |
| `search_machine` | `{ query: string, showAll?: boolean, limit?: number }` | 按关键词搜索机器：`machineId`、`name`、`host`、`score`（BM25 分数，降序），最多返回 `min(limit, 命中数)` 条，`showAll=true` 时每项带 `status` |
| `get_machine` | `{ machine: { machineId } \| { host } }` | 单台机器详情：描述、使用说明、注意事项、依赖、探活与软件索引 |
| `get_software` | `{ machine, software: { softwareId } \| { name } }` | 软件详情：描述、接入方式、注意事项、依赖、观测版本、探活与所属机器 |

`search_machine` 是唯一的模糊查询：只用关键词在机器的 `id`、`name`、`host` 三个字段上做 BM25 相关性排序，不搜索 `desc`、`instruction`、`software` 等字段，不做子串/正则匹配。`query` 必填；空串、纯空白、错误类型或未知字段都会被拒绝，但两条路径的表现不同——HTTP 与 pi extension 走内部路由，返回 `{ "error": { "code": "INVALID_ARGUMENT" } }`；HTTP MCP 由 SDK 用同一份严格 schema 在入参校验阶段拒绝，返回 `isError: true` 的工具错误（文本形如 `Input validation error: ...`），不会进入服务端 handler。默认只搜探活成功的机器，`showAll=true` 搜索全部并附 `status`；无匹配返回空数组。`limit` 控制返回条数：省略时为 `3`，显式给出时必须是正整数（`0`、负数、小数、字符串、`null`、`boolean`、`NaN`/`Infinity` 都会被拒绝），不设人为上限，实际返回 `min(limit, 命中数)` 条。排序先按健康状态过滤候选，再用全部候选语料做 BM25 评分、降序并保持同分配置顺序，最后截取前 `limit` 条：不会先截候选而改变分数或排名，截取也不改变被保留命中项的 `score`。分词先做大小写归一化，再按连续字母数字与单个汉字切分（`-`、`_`、`.`、`:`、`/`、`@` 等 id/host 分隔符都算边界），因此 `remote-example`、`root@192.168.0.1:22` 的用户名/IP/端口、以及中文名`本机`都能命中。分数始终为正的有限值，同分按配置顺序稳定排列；搜索只读内存缓存，不触发探活。BM25 使用 `k1=1.2`、`b=0.75`，IDF 取恒正形式避免常见词出现负分。

搜索索引的建立时机与存储：服务在启动（构造 `HealthEngine`）与每次配置热重载时各建立一次，配置统一从 `HealthEngine` 进入，所以 CLI 与进程内测试走的是同一条路径；首个查询不会临时构建。索引只放在内存里（`Bm25Index` 实例，构建时预计算每台机器 `id`/`name`/`host` 的词频、文档长度与倒排表，并整体替换旧实例而非累积），不落盘、不做磁盘缓存、也不引入新依赖。查询时只对关键词分词，按当前候选集合复用这些缓存计算 N/df/avgdl，不重新分词机器文本、不重建词频/长度/倒排表；`showAll` 与健康状态过滤只改变候选集合，健康状态变化不重建索引。

接口说明随 MCP 协议一并给出，不额外提供 describe 之类的工具：每个工具自带描述与入参 schema，`initialize` 返回的 instructions 说明服务边界、返回约定、状态含义与错误码。

### pi extension

同一个包提供 pi extension，注册四个只读工具 `list_machines`、`search_machine`、`get_machine`、`get_software`：工具名、入参 schema 与有效调用的返回与上面的 HTTP MCP 一致。区别在错误路径——pi extension 走内部 HTTP 路由，非法入参返回 `INVALID_ARGUMENT` 错误体；HTTP MCP 的非法入参由 SDK 在入参校验阶段拒绝（`isError: true`），见上面对 `search_machine` 的说明：

```bash
pi install npm:@black942026/computer-board
```

扩展加载时会在后台执行 `computer-board ensure`，工具调用时如果服务不在运行也会先拉起再重试一次，所以 pi 启动即拉起服务，不必另开终端；多个 pi 会话共享同一个实例，探活也只有一份。服务确实起不来时，工具返回 `{ error: { code: "INTERNAL_ERROR", message } }`，message 给出原因（配置缺失、日志路径等）。

扩展读取 `~/.computer/config.json`（可用 `COMPUTER_BOARD_CONFIG` 覆盖），每次调用都重新读取，因此只改 `server.port` 时按 `computer-board stop && computer-board ensure` 重新拉起即可，工具定义不变，不用重启 pi 会话。

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

`computer-board` 启动后，`dist/web` 存在时会在 `/` 提供只读页面，展示机器、软件、接入说明与探活状态。页面和 pi extension 都用同一组只读内部接口（`/api/discovery`、`/api/query/*`、`/api/health/refresh`），它们不是对外契约，只跟着页面与扩展的需要变化。

## 开发与发布

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run     # 确认发布内容
npm publish            # 发布前自动跑 check 与 build
```

发布内容由 `files` 白名单限定为 `index.ts`、`dist`、`extension`、`config.example.json`、`README.md`、`LICENSE`；`git` 忽略 `dist`、`node_modules`、`.computer` 与本地运行数据，配置与探活状态不会进入仓库。

本地基准（`node_modules/tsx` 直接跑源码，仅示意、非性能承诺）：2000 台机器建索引约 10ms；对 2000 台机器各跑 10000 次关键词查询，复用索引约 4.3s，而每次临时重算的旧公式约 42s。

pi extension 以根目录 `index.ts` 为导出入口，转导出 `extension/index.ts` 的默认扩展函数；安装后显示为 `@black942026/computer-board`，不带 `:extension` 后缀。扩展实现不 import 服务端源码，只用宿主提供的 `typebox` 与 `@earendil-works/pi-coding-agent`（见 `peerDependencies`），靠 `dist/server/cli.js` 拉起服务。所以本地路径安装前要先 `npm run build`；源码调试时可以用 `COMPUTER_BOARD_CLI` 指定 CLI 的启动命令，例如 `COMPUTER_BOARD_CLI="node node_modules/tsx/dist/cli.mjs server/cli.ts"`。
