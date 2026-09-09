/* 通用依赖分析：给定行区间，报告 ①区内定义 ②区内符号被区外引用（搬走会断）
   ③区内用到的区外符号（要注入）。用法: node dep.cjs <起始行> <结束行(不含)> */
const ROOT = require('path').resolve(__dirname, '..', '..');   // 仓库根（scripts/audit/ 往上两级）

const fs=require('fs');
const [S,E]=[Number(process.argv[2]),Number(process.argv[3])];
const L=fs.readFileSync(ROOT + '/server.js','utf8').replace(/\r/g,'').split('\n');
const inside=L.slice(S-1,E-1).join('\n');
const outside=L.slice(0,S-1).join('\n')+'\n'+L.slice(E-1).join('\n');
const defs=[];
for(const m of inside.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) defs.push(m[1]);
for(const m of inside.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=/gm)) defs.push(m[1]);
const cnt=(txt,n)=>((txt.match(new RegExp('(?<![\w$.])'+n+'(?![\w$])','g'))||[]).length);
console.log('区内定义:', defs.join(', ')||'（无）');
console.log('');
console.log('区内符号被区外引用（搬走会断）:');
let leak=0; for(const d of defs){const n=cnt(outside,d); if(n){leak++;console.log(`  ⚠️ ${d}: 区外 ${n} 处`);}}
if(!leak) console.log('  ✅ 无');
console.log('');
console.log('区内用到的外部符号（要注入）:');
const known=['supabase','warnOnce','app','callDeepSeek','callDeepSeekJson','callReplyModel','postAngelMoment','shDateKey','shDateTime','currentTimeText','coarseAgo','humanizeDuration','ncm','axios','path','crypto','express','getSystemPrompt','estimateTokens','callVisionModel','describeMomentImages','ensureMomentsBucket','randomDelay','parseJsonLoose','stripHtml','extractMetaHtml','digXhsNote','resolveAbsUrl'];
for(const k of known){const n=cnt(inside,k); if(n&&!defs.includes(k)) console.log(`  ${k}: ${n} 处`);}
