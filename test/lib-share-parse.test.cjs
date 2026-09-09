// ===== lib/share-parse.js 单元测试（node:test）=====
// 只测「拿到 HTML 之后怎么挖东西」的纯解析逻辑 —— 自己造 HTML 字符串，不发任何网络请求。

const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../lib/share-parse.js');

const BASE = 'https://blog.example.com/posts/1';

test('stripHtml：剥 script/style 内容、剥内联属性残渣、还原 HTML 实体', () => {
  const html = '<p>hi</p><script>var x=1</script><style>.a{}</style>' +
    '<div class="x">a &amp; b &lt; c &gt; d &quot;q&quot; &#39;e&#39;&nbsp;f</div>';
  assert.strictEqual(s.stripHtml(html), 'hi a & b < c > d "q" \'e\' f');
});

test('resolveAbsUrl：相对 / 绝对 / 协议相对 / 空引用', () => {
  assert.strictEqual(s.resolveAbsUrl(BASE, '/a.png'), 'https://blog.example.com/a.png');
  assert.strictEqual(s.resolveAbsUrl(BASE, 'https://b.com/z.png'), 'https://b.com/z.png');
  assert.strictEqual(s.resolveAbsUrl(BASE, '//cdn.e.com/z.png'), 'https://cdn.e.com/z.png');
  assert.strictEqual(s.resolveAbsUrl(BASE, ''), null);
  assert.strictEqual(s.resolveAbsUrl(BASE, null), null);
});

test('extractMetaHtml：og 系列为主来源，相对图转绝对', () => {
  const html = '<meta property="og:title" content="OG标题">' +
    '<meta property="og:description" content="OG描述">' +
    '<meta property="og:image" content="/img/cover.png">' +
    '<meta property="og:site_name" content="示例站">' +
    '<meta name="author" content="作者甲"><title>普通title（不应盖过 og）</title>';
  assert.deepStrictEqual(s.extractMetaHtml(html, BASE), {
    title: 'OG标题',
    image: 'https://blog.example.com/img/cover.png',
    description: 'OG描述',
    site_name: '示例站',
    author: '作者甲',
  });
});

test('extractMetaHtml：无 og 时回退 twitter 系列', () => {
  const html = '<meta name="twitter:title" content="TW标题">' +
    '<meta name="twitter:description" content="TW描述">' +
    '<meta name="twitter:image" content="https://cdn.tw.com/p.png">';
  assert.deepStrictEqual(s.extractMetaHtml(html, BASE), {
    title: 'TW标题',
    image: 'https://cdn.tw.com/p.png',
    description: 'TW描述',
    site_name: null,
    author: null,
  });
});

test('extractMetaHtml：缺字段时 JSON-LD 兜底，协议相对图也要能转绝对', () => {
  const html = '<script type="application/ld+json">' +
    '{"@type":"Article","headline":"LD标题","description":"LD描述","image":"//cdn.ld.com/hero.jpg"}' +
    '</script>';
  assert.deepStrictEqual(s.extractMetaHtml(html, BASE), {
    title: 'LD标题',
    image: 'https://cdn.ld.com/hero.jpg',
    description: 'LD描述',
    site_name: null,
    author: null,
  });
});

test('extractMetaHtml：description 超 400 字符截断并加省略号', () => {
  const html = `<meta property="og:description" content="${'x'.repeat(500)}">`;
  const out = s.extractMetaHtml(html, BASE);
  assert.strictEqual(out.description.length, 401);
  assert.ok(out.description.endsWith('…'));
});

test('extractJsonWindow：括号配平，取 marker 后第一个 { 的完整窗口', () => {
  const html = 'window.state = {"a":"含 {花括号} 的字符串","b":[1,2]};';
  assert.strictEqual(s.extractJsonWindow(html, 'window.state'), '{"a":"含 {花括号} 的字符串","b":[1,2]}');
  assert.strictEqual(s.extractJsonWindow(html, 'no-such-marker'), null);
});

test('lenientJsonParse：合法 JSON / 含 JS 字面量（undefined/NaN/Infinity）都能出对象', () => {
  assert.deepStrictEqual(s.lenientJsonParse('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(s.lenientJsonParse('{"a":undefined,"b":NaN,"c":Infinity}'), { a: null, b: null, c: null });
});

test('lenientJsonParse：无法恢复的垃圾输入会抛 SyntaxError（调用方 digXhsNote 已 try/catch）', () => {
  assert.throws(() => s.lenientJsonParse('{"a": }'), SyntaxError);
});

test('digXhsNote：不含 __INITIAL_STATE__ 时安全返回 null', () => {
  assert.strictEqual(s.digXhsNote('<html><body>什么也没有</body></html>'), null);
  assert.strictEqual(s.digXhsNote(''), null);
});

test('digXhsNote：有 marker 但窗口不足 500 字符的伪标记会被跳过 → null', () => {
  const html = '<script>window.__INITIAL_STATE__={"note":{}};</script>';
  assert.strictEqual(s.digXhsNote(html), null);
});

test('digXhsNote：从 noteDetailMap 挖出标题/描述/封面/作者，http 封面转 https', () => {
  const state = {
    filler: 'x'.repeat(600), // 撑过 500 字符下限
    note: {
      noteDetailMap: {
        'xhs://note/abc': {
          note: {
            title: '夜晚散步随想',
            desc: '第一行\n第二行文字',
            imageList: ['http://sns-webpic.xhscdn.com/photo.jpg'],
            user: { nickname: '山海集' },
          },
        },
      },
    },
  };
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script>`;
  assert.deepStrictEqual(s.digXhsNote(html), {
    title: '夜晚散步随想',
    desc: '第一行\n第二行文字',
    cover: 'https://sns-webpic.xhscdn.com/photo.jpg',
    author: '山海集',
  });
});
