/* ============================================================
   审计工具：读 Zeabur 部署记录 + 运行时日志（考古用）

   起因：08-30 request_stats 冻结的「breaker 部署」几点上线，需要部署记录来钉死。
   CLI 的 deployment list 只回最近 5 条、又没有分页参数，所以直接走 GraphQL 接口。

   ⛔ 只读：只有 query，没有 mutation。
   ⛔ token 从 ~/.config/zeabur/cli.yaml 读，**任何情况下都不打印**。

   用法：
     node scripts/audit/zeabur-deployments.cjs              # 列全部部署
     node scripts/audit/zeabur-deployments.cjs schema       # 内省类型
   ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CFG = path.join(os.homedir(), '.config', 'zeabur', 'cli.yaml');
const API = 'https://api.zeabur.com/graphql';

const SERVICE_ID = '6a82b69dbdeaa87e2c530a93';      // shenyan-backend
const ENV_ID = '6a64a2c92007fc25ea36057b';          // production
const TZ_OFFSET_MIN = 8 * 60;                       // 显示用：+0800

function readToken() {
  const m = fs.readFileSync(CFG, 'utf8').match(/^token:\s*(.+)$/m);
  if (!m) throw new Error('cli.yaml 里没找到 token（先 zeabur auth login）');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 800));
  return j.data;
}

/* UTC → 本地（+0800）显示，方便跟 git commit 时间对照 */
function local(iso) {
  if (!iso) return '(无)';
  const d = new Date(new Date(iso).getTime() + TZ_OFFSET_MIN * 60000);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' +0800';
}

/* 内省一个类型的所有字段 */
async function fieldsOf(typeName) {
  const d = await gql(`{ __type(name: "${typeName}") { kind name fields { name type { name kind ofType { name kind ofType { name } } } } } }`);
  return d.__type;
}

