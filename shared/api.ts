import type { CheckType } from './schema.js';

export type Status = 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'disabled';

/** 探活状态；没有产生的字段（未检查、未成功、无耗时）不返回。 */
export type HealthView = {
  status: Status;
  checkedAt?: string;
  lastSuccessAt?: string;
  reasonCode?: string;
  latencyMs?: number;
};

/** 列表只返回定位字段，说明文本和探活细节走详情接口。 */
export type SoftwareSummary = { name: string; status?: Status };
export type MachineSummary = { name: string; host: string; status?: Status; software: SoftwareSummary[] };
export type MachineList = MachineSummary[];

/** 机器搜索结果：只返回定位字段与 BM25 分数；showAll 时附 status。 */
export type MachineSearchHit = { machineId: string; name: string; host: string; score: number; status?: Status };

/** 单条探活配置的公开信息与状态；为空的可选字段不返回。 */
export type CheckView = { type: CheckType; required: boolean; command?: string; args?: string[]; health: HealthView };

export type MachineView = {
  machineId: string; name: string; host: string;
  desc?: string; instruction?: string; tips?: string[]; dependOn?: string;
  enabled: boolean; health: HealthView;
};
export type SoftwareView = {
  softwareId: string; name: string;
  desc?: string; instruction?: string; tips?: string[]; dependOn?: string;
  enabled: boolean; observedVersion?: string; health: HealthView;
};
export type MachineDetail = MachineView & {
  revision: number; healthChecks: CheckView[]; software: { softwareId: string; name: string }[];
};
export type SoftwareDetail = SoftwareView & {
  revision: number; machine: MachineView; healthChecks: CheckView[];
};

export type QueryErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'AMBIGUOUS' | 'INTERNAL_ERROR';
export type QueryErrorBody = { error: { code: QueryErrorCode; message: string; candidates?: Record<string, unknown>[] } };
