import fp from 'fastify-plugin';
import { BigQuery } from '@google-cloud/bigquery';
import { env } from '../config/env.js';

async function bigqueryPlugin(fastify) {
  const bq = new BigQuery({ projectId: env.GCP_PROJECT_ID });
  // Break encapsulation so fastify.bq is visible to all sibling plugins and routes
  fastify.decorate('bq', bq);
  fastify.log.info({ projectId: env.GCP_PROJECT_ID }, 'BigQuery client ready');
}

export default fp(bigqueryPlugin, { name: 'bigquery' });
