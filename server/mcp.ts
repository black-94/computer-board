import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { listMachinesInputSchema, machineSelectorSchema, searchMachineInputSchema, softwareSelectorSchema } from '../shared/schema.js';
import { BoardService } from './service.js';
import { queryError } from './errors.js';

/** 随 initialize 返回的使用说明：服务边界、返回约定、状态含义与错误码。 */
const instructions = [
  'computer-board 提供手工维护的机器与软件清单、接入说明与探活状态，只有只读查询。',
  '服务不执行任何业务操作，不做 SSH 或端口转发，不修改配置；instruction 与 tips 是需要执行时由调用方自行判断的说明文本。',
  '返回约定：只返回配置中确实存在的字段，空字符串、空数组、未设置的字段一律省略；列表只返回 name、host 与软件名，说明文本与探活细节请调用 get_machine / get_software；默认只列出探活成功的机器与软件，showAll=true 返回全部并为每项附 status；查询只读内存缓存，不触发探活。',
  '搜索：search_machine 按关键词在机器 id、name、host 上做 BM25 相关性搜索并按分数降序返回（score 为正的有限值，同分保持配置顺序），只返回得分最高的前 limit 条（limit 省略时为 3，须为正整数，不设人为上限）；默认只搜探活成功的机器，showAll=true 搜索全部并附 status；不搜索 desc、instruction、software 等字段；无匹配返回空数组。',
  '状态：healthy 最近一次检查成功；degraded 失败但未达阈值；unhealthy 失败已达到阈值；unknown 未检查或未配置检查；disabled 已停用。',
  '错误：返回 { error: { code, message } }，code 为 INVALID_ARGUMENT、NOT_FOUND、AMBIGUOUS（命中多个资源，candidates 中给出 machineId / softwareId）、INTERNAL_ERROR。',
].join('\n');

function createMcpServer(service: BoardService) {
  const server = new McpServer({ name: 'computer-board', version: '1.0.0' }, { instructions });
  server.registerTool('list_machines', {
    description: '机器和软件列表：返回 name、host 与软件名。默认只列探活成功项，showAll=true 时列出全部并附带 status。',
    inputSchema: listMachinesInputSchema.shape,
  }, ({ showAll }) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(service.listMachines({ showAll })) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(queryError(error).body()) }] }; }
  });
  server.registerTool('search_machine', {
    description: '按关键词在机器 id、name、host 上做 BM25 相关性搜索并按分数降序返回，返回得分最高的前 limit 条（limit 省略时为 3，须为正整数，不设上限）。默认只搜探活成功的机器，showAll=true 搜索全部并附 status；无匹配返回空数组。',
    // 传完整 schema（而非 .shape）以保留 strict：SDK 会用它做入参校验，拒绝空/纯空白、错误类型、非法 limit 与未知字段。
    inputSchema: searchMachineInputSchema,
    annotations: { readOnlyHint: true },
  }, ({ query, showAll, limit }) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(service.searchMachines({ query, showAll, limit })) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(queryError(error).body()) }] }; }
  });
  server.registerTool('get_machine', {
    description: '按 machineId 或 host 精确查询单台机器的用途、使用说明、注意事项、依赖、探活状态和软件索引。',
    inputSchema: { machine: machineSelectorSchema },
  }, ({ machine: selector }) => {
    try {
      const result = service.getMachine({ machine: selector });
      return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(queryError(error).body()) }] }; }
  });
  server.registerTool('get_software', {
    description: '按机器及软件精确查询单个软件的能力、接入方式、注意事项、依赖、观测版本、探活状态和所属机器。',
    inputSchema: { machine: machineSelectorSchema, software: softwareSelectorSchema },
  }, ({ machine: selector, software: target }) => {
    try {
      const result = service.getSoftware({ machine: selector, software: target });
      return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(queryError(error).body()) }] }; }
  });
  return server;
}

export async function handleMcpHttp(service: BoardService, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const server = createMcpServer(service);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 64 * 1024 });
  await server.connect(transport);
  try { await transport.handleRequest(req, res, body); }
  finally { await server.close(); }
}
