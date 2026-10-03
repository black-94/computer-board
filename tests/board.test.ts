import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardConfigSchema, parseMachineHost, type BoardConfig, type HealthCheck } from '../shared/schema.js';
import { initConfig, loadConfig } from '../server/config.js';
import { HealthEngine } from '../server/health.js';
import { BoardService } from '../server/service.js';
import { buildServer } from '../server/http.js';
import { QueryError } from '../server/errors.js';
import { DefaultProbeBackend, type ProbeBackend, type ProbeContext, type ProbeResult } from '../server/probes.js';
import computerBoardExtension, { configPath as extensionConfigPath, ensureCommand, serverBase } from '../extension/index.js';
import { address, baseUrl, ensureDaemon, launchLockPath, probe, readState, stopDaemon } from '../server/daemon.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
const base = boardConfigSchema.parse(example);
const clone = (): BoardConfig => structuredClone(base);
const success: ProbeResult = { outcome: 'success', latencyMs: 4 };
class FakeBackend implements ProbeBackend {
  constructor(public probe: (context: ProbeContext) => ProbeResult = () => success) {}
  async run(context: ProbeContext) { return this.probe(context); }
}
const local = (config: BoardConfig) => config.machines[0];
const cliEntry = resolve('server/cli.ts');
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const setup = (config = clone(), backend: ProbeBackend = new FakeBackend()) => {
  const health = new HealthEngine(config, backend);
  return { health, service: new BoardService(health) };
};

