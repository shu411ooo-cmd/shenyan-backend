/* ============================================================
   request_stats 写入韧性 —— 纯函数，供 recordRequestStat 逐列降级用

   为什么需要它（2026-09-10 补）：
   本项目的结构是「**代码先部署、迁移不自动跑**」。只要代码开始写一个 DB 里还没有的
   列，PostgREST 就**对未知列整行 400** —— 于是整个 request_stats 停止进货。
   2026-08-30 就这么瞎了两小时（11:45:26 → 20:33:57，56 轮真实对话的成本没记上；
   根因见 cd75a04）。原来的兜底是写死的 baseRow，但它自己仍带着几个较新的列，
   缺的若是其中之一，两次插入都失败、整行照样丢。

   改法：从报错里**抠出缺的那个列名**，剥掉重试。缺什么只丢什么，账本不再整段瞎。

   PostgREST 的报错文案不止一种，实测见过的形状（select 那条是本机实测的）：
     column request_stats.residue_mode does not exist
     column "request_stats"."residue_mode" does not exist
     column "residue_mode" of relation "request_stats" does not exist
     Could not find the 'residue_mode' column of 'request_stats' in the schema cache
   认不出来时返回 null（调用方据此退到核心列模式），**绝不猜**。
   ============================================================ */

/**
 * 从 PostgREST 报错文案里抠出「缺的是哪一列」。
 * @param {string} message 错误信息
 * @returns {string|null} 列名；认不出来返回 null
 */
function missingColumnFromError(message) {
  const m = String(message || '');
  if (!m) return null;
  // column [schema.]col does not exist
  let hit = m.match(/column\s+(?:"?\w+"?\.)?"?([A-Za-z_]\w*)"?\s+does not exist/i);
  if (hit) return hit[1];
  // column "col" of relation "table" does not exist
  hit = m.match(/column\s+"?([A-Za-z_]\w*)"?\s+of relation/i);
  if (hit) return hit[1];
  // Could not find the 'col' column of 'table' in the schema cache
  hit = m.match(/Could not find the\s+['"]?([A-Za-z_]\w*)['"]?\s+column/i);
  if (hit) return hit[1];
  return null;
}

/**
 * 返回去掉某一列的新对象（不改原对象）。列本来就不在则原样返回。
 * @param {object} row
 * @param {string} col
 * @returns {object}
 */
function stripColumn(row, col) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, col)) return row;
  const out = { ...row };
  delete out[col];
  return out;
}

/**
 * 只保留指定的列（核心列降级用）。缺失的列不会凭空补上。
 * @param {object} row
 * @param {string[]} keys
 * @returns {object}
 */
function pickColumns(row, keys) {
  const out = {};
  for (const k of keys || []) {
    if (row && Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
  }
  return out;
}

/**
 * 带「缺列逐列剥掉重试」的插入。循环本身也住在这里，是为了能被单测拿假 insert 跑通
 * （住在 server.js 里就只能靠肉眼看）。
 *
 * @param {object} row        要写的整行
 * @param {(row:object)=>Promise<{error:any}>} insert  真正的插入动作（便于测试注入假的）
 * @param {{maxStrip?:number, coreColumns?:string[]}} [opts]
 * @returns {Promise<{error:any, stripped:string[], coreOnly:boolean}>}
 *          error 非空 = **一行都没写进去**（账本丢行）；stripped/coreOnly = 降级记录
 */
async function insertRowResilient(row, insert, opts = {}) {
  const maxStrip = Number.isInteger(opts.maxStrip) ? opts.maxStrip : 8;
  const coreColumns = opts.coreColumns || [];
  let current = row;
  let { error } = await insert(current);
  const stripped = [];
  // 剥列：PostgREST 的报错里带列名，缺什么剥什么，剥到写得进去为止
  while (error && stripped.length < maxStrip) {
    const col = missingColumnFromError(error.message);
    if (!col || !Object.prototype.hasOwnProperty.call(current, col)) break;  // 认不出来就停，绝不猜
    stripped.push(col);
    current = stripColumn(current, col);
    ({ error } = await insert(current));
  }
  // 剥不动（报错不是缺列 / 文案没认出来）→ 退到核心列，尽量别丢整行
  let coreOnly = false;
  if (error && !stripped.length && coreColumns.length) {
    const { error: coreErr } = await insert(pickColumns(current, coreColumns));
    if (!coreErr) { error = null; coreOnly = true; }
  }
  return { error, stripped, coreOnly };
}

module.exports = { missingColumnFromError, stripColumn, pickColumns, insertRowResilient };
