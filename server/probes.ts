import { execFile } from 'node:child_process';
import type { HealthCheck, Machine, Software } from '../shared/schema.js';

export type ProbeContext = { machine: Machine; software?: Software; check: HealthCheck; timeoutMs: number };
export type ProbeResult = { outcome: 'success' | 'failure'; reasonCode?: string; latencyMs?: number; observedVersion?: string };
export interface ProbeBackend { run(context: ProbeContext): Promise<ProbeResult> }

export class ProbeError extends Error {
  constructor(public code: string) { super(code); }
}

const MAX_OUTPUT = 64 * 1024;
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/;

function runCommand(command: string, args: string[], signal: AbortSignal) {
  return new Promise<{ code: number; stdout: string }>((resolveResult, reject) => {
    execFile(command, args, { signal, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (error, stdout) => {
      if (signal.aborted) { reject(new ProbeError('PROBE_TIMEOUT')); return; }
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === 'number') resolveResult({ code, stdout });
        else reject(new ProbeError(code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'OUTPUT_LIMIT' : 'COMMAND_FAILED'));
      } else resolveResult({ code: 0, stdout });
    });
  });
}

export class DefaultProbeBackend implements ProbeBackend {
  async run({ check, timeoutMs }: ProbeContext): Promise<ProbeResult> {
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const observedVersion = await this.execute(check, controller.signal);
      return { outcome: 'success', latencyMs: Math.round(performance.now() - start), ...(observedVersion ? { observedVersion } : {}) };
    } catch (error) {
      const reasonCode = controller.signal.aborted ? 'PROBE_TIMEOUT' : error instanceof ProbeError ? error.code : 'PROBE_FAILED';
      return { outcome: 'failure', reasonCode, latencyMs: Math.round(performance.now() - start) };
    } finally { clearTimeout(timer); }
  }
  private async execute(check: HealthCheck, signal: AbortSignal) {
    if (check.type === 'local') return;
    const result = await runCommand(check.command, check.args, signal);
    if (result.code !== 0) throw new ProbeError('COMMAND_FAILED');
    if (!check.args.includes('--version') && !check.args.includes('-v')) return;
    return VERSION_PATTERN.exec(result.stdout)?.[0];
  }
}
