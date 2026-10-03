import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const serverName = 'computer-board';
const fallback = { host: '127.0.0.1', port: 3000, path: '/mcp' };

/** 默认读取 ~/.computer/config.json，可用 COMPUTER_BOARD_CONFIG 覆盖。 */
export function configPath(env = process.env) {
  return env.COMPUTER_BOARD_CONFIG ? resolve(env.COMPUTER_BOARD_CONFIG) : join(homedir(), '.computer', 'config.json');
}

/** server 段缺失或字段不合法时回落到默认回环地址，避免扩展加载失败。 */
function address(value: unknown) {
  const server = (value ?? {}) as Record<string, unknown>;
  return {
    host: typeof server.host === 'string' && server.host ? server.host : fallback.host,
    port: typeof server.port === 'number' ? server.port : fallback.port,
    path: typeof server.path === 'string' && server.path.startsWith('/') ? server.path : fallback.path,
  };
}

/** 由配置的 server 段推导本服务 HTTP MCP 地址。 */
export function serverUrl(path = configPath()): string {
  let config: { server?: unknown } | undefined;
  try { config = JSON.parse(readFileSync(path, 'utf8')) as { server?: unknown }; }
  catch { config = undefined; }
  const { host, port, path: route } = address(config?.server);
  return `http://${host}:${port}${route}`;
}

/** pi 扩展：把本服务的 HTTP MCP 工具按原样注册进 pi。 */
export default function computerBoardExtension(pi: ExtensionAPI) {
  pi.registerMcpServer(serverName, {
    type: 'http',
    url: serverUrl(),
    exposure: 'direct',
    timeout: 15,
    description: '手工维护的机器与软件清单、接入说明与探活状态，只读查询。',
  });
}
