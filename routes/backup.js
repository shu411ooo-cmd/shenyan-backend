/* ============================================================
   数据备份 / 恢复（Kelivo 借鉴 2026-09-03：数据可携带、可恢复）

   2026-09-09 从 server.js 原样搬出（分区第 2 步首块）。逻辑一字未改，
   只把 app.post('/api/backup/xxx') 改成 router.post('/xxx') + 前缀挂载。

   为什么用「工厂函数 + 显式依赖注入」而不是 require('../server')：
   反向 require 会造成循环依赖，CommonJS 不报错、只给你一个 undefined，
   等运行到那一行才 TypeError —— 正是这个项目今天已经踩过三次的那类静默故障。
   依赖写在参数里，缺什么一眼看得见。

   导出：白名单表全量拉出 → 单个 JSON（朋友圈图片本体在 Storage，这里只导元数据）。
   恢复：wipe=true 时对「payload 里出现的表」先清后插——防误点，不清就按插入（主键冲突会报错）。
   白名单兜底：不在 BACKUP_TABLES 的表名直接拒绝，防任意表被清空。
   ============================================================ */
const express = require('express');

const BACKUP_TABLES = [
  'sessions', 'messages', 'settings',
  'memory_topics', 'memory_relations', 'dialogue_residue', 'summary_segments',
  'diary_entries', 'moments', 'moment_comments',
  'desires', 'desire_notes', 'thought_pool',
  'personality_claim', 'stone_rings', 'keepalive_log', 'notes',
];
const BACKUP_PAGE = 1000;          // Supabase 单查行数上限，翻页拉全量
const BACKUP_INSERT_BATCH = 500;   // 恢复时分批插，防单请求过大

module.exports = function createBackupRouter({ supabase }) {
  if (!supabase) throw new Error('createBackupRouter: 缺少 supabase 依赖');
  const router = express.Router();

  async function backupFetchAll(table) {
    const rows = [];
    for (let from = 0; ; from += BACKUP_PAGE) {
      const { data, error } = await supabase.from(table).select('*').range(from, from + BACKUP_PAGE - 1);
      if (error) throw new Error(`${table} 读取失败: ${error.message}`);
      rows.push(...(data || []));
      if (!data || data.length < BACKUP_PAGE) break;
    }
    return rows;
  }

  // POST /api/backup/export → { exported_at, tables: { <表名>: [rows] } }
  router.post('/export', async (req, res) => {
    try {
      const tables = {};
      for (const t of BACKUP_TABLES) tables[t] = await backupFetchAll(t);
      res.json({ exported_at: new Date().toISOString(), tables });
    } catch (e) {
      console.error('💥 备份导出失败:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/backup/import → body: { tables: {...}, wipe: true|false }
  router.post('/import', async (req, res) => {
    try {
      const payload = req.body?.tables;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ error: 'payload 需要 { tables: { <表名>: [rows] }, wipe: true|false }' });
      }
      const names = Object.keys(payload);
      const bad = names.filter(n => !BACKUP_TABLES.includes(n));
      if (bad.length) return res.status(400).json({ error: `不在备份白名单的表: ${bad.join(', ')}` });

      const wipe = req.body?.wipe === true || req.query?.wipe === 'true';
      const restored = {};
      for (const t of names) {
        const rows = Array.isArray(payload[t]) ? payload[t] : [];
        if (wipe) {
          // PostgREST/supabase-js 要求 update/delete 带过滤条件；「id 非空」即全表
          const { error: derr } = await supabase.from(t).delete().not('id', 'is', null);
          if (derr) throw new Error(`${t} 清空失败: ${derr.message}`);
        }
        for (let i = 0; i < rows.length; i += BACKUP_INSERT_BATCH) {
          const batch = rows.slice(i, i + BACKUP_INSERT_BATCH);
          const { error } = await supabase.from(t).insert(batch);
          if (error) throw new Error(`${t} 恢复失败: ${error.message}`);
        }
        restored[t] = rows.length;
      }
      console.log(`💾 [backup] 恢复完成 wiped=${wipe} ${JSON.stringify(restored)}`);
      res.json({ ok: true, wiped: wipe, restored });
    } catch (e) {
      console.error('💥 备份恢复失败:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
module.exports.BACKUP_TABLES = BACKUP_TABLES;
