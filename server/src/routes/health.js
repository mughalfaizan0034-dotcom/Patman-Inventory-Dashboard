export async function healthRoutes(fastify) {
  fastify.get('/health', { logLevel: 'warn' }, async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/health/ready', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await fastify.bq.query({ query: 'SELECT 1' });
      return { status: 'ok', bigquery: 'reachable', timestamp: new Date().toISOString() };
    } catch (err) {
      request.log.error({ err }, 'Readiness check failed');
      return reply.code(503).send({ status: 'error', bigquery: 'unreachable' });
    }
  });
}
