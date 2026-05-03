// @ts-nocheck
// Universal team shell — same shape as kernel-shell.
// SCHEMA env var picks which DB schema's nodes to load (kernel/claude/groq/...).
import fastify from 'fastify';
import { Client } from 'pg';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const SCHEMA = process.env.SCHEMA || 'kernel';
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const helpers = {
    client,
    schema: SCHEMA,
    async markStatus(name: string, status: string, errorText: string = '') {
      await client.query(
        `UPDATE ${SCHEMA}.nodes SET status=$1, last_loaded_at=now(), error_text=$2, load_count=load_count+1 WHERE name=$3`,
        [status, errorText, name]
      );
    },
  };

  const app = fastify();
  app.__schema = SCHEMA;

  let res = await client.query(
    `SELECT code_text FROM ${SCHEMA}.nodes WHERE name='_shell_orchestrator' AND active=true AND (status='deployed' OR status='pending') ORDER BY version DESC LIMIT 1`
  );

  if (res.rowCount === 0) {
    res = await client.query(
      `SELECT code_text FROM ${SCHEMA}.nodes WHERE name='_shell_orchestrator' ORDER BY version DESC LIMIT 1`
    );
  }

  const code = res.rows[0]?.code_text;
  if (!code) throw new Error('No orchestrator code found in schema ' + SCHEMA);

  await helpers.markStatus('_shell_orchestrator', 'deploying');
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', 'require', 'app', 'helpers', code);
  fn(mod, mod.exports, require, app, helpers);
  if (typeof mod.exports.register !== 'function') throw new Error('orchestrator did not export register');
  await mod.exports.register(app, helpers);
  await helpers.markStatus('_shell_orchestrator', 'deployed');
  console.log('[shell] booted, schema=' + SCHEMA);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
