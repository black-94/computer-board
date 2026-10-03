import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthView, MachineDetail, MachineList, SoftwareDetail } from '../../shared/api.js';
import './style.css';

type MachineSelector = { machineId: string } | { host: string };
type Candidate = { machineId: string; name: string; host: string };

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) {
    const failure = new Error(data.error?.message ?? `HTTP ${response.status}`) as Error & { candidates?: Candidate[] };
    failure.candidates = data.error?.candidates;
    throw failure;
  }
  return data;
}

const LABELS: Record<string, string> = { healthy: '探活成功', degraded: '异常', unhealthy: '不可用', unknown: '未检查', disabled: '已停用' };
function Badge({ health, status }: { health?: HealthView; status?: string }) {
  const value = health?.status ?? status ?? 'unknown';
  return <span className={`badge ${value}`} title={health?.reasonCode ?? ''}>{LABELS[value] ?? value}</span>;
}
function Text({ value }: { value?: string }) {
  return value ? <p style={{ whiteSpace: 'pre-wrap' }}>{value}</p> : <span className="hint">无</span>;
}
function Tips({ values }: { values?: string[] }) {
  return values?.length ? <ul className="tips">{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <span className="hint">无</span>;
}
function CheckList({ checks }: { checks: MachineDetail['healthChecks'] }) {
  if (!checks.length) return <p className="hint">未配置探活检查，状态保持未检查。</p>;
  return <div className="checks">{checks.map((check, index) => <div className="check" key={index}>
    <div className="row"><strong>{check.type}</strong><Badge health={check.health} /></div>
    <p className="sub">{check.required ? '必需' : '可选'}{check.command ? ` · ${[check.command, ...(check.args ?? [])].join(' ')}` : ''}</p>
    {check.health.checkedAt && <p className="sub">最近检查：{new Date(check.health.checkedAt).toLocaleString()}　最近成功：{check.health.lastSuccessAt ? new Date(check.health.lastSuccessAt).toLocaleString() : '无'}　{check.health.reasonCode ?? ''}</p>}
  </div>)}</div>;
}
function App() {
  const [showAll, setShowAll] = useState(false);
  const [list, setList] = useState<MachineList>([]);
  const [machine, setMachine] = useState<MachineDetail>();
  const [software, setSoftware] = useState<SoftwareDetail>();
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const load = async (all = showAll) => {
    setError('');
    try { setList(await request<MachineList>(`/api/discovery?showAll=${all}`)); }
    catch (e) { setError(String(e)); }
  };
  useEffect(() => { void load(showAll); }, [showAll]);
  const openMachine = async (selector: MachineSelector) => {
    setError(''); setCandidates([]); setSoftware(undefined);
    try { setMachine(await request<MachineDetail>('/api/query/machine', { machine: selector })); }
    catch (e) {
      setError(String(e));
      const list = (e as Error & { candidates?: Candidate[] }).candidates;
      setCandidates(list?.some(candidate => candidate.machineId) ? list : []);
      setMachine(undefined);
    }
  };
  const selectMachine = async (host: string) => { setBusy(true); await openMachine({ host }); setBusy(false); };
  const selectSoftware = async (host: string, name: string) => {
    setBusy(true); setError(''); setCandidates([]);
    try { setSoftware(await request<SoftwareDetail>('/api/query/software', { machine: { host }, software: { name } })); setMachine(undefined); }
    catch (e) {
      const message = String(e);
      // 列表里只有软件名；同名时先打开机器详情，用稳定 ID 再查。
      if (message.includes('softwareId')) { try { await openMachine({ host }); } catch { /* 保留原始错误 */ } setError(message); }
      else setError(message);
    } finally { setBusy(false); }
  };
  const selectSoftwareById = async (machineId: string, softwareId: string) => {
    setBusy(true); setError('');
    try { setSoftware(await request<SoftwareDetail>('/api/query/software', { machine: { machineId }, software: { softwareId } })); setMachine(undefined); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true); setError('');
    try {
      await request('/api/health/refresh', {});
      await load();
      if (machine) setMachine(await request<MachineDetail>('/api/query/machine', { machine: { machineId: machine.machineId } }));
      if (software) setSoftware(await request<SoftwareDetail>('/api/query/software', { machine: { machineId: software.machine.machineId }, software: { softwareId: software.softwareId } }));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="shell">
    <header><div><p className="eyebrow">COMPUTER BOARD</p><h1>机器与软件环境</h1><p className="sub">展示手工登记的机器与软件、接入说明和探活状态。查询是只读的，不会执行任何业务操作。</p></div>
      <button disabled={busy} onClick={() => void refresh()}>重新探活</button></header>
    <main><aside className="panel sidebar"><div className="row"><h2>机器列表</h2><label className="switch"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> 显示全部</label></div>
      <p className="hint">{showAll ? '显示全部已登记资源及状态' : '仅展示探活成功的机器和软件'}</p>
      {list.length === 0 && <p className="empty">{busy ? '正在加载…' : '暂无可用机器。可切换「显示全部」。'}</p>}
      {list.map((item, index) => <div className="machine" key={`${item.host}:${index}`}>
        <div className="row"><button className="link mainlink" onClick={() => void selectMachine(item.host)}>{item.name}</button><Badge status={item.status} /></div>
        <p className="sub mono">{item.host}</p>
        <div className="chips">{item.software.map((entry, i) => <button className="chip" key={i} onClick={() => void selectSoftware(item.host, entry.name)}>{entry.name} <Badge status={entry.status} /></button>)}</div>
      </div>)}</aside>
      <section className="panel detail">{error && <div className="error" role="alert">{error}</div>}
        {candidates.length > 0 && <div className="chips">{candidates.map(candidate => <button className="chip" key={candidate.machineId} onClick={() => void openMachine({ machineId: candidate.machineId })}>{candidate.name} · {candidate.host} · {candidate.machineId}</button>)}</div>}
        {!machine && !software && <div className="welcome"><div className="icon">⌘</div><h2>选择一台机器或一款软件</h2><p className="sub">机器详情显示用途、使用说明与探活；软件详情显示能力、接入方式、注意事项与探活。</p></div>}
        {machine && <><div className="row"><div><p className="eyebrow">MACHINE</p><h2>{machine.name}</h2></div><Badge health={machine.health} /></div>
          <p className="mono">{machine.host} · {machine.machineId} · {machine.enabled ? '已启用' : '已停用'}</p>
          <h3>描述</h3><Text value={machine.desc} />
          <h3>使用说明</h3><Text value={machine.instruction} />
          <h3>注意事项</h3><Tips values={machine.tips} />
          <h3>依赖</h3><Text value={machine.dependOn} />
          <h3>探活检查</h3><CheckList checks={machine.healthChecks} />
          <h3>软件</h3><div className="chips">{machine.software.map(entry => <button className="chip" key={entry.softwareId} onClick={() => void selectSoftwareById(machine.machineId, entry.softwareId)}>{entry.name}</button>)}</div></>}
        {software && <><div className="row"><div><p className="eyebrow">SOFTWARE · {software.machine.name}</p><h2>{software.name}</h2></div><Badge health={software.health} /></div>
          <p className="sub mono">{software.softwareId} · {software.enabled ? '已启用' : '已停用'}{software.observedVersion ? ` · 已观测 ${software.observedVersion}` : ''}</p>
          <h3>描述</h3><Text value={software.desc} />
          <h3>接入方式</h3><Text value={software.instruction} />
          <h3>注意事项</h3><Tips values={software.tips} />
          <h3>软件依赖</h3><Text value={software.dependOn} />
          <h3>所属机器</h3><div className="info"><p className="mono">{software.machine.host}</p><Text value={software.machine.instruction} /></div>
          <h3>探活检查</h3><CheckList checks={software.healthChecks} /></>}
      </section></main><footer>Computer Board · JSON 配置 · local / bash 探活 · 只读</footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
