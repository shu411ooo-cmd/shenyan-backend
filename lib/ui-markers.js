/* ============================================================
   前端渲染语法的纸卡剥壳（分区第 3 步 · 2026-09-11）

   逐字搬运自 server.js 行 3916-3925（baseRev f7e49da），注释一并带走，**零逻辑改动**。

   为什么单独成文件、而不是跟着记忆片走：它零依赖，却被**三个域**在用 ——
     备份导出   server.js:1028
     对话残留   server.js:2510
     记忆门控   lib/memory/index.js（原 server.js:3956）
   按「谁的依赖面就是谁的」，它属于全文件。可它又是个纯叶子（进字符串出字符串），
   跟 lib/time.js / lib/cache-control.js 同类，所以进 lib/ 而不是留在 server.js 注入 ——
   注入就得在 spec 里再抄一份，而**两份副本漂移是没有测试能发现的**。

   ⚠️ 行为基线：scripts/audit/specs/memory-write.cjs 的 ui_* 五组。
   ============================================================ */

module.exports = { stripUiMarkers };

// —— UI 标记剥壳（2026-09-06 随 [[ask]] 协议加）——
// [[ask]]…[[/ask]] 块、[[event …]]/[[alarm …]] 行内标记，都是前端渲染语法的纸卡，
// 不是她/他说的话。剥掉再喂记忆分类/镜子，防止「选项一/选项二」骨架以「他亲口说的」身份落进长期记忆。
function stripUiMarkers(text) {
  return String(text || '')
    .replace(/\[\[ask\]\][\s\S]*?\[\[\/ask\]\]/g, ' ')
    .replace(/\[\[(?:event|alarm)\b[^\]\n]*\]\]/g, ' ')
    .replace(/\[\[ask\]\]|\[\[\/ask\]\]/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}
