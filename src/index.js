import Fastify from 'fastify';
import pg from 'pg';

const { Pool } = pg;
const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT) || 8080;
const DATABASE_URL = process.env.MEMELLI_CORE_DATABASE_URL || process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL / MEMELLI_CORE_DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 10 });

// ── Auth — trusts X-Tenant-Id + Bearer from gateway. Production upgrade: verify JWT. ─
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return reply.code(401).send({ success: false, error: 'missing tenant' });
  req.tenantId = tenantId;
});

app.get('/health', async () => ({ ok: true, service: 'contact-service' }));

// ── List / search ───────────────────────────────────────────────────
app.get('/contacts', async (req, reply) => {
  const { q = '', tag, lifecycle, limit = 50, offset = 0 } = req.query || {};
  const params = [req.tenantId];
  let where = `tenant_id = $1 AND deleted_at IS NULL`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length})`;
  }
  if (tag) {
    params.push(tag);
    where += ` AND $${params.length} = ANY(tags)`;
  }
  if (lifecycle) {
    params.push(lifecycle);
    where += ` AND lifecycle_stage = $${params.length}`;
  }
  params.push(Number(limit), Number(offset));
  const sql = `SELECT id, tenant_id, first_name, last_name, email, phone, tags, source, lifecycle_stage, assigned_to_id, created_at, updated_at
    FROM "Contact" WHERE ${where} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  try {
    const r = await pool.query(sql, params);
    reply.send({ success: true, data: r.rows, count: r.rows.length });
  } catch (e) {
    reply.code(500).send({ success: false, error: e.message });
  }
});

// ── Get by id ───────────────────────────────────────────────────────
app.get('/contacts/:id', async (req, reply) => {
  try {
    const r = await pool.query(`SELECT * FROM "Contact" WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [req.params.id, req.tenantId]);
    if (!r.rows[0]) return reply.code(404).send({ success: false, error: 'not found' });
    reply.send({ success: true, data: r.rows[0] });
  } catch (e) {
    reply.code(500).send({ success: false, error: e.message });
  }
});

// ── Create ──────────────────────────────────────────────────────────
app.post('/contacts', async (req, reply) => {
  const b = req.body || {};
  const fields = ['tenant_id', 'first_name', 'last_name', 'email', 'phone', 'tags', 'source', 'lifecycle_stage', 'assigned_to_id'];
  const values = [req.tenantId, b.firstName || null, b.lastName || null, b.email || null, b.phone || null, b.tags || [], b.source || null, b.lifecycleStage || null, b.assignedToId || null];
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO "Contact" (${fields.map((f) => `"${f}"`).join(', ')}, created_at, updated_at) VALUES (${placeholders}, NOW(), NOW()) RETURNING *`;
  try {
    const r = await pool.query(sql, values);
    reply.code(201).send({ success: true, data: r.rows[0] });
  } catch (e) {
    reply.code(500).send({ success: false, error: e.message });
  }
});

// ── Update ──────────────────────────────────────────────────────────
app.patch('/contacts/:id', async (req, reply) => {
  const b = req.body || {};
  const map = {
    firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone',
    tags: 'tags', source: 'source', lifecycleStage: 'lifecycle_stage', assignedToId: 'assigned_to_id',
  };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in b) { params.push(b[k]); sets.push(`"${col}" = $${params.length}`); }
  }
  if (!sets.length) return reply.code(400).send({ success: false, error: 'no fields to update' });
  sets.push('updated_at = NOW()');
  params.push(req.params.id, req.tenantId);
  const sql = `UPDATE "Contact" SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} AND deleted_at IS NULL RETURNING *`;
  try {
    const r = await pool.query(sql, params);
    if (!r.rows[0]) return reply.code(404).send({ success: false, error: 'not found' });
    reply.send({ success: true, data: r.rows[0] });
  } catch (e) {
    reply.code(500).send({ success: false, error: e.message });
  }
});

// ── Soft delete ─────────────────────────────────────────────────────
app.delete('/contacts/:id', async (req, reply) => {
  try {
    const r = await pool.query(
      `UPDATE "Contact" SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, req.tenantId],
    );
    if (!r.rows[0]) return reply.code(404).send({ success: false, error: 'not found' });
    reply.send({ success: true, data: { id: r.rows[0].id, deleted: true } });
  } catch (e) {
    reply.code(500).send({ success: false, error: e.message });
  }
});

// ── Tag add / remove ────────────────────────────────────────────────
app.post('/contacts/:id/tags', async (req, reply) => {
  const { tag, op = 'add' } = req.body || {};
  if (!tag) return reply.code(400).send({ success: false, error: 'tag required' });
  const sql = op === 'remove'
    ? `UPDATE "Contact" SET tags = array_remove(tags, $1), updated_at = NOW() WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL RETURNING tags`
    : `UPDATE "Contact" SET tags = array_append(tags, $1), updated_at = NOW() WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL AND NOT ($1 = ANY(tags)) RETURNING tags`;
  try {
    const r = await pool.query(sql, [tag, req.params.id, req.tenantId]);
    reply.send({ success: true, data: { tags: r.rows[0]?.tags || [] } });
  } catch (e) {
    reply.code(500).send({ success: false, error: e.message });
  }
});

// ── Bulk CSV import ─────────────────────────────────────────────────
app.post('/contacts/import', async (req, reply) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return reply.code(400).send({ success: false, error: 'rows required' });
  let inserted = 0, failed = 0;
  for (const r of rows) {
    try {
      await pool.query(
        `INSERT INTO "Contact" ("tenant_id","first_name","last_name","email","phone","tags","source","created_at","updated_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [req.tenantId, r.firstName || null, r.lastName || null, r.email || null, r.phone || null, r.tags || [], r.source || 'import'],
      );
      inserted += 1;
    } catch { failed += 1; }
  }
  reply.send({ success: true, data: { inserted, failed, total: rows.length } });
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => console.log('contact-service listening on', PORT));
