import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardConfigSchema, parseMachineHost, type BoardConfig, type HealthCheck, type Machine } from '../shared/schema.js';
import { initConfig, loadConfig, watchConfig } from '../server/config.js';
import { HealthEngine } from '../server/health.js';
import { BoardService } from '../server/service.js';
import { buildSearchIndex, rank, tokenize, type SearchIndexBuilder } from '../server/search.js';
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
/** 构造只用于搜索测试的配置：每台机器一个必成功的 bash 检查，软件为空，字段可控。 */
const searchConfig = (machines: { id: string; name: string; host: string; enabled?: boolean }[]) => {
  const config = clone();
  config.machines = machines.map(machine => ({
    id: machine.id, name: machine.name, host: machine.host,
    desc: '', instruction: '', tips: [], enabled: machine.enabled ?? true, dependOn: '',
    healthChecks: [{ type: 'bash' as const, required: true, command: 'true', args: [] }],
    software: [],
  }));
  return config;
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

describe('config hot reload', () => {
  const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return predicate();
  };

  it('applies valid changes immediately and keeps the old config when the file is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-board-reload-'));
    const file = join(directory, 'config.json');
    const initial = clone();
    initial.revision = 1;
    await writeFile(file, JSON.stringify(initial));
    let probes = 0;
    const { health, service } = setup(initial, new FakeBackend(() => { probes += 1; return success; }));
    const errors: string[] = [];
    const watcher = watchConfig(file, config => { void health.reload(config); },
      { debounceMs: 20, onError: error => errors.push(error.message) });
    try {
      const updated = clone();
      updated.revision = 2;
      updated.machines[0].software = updated.machines[0].software.slice(0, 1);
      await writeFile(file, JSON.stringify(updated));
      expect(await waitFor(() => health.config.revision === 2)).toBe(true);
      // 重载后按新配置立刻重跑一轮探活（后台进行），查询接口也改用新配置。
      expect(await waitFor(() => service.listMachines({ showAll: true })[0]?.software.length === 1)).toBe(true);
      expect(await waitFor(() => probes > 0)).toBe(true);
      expect(await waitFor(() => service.listMachines({ showAll: true })[0].software[0].status === 'healthy')).toBe(true);

      // 语法错误：保留老配置，只报告原因。
      await writeFile(file, '{ "schemaVersion": 1,');
      expect(await waitFor(() => errors.length > 0)).toBe(true);
      expect(health.config.revision).toBe(2);

      // 校验错误（ID 重复）：同样保留老配置。
      const duplicate = clone();
      duplicate.machines[1].id = duplicate.machines[0].id;
      await writeFile(file, JSON.stringify(duplicate));
      expect(await waitFor(() => errors.length > 1)).toBe(true);
      expect(health.config.revision).toBe(2);
      expect(health.config.machines[0].software).toHaveLength(1);

      // 改回合法内容后自动生效，不需要重启。
      const fixed = clone();
      fixed.revision = 3;
      await writeFile(file, JSON.stringify(fixed));
      expect(await waitFor(() => health.config.revision === 3)).toBe(true);
      expect(service.getMachine({ machine: { machineId: 'local' } }).software).toHaveLength(4);
    } finally {
      watcher.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 内核通知可能被合并或漏掉：用硬链接模拟（写的是同一份文件，但事件落在另一个目录），
  // 兜底轮询必须把改动补上，否则配置会一直不生效。
  it('still applies a change when the file notification never arrives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-board-poll-'));
    const aliasDirectory = await mkdtemp(join(tmpdir(), 'computer-board-poll-alias-'));
    const file = join(directory, 'config.json');
    const alias = join(aliasDirectory, 'config.json');
    const initial = clone();
    initial.revision = 1;
    await writeFile(file, JSON.stringify(initial));
    linkSync(file, alias);
    let revision: number | undefined;
    const errors: string[] = [];
    const watcher = watchConfig(file, config => { revision = config.revision; },
      { debounceMs: 20, pollMs: 50, onError: error => errors.push(error.message) });
    try {
      const updated = clone();
      updated.revision = 2;
      writeFileSync(alias, JSON.stringify(updated));
      expect(await waitFor(() => revision === 2)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      watcher.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(aliasDirectory, { recursive: true, force: true });
    }
  });

  it('searches machines added by a hot reload immediately', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-board-search-reload-'));
    const file = join(directory, 'config.json');
    const initial = searchConfig([{ id: 'first', name: '第一台', host: 'a@1.1.1.1:22' }]);
    await writeFile(file, JSON.stringify(initial));
    const { health, service } = setup(initial);
    const watcher = watchConfig(file, config => { void health.reload(config); }, { debounceMs: 20 });
    try {
      await health.refresh();
      expect(service.searchMachines({ query: 'first' }).map(hit => hit.machineId)).toEqual(['first']);
      expect(service.searchMachines({ query: 'second' })).toEqual([]);
      const updated = searchConfig([
        { id: 'first', name: '第一台', host: 'a@1.1.1.1:22' },
        { id: 'second', name: '第二台', host: 'b@2.2.2.2:22' },
      ]);
      updated.revision = 2;
      await writeFile(file, JSON.stringify(updated));
      expect(await waitFor(() => health.config.revision === 2)).toBe(true);
      expect(service.searchMachines({ query: 'second', showAll: true }).map(hit => hit.machineId)).toEqual(['second']);
    } finally {
      watcher.stop();
      await rm(directory, { recursive: true, force: true });
    }
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

describe('search', () => {
  it('tokenizes case, separators, CJK and id/host punctuation', () => {
    expect(tokenize('Local-Node_1.2:3@host')).toEqual(['local', 'node', '1', '2', '3', 'host']);
    expect(tokenize('root@192.168.0.1:22')).toEqual(['root', '192', '168', '0', '1', '22']);
    expect(tokenize('  本机  ')).toEqual(['本', '机']);
    expect(tokenize('---')).toEqual([]);
  });

  it('matches the id, name and host fields with BM25 and never probes on search', () => {
    const config = searchConfig([
      { id: 'alpha-01', name: '研发工作站', host: 'alice@10.0.0.5:22' },
      { id: 'beta-02', name: '测试服务器', host: 'bob@10.0.0.6:22' },
      { id: 'gamma-03', name: '研发服务器', host: 'carol@10.0.0.7:22' },
    ]);
    // 搜索只读内存，不触发探活：用会抛错的 backend 证明搜索路径不会调用它。
    const { service } = setup(config, new FakeBackend(() => { throw new Error('search must not probe'); }));
    const ids = (query: string) => service.searchMachines({ query, showAll: true }).map(hit => hit.machineId);
    expect(ids('alpha')).toEqual(['alpha-01']); // id
    expect(ids('ALPHA')).toEqual(['alpha-01']); // 大小写归一化
    expect(ids('工作站')).toEqual(['alpha-01']); // 中文 name
    expect(ids('服务器')).toEqual(['beta-02', 'gamma-03']); // 中文 name
    expect(ids('alice')).toEqual(['alpha-01']); // host 用户名
    expect(ids('carol')).toEqual(['gamma-03']); // host 用户名
    expect(ids('10.0.0.5')).toEqual(['alpha-01', 'beta-02', 'gamma-03']); // IP：含 5 者最高
    expect(ids('22')).toEqual(['alpha-01', 'beta-02', 'gamma-03']); // 端口
  });

  it('ranks by term frequency (id+name+host all containing the term)', async () => {
    const config = searchConfig([
      { id: 'node', name: 'node', host: 'node@10.0.0.1:22' },
      { id: 'node-2', name: 'web', host: 'bob@10.0.0.2:22' },
      { id: 'other', name: 'node服务', host: 'carol@10.0.0.3:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    const results = service.searchMachines({ query: 'node', showAll: true });
    expect(results.map(hit => hit.machineId)).toEqual(['node', 'node-2', 'other']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('favors shorter documents when term frequency and IDF tie', async () => {
    const config = searchConfig([
      { id: 'm-one', name: 'tag', host: 'u@1.1.1.1:1' },
      { id: 'm-two', name: 'tag 额外 很多 词 填充', host: 'u@1.1.1.1:1' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    const results = service.searchMachines({ query: 'tag', showAll: true });
    expect(results.map(hit => hit.machineId)).toEqual(['m-one', 'm-two']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('weights rarer query terms above common ones via IDF', async () => {
    const config = searchConfig([
      { id: 'common', name: 'alpha', host: 'a@1.1.1.1:22' },
      { id: 'rare', name: 'beta', host: 'b@2.2.2.2:22' },
      { id: 'common-2', name: 'gamma', host: 'c@3.3.3.3:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    const results = service.searchMachines({ query: 'rare common', showAll: true });
    expect(results[0].machineId).toBe('rare'); // 稀有词排在第一个配置项之前
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('keeps configuration order for equal scores', async () => {
    const config = searchConfig([
      { id: 'a-1', name: 'twin', host: 'same@1.1.1.1:22' },
      { id: 'a-2', name: 'twin', host: 'same@1.1.1.1:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    const results = service.searchMachines({ query: 'twin', showAll: true });
    expect(results.map(hit => hit.machineId)).toEqual(['a-1', 'a-2']);
    expect(results[0].score).toBe(results[1].score);
  });

  it('rejects invalid input and returns an empty array when nothing matches', async () => {
    const { health, service } = setup(searchConfig([{ id: 'only', name: '唯一', host: 'a@1.1.1.1:22' }]));
    await health.refresh();
    for (const input of [{}, { query: '' }, { query: '   ' }, { query: 42 }, { query: 'ok', extra: true }, { showAll: true }]) {
      expect(() => service.searchMachines(input)).toThrowError(QueryError);
    }
    expect(service.searchMachines({ query: 'no-such-machine-xyz' })).toEqual([]);
    expect(service.searchMachines({ query: '---' })).toEqual([]); // 分隔符切不出关键词
  });

  it('defaults to healthy machines and attaches status with showAll', async () => {
    const config = searchConfig([
      { id: 'healthy-one', name: '在线机器', host: 'a@1.1.1.1:22' },
      { id: 'disabled-one', name: '停用机器', host: 'b@2.2.2.2:22', enabled: false },
      { id: 'broken-one', name: '故障机器', host: 'c@3.3.3.3:22' },
    ]);
    const { health, service } = setup(config, new FakeBackend(context =>
      context.machine.id === 'broken-one' ? { outcome: 'failure', reasonCode: 'COMMAND_FAILED' } : success));
    await health.refresh();
    const healthy = service.searchMachines({ query: '机器' });
    expect(healthy.map(hit => hit.machineId)).toEqual(['healthy-one']);
    expect(healthy[0].score).toBeGreaterThan(0);
    expect(Number.isFinite(healthy[0].score)).toBe(true);
    expect(healthy[0]).not.toHaveProperty('status');
    const all = service.searchMachines({ query: '机器', showAll: true });
    expect(all.map(hit => [hit.machineId, hit.status])).toEqual([
      ['healthy-one', 'healthy'], ['disabled-one', 'disabled'], ['broken-one', 'degraded'],
    ]);
    expect(all.every(hit => hit.score > 0 && Number.isFinite(hit.score))).toBe(true);
  });

  it('only indexes id, name and host, never desc/instruction/software or other fields', async () => {
    const config = clone();
    config.machines = [{
      id: 'ix-1', name: 'ix-name', host: 'ixuser@10.9.9.9:2201',
      desc: 'zebraword', instruction: 'unicornword', tips: ['quokkaword'], dependOn: 'narwhalword',
      enabled: true, healthChecks: [{ type: 'bash', required: true, command: 'true', args: [] }],
      software: [{
        id: 'ix-sw', name: 'softwareword', desc: 'penguinword', instruction: 'otterword',
        tips: [], enabled: true, dependOn: 'walrusword', healthChecks: [],
      }],
    }];
    const { health, service } = setup(config);
    await health.refresh();
    for (const term of ['zebraword', 'unicornword', 'quokkaword', 'narwhalword', 'softwareword', 'penguinword', 'otterword', 'walrusword']) {
      expect(service.searchMachines({ query: term })).toEqual([]);
    }
    expect(service.searchMachines({ query: 'ix-name' }).map(hit => hit.machineId)).toEqual(['ix-1']);
    expect(service.searchMachines({ query: '10.9.9.9' }).map(hit => hit.machineId)).toEqual(['ix-1']);
  });

  it('computes BM25 from the formula and deduplicates repeated query terms', async () => {
    const config = searchConfig([
      { id: 'alpha', name: 'alpha', host: 'alpha@10.0.0.1:22' },
      { id: 'beta', name: 'beta', host: 'beta@10.0.0.2:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    const hit = service.searchMachines({ query: 'alpha', showAll: true })[0];
    expect(hit.machineId).toBe('alpha');
    // N=2、df=1 → IDF=ln(1+(2-1+0.5)/(1+0.5))=ln2；该文档 tf=3、|D|=avgdl=8，k1=1.2、b=0.75。
    // score = ln2 · 3·2.2 / (3 + 1.2·(0.25 + 0.75·8/8)) = ln2 · 6.6/4.2 ≈ 1.0892312837
    expect(hit.score).toBeCloseTo(Math.log(2) * (6.6 / 4.2), 10);
    expect(hit.score).toBeCloseTo(1.0892312837, 9);
    // 重复关键词去重：'alpha alpha' 与 'alpha' 分数完全相同。
    expect(service.searchMachines({ query: 'alpha alpha', showAll: true })[0].score).toBe(hit.score);
  });

  it('defaults to the top 3 hits and never exceeds the hit count', async () => {
    const config = searchConfig([
      { id: 'm-1', name: 'node', host: 'u@1.0.0.1:22' },
      { id: 'm-2', name: 'node', host: 'u@1.0.0.2:22' },
      { id: 'm-3', name: 'node', host: 'u@1.0.0.3:22' },
      { id: 'm-4', name: 'node', host: 'u@1.0.0.4:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    // 4 条命中但默认只返回 3 条（省略 limit 即 3），且按分数/配置顺序取前 3。
    expect(service.searchMachines({ query: 'node' }).map(hit => hit.machineId)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(service.searchMachines({ query: 'no-such-machine-xyz' })).toEqual([]);
  });

  it('honors an explicit positive integer limit, including larger than the hit count', async () => {
    const config = searchConfig([
      { id: 'm-1', name: 'node', host: 'u@1.0.0.1:22' },
      { id: 'm-2', name: 'node', host: 'u@1.0.0.2:22' },
      { id: 'm-3', name: 'node', host: 'u@1.0.0.3:22' },
      { id: 'm-4', name: 'node', host: 'u@1.0.0.4:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    expect(service.searchMachines({ query: 'node', limit: 1 }).map(hit => hit.machineId)).toEqual(['m-1']);
    expect(service.searchMachines({ query: 'node', limit: 2 }).map(hit => hit.machineId)).toEqual(['m-1', 'm-2']);
    expect(service.searchMachines({ query: 'node', limit: 4 })).toHaveLength(4); // 等于命中数
    expect(service.searchMachines({ query: 'node', limit: 10 }).map(hit => hit.machineId))
      .toEqual(['m-1', 'm-2', 'm-3', 'm-4']); // 大于命中数：返回全部，不补空
  });

  it('ranks the whole candidate corpus before truncating, so a tail machine can lead', async () => {
    // 最高分的机器放在配置尾部：若实现先截候选再评分，limit=1 只会拿到 plain-1。
    const config = searchConfig([
      { id: 'plain-1', name: 'node', host: 'u@1.0.0.1:22' },
      { id: 'plain-2', name: 'node', host: 'u@1.0.0.2:22' },
      { id: 'plain-3', name: 'node', host: 'u@1.0.0.3:22' },
      { id: 'tail-top', name: 'node node node node', host: 'node@1.0.0.4:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    const ranked = service.searchMachines({ query: 'node', showAll: true, limit: 10 });
    expect(ranked.map(hit => hit.machineId)).toEqual(['tail-top', 'plain-1', 'plain-2', 'plain-3']);
    expect(service.searchMachines({ query: 'node', limit: 1 }).map(hit => hit.machineId)).toEqual(['tail-top']);
    expect(service.searchMachines({ query: 'node' })[0].machineId).toBe('tail-top'); // 默认 3 也保留尾部高分项
  });

  it('truncates equal scores in configuration order', async () => {
    const config = searchConfig([
      { id: 't-1', name: 'twin', host: 'same@1.1.1.1:22' },
      { id: 't-2', name: 'twin', host: 'same@1.1.1.1:22' },
      { id: 't-3', name: 'twin', host: 'same@1.1.1.1:22' },
    ]);
    const { health, service } = setup(config);
    await health.refresh();
    const all = service.searchMachines({ query: 'twin', showAll: true });
    expect(new Set(all.map(hit => hit.score)).size).toBe(1); // 同分
    expect(service.searchMachines({ query: 'twin', limit: 2 }).map(hit => hit.machineId)).toEqual(['t-1', 't-2']);
  });

  it('filters by current health before truncating and limit never changes retained scores', async () => {
    const config = searchConfig([
      { id: 'up-one', name: 'node', host: 'u@1.0.0.1:22' },
      { id: 'down-top', name: 'node node node', host: 'node@1.0.0.2:22' }, // 分最高但探活失败
      { id: 'up-two', name: 'node', host: 'u@1.0.0.3:22' },
    ]);
    const { health, service } = setup(config, new FakeBackend(context =>
      context.machine.id === 'down-top' ? { outcome: 'failure', reasonCode: 'COMMAND_FAILED' } : success));
    await health.refresh();
    // 默认先按 healthy 过滤：down-top 不进入候选，不占用 limit 名额。
    expect(service.searchMachines({ query: 'node' }).map(hit => hit.machineId)).toEqual(['up-one', 'up-two']);
    expect(service.searchMachines({ query: 'node', limit: 1 }).map(hit => hit.machineId)).toEqual(['up-one']);
    // limit 只截取，不改分数：同一候选语料下 limit=1 与 limit=3 的首条完全相同。
    expect(service.searchMachines({ query: 'node', limit: 1 })[0])
      .toEqual(service.searchMachines({ query: 'node', limit: 3 })[0]);
    // showAll=true 不过滤：分最高的 down-top 参与排名并排在首位（截取发生在排名之后）。
    expect(service.searchMachines({ query: 'node', showAll: true, limit: 1 }).map(hit => hit.machineId)).toEqual(['down-top']);
  });

  it('rejects a non-positive, non-integer or wrong-type limit but accepts positive integers', async () => {
    const { health, service } = setup(searchConfig([{ id: 'only', name: '唯一', host: 'a@1.1.1.1:22' }]));
    await health.refresh();
    for (const limit of [0, -1, -3, 1.5, 2.5, '2', null, true, false, NaN, Infinity, -Infinity]) {
      expect(() => service.searchMachines({ query: 'only', limit })).toThrowError(QueryError);
    }
    expect(service.searchMachines({ query: 'only', limit: 1 }).map(hit => hit.machineId)).toEqual(['only']);
    expect(service.searchMachines({ query: 'only', limit: 99 }).map(hit => hit.machineId)).toEqual(['only']); // 不设人为上限
    expect(service.searchMachines({ query: 'only', limit: undefined }).map(hit => hit.machineId)).toEqual(['only']); // 省略即默认
  });
});

describe('search index lifecycle', () => {
  const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return predicate();
  };
  /** spy builder：包装真实建索引，只统计调用次数，供生命周期断言使用。 */
  const trackedBuilder = () => {
    const built: unknown[] = [];
    const buildIndex: SearchIndexBuilder = (documents, toDocument) => {
      const index = buildSearchIndex(documents, toDocument);
      built.push(index);
      return index;
    };
    return { built, buildIndex };
  };
  const setupIndexed = (config: BoardConfig, buildIndex: SearchIndexBuilder, backend: ProbeBackend = new FakeBackend()) => {
    const health = new HealthEngine(config, backend, undefined, buildIndex);
    return { health, service: new BoardService(health) };
  };

  it('builds exactly once at construction, never on the first or repeated queries', async () => {
    const { built, buildIndex } = trackedBuilder();
    const { health, service } = setupIndexed(searchConfig([{ id: 'alpha', name: 'alpha', host: 'a@1.1.1.1:22' }]), buildIndex);
    expect(built).toHaveLength(1); // 构造即建好，首个查询不触发 lazy build
    expect(health.searchIndex).toBe(built[0]);
    await health.refresh();
    const identity = health.searchIndex;
    expect(service.searchMachines({ query: 'alpha', showAll: true }).map(hit => hit.machineId)).toEqual(['alpha']);
    expect(service.searchMachines({ query: 'alpha alpha', showAll: true })[0].score).toBeGreaterThan(0);
    expect(service.searchMachines({ query: 'no-such-machine' })).toEqual([]);
    expect(built).toHaveLength(1); // 查询不重建
    expect(health.searchIndex).toBe(identity); // 反复查询同一索引身份
  });

  it('rebuilds exactly once per reload and swaps in a fresh index, even without a revision bump', async () => {
    const { built, buildIndex } = trackedBuilder();
    const initial = searchConfig([{ id: 'first', name: 'first', host: 'a@1.1.1.1:22' }]);
    initial.revision = 1;
    const { health, service } = setupIndexed(initial, buildIndex);
    await health.refresh();
    const before = health.searchIndex;
    const grown = searchConfig([
      { id: 'first', name: 'first', host: 'a@1.1.1.1:22' },
      { id: 'second', name: 'second', host: 'b@2.2.2.2:22' },
    ]);
    grown.revision = 2;
    health.reload(grown);
    expect(built).toHaveLength(2); // 每次 reload 恰好重建一次
    expect(health.searchIndex).toBe(built[1]);
    expect(health.searchIndex).not.toBe(before); // 替换旧实例而非累积
    // 新配置 + 新索引同步可用，不等异步探活。
    expect(service.searchMachines({ query: 'second', showAll: true }).map(hit => hit.machineId)).toEqual(['second']);
    // revision 不变也重建：机器可能改名而 revision 不动。
    const sameRevision = searchConfig([{ id: 'renamed', name: 'renamed', host: 'c@3.3.3.3:22' }]);
    sameRevision.revision = 2;
    health.reload(sameRevision);
    expect(built).toHaveLength(3);
    expect(service.searchMachines({ query: 'first', showAll: true })).toEqual([]);
    expect(service.searchMachines({ query: 'renamed', showAll: true }).map(hit => hit.machineId)).toEqual(['renamed']);
  });

  it('applies add, modify and delete under an unchanged revision', async () => {
    const { buildIndex } = trackedBuilder();
    const initial = searchConfig([
      { id: 'keep', name: 'keep', host: 'a@1.1.1.1:22' },
      { id: 'change', name: 'before', host: 'b@2.2.2.2:22' },
      { id: 'drop', name: 'drop', host: 'c@3.3.3.3:22' },
    ]);
    initial.revision = 7;
    const { health, service } = setupIndexed(initial, buildIndex);
    await health.refresh();
    const updated = searchConfig([
      { id: 'keep', name: 'keep', host: 'a@1.1.1.1:22' },
      { id: 'change', name: 'after', host: 'b@2.2.2.2:22' },
      { id: 'add', name: 'add', host: 'd@4.4.4.4:22' },
    ]);
    updated.revision = 7; // 同一 revision
    health.reload(updated);
    const ids = (query: string) => service.searchMachines({ query, showAll: true }).map(hit => hit.machineId);
    expect(ids('keep')).toEqual(['keep']);
    expect(ids('after')).toEqual(['change']); // 改名生效
    expect(ids('before')).toEqual([]); // 旧名失效
    expect(ids('drop')).toEqual([]); // 删除生效
    expect(ids('add')).toEqual(['add']); // 新增生效
  });

  it('filters by the current health without rebuilding the index', async () => {
    const config = searchConfig([
      { id: 'up', name: '机器一', host: 'a@1.1.1.1:22' },
      { id: 'down', name: '机器二', host: 'b@2.2.2.2:22' },
    ]);
    const { built, buildIndex } = trackedBuilder();
    let failing = false;
    const backend = new FakeBackend(context => context.machine.id === 'down' && failing
      ? { outcome: 'failure', reasonCode: 'COMMAND_FAILED' } : success);
    const { health, service } = setupIndexed(config, buildIndex, backend);
    await health.refresh();
    const identity = health.searchIndex;
    expect(service.searchMachines({ query: '机器' }).map(hit => hit.machineId)).toEqual(['up', 'down']);
    failing = true;
    await health.refresh(); // 健康状态变化
    expect(health.searchIndex).toBe(identity); // 不重建索引
    expect(built).toHaveLength(1);
    expect(service.searchMachines({ query: '机器' }).map(hit => hit.machineId)).toEqual(['up']); // 只改过滤
    expect(service.searchMachines({ query: '机器', showAll: true }).map(hit => [hit.machineId, hit.status]))
      .toEqual([['up', 'healthy'], ['down', 'degraded']]); // showAll 附当前 status
  });

  it('keeps the previous index when the watcher rejects an invalid config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'computer-board-index-invalid-'));
    const file = join(directory, 'config.json');
    const initial = searchConfig([{ id: 'first', name: 'first', host: 'a@1.1.1.1:22' }]);
    initial.revision = 1;
    await writeFile(file, JSON.stringify(initial));
    const { built, buildIndex } = trackedBuilder();
    const { health, service } = setupIndexed(initial, buildIndex);
    await health.refresh();
    const identity = health.searchIndex;
    const before = built.length;
    const errors: string[] = [];
    const watcher = watchConfig(file, config => { void health.reload(config); }, { debounceMs: 20, onError: error => errors.push(error.message) });
    try {
      await writeFile(file, '{ "schemaVersion": 1,');
      expect(await waitFor(() => errors.length > 0)).toBe(true);
      expect(health.searchIndex).toBe(identity); // 旧索引继续可用
      expect(built.length).toBe(before); // 非法配置不触发重建
      expect(service.searchMachines({ query: 'first' }).map(hit => hit.machineId)).toEqual(['first']);
    } finally {
      watcher.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the old config and index when the builder throws, then recovers on the next reload', async () => {
    let failing = false;
    const buildIndex: SearchIndexBuilder = (documents, toDocument) => {
      if (failing) throw new Error('index build failed');
      return buildSearchIndex(documents, toDocument);
    };
    const initial = searchConfig([{ id: 'first', name: 'first', host: 'a@1.1.1.1:22' }]);
    initial.revision = 1;
    const { health, service } = setupIndexed(initial, buildIndex);
    await health.refresh();
    const configBefore = health.config;
    const indexBefore = health.searchIndex;

    const broken = searchConfig([{ id: 'second', name: 'second', host: 'b@2.2.2.2:22' }]);
    broken.revision = 2;
    failing = true;
    expect(() => health.reload(broken)).toThrowError('index build failed'); // 构建失败向上抛出
    expect(health.config).toBe(configBefore); // 配置保持旧引用
    expect(health.searchIndex).toBe(indexBefore); // 索引保持旧身份
    expect(service.searchMachines({ query: 'first' }).map(hit => hit.machineId)).toEqual(['first']); // 旧搜索仍正确
    expect(service.searchMachines({ query: 'second', showAll: true })).toEqual([]); // 新配置未生效

    failing = false;
    const fixed = searchConfig([{ id: 'second', name: 'second', host: 'b@2.2.2.2:22' }]);
    fixed.revision = 2;
    health.reload(fixed);
    expect(health.config).toBe(fixed);
    expect(health.searchIndex).not.toBe(indexBefore);
    expect(service.searchMachines({ query: 'second', showAll: true }).map(hit => hit.machineId)).toEqual(['second']);
  });

  it('scores exactly like the original rank formula, including the healthy-only subset corpus', async () => {
    const config = searchConfig([
      { id: 'alpha-node', name: 'alpha 研发', host: 'alice@10.0.0.5:22' },
      { id: 'beta-node', name: 'beta 测试', host: 'bob@10.0.0.6:22' },
      { id: 'gamma-box', name: 'gamma 研发', host: 'carol@10.0.0.7:22' },
    ]);
    const backend = new FakeBackend(context => context.machine.id === 'beta-node'
      ? { outcome: 'failure', reasonCode: 'COMMAND_FAILED' } : success);
    const { health, service } = setupIndexed(config, buildSearchIndex, backend);
    await health.refresh();
    const machines = health.config.machines;
    const toDocument = (machine: Machine) => ({ id: machine.id, name: machine.name, host: machine.host });
    // 全量语料：showAll=true 的候选集合。
    for (const query of ['node', '研发', '10.0.0.5', 'alpha beta', 'node node']) {
      expect(health.searchIndex.search(query, [0, 1, 2])).toEqual(rank(query, [...machines], toDocument));
    }
    // 过滤后子集语料：默认只搜 healthy，beta-node 被排除，IDF/avgdl 只按 [0,2] 计算。
    for (const query of ['node', '研发', 'alpha', 'gamma']) {
      const expected = rank(query, [machines[0], machines[2]], toDocument);
      expect(health.searchIndex.search(query, [0, 2])).toEqual(expected);
      expect(service.searchMachines({ query })).toEqual(expected.map(hit => ({
        machineId: hit.document.id, name: hit.document.name, host: hit.document.host, score: hit.score,
      })));
    }
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
  it('registers the four read-only tools and starts the service on demand', async () => {
    const { config, directory, file } = await daemonSetup();
    try {
      // 扩展加载时就会按配置拉起服务，所以配置必须在注册前生效。
      await withConfig(file, async () => {
        const tools: PiTool[] = [];
        computerBoardExtension({ registerTool: (tool: PiTool) => { tools.push(tool); } } as never);
        expect(tools.map(tool => tool.name)).toEqual(['list_machines', 'get_machine', 'get_software', 'search_machine']);
        expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
        expect(tools.every(tool => Boolean(tool.description))).toBe(true);
        // pi 入参 schema 必须暴露可选的 limit（正整数），且描述写明默认 3。
        const searchParameters = tools[3].parameters as { properties?: Record<string, { type?: string; minimum?: number }> };
        expect(searchParameters.properties?.limit).toMatchObject({ type: 'integer', minimum: 1 });
        expect(tools[3].description).toContain('3');

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

        const search = await tools[3].execute('call-6',
          { query: '本机' } as never, undefined, undefined, undefined as never);
        expect(payload(search)).toMatchObject([{ machineId: 'local', name: '本机', host: 'localhost' }]);

        // 显式 limit 经 HTTP 透传到服务端：limit=1 正常返回。
        const searchLimited = await tools[3].execute('call-7',
          { query: '本机', limit: 1 } as never, undefined, undefined, undefined as never);
        expect(payload(searchLimited)).toMatchObject([{ machineId: 'local', name: '本机', host: 'localhost' }]);
      });
    } finally {
      await stopDaemon(file);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forwards limit to the service over HTTP and omits it when unset', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const tools: PiTool[] = [];
      computerBoardExtension({ registerTool: (tool: PiTool) => { tools.push(tool); } } as never);
      const search = tools.find(tool => tool.name === 'search_machine')!;
      const call = (params: unknown) => search.execute('call', params as never, undefined, undefined, undefined as never);
      await call({ query: 'node', limit: 2 });
      await call({ query: 'node' });
      await call({ query: 'node', showAll: true });
      const bodies = calls.filter(entry => entry.url.endsWith('/api/query/machine/search')).map(entry => entry.body);
      expect(bodies).toEqual([
        { query: 'node', limit: 2 }, // 显式 limit 透传给服务端
        { query: 'node' }, // 省略时不下发 limit，由服务端兜底为 3
        { query: 'node', showAll: true },
      ]);
    } finally { globalThis.fetch = original; }
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
    const search = await app.inject({ method: 'POST', url: '/api/query/machine/search', payload: { query: '本机' } });
    expect(search.json()).toMatchObject([{ machineId: 'local', name: '本机', host: 'localhost', score: expect.any(Number) }]);
    const limited = await app.inject({ method: 'POST', url: '/api/query/machine/search', payload: { query: '本机', limit: 1 } });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toMatchObject([{ machineId: 'local' }]);
    for (const limit of [0, -1, 1.5, '2', null, true]) {
      expect((await app.inject({ method: 'POST', url: '/api/query/machine/search', payload: { query: '本机', limit } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/query/machine/search', payload: { query: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/query/machine/search', payload: { query: '本机', extra: 1 } })).statusCode).toBe(400);
  });

  it('exposes the four read-only tools and their usage notes over HTTP MCP', async () => {
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
      expect(tools.map(tool => tool.name).sort()).toEqual(['get_machine', 'get_software', 'list_machines', 'search_machine']);
      expect(tools.every(tool => Boolean(tool.description))).toBe(true);
      // MCP 的入参 schema 必须完整暴露 limit（可选、整数、正整数下限 minimum:1）。
      const searchSchema = tools.find(tool => tool.name === 'search_machine')!.inputSchema as {
        properties?: Record<string, { type?: string; minimum?: number }>; required?: string[];
      };
      expect(Object.keys(searchSchema.properties ?? {})).toEqual(expect.arrayContaining(['query', 'showAll', 'limit']));
      expect(searchSchema.properties?.limit).toMatchObject({ type: 'integer', minimum: 1 });
      expect(searchSchema.required ?? []).not.toContain('limit');
      const instructions = client.getInstructions() ?? '';
      for (const note of ['只读', 'showAll', 'get_machine', 'degraded', 'AMBIGUOUS']) expect(instructions).toContain(note);
      expect(instructions).toContain('limit');
      const list = await client.callTool({ name: 'list_machines', arguments: {} });
      expect(JSON.parse((list.content as { text: string }[])[0].text)[0].software)
        .toEqual([{ name: 'Node.js' }, { name: 'Docker' }, { name: 'CodeBuddy' }, { name: 'Blender' }]);
      const machine = await client.callTool({ name: 'get_machine', arguments: { machine: { host: 'localhost' } } });
      expect(machine.structuredContent).toMatchObject({ machineId: 'local' });
      const error = await client.callTool({ name: 'get_machine', arguments: { machine: { machineId: 'no' } } });
      expect(error.isError).toBe(true);
      expect(JSON.parse((error.content as { text: string }[])[0].text).error.code).toBe('NOT_FOUND');
      const search = await client.callTool({ name: 'search_machine', arguments: { query: '本机' } });
      expect(JSON.parse((search.content as { text: string }[])[0].text)[0])
        .toMatchObject({ machineId: 'local', name: '本机', host: 'localhost' });
      const searchAll = await client.callTool({ name: 'search_machine', arguments: { query: 'remote', showAll: true } });
      expect(JSON.parse((searchAll.content as { text: string }[])[0].text)[0])
        .toMatchObject({ machineId: 'remote', status: 'disabled' });
      const searchLimited = await client.callTool({ name: 'search_machine', arguments: { query: '本机', limit: 1 } });
      expect(JSON.parse((searchLimited.content as { text: string }[])[0].text))
        .toMatchObject([{ machineId: 'local', name: '本机', host: 'localhost' }]);
      // 严格 schema 在 MCP 入参校验阶段即拒绝（空/纯空白、错误类型、非法 limit、未知字段），合法调用照常返回。
      for (const args of [
        { query: '' }, { query: '   ' }, { query: '本机', extra: 1 }, { query: 42 }, { query: '本机', showAll: 'yes' },
        { query: '本机', limit: 0 }, { query: '本机', limit: -1 }, { query: '本机', limit: 1.5 },
        { query: '本机', limit: '2' }, { query: '本机', limit: null }, { query: '本机', limit: true },
      ]) {
        const invalid = await client.callTool({ name: 'search_machine', arguments: args });
        expect(invalid.isError).toBe(true);
      }
    } finally { await client.close(); }
  });
});
