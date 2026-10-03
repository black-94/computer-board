import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardConfig } from '../shared/schema.js';
import { configPath, exampleConfigPath } from './config.js';

const name = 'computer-board';
const staleLockMs = 10_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 启动互斥、运行状态与日志都与配置文件同目录（默认 ~/.computer/），因此可用 COMPUTER_BOARD_CONFIG 整体隔离。 */
export const launchLockPath = (configFile = configPath()) => join(dirname(configFile), 'daemon.lock');
const statePath = (configFile = configPath()) => join(dirname(configFile), 'daemon.json');
const logPath = (configFile = configPath()) => join(dirname(configFile), 'daemon.log');

export type Address = { host: string; port: number; path: string; url: string };
export type DaemonState = Address & { pid: number; startedAt: string };

/** 由配置的 server 段推导监听地址与 HTTP MCP 地址。 */
export function address(config: BoardConfig): Address {
  const { host, port, path } = config.server;
  return { host, port, path, url: `http://${host}:${port}${path}` };
}

/** 只读接口的根地址，用于查询与就绪探测。 */
export const baseUrl = ({ host, port }: Address) => `http://${host}:${port}`;

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function readState(configFile = configPath()): Promise<DaemonState | undefined> {
  try { return JSON.parse(await readFile(statePath(configFile), 'utf8')) as DaemonState; }
  catch { return undefined; }
}

/** 记录本实例的监听信息，供 stop 与重复启动判断使用。 */
export async function writeState(state: DaemonState, configFile = configPath()) {
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(statePath(configFile), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** 退出时清理运行状态；已被别的实例接管时不动它。 */
export async function clearState(configFile = configPath(), pid = process.pid) {
  const state = await readState(configFile);
  if (state && state.pid !== pid) return;
  await rm(statePath(configFile), { force: true });
}

/** 用 MCP ping 判断该地址上是否已有实例在服务：服务是 JSON 响应的无会话模式，不需要先 initialize。 */
export async function probe(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as { result?: unknown };
    return body.result !== undefined;
  } catch { return false; }
}

async function lockOwner(file: string) {
  try { return (JSON.parse(await readFile(file, 'utf8')) as { pid?: number }).pid; } catch { return undefined; }
}

/** 锁文件陈旧判定：持有者已不存在，且锁不是刚创建的（刚创建说明对方正在写内容）。 */
async function staleLock(file: string) {
  const [owner, info] = await Promise.all([lockOwner(file), stat(file).catch(() => undefined)]);
  if (owner !== undefined && alive(owner)) return false;
  return info === undefined || Date.now() - info.mtimeMs > staleLockMs;
}

/** 启动锁：同一时刻只允许一个进程尝试拉起守护进程；返回释放函数，没抢到时返回 undefined。 */
async function acquireLaunchLock(configFile: string) {
  const file = launchLockPath(configFile);
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return async () => { await rm(file, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!await staleLock(file)) return undefined;
      await rm(file, { force: true });
    }
  }
  return undefined;
}

/** 覆盖 CLI 的启动方式（命令与参数），便于源码运行与测试：COMPUTER_BOARD_CLI="node /abs/path/server/cli.ts"。 */
function cliOverride(env = process.env) {
  const value = (env.COMPUTER_BOARD_CLI ?? '').trim();
  if (!value) return undefined;
  const [command, ...args] = value.split(/\s+/u);
  return { command, args };
}

/** 以与当前进程相同的方式（node 或 tsx）重新拉起本 CLI。 */
function selfCommand(subcommand: string) {
  const custom = cliOverride();
  if (custom) return { command: custom.command, args: [...custom.args, subcommand] };
  const compiled = new URL('./cli.js', import.meta.url);
  const cli = fileURLToPath(existsSync(compiled) ? compiled : new URL('./cli.ts', import.meta.url));
  return { command: process.execPath, args: [...process.execArgv.filter(arg => !arg.startsWith('--inspect')), cli, subcommand] };
}

async function spawnDaemon(configFile: string) {
  const log = await open(logPath(configFile), 'a');
  const { command, args } = selfCommand('start');
  const child = spawn(command, args, {
    // 包根目录作工作目录，页面这类相对路径不受调用方工作目录影响。
    cwd: dirname(exampleConfigPath()),
    env: { ...process.env, COMPUTER_BOARD_CONFIG: configFile },
    // 自成进程组并与父进程解绑：结束会话的一方按进程组终止子进程时，不会带走守护进程。
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  child.unref();
  await log.close();
  // 拉起失败（例如 PATH 上没有 computer-board）只会触发 error 事件，收好原因用于报错。
  const failures: string[] = [];
  child.on('error', error => { failures.push(error.message); });
  return { child, failures };
}

async function waitFor(url: string, timeoutMs: number, stopped?: () => boolean) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopped?.()) {
    if (await probe(url)) return true;
    await sleep(100);
  }
  return false;
}

export type EnsureResult = { address: Address; state?: DaemonState; started: boolean };

/**
 * 保证唯一的守护进程在运行：已有实例直接复用，否则后台拉起一个并等它就绪。
 * 单例由两层保证：启动锁让并发调用只有一方负责拉起，服务端独占端口让第二个实例 listen 失败而退出。
 */
export async function ensureDaemon(config: BoardConfig, options: { configFile?: string; timeoutMs?: number } = {}): Promise<EnsureResult> {
  const configFile = options.configFile ?? configPath();
  const timeoutMs = options.timeoutMs ?? 8000;
  const target = address(config);
  if (await probe(target.url)) return { address: target, state: await readState(configFile), started: false };
  const release = await acquireLaunchLock(configFile);
  if (!release) {
    if (await waitFor(target.url, timeoutMs)) return { address: target, state: await readState(configFile), started: false };
    throw new Error(`等待 ${target.url} 就绪超时，见 ${logPath(configFile)}`);
  }
  try {
    const { child, failures } = await spawnDaemon(configFile);
    const stopped = () => failures.length > 0 || child.exitCode !== null;
    if (await waitFor(target.url, timeoutMs, stopped)) return { address: target, state: await readState(configFile), started: true };
    throw new Error(failures[0] ?? `${name} 未能在 ${timeoutMs / 1000} 秒内就绪，见 ${logPath(configFile)}`);
  } finally { await release(); }
}

/** 停止守护进程，返回是否确实停掉了一个在运行的实例。 */
export async function stopDaemon(configFile = configPath(), timeoutMs = 5000) {
  const state = await readState(configFile);
  if (!state || !alive(state.pid)) {
    await rm(statePath(configFile), { force: true });
    return false;
  }
  process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive(state.pid)) await sleep(100);
  // 探活可能还在跑，宽限期后强制结束。
  if (alive(state.pid)) process.kill(state.pid, 'SIGKILL');
  await rm(statePath(configFile), { force: true });
  return true;
}