(async () => {
  const mode = process.argv[2] || 'list';

  if (mode === 'logs') {
    // 用法: node ... logs <关键字> [起 ISO] [止 ISO] [deploymentId]
    const q = process.argv[3] || 'request_stats';
    const start = process.argv[4] ? new Date(process.argv[4]).toISOString() : '2026-08-30T00:00:00Z';
    const end = process.argv[5] ? new Date(process.argv[5]).toISOString() : '2026-08-31T00:00:00Z';
    const depId = process.argv[6] || null;
    const vars = { s: SERVICE_ID, e: ENV_ID, q, n: 200, a: start, b: end };
    if (depId) vars.d = depId;
    const d = await gql(
      `query($s: ObjectID!, $e: ObjectID!, $d: ObjectID, $q: String!, $n: Int, $a: Time, $b: Time) {
         searchRuntimeLogs(serviceID: $s, environmentID: $e, deploymentID: $d, query: $q, limit: $n, startTime: $a, endTime: $b) {
           message timestamp region stream
         }
       }`,
      vars,
    );
    const logs = d.searchRuntimeLogs;
    console.log(`查询 "${q}"  ${start} ~ ${end}${depId ? '  deployment=' + depId : ''}`);
    console.log(`命中 ${Array.isArray(logs) ? logs.length : 0} 条\n`);
    for (const l of Array.isArray(logs) ? logs : []) console.log(JSON.stringify(l).slice(0, 900));
    return;
  }

  if (mode === 'raw') {
    // 基础版运行时日志（不需要 Pro）：node ... raw <deploymentId> [关键字过滤]
    const depId = process.argv[3];
    const filt = process.argv[4] || null;
    const d = await gql(
      `query($p: ObjectID!, $s: ObjectID!, $e: ObjectID!, $d: ObjectID!) {
         runtimeLogs(projectID: $p, serviceID: $s, environmentID: $e, deploymentID: $d) {
           message timestamp stream
         }
       }`,
      { p: '6a64a2c97bcbc56e70a11cc8', s: SERVICE_ID, e: ENV_ID, d: depId },
    );
    const logs = d.runtimeLogs || [];
    console.log(`deployment ${depId} 取到 ${logs.length} 条日志`);
    for (const l of logs) {
      if (filt && !l.message.includes(filt)) continue;
      console.log(`  ${l.timestamp}  ${String(l.message).slice(0, 400)}`);
    }
    return;
  }

  if (mode === 'detail') {
    for (const id of process.argv.slice(3)) {
      const d = await gql(`query($i: ObjectID!) { deployment(_id: $i) { _id status createdAt startedAt finishedAt planType oomKilled: status } }`, { i: id });
      const x = d.deployment;
      console.log(`${x._id}  ${x.status}`);
      console.log(`  createdAt  ${local(x.createdAt)}`);
      console.log(`  startedAt  ${local(x.startedAt)}`);
      console.log(`  finishedAt ${local(x.finishedAt)}  (耗时 ${x.finishedAt && x.startedAt ? ((new Date(x.finishedAt) - new Date(x.startedAt)) / 1000).toFixed(0) + 's' : '?'})`);
    }
    return;
  }

  if (mode === 'schema') {
    for (const t of ['DeploymentConnection', 'Deployment', 'DeploymentEdge', 'RuntimeLog']) {
      const ty = await fieldsOf(t);
      if (!ty) { console.log(`\n${t}: 不存在`); continue; }
      console.log(`\n${t} (${ty.kind}):`);
      for (const f of ty.fields || []) {
        const tn = (x) => (x ? (x.name || (x.ofType ? tn(x.ofType) : x.kind)) : '?');
        console.log(`  ${f.name}: ${tn(f.type)}`);
      }
    }
    // 日志类字段
    const q = await fieldsOf('Query');
    for (const n of ['runtimeLogs', 'buildLogs', 'searchRuntimeLogs']) {
      const f = (q.fields || []).find((x) => x.name === n);
      if (!f) continue;
      const d = await gql(`{ __type(name: "Query") { fields { name args { name type { name kind ofType { name kind ofType { name } } } } } } }`);
      const g = d.__type.fields.find((x) => x.name === n);
      const tn = (x) => (x ? (x.name || (x.ofType ? tn(x.ofType) : x.kind)) : '?');
      console.log(`\n${n}(${(g.args || []).map((a) => a.name + ': ' + tn(a.type)).join(', ')}) -> ${tn(g.type)}`);
    }
    return;
  }

  // —— 翻页拉全部部署 ——
  const all = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const d = await gql(
      `query($s: ObjectID!, $e: ObjectID!, $c: String, $p: Int) {
         deployments(serviceID: $s, environmentID: $e, cursor: $c, perPage: $p) {
           edges { cursor node { _id createdAt status } }
         }
       }`,
      { s: SERVICE_ID, e: ENV_ID, c: cursor, p: 100 },
    );
    const edges = d.deployments.edges || [];
    for (const e of edges) all.push(e.node);
    if (edges.length < 100) break;              // 不足一页 = 到底了（没有 pageInfo 可用）
    cursor = edges[edges.length - 1].cursor;
  }

  all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  console.log(`部署总数: ${all.length}`);
  console.log('（时间已换算 +0800，可直接跟 git commit 对照）\n');
  console.log('创建(+0800)            状态        ID');
  for (const d of all) console.log(`${local(d.createdAt)}  ${String(d.status).padEnd(10)}  ${d._id}`);

  // —— 重点窗口：08-30 本地全天 ——
  const from = Date.parse('2026-08-30T00:00:00+08:00');
  const to = Date.parse('2026-08-31T12:00:00+08:00');
  const win = all.filter((d) => new Date(d.createdAt) >= from && new Date(d.createdAt) <= to);
  console.log(`\n=== 08-30 00:00 ~ 08-31 12:00 (+0800) 共 ${win.length} 次部署 ===`);
  for (const d of win) console.log(`  ${local(d.createdAt)}  ${d.status}  ${d._id}`);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
