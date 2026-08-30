#!/usr/bin/env node
// 迁移接管 runner —— 2026-08-31 程芥决定把迁移交给我跑，不再手抄 SQL editor。
//
// 用法（均在 shenyan-backend 根目录）：
//   npm run migrate            # 首次=基线化历史迁移；之后=只跑新出现的 pending 文件
//   npm run migrate -- --status  # 列出 40+ 个迁移的已应用/未应用状态
//   npm run migrate -- --baseline # 强制把所有现存文件标为已应用（接管/重标用）
//   npm run migrate -- --reset    # 清空 schema_migrations 跟踪（慎用：下次跑会把全部文件当 pending 执行）
//
// 前置：后端 .env 加 PG_CONN_STRING（postgresql://... 连接串，.env 已 gitignore）。
//
// 纪律（部署前固定动作）：
//   1. 写完新迁移放到 migrations/，命名 2026-YYYY-MM-DD-xxx.sql，内容幂等（IF NOT EXISTS）。
//   2. 跑 npm run migrate 应用它（单文件事务，失败自动回滚，不影响其余文件）。
//   3. 再 zeabur deploy。
// 这样新迁移永远不会「写了忘跑」——部署前必跑。

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const args = process.argv.slice(2);
  const wantStatus = args.includes('--status');
  const wantBaseline = args.includes('--baseline');
  const wantReset = args.includes('--reset');

  const conn = process.env.PG_CONN_STRING;
  if (!conn) {
    console.error('❌ 后端 .env 缺 PG_CONN_STRING。');
    console.error('   请程芥把 Supabase 连接串（postgresql://...）加进 shenyan-backend/.env，.env 已 gitignore。');
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`🔌 已连接（${path.basename(new URL(conn).hostname)}）`);

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT 'cli'
  )`);

  const { rows } = await client.query('SELECT migration_name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.migration_name));

  if (wantReset) {
    await client.query('TRUNCATE schema_migrations');
    applied.clear();
    console.log('↺ 已清空 schema_migrations（下次跑会把全部文件当 pending）');
  }

  if (wantBaseline) {
    for (const f of files) {
      await client.query(
        'INSERT INTO schema_migrations (migration_name, applied_by) VALUES ($1, $2) ON CONFLICT (migration_name) DO NOTHING',
        [f, 'baseline-manual']
      );
    }
    console.log(`✓ 基线完成：${files.length} 个迁移全部标为「已应用（此前程芥手跑）」`);
    await client.end();
    return;
  }

  // 首次运行（表刚建、跟踪为空）＝接管仪式：把历史迁移全部基线化，不执行。
  // 之后新增的文件才是 pending，会被执行。这样不用重跑历史非幂等迁移。
  if (rows.length === 0 && !wantReset) {
    for (const f of files) {
      await client.query(
        'INSERT INTO schema_migrations (migration_name, applied_by) VALUES ($1, $2) ON CONFLICT (migration_name) DO NOTHING',
        [f, 'baseline-manual']
      );
    }
    console.log(`✓ 首次接管：${files.length} 个历史迁移基线化（标记已应用，未执行）`);
    console.log('   之后每次 npm run migrate 只跑新文件。可用 --status 查看。');
    await client.end();
    return;
  }

  const pending = files.filter((f) => !applied.has(f));

  if (wantStatus) {
    console.log(`共 ${files.length} 个迁移 · 已应用 ${files.length - pending.length} · 未应用 ${pending.length}`);
    for (const f of files) console.log(`  ${applied.has(f) ? '✓' : '·'}  ${f}`);
    await client.end();
    return;
  }

  if (pending.length === 0) {
    console.log('✓ 没有待跑迁移（全部已应用）');
    await client.end();
    return;
  }

  let ok = 0;
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    console.log(`▶ 应用 ${f} ...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (migration_name, applied_by) VALUES ($1, $2)', [f, 'cli']);
      await client.query('COMMIT');
      console.log(`  ✓ ${f} 完成`);
      ok++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${f} 失败：${e.message}`);
      console.error('    已回滚该文件（其余继续）。修好后重跑 npm run migrate。');
    }
  }
  console.log(`\n本次应用 ${ok}/${pending.length} 个迁移`);
  await client.end();
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
