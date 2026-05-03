/*************************************************************************************
 * kernel-resolver.bundle.ts
 *
 * Stand‑alone bundle that routes all kernel operations through the gateway's
 * POST /api/kernel/resolve endpoint.  Mirrors the shape of
 * hot‑load-connectors.bundle.ts – a single file with zero npm dependencies that can
 * be copy‑pasted into any service.
 *
 * Environment variables (in order of precedence):
 *   - GATEWAY_URL
 *   - MEMELLI_CORE_API_URL
 *   - defaults to "https://api.memelli.io"
 *
 * Authorization:
 *   Bearer token taken from INTERNAL_SERVICE_TOKEN.
 *
 * Features:
 *   • kernelSelect, kernelGet, kernelInsert, kernelUpdate, getKernelSchema
 *   • LRU‑style in‑memory cache for schema (60 s TTL, cleared on /api/dev/refresh)
 *   • Automatic retry on 5xx responses (3 attempts, exponential back‑off)
 *   • kernelSubscribe – simple polling stub (30 s) that emits when rows change.
 *
 * Compatible with Fastify 4+, Node 20 (uses global fetch & crypto).
 *
 * NOTE: This file contains no direct DB imports – all data access is performed via
 * the gateway resolver.
 *************************************************************************************/

import { setInterval, clearInterval } from 'timers';
import { createHash, randomUUID } from 'crypto';

// -----------------------------------------------------------------------------
// Configuration & helpers
// -----------------------------------------------------------------------------

const GATEWAY_BASE_URL: string = (() => {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL;
  if (process.env.MEMELLI_CORE_API_URL) return process.env.MEMELLI_CORE_API_URL;
  return 'https://api.memelli.io';
})();

const AUTH_TOKEN: string | undefined = process.env.INTERNAL_SERVICE_TOKEN;

const RESOLVE_ENDPOINT = `${GATEWAY_BASE_URL.replace(/\/+$/, '')}/api/kernel/resolve`;

type ResolvePayload = Record<string, any>;

interface SchemaCacheEntry {
  schema: Array<{ field_name: string; field_type: string; required: boolean; json_path: string | null }>;
  expiresAt: number;
}

const schemaCache = new Map<string, SchemaCacheEntry>();

// Simple LRU eviction based on TTL (60 s)
function getCachedSchema(object_type: string) {
  const entry = schemaCache.get(object_type);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.schema;
  }
  schemaCache.delete(object_type);
  return null;
}

function setCachedSchema(object_type: string, schema: any) {
  const expiresAt = Date.now() + 60_000; // 60 s TTL
  schemaCache.set(object_type, { schema, expiresAt });
}

// Invalidate cache – used when /api/dev/refresh is called on the gateway
export function invalidateKernelSchemaCache(object_type?: string) {
  if (object_type) {
    schemaCache.delete(object_type);
  } else {
    schemaCache.clear();
  }
}

// -----------------------------------------------------------------------------
// Core HTTP POST with retry logic
// -----------------------------------------------------------------------------

async function postResolve(payload: ResolvePayload): Promise<any> {
  const requestId = randomUUID();
  const body = JSON.stringify({ ...payload, requestId });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  const backoffs = [200, 600, 1500]; // ms

  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    try {
      const response = await fetch(RESOLVE_ENDPOINT, {
        method: 'POST',
        headers,
        body,
      });

      if (response.ok) {
        // Successful (2xx)
        return await response.json();
      }

      if (response.status >= 500 && response.status < 600) {
        // Server error – retry after delay
        await new Promise((res) => setTimeout(res, backoffs[attempt]));
        continue;
      }

      // Non‑retryable error – throw
      const errText = await response.text();
      throw new Error(`Kernel resolve error ${response.status}: ${errText}`);
    } catch (err) {
      // Network or other fetch error – retry if attempts remain
      if (attempt < backoffs.length - 1) {
        await new Promise((res) => setTimeout(res, backoffs[attempt]));
        continue;
      }
      throw err;
    }
  }

  // Should never reach here
  throw new Error('Exhausted retries for kernel resolve');
}

// -----------------------------------------------------------------------------
// Exported API
// -----------------------------------------------------------------------------

export async function kernelSelect(
  object_type: string,
  filter: Record<string, any> = {},
  opts: { limit?: number } = {}
): Promise<any[]> {
  const payload: ResolvePayload = {
    op: 'select',
    object_type,
    filter,
    limit: opts.limit,
  };
  const result = await postResolve(payload);
  return result?.data ?? [];
}

export async function kernelGet(
  object_type: string,
  key: string | { object_type: string; slug?: string; id?: string }
): Promise<any | null> {
  const payload: ResolvePayload = {
    op: 'get',
    object_type,
    key,
  };
  const result = await postResolve(payload);
  return result?.data ?? null;
}

export async function kernelInsert(
  object_type: string,
  fields: Record<string, any>
): Promise<{ id: string }> {
  const payload: ResolvePayload = {
    op: 'insert',
    object_type,
    fields,
  };
  const result = await postResolve(payload);
  if (!result?.id) {
    throw new Error('Insert failed: no id returned');
  }
  return { id: result.id };
}

export async function kernelUpdate(
  object_type: string,
  where: Record<string, any>,
  set: Record<string, any>
): Promise<{ updated: number }> {
  const payload: ResolvePayload = {
    op: 'update',
    object_type,
    where,
    set,
  };
  const result = await postResolve(payload);
  return { updated: result?.updated ?? 0 };
}

export async function getKernelSchema(
  object_type: string
): Promise<
  Array<{
    field_name: string;
    field_type: string;
    required: boolean;
    json_path: string | null;
  }>
> {
  const cached = getCachedSchema(object_type);
  if (cached) {
    return cached;
  }

  const payload: ResolvePayload = {
    op: 'schema',
    object_type,
  };
  const result = await postResolve(payload);
  const schema = result?.schema ?? [];

  setCachedSchema(object_type, schema);
  return schema;
}

// -----------------------------------------------------------------------------
// Kernel subscription (polling stub)
// -----------------------------------------------------------------------------

type KernelChangeCallback = (rows: any[]) => void;

export function kernelSubscribe(
  object_type: string,
  callback: KernelChangeCallback
): { stop: () => void } {
  let previousHash = '';
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      const rows = await kernelSelect(object_type);
      const hash = createHash('sha256')
        .update(JSON.stringify(rows))
        .digest('hex');
      if (hash !== previousHash) {
        previousHash = hash;
        callback(rows);
      }
    } catch (err) {
      // Swallow errors to keep polling alive; optionally log in real usage
      console.error('kernelSubscribe poll error:', err);
    }
  }

  // Initial poll immediately, then every 30 s
  poll();
  const intervalId = setInterval(poll, 30_000);

  return {
    stop: () => {
      stopped = true;
      clearInterval(intervalId);
    },
  };
}

// -----------------------------------------------------------------------------
// End of bundle
// -----------------------------------------------------------------------------