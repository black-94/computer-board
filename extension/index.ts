import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

const serverName = 'computer-board';
const fallback = { host: '127.0.0.1', port: 3000 };
const readyTimeoutMs = 8000;
const requestTimeoutMs = 15_000;

/** 默认读取 ~/.computer/config.json，可用 COMPUTER_BOARD_CONFIG 覆盖。 */
export function configPath(env = process.env) {
  return env.COMPUTER_BOARD_CONFIG ? resolve(env.COMPUTER_BOARD_CONFIG) : join(homedir(), '.computer', 'config.json');
}

/** server 段缺失或字段不合法时回落到默认回环地址，避免扩展加载失败；真正的校验由服务端做。 */
export function serverBase(path = configPath()): string {
  let config: { server?: unknown } | undefined;
  try { config = JSON.parse(readFileSync(path, 'utf8')) as { server?: unknown }; }
  catch { config = undefined; }
  const server = (config?.server ?? {}) as Record<string, unknown>;
  const host = typeof server.host === 'string' && server.host ? server.host : fallback.host;
  const port = typeof server.port === 'number' ? server.port : fallback.port;
  return `http://${host}:${port}`;
}

/** 拉起服务用的命令：优先用本包自带的 CLI，源码运行可用 COMPUTER_BOARD_CLI 覆盖，否则用 PATH 上的 bin。 */
export function ensureCommand(env = process.env) {
  const override = (env.COMPUTER_BOARD_CLI ?? '').trim();
  if (override) {
    const [command, ...args] = override.split(/\s+/u);
    return { command, args: [...args, 'ensure'] };
  }
  const compiled = new URL('../dist/server/cli.js', import.meta.url);
  if (existsSync(compiled)) return { command: process.execPath, args: [fileURLToPath(compiled), 'ensure'] };
  return { command: serverName, args: ['ensure'] };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const logOf = (configFile: string) => join(dirname(configFile), 'daemon.log');

/** GET /api/discovery 是只读查询，200 即说明服务已就绪（探活还没跑完、列表为空时也是 200）。 */
async function running(base: string) {
  try { return (await fetch(`${base}/api/discovery?showAll=false`, { signal: AbortSignal.timeout(800) })).ok; }
  catch { return false; }
}

/** 需要时后台拉起服务并等它就绪：单例与去重由 CLI 的 ensure 负责，这里只管等待与报错。 */
async function ensureServer(configFile = configPath()) {
  const base = serverBase(configFile);
  if (await running(base)) return { base, error: undefined as string | undefined };
  const { command, args } = ensureCommand();
  const child = spawn(command, args, {
    // 自成进程组并与 pi 解绑：会话结束时 pi 按进程组终止子进程，不会带走服务。
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, COMPUTER_BOARD_CONFIG: configFile },
  });
  child.unref();
  let stderr = '';
  let failure = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => { failure = detail(error); });
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.pid !== undefined && !failure) {
    if (await running(base)) return { base, error: undefined };
    await sleep(150);
  }
  if (await running(base)) return { base, error: undefined };
  const reason = failure || stderr.trim().split('\n').at(-1) || `见 ${logOf(configFile)}`;
  return { base, error: reason };
}

type Outcome = { body: unknown; failed: boolean };

const problem = (message: string): Outcome => ({ body: { error: { code: 'INTERNAL_ERROR', message } }, failed: true });

