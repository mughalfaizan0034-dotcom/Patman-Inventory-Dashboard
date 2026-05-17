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

  // ── Cloud Tasks (Phase A async upload lifecycle) ───────────────────
  // All four must be set for Cloud Tasks to be active. When any is
  // missing, cloudTasksService runs the summary refresh inline as a
  // fallback (same correctness, just no out-of-band scheduling). This
  // means the backend ships and works BEFORE the operator creates the
  // queue — uploads still return 202 + run Phase 2-4 in background;
  // the only difference is the refresh runs in the same Node task
  // instead of a separate Cloud Run invocation.
  //
  //   TASKS_LOCATION    — Cloud Tasks region (e.g. us-central1)
  //   TASKS_QUEUE_NAME  — queue name (e.g. patman-summary-refresh)
  //   WORKER_BASE_URL   — canonical Cloud Run URL of THIS service
  //                       (used as the task's HTTP target + OIDC audience)
  //   TASKS_INVOKER_SA  — service account email that signs the task's
  //                       OIDC token. Must have roles/run.invoker on
  //                       this Cloud Run service.
  TASKS_LOCATION:   optional('TASKS_LOCATION',   ''),
  TASKS_QUEUE_NAME: optional('TASKS_QUEUE_NAME', ''),
  WORKER_BASE_URL:  optional('WORKER_BASE_URL',  ''),
  TASKS_INVOKER_SA: optional('TASKS_INVOKER_SA', ''),
};
