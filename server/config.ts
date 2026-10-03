import { existsSync, watch } from 'node:fs';
import { readFile, writeFile, mkdir, rename, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { boardConfigSchema, type BoardConfig } from '../shared/schema.js';

/** 配置默认位置：~/.computer/config.json，可用 COMPUTER_BOARD_CONFIG 覆盖。 */
export function configPath(env = process.env) {
  return resolve(env.COMPUTER_BOARD_CONFIG ?? join(homedir(), '.computer', 'config.json'));
}

/** 随包分发的配置样例，源码运行与 dist 运行都能向上找到它。 */
export function exampleConfigPath() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(directory, 'config.example.json');
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error('未找到 config.example.json');
}

export async function loadConfig(path = configPath()): Promise<BoardConfig> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new Error(`读取配置失败：${path}（先运行 computer-board init 创建）`); }
  try { return boardConfigSchema.parse(JSON.parse(raw)); }
  catch (error) {
    const detail = error instanceof ZodError
      ? error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
      : error instanceof Error ? error.message : '未知错误';
    throw new Error(`配置无效：${path}：${detail}`);
  }
}

export type ConfigWatcher = { stop(): void };

/**
 * 监听配置文件并在每次改动后重载：解析或校验失败时只报告原因，由调用方保留上一份可用配置。
 * 监听所在目录而不是文件本身：编辑器保存普遍是「写临时文件再改名」，改名后原 inode 上的监听会失效；
 * 同一目录还有 daemon.log 等运行数据，所以按文件名过滤，并用防抖合并写入过程中的多次事件。
 */
export function watchConfig(
  path: string,
  onChange: (config: BoardConfig) => void,
  options: { debounceMs?: number; onError?: (error: Error) => void } = {},
): ConfigWatcher {
  const target = resolve(path);
  const file = basename(target);
  const debounceMs = options.debounceMs ?? 150;
  const fail = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const reload = () => {
    if (stopped) return;
    void loadConfig(target).then(config => { if (!stopped) onChange(config); }, fail);
  };
  const watcher = watch(dirname(target), { persistent: false }, (_event, changed) => {
    if (changed && basename(changed) !== file) return;
    clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  });
  watcher.on('error', fail);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}

/** 从配置样例创建配置文件；文件已存在时不做任何改动。 */
export async function initConfig(path = configPath()) {
  if (existsSync(path)) return undefined;
  const config = boardConfigSchema.parse(JSON.parse(await readFile(exampleConfigPath(), 'utf8')));
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const file = await open(temp, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  return path;
}
