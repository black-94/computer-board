#!/usr/bin/env node
import { configPath, initConfig, loadConfig } from './config.js';
import { HealthEngine } from './health.js';
import { BoardService } from './service.js';
import { buildServer } from './http.js';
import { address, clearState, ensureDaemon, stopDaemon, writeState } from './daemon.js';

const usage = [
  '用法：computer-board [start|ensure|stop|init|validate]',
  '  start     前台启动服务（默认）',
  '  ensure    确保后台服务在运行（已在运行则复用），pi extension 用它拉起服务',
  '  stop      停止后台服务',
  `  init      按样例在 ${configPath()} 创建配置`,
  '  validate  校验配置',
].join('\n');

async function start() {
  const config = await loadConfig();
  const health = new HealthEngine(config);
  const app = await buildServer(new BoardService(health));
  const { host, port, path } = config.server;
  try { await app.listen({ host, port }); }
  catch (error) {
    // 端口独占就是实例的唯一性判据：占用了说明已经有实例在服务。
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`${host}:${port} 已被占用，可能已有实例在运行（computer-board ensure 会复用它）`);
    }
    throw error;
  }
  // 先记录监听信息再放开探活：ensure 依赖它就绪，端口独占保证同时只有一个实例。
  await writeState({ pid: process.pid, startedAt: new Date().toISOString(), ...address(config) });
  console.log(`Computer Board: http://${host}:${port}（HTTP MCP: http://${host}:${port}${path}）`);
  await health.start();
  const close = async () => { await clearState(); await health.stop(); await app.close(); process.exit(0); };
  process.on('SIGINT', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
}

async function ensure() {
  const { address: target, state, started } = await ensureDaemon(await loadConfig());
  console.log(`${started ? '已启动' : '已在运行'} ${target.url}${state ? `（pid ${state.pid}）` : ''}`);
}

async function stop() {
  console.log(await stopDaemon() ? '已停止后台服务' : '没有运行中的后台服务');
}

async function run() {
  const command = process.argv[2] ?? 'start';
  if (command === 'start') return start();
  if (command === 'ensure') return ensure();
  if (command === 'stop') return stop();
  if (command === 'init') {
    const path = await initConfig();
    console.log(path ? `已创建 ${path}` : `${configPath()} 已存在，未改动`);
    return;
  }
  if (command === 'validate') {
    const config = await loadConfig();
    console.log(`配置有效：${config.machines.length} 台机器，revision=${config.revision}`);
    return;
  }
  console.error(usage);
  process.exitCode = 1;
}

try { await run(); }
catch (error) { console.error(error instanceof Error ? error.message : '未知错误'); process.exitCode = 1; }
