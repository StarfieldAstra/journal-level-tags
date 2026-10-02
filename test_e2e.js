/**
 * 端到端测试：用 jsdom 构造真实 DOM，验证站点适配器 + 判定 + 注入
 * node test_e2e.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { buildIndex, judge } = require('./extension/core/judge.js');
const { SITES } = require('./extension/sites/index.js');

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'extension/data/journals.json'), 'utf8')
);
const CTX = { journals: data.journals, meta: data.meta, idx: buildIndex(data.journals) };

/** 复刻 content.js 的刊名清洗 + 候选名逻辑（保持一致，改一处须同步） */
function cleanName(raw) {
  let s = (raw || '').trim();
  s = s.replace(/[,，]?\s*(19|20)\d{2}\s*年?.*$/, '');
  s = s.replace(/[,，]\s*\d+\s*卷.*$/, '');
  s = s.replace(/[,，]\s*第?\s*\d+\s*期.*$/, '');
  s = s.replace(/[,，]\s*\d+\s*[-,–]\s*\d+\s*页.*$/, '');
  s = s.replace(/^[\s·•\-–—|:：]+/, '').replace(/[\s·•\-–—|:：]+$/, '');
  return s.trim();
}
function candidateNames(raw) {
  const base = cleanName(raw);
  const list = [base];
  const m = base.match(/^(.+?)[（(][^）)]*[）)]\s*$/);
  if (m && m[1]) list.push(m[1].trim());
  if (base.includes(':') || base.includes('：')) list.push(base.split(/[:：]/)[0].trim());
  return list.filter(Boolean);
}

const cases = [
  {
    site: 'cnki',
    label: '知网（真实DOM·来源列）',
    html: `<table class="result-table-list">
      <thead><tr><th>题名</th><th>作者</th><th>来源</th><th>发表时间</th><th>数据库</th><th>被引</th><th>下载</th></tr></thead>
      <tbody>
        <tr><td class="name"><a class="fz14" href="#">基于可解释Super Learner的中国建筑业碳排放效率时空分异及驱动因素研究</a></td>
            <td class="author"><a>张三</a></td>
            <td class="source"><a href="#">环境科学学报</a></td>
            <td class="date">2026-07-17</td><td class="data">期刊</td><td class="quote">162</td><td class="download">1</td></tr>
      </tbody></table>`,
    expect: '环境科学学报',
  },
  {
    site: 'cnki',
    label: '知网（来源列无链接）',
    html: `<table class="result-table-list">
      <thead><tr><th>题名</th><th>作者</th><th>来源</th><th>发表时间</th></tr></thead>
      <tbody>
        <tr><td class="name"><a class="fz14" href="#">中国城市数字化与绿色化协同水平时空分异及驱动因素</a></td>
            <td class="author"><a>张三</a></td>
            <td class="source">环境科学</td>
            <td class="date">2026-05-25</td></tr>
      </tbody></table>`,
    expect: '环境科学',
  },
  {
    site: 'cnki',
    label: '知网（无source类·按表头列定位）',
    html: `<table class="result-table-list">
      <thead><tr><th>序号</th><th>题名</th><th>作者</th><th>来源</th><th>发表时间</th></tr></thead>
      <tbody>
        <tr><td>1</td><td><a href="#">某论文题目</a></td><td>张三</td><td>学术月刊</td><td>2026-01-01</td></tr>
      </tbody></table>`,
    expect: '学术月刊',
  },
  {
    site: 'wos',
    label: 'WoS 新版记录',
    html: `<div class="app-records-list">
      <div class="record"><span class="journal-title">Energy Economics</span></div>
    </div>`,
    expect: 'Energy Economics',
  },
  {
    site: 'scholar',
    label: 'Google 学术（年份后缀）',
    html: `<div class="gs_r gs_or"><div class="gs_a">经济研究, 2020</div></div>`,
    expect: '经济研究',
  },
  {
    site: 'scholar',
    label: 'Google 学术（卷期页码）',
    html: `<div class="gs_r gs_or"><div class="gs_a">中国工业经济, 2021, (5): 45-68</div></div>`,
    expect: '中国工业经济',
  },
  {
    site: 'scholar',
    label: 'Google 学术（英文刊）',
    html: `<div class="gs_r gs_or"><div class="gs_a">Nature Sustainability, 2019</div></div>`,
    expect: 'Nature Sustainability',
  },
  {
    site: 'pubmed',
    label: 'PubMed 结果',
    html: `<div class="docsum-content">
      <div class="docsum-journal-citation full-journal-citation">
        <span class="docsum-journal-citation-text">J Environ Econ Manage. 2021</span>
      </div>
    </div>`,
    expect: null, // PubMed 缩写刊名通常匹配不上，只验证能找到元素
    lenient: true,
  },
  {
    site: 'baidu',
    label: '百度学术',
    html: `<div class="result"><div class="result-content-default">
      <span class="sc_journal">管理世界</span>
    </div></div>`,
    expect: '管理世界',
  },
  {
    site: 'sd',
    label: 'ScienceDirect',
    html: `<div class="result-list-title"><a>Journal of Environmental Economics and Management</a></div>`,
    expect: 'JOURNAL OF ENVIRONMENTAL ECONOMICS AND MANAGEMENT',
  },
];