/** 调用服务的只读接口；连不上时先确保服务在运行再重试一次，业务错误原样返回。 */
async function query(configFile: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<Outcome> {
  const send = async (base: string): Promise<Outcome> => {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const response = await fetch(`${base}${path}`, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!response.ok) return { body: body ?? { error: { code: 'INTERNAL_ERROR', message: `${base}${path} 返回 HTTP ${response.status}` } }, failed: true };
    if (body === undefined) return problem(`${base}${path} 的响应不是 JSON`);
    return { body, failed: false };
  };
  try { return await send(serverBase(configFile)); }
  catch (error) {
    if (signal?.aborted) return problem('调用已取消');
    const ensured = await ensureServer(configFile);
    if (ensured.error) return problem(`${serverName} 服务不可用：${ensured.error}`);
    try { return await send(ensured.base); }
    catch (retry) { return problem(`无法连接 ${ensured.base}：${detail(retry)}`); }
  }
}

const result = (outcome: Outcome): AgentToolResult<unknown> => ({
  content: [{ type: 'text', text: JSON.stringify(outcome.body) }],
  details: outcome.body,
  ...(outcome.failed ? { isError: true } : {}),
});

const machineSelector = Type.Union([
  Type.Object({ machineId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ host: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
const softwareSelector = Type.Union([
  Type.Object({ softwareId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

const listTool = defineTool({
  name: 'list_machines',
  label: '机器与软件列表',
  description: '机器和软件列表：返回 name、host 与软件名。默认只列探活成功项，showAll=true 时列出全部并附带 status。',
  promptSnippet: '列出 computer-board 中探活成功的机器与软件',
  parameters: Type.Object({ showAll: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  annotations: { readOnlyHint: true },
  async execute(_id, params, signal) {
    return result(await query(configPath(), `/api/discovery?showAll=${params.showAll === true}`, { method: 'GET' }, signal));
  },
});

const machineTool = defineTool({
  name: 'get_machine',
  label: '机器详情',
  description: '按 machineId 或 host 精确查询单台机器的用途、使用说明、注意事项、依赖、探活状态和软件索引。',
  promptSnippet: '查询某台机器的接入说明与探活状态',
  parameters: Type.Object({ machine: machineSelector }, { additionalProperties: false }),
  annotations: { readOnlyHint: true },
  async execute(_id, params, signal) {
    return result(await query(configPath(), '/api/query/machine', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machine: params.machine }),
    }, signal));
  },
});

const softwareTool = defineTool({
  name: 'get_software',
  label: '软件详情',
  description: '按机器及软件精确查询单个软件的能力、接入方式、注意事项、依赖、观测版本、探活状态和所属机器。',
  promptSnippet: '查询某个软件的接入方式与探活状态',
  parameters: Type.Object({ machine: machineSelector, software: softwareSelector }, { additionalProperties: false }),
  annotations: { readOnlyHint: true },
  async execute(_id, params, signal) {
    return result(await query(configPath(), '/api/query/software', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machine: params.machine, software: params.software }),
    }, signal));
  },
});

const searchTool = defineTool({
  name: 'search_machine',
  label: '搜索机器',
  description: '按关键词在机器 id、name、host 上做 BM25 相关性搜索并按分数降序返回，返回得分最高的前 limit 条（limit 省略时为 3，须为正整数）。默认只搜探活成功的机器，showAll=true 搜索全部并附 status；无匹配返回空数组。',
  promptSnippet: '按关键词搜索机器',
  parameters: Type.Object({
    query: Type.String({ minLength: 1 }),
    showAll: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: '最多返回的机器条数，默认 3；必须是正整数。' })),
  }, { additionalProperties: false }),
  annotations: { readOnlyHint: true },
  async execute(_id, params, signal) {
    return result(await query(configPath(), '/api/query/machine/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: params.query,
        ...(params.showAll !== undefined ? { showAll: params.showAll } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      }),
    }, signal));
  },
});

/**
 * pi 扩展：注册四个只读工具，直接调用服务端的只读接口。
 * 扩展加载时后台确保服务在运行：服务是有状态的单例进程，多个 pi 会话共享同一份探活结果。
 */
export default function computerBoardExtension(pi: ExtensionAPI) {
  const configFile = configPath();
  void ensureServer(configFile).catch(() => undefined);
  pi.registerTool(listTool);
  pi.registerTool(machineTool);
  pi.registerTool(softwareTool);
  pi.registerTool(searchTool);
}
