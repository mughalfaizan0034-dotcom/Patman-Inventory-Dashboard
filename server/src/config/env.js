import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name, defaultValue = '') {
  return process.env[name] ?? defaultValue;
}

export const env = {
  PORT:     parseInt(optional('PORT', '8080'), 10),
  NODE_ENV: optional('NODE_ENV', 'development'),

  GCP_PROJECT_ID: required('GCP_PROJECT_ID'),

  JWT_SECRET:          required('JWT_SECRET'),
  JWT_ACCESS_EXPIRES:  optional('JWT_ACCESS_EXPIRES',  '2h'),
  JWT_REFRESH_EXPIRES: optional('JWT_REFRESH_EXPIRES', '7d'),

  LOG_LEVEL: optional('LOG_LEVEL', 'info'),

  // Comma-separated list of EXTRA allowed origins. The production
  // GitHub Pages frontend is hardcoded in server.js so it cannot be
  // dropped by a missing/misconfigured Cloud Run env var. Use this
  // env for dev (e.g. http://localhost:3000) or preview deployments.
  // The literal string '*' enables the dev-only wildcard.
  CORS_ORIGIN: optional('CORS_ORIGIN', '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
};
