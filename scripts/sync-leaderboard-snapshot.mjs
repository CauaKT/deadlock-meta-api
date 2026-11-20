import { PrismaClient } from '@prisma/client';

const API = 'https://api.deadlock-api.com/v1/sql';
const PAGE = 100000;
const MAX_PAGES = 10;
const WAIT_MS = 61000;
const MIN_ROWS_TO_PRUNE = 100000;

const REGION_MAP = {
  south_america: 'SAmerica',
  argentina: 'SAmerica',
  chile: 'SAmerica',
  peru: 'SAmerica',
  us_south_central: 'Row',
  us_north_central: 'Row',
  us_southeast: 'Row',
  us_east: 'Row',
  us_southwest: 'Row',
  us_west: 'Row',
  'dpkt-stockholm': 'Europe',
  eu_north: 'Europe',
  'dpkt-frankfurt': 'Europe',
  eu_west: 'Europe',
  london: 'Europe',
  'dpkt-london': 'Europe',
  poland: 'Europe',
  helsinki: 'Europe',
  'dpkt-vienna': 'Europe',
  falkenstein: 'Europe',
  eu_east: 'Europe',
  spain: 'Europe',
  dubai: 'Europe',
  'dpkt-fujairah': 'Europe',
  south_africa: 'Europe',
  hong_kong: 'SEAsia',
  asia: 'SEAsia',
  japan: 'SEAsia',
  seoul: 'SEAsia',
  australia: 'Oceania',
};

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(offset) {
  const sql =
    'SELECT m.account_id, argMax(m.player_rank_final_flat_progress, m.start_time) AS pts, MAX(c.region) AS reg ' +
    'FROM match_player_latest m ' +
    'LEFT JOIN (SELECT account_id, argMax(cluster_id, matches) AS cid FROM player_cluster_matches WHERE month >= now() - INTERVAL 60 DAY GROUP BY account_id) pc ON m.account_id = pc.account_id ' +
    'LEFT JOIN (SELECT cluster_id, MAX(region) AS region FROM server_clusters GROUP BY cluster_id) c ON pc.cid = c.cluster_id ' +
    'WHERE m.start_time > now() - INTERVAL 14 DAY AND m.rank_interval = 2 ' +
    'AND m.player_rank_final_flat_progress IS NOT NULL GROUP BY m.account_id ' +
    `ORDER BY pts DESC, m.account_id LIMIT ${PAGE} OFFSET ${offset}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(`${API}?format=json&query=${encodeURIComponent(sql)}`, {
      signal: AbortSignal.timeout(120000),
    });
    if (res.status === 429) {
      console.log(`429 no offset ${offset}, tentativa ${attempt}; aguardando 65s`);
      await sleep(65000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} no offset ${offset}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('Resposta inesperada do /v1/sql');
    return rows;
  }
  throw new Error(`Cota esgotada no offset ${offset}`);
}

async function upsertBatch(rows, runAt) {
  const ids = rows.map((r) => String(r.account_id));
  const pts = rows.map((r) => Number(r.pts));
  const regs = rows.map((r) => r.region);
  await prisma.$executeRaw`
    INSERT INTO leaderboard_snapshot (account_id, points, region, updated_at)
    SELECT t.a::bigint, t.p, t.r, ${runAt}::timestamp
    FROM unnest(${ids}::text[], ${pts}::int[], ${regs}::text[]) AS t(a, p, r)
    ON CONFLICT (account_id) DO UPDATE
    SET points = EXCLUDED.points, region = EXCLUDED.region, updated_at = EXCLUDED.updated_at`;
}

async function main() {
  const runAt = new Date().toISOString();
  const byId = new Map();

  for (let i = 0; i < MAX_PAGES; i += 1) {
    if (i > 0) await sleep(WAIT_MS);
    const rows = await fetchPage(i * PAGE);
    console.log(`pagina ${i + 1}: ${rows.length} linhas`);
    for (const r of rows) {
      const id = Number(r.account_id);
      const p = Number(r.pts);
      const region = typeof r.reg === 'string' ? (REGION_MAP[r.reg] ?? null) : null;
      if (id > 0 && Number.isFinite(p)) byId.set(id, { pts: p, region });
    }
    if (rows.length < PAGE) break;
    if (i === MAX_PAGES - 1) throw new Error('Limite de paginas atingido: snapshot possivelmente truncado');
  }

  const all = Array.from(byId, ([account_id, v]) => ({ account_id, pts: v.pts, region: v.region }));
  console.log(`total unico: ${all.length}`);

  for (let i = 0; i < all.length; i += 10000) {
    await upsertBatch(all.slice(i, i + 10000), runAt);
  }

  if (all.length >= MIN_ROWS_TO_PRUNE) {
    const removed = await prisma.$executeRaw`
      DELETE FROM leaderboard_snapshot WHERE updated_at < ${runAt}::timestamp`;
    console.log(`removidas ${removed} contas fora da janela de 14 dias`);
  } else {
    console.log('total abaixo do minimo seguro: limpeza de contas antigas ignorada');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());