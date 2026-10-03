import { z } from 'zod';

const text = z.string().min(1).regex(/\S/, '不能仅包含空白');
const seconds = z.number().positive().finite();
const port = z.number().int().min(1).max(65535);

/** tips 允许写单个字符串或字符串数组，统一归一为数组。 */
const tipsSchema = z.union([text, z.array(text)]).transform(value => typeof value === 'string' ? [value] : value);

const sshHostPattern = /^([^\s@:/]+)@(\[[^\]]+\]|[^\s@:]+):([0-9]+)$/;
export function parseMachineHost(host: string): { hostname: string; username: string; port: number } | undefined {
  const match = sshHostPattern.exec(host);
  if (!match) return undefined;
  const hostname = match[2].startsWith('[') ? match[2].slice(1, -1) : match[2];
  if (!z.string().ip({ version: match[2].startsWith('[') ? 'v6' : 'v4' }).safeParse(hostname).success) return undefined;
  const parsed = port.safeParse(Number(match[3]));
  return parsed.success ? { hostname, username: match[1], port: parsed.data } : undefined;
}
export const machineHostSchema = text.refine(value => value === 'localhost' || parseMachineHost(value) !== undefined,
  'host 必须是 localhost 或 account@ip:port（IPv6 使用方括号）');

export const checkTypeSchema = z.enum(['local', 'bash']);
export type CheckType = z.infer<typeof checkTypeSchema>;

const checkBase = {
  required: z.boolean(),
  intervalSeconds: seconds.optional(),
  timeoutSeconds: seconds.optional(),
  failureThreshold: z.number().int().positive().optional(),
};
export const healthCheckSchema = z.discriminatedUnion('type', [
  z.object({ ...checkBase, type: z.literal('local') }).strict(),
  z.object({ ...checkBase, type: z.literal('bash'), command: text, args: z.array(z.string()) }).strict(),
]);
export type HealthCheck = z.infer<typeof healthCheckSchema>;

const softwareSchema = z.object({
  id: text, name: text, desc: z.string(), instruction: z.string(), tips: tipsSchema,
  enabled: z.boolean(), dependOn: z.string(), healthChecks: z.array(healthCheckSchema),
}).strict();
const machineSchema = z.object({
  id: text, name: text, host: machineHostSchema, desc: z.string(), instruction: z.string(), tips: tipsSchema,
  enabled: z.boolean(), dependOn: z.string(), healthChecks: z.array(healthCheckSchema), software: z.array(softwareSchema),
}).strict();
const defaultsSchema = z.object({
  intervalSeconds: seconds, timeoutSeconds: seconds, failureThreshold: z.number().int().positive(),
  maxConcurrency: z.number().int().min(1).max(100),
}).strict();
const serverSchema = z.object({
  host: text, port, path: text.regex(/^\//, 'path 必须以 / 开头'),
}).strict();
const rawBoardSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  server: serverSchema, defaults: defaultsSchema, machines: z.array(machineSchema),
}).strict();
export type BoardConfig = z.infer<typeof rawBoardSchema>;
export type Machine = z.infer<typeof machineSchema>;
export type Software = z.infer<typeof softwareSchema>;
export type Defaults = z.infer<typeof defaultsSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;

export const boardConfigSchema = rawBoardSchema.superRefine((config, ctx) => {
  const ids = new Set<string>();
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const unique = (id: string, path: (string | number)[]) => {
    if (ids.has(id)) issue(path, '机器与软件 ID 必须全局唯一');
    ids.add(id);
  };
  if (config.machines.filter(machine => machine.host === 'localhost').length > 1) issue(['machines'], '最多一台 localhost 机器');
  config.machines.forEach((machine, mi) => {
    const mp = ['machines', mi];
    unique(machine.id, [...mp, 'id']);
    machine.healthChecks.forEach((check, ci) => {
      if (check.type === 'local' && machine.host !== 'localhost') issue([...mp, 'healthChecks', ci, 'type'], 'local 检查只能用于 localhost 机器');
    });
    machine.software.forEach((software, si) => {
      const sp = [...mp, 'software', si];
      unique(software.id, [...sp, 'id']);
      software.healthChecks.forEach((check, ci) => {
        if (check.type === 'local') issue([...sp, 'healthChecks', ci, 'type'], 'local 检查不能用于软件');
      });
    });
  });
});

export const listMachinesInputSchema = z.object({ showAll: z.boolean().optional() }).strict();
export const machineSelectorSchema = z.union([
  z.object({ machineId: text }).strict(),
  z.object({ host: text }).strict(),
]);
export const softwareSelectorSchema = z.union([
  z.object({ softwareId: text }).strict(),
  z.object({ name: text }).strict(),
]);
export const getMachineInputSchema = z.object({ machine: machineSelectorSchema }).strict();
export const getSoftwareInputSchema = z.object({ machine: machineSelectorSchema, software: softwareSelectorSchema }).strict();
export type MachineSelector = z.infer<typeof machineSelectorSchema>;
export type SoftwareSelector = z.infer<typeof softwareSelectorSchema>;