let pass = 0, fail = 0;
console.log('=== 站点适配器 + 判定 ===');

for (const c of cases) {
  const site = SITES.find((s) => s.id === c.site);
  if (!site) { console.log('✗ 找不到站点 ' + c.site); fail++; continue; }

  const dom = new JSDOM('<!DOCTYPE html><body>' + c.html + '</body>');
  global.document = dom.window.document;

  let items = [];
  try { items = site.find() || []; } catch (e) {
    console.log('✗ ' + c.label + ' 适配器异常: ' + e.message);
    fail++; continue;
  }

  if (!items.length) {
    console.log('✗ ' + c.label.padEnd(26) + ' 未找到刊名元素');
    fail++; continue;
  }

  const raw = items[0].nameEl.textContent;
  const names = candidateNames(raw);
  let res = null;
  for (const n of names) { res = judge(n, CTX); if (res.record) break; }

  const found = res && res.record ? res.record.n : null;
  const ok = c.expectNoTag
    ? (found === null)               // 未收录刊必须不挂标签
    : (c.lenient ? !!items.length : found === c.expect);

  ok ? pass++ : fail++;
  console.log(
    (ok ? '✓ ' : '✗ ') + c.label.padEnd(26) +
    '「' + raw.trim().slice(0, 34) + '」→ ' +
    (res ? res.level : '-') + '  ' + (found || '未匹配') +
    (ok ? '' : '\n     期望: ' + c.expect)
  );
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');

// ---------------------------------------------------------------- 刊名清洗
console.log('\n=== 刊名清洗 ===');
const cleans = [
  ['经济研究, 2020', '经济研究'],
  ['中国工业经济, 2021, (5): 45-68', '中国工业经济'],
  ['经济学（季刊）', '经济学（季刊）'],
  ['Nature Energy, 2024', 'Nature Energy'],
  ['  · 管理世界  ', '管理世界'],
  ['经济研究 2019, 60(3): 1-10', '经济研究'],
  ['中国软科学, 2020', '中国软科学'],
  ['Ecological Economics, 2023, 231: 107361', 'Ecological Economics'],
];
let cp = 0, cf = 0;
for (const [inp, exp] of cleans) {
  const got = cleanName(inp);
  const ok = got === exp;
  ok ? cp++ : cf++;
  console.log((ok ? '✓ ' : '✗ ') + '「' + inp + '」→ 「' + got + '」' + (ok ? '' : '  期望「' + exp + '」'));
}
console.log('清洗: ' + cp + ' 通过, ' + cf + ' 失败');

// ---------------------------------------------------------------- 级别分布
console.log('\n=== 全量数据级别分布（抽样 4000 条） ===');
const dist = {};
const keys = Object.keys(data.journals);
for (let i = 0; i < 4000; i++) {
  const k = keys[Math.floor(Math.random() * keys.length)];
  const r = judge(data.journals[k].n, CTX);
  if (r.record) dist[r.level] = (dist[r.level] || 0) + 1;
}
Object.keys(dist).sort().forEach((l) => {
  const pct = ((dist[l] / 4000) * 100).toFixed(1);
  console.log('  ' + l + ': ' + dist[l] + '  (' + pct + '%)');
});

console.log('\n总: ' + (fail + cf === 0 ? '全部通过' : (fail + cf) + ' 项失败'));
process.exit(fail + cf === 0 ? 0 : 1);
