import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { BoardService } from './service.js';
import { QueryError, queryError } from './errors.js';
import { handleMcpHttp } from './mcp.js';

export async function buildServer(service: BoardService, options: { staticFiles?: boolean } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    const problem = error instanceof QueryError ? error :
      (error instanceof z.ZodError ? new QueryError('INVALID_ARGUMENT', error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')) : queryError(error));
    reply.code(problem.statusCode).send(problem.body());
  });
  app.get('/api/discovery', request => {
    const params = request.query as Record<string, unknown>;
    if (Object.keys(params).some(k => k !== 'showAll') || (params.showAll !== undefined && params.showAll !== 'true' && params.showAll !== 'false')) {
      throw new QueryError('INVALID_ARGUMENT', 'showAll 只能是 true 或 false');
    }
    return service.listMachines({ showAll: params.showAll === 'true' });
  });
  app.post('/api/query/machine', request => service.getMachine(request.body));
  app.post('/api/query/software', request => service.getSoftware(request.body));
  app.post('/api/health/refresh', async request => {
    if (request.body && Object.keys(request.body as object).length) throw new QueryError('INVALID_ARGUMENT', '不接受临时检查参数');
    await service.health.refresh();
    return { revision: service.health.config.revision, refreshed: true };
  });
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: async (request, reply) => {
    reply.hijack();
    await handleMcpHttp(service, request.raw, reply.raw, request.body);
  } });
  if (options.staticFiles !== false && existsSync(resolve('dist/web'))) {
    await app.register(fastifyStatic, { root: resolve('dist/web'), prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/mcp') reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      else reply.sendFile('index.html');
    });
  }
  return app;
}
