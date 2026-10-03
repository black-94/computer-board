#!/usr/bin/env node
import { configPath, initConfig, loadConfig } from './config.js';
import { HealthEngine } from './health.js';
import { BoardService } from './service.js';
import { buildServer } from './http.js';

const usage = [
  '用法：computer-board [start|init|validate]',
  '  start     启动服务（默认）',
  `  init      按样例在 ${configPath()} 创建配置`,
  '  validate  校验配置',
].join('\n');

async function start() {
  const config = await loadConfig();
  const health = new HealthEngine(config);
  const app = await buildServer(new BoardService(health));
  const { host, port, path } = config.server;
  await app.listen({ host, port });
  console.log(`Computer Board: http://${host}:${port}（HTTP MCP: http://${host}:${port}${path}）`);
  await health.start();
  const close = async () => { await health.stop(); await app.close(); process.exit(0); };
  process.on('SIGINT', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
}

async function run() {
  const command = process.argv[2] ?? 'start';
  if (command === 'start') return start();
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
