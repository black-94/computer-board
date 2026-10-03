import { z } from 'zod';
import {
  getMachineInputSchema, getSoftwareInputSchema, listMachinesInputSchema,
  type Machine, type MachineSelector, type Software, type SoftwareSelector,
} from '../shared/schema.js';
import type { CheckView, MachineDetail, MachineList, MachineView, SoftwareDetail, SoftwareView } from '../shared/api.js';
import { HealthEngine } from './health.js';
import { QueryError } from './errors.js';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new QueryError('INVALID_ARGUMENT', result.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
  return result.data;
}

export class BoardService {
  constructor(readonly health: HealthEngine) {}
  private findMachine(selector: MachineSelector): Machine {
    const matches = this.health.config.machines.filter(machine =>
      'machineId' in selector ? machine.id === selector.machineId : machine.host === selector.host);
    if (!matches.length) throw new QueryError('NOT_FOUND', '未找到机器');
    if (matches.length > 1) throw new QueryError('AMBIGUOUS', '存在多台同 host 机器，请用 machineId 精确查询。',
      matches.map(machine => ({ machineId: machine.id, name: machine.name, host: machine.host })));
    return matches[0];
  }
  private findSoftware(machine: Machine, selector: SoftwareSelector): Software {
    const matches = machine.software.filter(software =>
      'softwareId' in selector ? software.id === selector.softwareId : software.name === selector.name);
    if (!matches.length) throw new QueryError('NOT_FOUND', '指定机器上未找到软件');
    if (matches.length > 1) throw new QueryError('AMBIGUOUS', '存在同名软件，请用 softwareId 精确查询。',
      matches.map(software => ({ softwareId: software.id, name: software.name })));
    return matches[0];
  }
  listMachines(input: unknown = {}): MachineList {
    const { showAll = false } = parse(listMachinesInputSchema, input);
    return this.health.config.machines.flatMap(machine => {
      const health = this.health.machineView(machine);
      if (!showAll && health.status !== 'healthy') return [];
      return [{
        name: machine.name, host: machine.host,
        ...(showAll ? { status: health.status } : {}),
        software: machine.software.flatMap(software => {
          const state = this.health.softwareView(machine, software);
          return !showAll && state.status !== 'healthy' ? [] : [{ name: software.name, ...(showAll ? { status: state.status } : {}) }];
        }),
      }];
    });
  }
  private machineView(machine: Machine): MachineView {
    return {
      machineId: machine.id, name: machine.name, host: machine.host,
      ...(machine.desc ? { desc: machine.desc } : {}),
      ...(machine.instruction ? { instruction: machine.instruction } : {}),
      ...(machine.tips.length ? { tips: [...machine.tips] } : {}),
      ...(machine.dependOn ? { dependOn: machine.dependOn } : {}),
      enabled: machine.enabled, health: this.health.machineView(machine),
    };
  }
  private softwareView(machine: Machine, software: Software): SoftwareView {
    const observedVersion = this.health.observedVersion(software);
    return {
      softwareId: software.id, name: software.name,
      ...(software.desc ? { desc: software.desc } : {}),
      ...(software.instruction ? { instruction: software.instruction } : {}),
      ...(software.tips.length ? { tips: [...software.tips] } : {}),
      ...(software.dependOn ? { dependOn: software.dependOn } : {}),
      enabled: software.enabled,
      ...(observedVersion ? { observedVersion } : {}),
      health: this.health.softwareView(machine, software),
    };
  }
  private checkViews(machine: Machine, software?: Software): CheckView[] {
    return (software?.healthChecks ?? machine.healthChecks).map((check, index) => ({
      type: check.type,
      required: check.required,
      ...(check.type === 'bash' ? { command: check.command, ...(check.args.length ? { args: [...check.args] } : {}) } : {}),
      health: this.health.checkView(machine, software, index),
    }));
  }
  getMachine(input: unknown): MachineDetail {
    const args = parse(getMachineInputSchema, input);
    const machine = this.findMachine(args.machine);
    return {
      revision: this.health.config.revision, ...this.machineView(machine), healthChecks: this.checkViews(machine),
      software: machine.software.map(software => ({ softwareId: software.id, name: software.name })),
    };
  }
  getSoftware(input: unknown): SoftwareDetail {
    const args = parse(getSoftwareInputSchema, input);
    const machine = this.findMachine(args.machine);
    const software = this.findSoftware(machine, args.software);
    return {
      revision: this.health.config.revision, machine: this.machineView(machine),
      ...this.softwareView(machine, software), healthChecks: this.checkViews(machine, software),
    };
  }
}
