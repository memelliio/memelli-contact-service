import { PrismaClient } from "@memelliio/db";

type GroqPoolStatus = {
  running: boolean;
  cyclesRun: number;
  poolSize: number;
  idle: number;
  claimed: number;
  lastHeartbeatAt: string | null;
  standaloneRepo: string;
};

let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient | null {
  if (_prisma) return _prisma;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  _prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });
  return _prisma;
}

const STANDALONE_REPO = process.env.STANDALONE_REPO ?? "";
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";
const GROQ_DISPATCH_URL = process.env.GROQ_DISPATCH_URL ?? "https://api.memelli.io/api/groq/dispatch";

let running = false;
let cyclesRun = 0;
let lastHeartbeatAt: string | null = null;
let claimInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

async function claimIdleAgents(): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) return;

  // Claim a batch of IDLE agents atomically
  const batchSize = 10; // arbitrary batch size
  const claimedAgents = await prisma.$queryRawUnsafe<any[]>(`
    WITH cte AS (
      SELECT id
      FROM agent_instances
      WHERE status = 'IDLE'
        AND config->>'standaloneRepo' = $1
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE agent_instances
    SET status = 'CLAIMED'
    FROM cte
    WHERE agent_instances.id = cte.id
    RETURNING agent_instances.id, config
  `, STANDALONE_REPO, batchSize);

  if (claimedAgents.length === 0) return;

  // For each claimed agent, dispatch a work order to the central Groq service
  for (const agent of claimedAgents) {
    const payload = {
      internalServiceToken: INTERNAL_SERVICE_TOKEN,
      agentId: agent.id,
      config: agent.config,
    };
    try {
      await fetch(GROQ_DISPATCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // If dispatch fails, reset status back to IDLE to avoid orphaned CLAIMED rows
      await prisma.$executeRawUnsafe(`
        UPDATE agent_instances
        SET status = 'IDLE'
        WHERE id = $1
      `, agent.id);
    }
  }
}

async function sendHeartbeat(): Promise<void> {
  const prisma = getPrisma();
  if (!prisma) return;

  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(`
    INSERT INTO groq_patch_records (task_key, result, created_at)
    VALUES ('groq-pool-supervisor-heartbeat', $1::jsonb, now())
  `, JSON.stringify({ repo: STANDALONE_REPO, timestamp: now }));

  lastHeartbeatAt = now;
}

function computeStatus(): GroqPoolStatus {
  const prisma = getPrisma();
  if (!prisma) {
    return {
      running,
      cyclesRun,
      poolSize: 0,
      idle: 0,
      claimed: 0,
      lastHeartbeatAt,
      standaloneRepo: STANDALONE_REPO,
    };
  }

  // Synchronous return; actual counts will be stale until next async refresh.
  // For simplicity we perform a blocking query (await) in the async caller.
  // Here we return placeholder values; the async caller updates them.
  return {
    running,
    cyclesRun,
    poolSize: 0,
    idle: 0,
    claimed: 0,
    lastHeartbeatAt,
    standaloneRepo: STANDALONE_REPO,
  };
}

export async function getGroqPoolStatus(): Promise<GroqPoolStatus> {
  const prisma = getPrisma();
  if (!prisma) {
    return computeStatus();
  }

  const [poolSize, idle, claimed] = await Promise.all([
    prisma.$queryRawUnsafe<number>(`SELECT COUNT(*) FROM agent_instances WHERE config->>'standaloneRepo' = $1`, STANDALONE_REPO),
    prisma.$queryRawUnsafe<number>(`SELECT COUNT(*) FROM agent_instances WHERE status = 'IDLE' AND config->>'standaloneRepo' = $1`, STANDALONE_REPO),
    prisma.$queryRawUnsafe<number>(`SELECT COUNT(*) FROM agent_instances WHERE status = 'CLAIMED' AND config->>'standaloneRepo' = $1`, STANDALONE_REPO),
  ]);

  return {
    running,
    cyclesRun,
    poolSize: Number(poolSize),
    idle: Number(idle),
    claimed: Number(claimed),
    lastHeartbeatAt,
    standaloneRepo: STANDALONE_REPO,
  };
}

export function startGroqPoolSupervisor(): void {
  if (running) return;
  if (!STANDALONE_REPO) {
    // Without a repo identifier the supervisor cannot operate.
    return;
  }

  running = true;

  // Claim loop every 5 seconds
  claimInterval = setInterval(async () => {
    cyclesRun += 1;
    try {
      await claimIdleAgents();
    } catch (e) {
      // Log silently; in production a proper logger would be used.
    }
  }, 5_000);

  // Heartbeat loop every 5 minutes
  heartbeatInterval = setInterval(async () => {
    try {
      await sendHeartbeat();
    } catch (e) {
      // Silent fail; next interval will retry.
    }
  }, 5 * 60_000);

  // Initial immediate runs
  claimIdleAgents().catch(() => {});
  sendHeartbeat().catch(() => {});
}

// ── Auto-start when STANDALONE_REPO env is set (Track D 2026-05-02) ──
if (typeof process !== "undefined" && process.env && process.env.STANDALONE_REPO) {
  try {
    startGroqPoolSupervisor();
  } catch (err) {
    console.warn("[groq-pool-supervisor] auto-start failed:", (err as any)?.message);
  }
}
