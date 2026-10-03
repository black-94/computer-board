import type { BoardConfig, HealthCheck, Machine, Software } from '../shared/schema.js';
import type { HealthView, Status } from '../shared/api.js';
import { DefaultProbeBackend, type ProbeBackend, type ProbeResult } from './probes.js';

const unknownHealth = (reasonCode?: string): HealthView => ({ status: 'unknown', ...(reasonCode ? { reasonCode } : {}) });
const disabledHealth = (): HealthView => ({ status: 'disabled', reasonCode: 'DISABLED' });
const worstFirst: Status[] = ['unhealthy', 'degraded', 'unknown', 'healthy'];

type CheckState = { result: ProbeResult; checkedAt: number; lastSuccessAt?: number; failures: number; nextAt: number };
type Job = { machine: Machine; software?: Software; check: HealthCheck; index: number };
/** 机器与软件的 ID 全局唯一，因此 ownerId 加下标即可定位一条探活结果。 */
const keyOf = (ownerId: string, index: number) => `${ownerId}:${index}`;

export class HealthEngine {
  private states = new Map<string, CheckState>();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(public config: BoardConfig, private backend: ProbeBackend = new DefaultProbeBackend(), private now: () => number = Date.now) {}
  /** 配置里仍然存在的探活结果 key；其余（被删掉的机器或软件）在重载时清理。 */
  private liveKeys(config = this.config) {
    const keys = new Set<string>();
    for (const machine of config.machines) {
      machine.healthChecks.forEach((_, index) => keys.add(keyOf(machine.id, index)));
      for (const software of machine.software) software.healthChecks.forEach((_, index) => keys.add(keyOf(software.id, index)));
    }
    return keys;
  }
  /**
   * 热重载：换上新配置并立刻按新配置重跑一轮探活，未改动项沿用已有结果与失败计数。
   * 调用方负责只传入校验通过的配置。换配置本身不等探活，调用返回时新配置已经生效；
   * 重跑要等上一轮结束后才开始，否则新旧两轮会并发写同一批结果。
   */
  reload(config: BoardConfig) {
    const previous = this.active;
    this.config = config;
    const live = this.liveKeys(config);
    for (const key of this.states.keys()) if (!live.has(key)) this.states.delete(key);
    void (async () => {
      if (previous) await previous.catch(() => undefined);
      await this.refresh(true);
    })().catch(() => undefined);
  }
  policy(check: HealthCheck) {
    return {
      intervalSeconds: check.intervalSeconds ?? this.config.defaults.intervalSeconds,
      timeoutSeconds: check.timeoutSeconds ?? this.config.defaults.timeoutSeconds,
      failureThreshold: check.failureThreshold ?? this.config.defaults.failureThreshold,
    };
  }
  async start() {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh(false); }, 250);
    this.timer.unref();
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.active; }
  refresh(force = true): Promise<void> {
    if (this.active) return this.active;
    this.active = this.performRefresh(force).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async runJobs(jobs: Job[], force: boolean) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const { machine, software, check, index } = jobs[cursor++];
        if (!machine.enabled || (software && !software.enabled)) continue;
        const key = keyOf(software?.id ?? machine.id, index);
        const previous = this.states.get(key);
        if (!force && previous && previous.nextAt > this.now()) continue;
        const policy = this.policy(check);
        let result: ProbeResult;
        try { result = await this.backend.run({ machine, software, check, timeoutMs: policy.timeoutSeconds * 1000 }); }
        catch { result = { outcome: 'failure', reasonCode: 'PROBE_FAILED' }; }
        const now = this.now();
        this.states.set(key, {
          result, checkedAt: now,
          lastSuccessAt: result.outcome === 'success' ? now : previous?.lastSuccessAt,
          failures: result.outcome === 'success' ? 0 : (previous?.failures ?? 0) + 1,
          nextAt: now + policy.intervalSeconds * 1000 * (0.9 + Math.random() * 0.2),
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs.length, this.config.defaults.maxConcurrency) }, worker));
  }
  private async performRefresh(force: boolean) {
    await this.runJobs(this.config.machines.flatMap(machine => machine.healthChecks.map((check, index) => ({ machine, check, index }))), force);
    await this.runJobs(this.config.machines.flatMap(machine => machine.software.flatMap(software =>
      software.healthChecks.map((check, index) => ({ machine, software, check, index })))), force);
  }
  checkView(machine: Machine, software: Software | undefined, index: number): HealthView {
    if (!machine.enabled || (software && !software.enabled)) return disabledHealth();
    const check = (software?.healthChecks ?? machine.healthChecks)[index];
    const state = this.states.get(keyOf(software?.id ?? machine.id, index));
    if (!state) return unknownHealth();
    const times = {
      checkedAt: new Date(state.checkedAt).toISOString(),
      ...(state.lastSuccessAt !== undefined ? { lastSuccessAt: new Date(state.lastSuccessAt).toISOString() } : {}),
      ...(state.result.latencyMs !== undefined ? { latencyMs: state.result.latencyMs } : {}),
    };
    if (state.result.outcome === 'success') return { ...times, status: 'healthy' };
    return {
      ...times, reasonCode: state.result.reasonCode,
      status: state.failures >= this.policy(check).failureThreshold ? 'unhealthy' : 'degraded',
    };
  }
  private aggregate(checks: HealthCheck[], views: HealthView[]): HealthView {
    if (!views.length) return unknownHealth();
    const required = views.filter((_, index) => checks[index].required);
    const primary = required.length ? required : views;
    const status = worstFirst.find(candidate => primary.some(view => view.status === candidate)) ?? 'unknown';
    const source = primary.find(view => view.status === status);
    const checked = views.flatMap(view => view.checkedAt ? [view.checkedAt] : []);
    const successes = primary.flatMap(view => view.lastSuccessAt ? [view.lastSuccessAt] : []);
    return {
      status,
      ...(checked.length ? { checkedAt: checked.sort().at(-1) } : {}),
      ...(successes.length === primary.length ? { lastSuccessAt: successes.sort()[0] } : {}),
      ...(source?.reasonCode ? { reasonCode: source.reasonCode } : {}),
    };
  }
  private checksView(machine: Machine, software: Software | undefined): HealthView {
    const checks = software?.healthChecks ?? machine.healthChecks;
    return this.aggregate(checks, checks.map((_, index) => this.checkView(machine, software, index)));
  }
  machineView(machine: Machine): HealthView {
    if (!machine.enabled) return disabledHealth();
    return this.checksView(machine, undefined);
  }
  softwareView(machine: Machine, software: Software): HealthView {
    if (!machine.enabled || !software.enabled) return disabledHealth();
    return this.checksView(machine, software);
  }
  observedVersion(software: Software) {
    return software.healthChecks.map((_, index) => this.states.get(keyOf(software.id, index))?.result.observedVersion).find(Boolean);
  }
}