describe('config', () => {
  it.each([
    ['localhost', undefined],
    ['operator@192.0.2.10:22', { hostname: '192.0.2.10', username: 'operator', port: 22 }],
    ['worker@192.0.2.10:65535', { hostname: '192.0.2.10', username: 'worker', port: 65535 }],
    ['root@[2001:db8::1]:2222', { hostname: '2001:db8::1', username: 'root', port: 2222 }],
  ])('parses machine host %s', (host, target) => {
    expect(parseMachineHost(host as string)).toEqual(target);
    const config = clone();
    if (host === 'localhost') config.machines = [config.machines[0]];
    else config.machines[1].host = host as string;
    expect(boardConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each(['192.0.2.10', 'operator@192.0.2.10', '192.0.2.10:22', 'operator@example.com:22',
    'operator@999.0.2.10:22', 'operator@192.0.2.10:0', 'operator@192.0.2.10:65536',
    'operator@192.0.2.10:2.2', 'operator@2001:db8::1:22', ' @192.0.2.10:22', 'localhost:22'])('rejects invalid host %s', host => {
    const config = clone();
    config.machines[1].host = host;
    expect(boardConfigSchema.safeParse(config).success).toBe(false);
  });

  it('normalizes tips, allows empty tips and rejects a second localhost machine', () => {
    expect(base.machines[0].tips).toEqual(['local指的服务端所在机器不是客户端所在机器', '禁止rm -rf /']);
    expect(base.machines[0].software[2].tips).toEqual(['使用acp连接']);
    expect(base.machines[0].software[3].tips).toEqual([]);
    const config = clone();
    config.machines[1].host = 'localhost';
    expect(boardConfigSchema.safeParse(config).success).toBe(false);
  });

  it('requires a server address, defaults and a valid concurrency limit', () => {
    const missingServer = clone() as unknown as Record<string, unknown>;
    delete missingServer.server;
    expect(boardConfigSchema.safeParse(missingServer).success).toBe(false);

    const relativePath = clone();
    relativePath.server.path = 'mcp';
    expect(boardConfigSchema.safeParse(relativePath).success).toBe(false);

    const badPort = clone();
    badPort.server.port = 70000;
    expect(boardConfigSchema.safeParse(badPort).success).toBe(false);

    const missingConcurrency = clone() as unknown as { defaults: Record<string, unknown> };
    delete missingConcurrency.defaults.maxConcurrency;
    expect(boardConfigSchema.safeParse(missingConcurrency).success).toBe(false);

    for (const maxConcurrency of [0, 101, 1.5]) {
      const config = clone();
      config.defaults.maxConcurrency = maxConcurrency;
      expect(boardConfigSchema.safeParse(config).success).toBe(false);
    }
  });

  it('rejects duplicate IDs, blank IDs, unknown fields and misplaced local checks', () => {
    const duplicateMachine = clone();
    duplicateMachine.machines[1].id = duplicateMachine.machines[0].id;
    expect(boardConfigSchema.safeParse(duplicateMachine).success).toBe(false);

    const duplicateSoftware = clone();
    duplicateSoftware.machines[0].software[1].id = duplicateSoftware.machines[0].software[0].id;
    expect(boardConfigSchema.safeParse(duplicateSoftware).success).toBe(false);

    const crossMachine = clone();
    crossMachine.machines[1].software.push(structuredClone(crossMachine.machines[0].software[0]));
    expect(boardConfigSchema.safeParse(crossMachine).success).toBe(false);

    const blank = clone();
    blank.machines[1].software[0].id = '   ';
    expect(boardConfigSchema.safeParse(blank).success).toBe(false);

    const unknownField = clone() as unknown as { machines: Record<string, unknown>[] };
    unknownField.machines[0].password = 'should-not-exist';
    expect(boardConfigSchema.safeParse(unknownField).success).toBe(false);

    const localCheckOnRemote = clone();
    localCheckOnRemote.machines[1].healthChecks = [{ type: 'local', required: true }];
    expect(boardConfigSchema.safeParse(localCheckOnRemote).success).toBe(false);

    const localCheckOnSoftware = clone();
    localCheckOnSoftware.machines[0].software[0].healthChecks = [{ type: 'local', required: true }];
    expect(boardConfigSchema.safeParse(localCheckOnSoftware).success).toBe(false);
  });

  it('reads and validates the configuration file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-board-config-'));
    const file = join(directory, 'config.json');
    try {
      await writeFile(file, JSON.stringify(base));
      expect(await loadConfig(file)).toEqual(base);
      const broken = clone();
      broken.schemaVersion = 2 as unknown as 1;
      await writeFile(file, JSON.stringify(broken));
      await expect(loadConfig(file)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('discovery', () => {
  it('starts unknown, lists everything with showAll and defaults to strictly healthy only', async () => {
    const { health, service } = setup();
    expect(service.listMachines()).toEqual([]);
    const initial = service.listMachines({ showAll: true });
    expect(initial).toHaveLength(2);
    expect(initial[0]).toMatchObject({ name: '本机', host: 'localhost', status: 'unknown' });
    expect(initial[0].software).toEqual([
      { name: 'Node.js', status: 'unknown' }, { name: 'Docker', status: 'unknown' },
      { name: 'CodeBuddy', status: 'unknown' }, { name: 'Blender', status: 'unknown' },
    ]);
    expect(initial[1]).toEqual({ name: 'remote-example', host: 'root@192.168.0.1:22', status: 'disabled',
      software: [{ name: 'comfyui', status: 'disabled' }] });
    await health.refresh();
    expect(service.listMachines()).toEqual([{ name: '本机', host: 'localhost', software: [
      { name: 'Node.js' }, { name: 'Docker' }, { name: 'CodeBuddy' }, { name: 'Blender' },
    ] }]);
    expect(service.listMachines({ showAll: true })[0].status).toBe('healthy');
    expect(() => service.listMachines({ showAll: 'yes' })).toThrowError(QueryError);
  });

  it('hides degraded results from the default list but reports them in showAll', async () => {
    let ok = true;
    const { health, service } = setup(clone(), new FakeBackend(context =>
      context.software?.id === 'local-docker' && !ok ? { outcome: 'failure', reasonCode: 'COMMAND_FAILED' } : success));
    await health.refresh();
    ok = false;
    await health.refresh();
    expect(health.softwareView(local(health.config), local(health.config).software[1]))
      .toMatchObject({ status: 'degraded', reasonCode: 'COMMAND_FAILED' });
    expect(service.listMachines()[0].software.map(software => software.name)).not.toContain('Docker');
    expect(service.listMachines({ showAll: true })[0].software[1]).toEqual({ name: 'Docker', status: 'degraded' });
  });

  it('turns a check unhealthy after the failure threshold and skips disabled software', async () => {
    const config = clone();
    config.defaults.failureThreshold = 2;
    config.machines[0].software[1].enabled = false;
    const probed: string[] = [];
    const { health, service } = setup(config, new FakeBackend(context => {
      probed.push(context.software?.id ?? context.machine.id);
      return context.software?.id === 'local-node' ? { outcome: 'failure', reasonCode: 'COMMAND_FAILED' } : success;
    }));
    await health.refresh();
    await health.refresh();
    expect(probed).not.toContain('local-docker');
    expect(health.softwareView(config.machines[0], config.machines[0].software[0])).toMatchObject({ status: 'unhealthy', reasonCode: 'COMMAND_FAILED' });
    expect(health.softwareView(config.machines[0], config.machines[0].software[1])).toMatchObject({ status: 'disabled' });
    expect(service.listMachines()[0].software.map(software => software.name)).toEqual(['CodeBuddy', 'Blender']);
  });

  it('respects the configured probe concurrency', async () => {
    const config = clone();
    config.defaults.maxConcurrency = 1;
    let running = 0;
    let peak = 0;
    const { health } = setup(config, { run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
      return success;
    } });
    await health.refresh();
    expect(peak).toBe(1);
  });

  it('keeps unconfigured checks unknown', async () => {
    const config = clone();
    config.machines[0].software[0].healthChecks = [];
    const { health, service } = setup(config);
    await health.refresh();
    expect(service.listMachines({ showAll: true })[0].software[0]).toEqual({ name: 'Node.js', status: 'unknown' });
    expect(service.listMachines()).toEqual([{ name: '本机', host: 'localhost', software: [
      { name: 'Docker' }, { name: 'CodeBuddy' }, { name: 'Blender' },
    ] }]);
  });

  it('returns details without empty fields and never probes on query', () => {
    const { service } = setup(clone(), new FakeBackend(() => { throw new Error('query must not probe'); }));
    const machine = service.getMachine({ machine: { machineId: 'local' } });
    expect(machine).toMatchObject({ machineId: 'local', name: '本机', host: 'localhost', desc: '日常工作最常用机器',
      tips: ['local指的服务端所在机器不是客户端所在机器', '禁止rm -rf /'], enabled: true });
    expect(machine).not.toHaveProperty('instruction');
    expect(machine).not.toHaveProperty('dependOn');
    expect(machine.healthChecks).toEqual([{ type: 'local', required: true, health: { status: 'unknown' } }]);
    expect(machine.software).toEqual([
      { softwareId: 'local-node', name: 'Node.js' }, { softwareId: 'local-docker', name: 'Docker' },
      { softwareId: 'local-codebuddy', name: 'CodeBuddy' }, { softwareId: 'local-blender', name: 'Blender' },
    ]);
    const software = service.getSoftware({ machine: { machineId: 'local' }, software: { name: 'Node.js' } });
    expect(software).toMatchObject({ softwareId: 'local-node', instruction: 'node --version', tips: ['无特殊说明'],
      dependOn: '已安装node并加入path', enabled: true, machine: { name: '本机', host: 'localhost' } });
    expect(software.healthChecks).toEqual([{ type: 'bash', required: true, command: 'node', args: ['--version'], health: { status: 'unknown' } }]);
    expect(service.getSoftware({ machine: { machineId: 'local' }, software: { softwareId: 'local-blender' } })).not.toHaveProperty('tips');
  });

  it('omits empty command arguments and resolves machines by id or host', () => {
    const config = clone();
    config.machines[0].software[0].healthChecks[0] = { type: 'bash', required: true, command: 'node', args: [] };
    const { service } = setup(config);
    expect(service.getMachine({ machine: { host: 'localhost' } }).machineId).toBe('local');
    expect(service.getSoftware({ machine: { host: 'localhost' }, software: { name: 'Node.js' } }).healthChecks[0])
      .toEqual({ type: 'bash', required: true, command: 'node', health: { status: 'unknown' } });
    expect(() => service.getMachine({ machine: { machineId: 'missing' } })).toThrowError(QueryError);
    expect(() => service.getMachine({ machine: { machineId: 'local', host: 'localhost' } })).toThrowError(QueryError);
    expect(() => service.getSoftware({ machine: { machineId: 'remote' }, software: { name: 'Node.js' } })).toThrowError(QueryError);
  });

  it('reports candidate ids for duplicate hosts and duplicate software names', () => {
    const config = clone();
    const twin = structuredClone(config.machines[1]);
    twin.id = 'remote-2';
    twin.software[0].id = 'remote-comfyui-2';
    config.machines.push(twin);
    const docker = structuredClone(config.machines[0].software[1]);
    docker.id = 'local-docker-2';
    config.machines[0].software.push(docker);
    expect(boardConfigSchema.safeParse(config).success).toBe(true);
    const { service } = setup(config);
    expect(service.getMachine({ machine: { machineId: 'remote-2' } }).name).toBe('remote-example');
    try {
      service.getMachine({ machine: { host: 'root@192.168.0.1:22' } });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).candidates).toEqual([
        { machineId: 'remote', name: 'remote-example', host: 'root@192.168.0.1:22' },
        { machineId: 'remote-2', name: 'remote-example', host: 'root@192.168.0.1:22' },
      ]);
    }
    expect(() => service.getSoftware({ machine: { machineId: 'local' }, software: { name: 'Docker' } })).toThrowError(QueryError);
    expect(service.getSoftware({ machine: { machineId: 'local' }, software: { softwareId: 'local-docker-2' } }).softwareId).toBe('local-docker-2');
  });
});

describe('probes', () => {
  const machine = () => local(clone());
  const run = (check: HealthCheck, timeoutMs = 5000) => new DefaultProbeBackend().run({ machine: machine(), check, timeoutMs });
  it('treats the local machine as reachable', async () => {
    expect(await run({ type: 'local', required: true })).toMatchObject({ outcome: 'success' });
  });
  it('runs fixed bash commands with real timeouts and reports failures', async () => {
    const version = await run({ type: 'bash', required: true, command: process.execPath, args: ['--version'] });
    expect(version).toMatchObject({ outcome: 'success' });
    expect(version.observedVersion).toMatch(/^\d+\.\d+/);
    expect(await run({ type: 'bash', required: true, command: process.execPath, args: ['-e', 'process.exit(3)'] }))
      .toMatchObject({ outcome: 'failure', reasonCode: 'COMMAND_FAILED' });
    expect(await run({ type: 'bash', required: true, command: 'computer-board-missing-binary', args: [] }))
      .toMatchObject({ outcome: 'failure', reasonCode: 'EXECUTABLE_NOT_FOUND' });
    expect(await run({ type: 'bash', required: true, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'] }, 300))
      .toMatchObject({ outcome: 'failure', reasonCode: 'PROBE_TIMEOUT' });
  });
});

// 扩展与守护进程都按同一约定拉起 CLI：测试里用 tsx 跑源码。
process.env.COMPUTER_BOARD_CLI = `${process.execPath} ${tsxCli} ${cliEntry}`;

type PiTool = Parameters<Parameters<typeof computerBoardExtension>[0]['registerTool']>[0];
type ToolResult = { content: unknown[]; details?: unknown; isError?: boolean };

const payload = (result: ToolResult) => {
  const text = (result.content as { text?: string }[])[0]?.text;
  return JSON.parse(text ?? '');
};
const withConfig = (file: string, run: () => Promise<void>) => {
  const previous = process.env.COMPUTER_BOARD_CONFIG;
  process.env.COMPUTER_BOARD_CONFIG = file;
  return run().finally(() => {
    if (previous === undefined) delete process.env.COMPUTER_BOARD_CONFIG;
    else process.env.COMPUTER_BOARD_CONFIG = previous;
  });
};

const freePort = () => new Promise<number>(resolvePort => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolvePort(port));
  });
});

/** 单机 + local 探活、软件无检查的临时配置：探活立即出结果，也覆盖 unknown 软件。 */
const daemonSetup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-board-daemon-'));
  const file = join(directory, 'config.json');
  const config = clone();
  config.server = { host: '127.0.0.1', port: await freePort(), path: '/mcp' };
  config.machines = [config.machines[0]];
  config.machines[0].healthChecks = [{ type: 'local', required: true }];
  config.machines[0].software = config.machines[0].software.map(software => ({ ...software, healthChecks: [] }));
  await writeFile(file, JSON.stringify(config));
  return { config, directory, file };
};

describe('daemon', () => {
  it('拉起唯一实例：重复 ensure 复用同一进程，stop 后端口与状态一起释放', async () => {
    const { config, directory, file } = await daemonSetup();
    try {
      const first = await ensureDaemon(config, { configFile: file });
      expect(first.started).toBe(true);
      expect(first.address).toEqual(address(config));
      expect(first.state?.pid).toBeGreaterThan(0);
      expect(await probe(first.address.url)).toBe(true);
      expect(existsSync(launchLockPath(file))).toBe(false);

      const second = await ensureDaemon(config, { configFile: file });
      expect(second.started).toBe(false);
      expect(second.state?.pid).toBe(first.state?.pid);

      expect(await stopDaemon(file)).toBe(true);
      expect(await probe(first.address.url)).toBe(false);
      expect(await readState(file)).toBeUndefined();
      expect(await stopDaemon(file)).toBe(false);
    } finally {
      await stopDaemon(file);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('并发 ensure 也只拉起一个实例', async () => {
    const { config, directory, file } = await daemonSetup();
    try {
      const results = await Promise.all([
        ensureDaemon(config, { configFile: file }), ensureDaemon(config, { configFile: file }),
      ]);
      expect(results.map(result => result.started).sort()).toEqual([false, true]);
      const state = await readState(file);
      expect(state?.pid).toBeGreaterThan(0);
      expect(results.flatMap(result => result.state ? [result.state.pid] : []).every(pid => pid === state?.pid)).toBe(true);
      expect(await probe(address(config).url)).toBe(true);
    } finally {
      await stopDaemon(file);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('pi extension', () => {
  it('registers the three read-only tools and starts the service on demand', async () => {
    const { config, directory, file } = await daemonSetup();
    try {
      // 扩展加载时就会按配置拉起服务，所以配置必须在注册前生效。
      await withConfig(file, async () => {
        const tools: PiTool[] = [];
        computerBoardExtension({ registerTool: (tool: PiTool) => { tools.push(tool); } } as never);
        expect(tools.map(tool => tool.name)).toEqual(['list_machines', 'get_machine', 'get_software']);
        expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
        expect(tools.every(tool => Boolean(tool.description))).toBe(true);

        // 第一次调用把服务拉起来，因此这里不依赖调用前服务已在运行。
        await tools[0].execute('call-1', {} as never, undefined, undefined, undefined as never);
        expect(await probe(address(config).url)).toBe(true);
        await fetch(`${baseUrl(address(config))}/api/health/refresh`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });

        const list = await tools[0].execute('call-2', { showAll: false } as never, undefined, undefined, undefined as never);
        expect(payload(list)).toEqual([{ name: '本机', host: 'localhost', software: [] }]);

        const machine = await tools[1].execute('call-3',
          { machine: { host: 'localhost' } } as never, undefined, undefined, undefined as never);
        expect(payload(machine)).toMatchObject({ machineId: 'local', name: '本机', revision: config.revision });
        expect(machine.details).toMatchObject({ machineId: 'local' });

        const missing = await tools[1].execute('call-4',
          { machine: { machineId: 'no-such-machine' } } as never, undefined, undefined, undefined as never);
        expect(missing.isError).toBe(true);
        expect(payload(missing).error).toEqual({ code: 'NOT_FOUND', message: '未找到机器' });

        const software = await tools[2].execute('call-5',
          { machine: { machineId: 'local' }, software: { name: 'Node.js' } } as never, undefined, undefined, undefined as never);
        expect(payload(software)).toMatchObject({ softwareId: 'local-node', healthChecks: [] });
      });
    } finally {
      await stopDaemon(file);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('falls back to the loopback defaults, ~/.computer/config.json and PATH', () => {
    expect(extensionConfigPath({})).toBe(join(homedir(), '.computer', 'config.json'));
    expect(extensionConfigPath({ COMPUTER_BOARD_CONFIG: 'relative/config.json' })).toBe(resolve('relative/config.json'));
    expect(serverBase(join(homedir(), '.computer', 'definitely-missing.json'))).toBe('http://127.0.0.1:3000');
    expect(ensureCommand({ COMPUTER_BOARD_CLI: '/usr/bin/env node /abs/cli.js' }))
      .toEqual({ command: '/usr/bin/env', args: ['node', '/abs/cli.js', 'ensure'] });
    expect(ensureCommand({}).args.at(-1)).toBe('ensure');
  });
});

describe('CLI', () => {
  const cli = (args: string[], env: NodeJS.ProcessEnv) => execFileSync(process.execPath,
    [tsxCli, cliEntry, ...args],
    { cwd: resolve('.'), env: { ...process.env, ...env }, encoding: 'utf8' });

  it('validates the example configuration', () => {
    const output = cli(['validate'], { COMPUTER_BOARD_CONFIG: resolve('config.example.json') });
    expect(output).toContain('配置有效');
    expect(output).toContain(`${base.machines.length} 台机器`);
  });

  it('creates the configuration once and leaves an existing file untouched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-board-cli-'));
    const file = join(directory, '.computer', 'config.json');
    try {
      expect(cli(['init'], { COMPUTER_BOARD_CONFIG: file })).toContain('已创建');
      const created = await readFile(file, 'utf8');
      expect(boardConfigSchema.parse(JSON.parse(created))).toEqual(base);
      expect(cli(['init'], { COMPUTER_BOARD_CONFIG: file })).toContain('已存在');
      expect(await readFile(file, 'utf8')).toBe(created);
      await expect(initConfig(file)).resolves.toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects unknown commands', () => {
    expect(() => cli(['destroy'], { COMPUTER_BOARD_CONFIG: resolve('config.example.json') })).toThrowError(/用法/u);
  });
});

describe('REST and MCP', () => {
  const servers: { close(): Promise<unknown> }[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

  it('serves discovery, details, fixed refresh and rejections over REST', async () => {
    const { health, service } = setup();
    const app = await buildServer(service, { staticFiles: false });
    servers.push(app);
    const list = await app.inject('/api/discovery?showAll=true');
    expect(list.statusCode).toBe(200);
    expect(list.json()[1]).toMatchObject({ name: 'remote-example', host: 'root@192.168.0.1:22', status: 'disabled' });
    expect((await app.inject('/api/discovery?showAll=bad')).statusCode).toBe(400);
    const machine = await app.inject({ method: 'POST', url: '/api/query/machine', payload: { machine: { host: 'localhost' } } });
    expect(machine.json().machineId).toBe('local');
    const software = await app.inject({ method: 'POST', url: '/api/query/software', payload: { machine: { machineId: 'local' }, software: { name: 'Node.js' } } });
    expect(software.json()).toMatchObject({ softwareId: 'local-node', healthChecks: [{ command: 'node' }] });
    expect((await app.inject({ method: 'POST', url: '/api/query/machine', payload: { machine: { machineId: 'no' } } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/query/machine', payload: { machine: { host: 'localhost', unexpected: 1 } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/health/refresh', payload: { command: 'whoami' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/health/refresh', payload: {} })).statusCode).toBe(200);
    expect(health.machineView(local(health.config)).status).toBe('healthy');
  });

  it('exposes the three read-only tools and their usage notes over HTTP MCP', async () => {
    const { health, service } = setup();
    await health.refresh();
    const app = await buildServer(service, { staticFiles: false });
    servers.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new McpClient({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', app.listeningOrigin));
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name).sort()).toEqual(['get_machine', 'get_software', 'list_machines']);
      expect(tools.every(tool => Boolean(tool.description))).toBe(true);
      const instructions = client.getInstructions() ?? '';
      for (const note of ['只读', 'showAll', 'get_machine', 'degraded', 'AMBIGUOUS']) expect(instructions).toContain(note);
      const list = await client.callTool({ name: 'list_machines', arguments: {} });
      expect(JSON.parse((list.content as { text: string }[])[0].text)[0].software)
        .toEqual([{ name: 'Node.js' }, { name: 'Docker' }, { name: 'CodeBuddy' }, { name: 'Blender' }]);
      const machine = await client.callTool({ name: 'get_machine', arguments: { machine: { host: 'localhost' } } });
      expect(machine.structuredContent).toMatchObject({ machineId: 'local' });
      const error = await client.callTool({ name: 'get_machine', arguments: { machine: { machineId: 'no' } } });
      expect(error.isError).toBe(true);
      expect(JSON.parse((error.content as { text: string }[])[0].text).error.code).toBe('NOT_FOUND');
    } finally { await client.close(); }
  });
});
