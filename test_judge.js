/**
 * 判定引擎测试：node test_judge.js
 * 覆盖山财七级 + 边界情形
 */
const fs = require('fs');
const path = require('path');
const { norm, buildIndex, judge, lookupIssn } = require('./extension/core/judge.js');

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'extension/data/journals.json'), 'utf8')
);
const ctx = {
  journals: data.journals,
  meta: data.meta,
  idx: buildIndex(data.journals),
};

const cases = [
  // [输入, 期望级别, 说明]
  ['经济研究', 'A1', 'A1 目录 + CSSCI来源'],
  ['管理世界', 'A1', 'A1 目录'],
  ['中国社会科学', 'A1', 'A1 目录'],
  ['中国工业经济', 'A2', 'A2 目录 + CSSCI来源'],
  ['会计研究', 'A2', 'A2 目录'],
  ['金融研究', 'A2', 'A2 目录'],
  ['数量经济技术经济研究', 'A2', 'A2 目录'],
  ['经济评论', 'A3', 'A2目录无此刊；中国财政学会所属 → A3 附条件'],

  // 中科院分区动态条款
  ['Energy Economics', 'A2', '中科院1区 → A2'],
  ['Journal of Environmental Economics and Management', 'A3', '中科院2区 → A3'],

  // 中文核心 → A3/A4（取决于主办单位是否属省级"国家级学术刊物"认定范围）
  ['中国农村观察', 'A3', 'CSSCI来源 + 中国社科院农村发展研究所 → A3'],
  ['经济学（季刊）', 'A4', 'CSSCI来源 + 上海社科院（非国家级）→ A4'],
  ['数量经济研究', 'C', 'CSSCI集刊，当前数据集未收录集刊 → 已知缺口'],
  ['南开经济研究', 'A3', 'CSSCI来源 + 南开大学（教育部直属）→ A3'],
  ['财贸经济', 'A2', 'A2 目录优先'],
  ['社会保障评论', 'A2', 'A2 目录（属中国社会保障学会）'],

  // CSSCI 扩展版 → B1
  ['社会保障研究', 'B1', 'CSSCI扩展版'],

  // 预警名单 → C
  ['Sustainability', 'C', '2020 预警名单'],
  ['Aging-US', 'C', '2020/2021 预警名单'],
  ['Diagnostics', 'C', '2024 预警名单'],

  // 本校学报
  ['经济科学', 'A3', 'CSSCI来源 + 山东大学（教育部直属高校）→ A3 附条件'],
];

let pass = 0, fail = 0;
for (const [name, expect, note] of cases) {
  const r = judge(name, ctx);
  const ok = r.level === expect;
  if (ok) pass++;
  else fail++;
  const mark = ok ? '✓' : '✗';
  console.log(
    `${mark} ${String(name).slice(0, 42).padEnd(44)} → ${(r.level || '-').padEnd(3)} (期望 ${expect})  ${note}`
  );
  if (!ok) {
    console.log(`     实际理由: ${r.reasons.join(' / ')}`);
    console.log(`     标签: ${r.badges.map(b => b.t).join(', ') || '无'}`);
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
console.log(`\n数据规模: ${Object.keys(data.journals).length} 条`);
console.log(`CSSCI来源 ${data.meta.counts.cssciSource} / 扩展 ${data.meta.counts.cssciExt}`);
console.log(`CSCD核心 ${data.meta.counts.cscdCore} / 扩展 ${data.meta.counts.cscdExt}`);
console.log(`中科院分区 ${data.meta.counts.cas} / 预警 ${data.meta.counts.warning}`);

// ISSN 匹配测试
console.log('\n--- ISSN 匹配 ---');
for (const issn of ['0577-9154', '1006-480X', '0140-9883']) {
  const k = lookupIssn(issn, ctx.idx);
  const r = k ? judge({ name: data.journals[k].n, issn }, ctx) : null;
  console.log(`${issn} → ${k ? data.journals[k].n : '未找到'} → ${r ? r.level : '-'}`);
}

// ---------------------------------------------------------------- 人工覆盖测试
console.log('\n=== 人工覆盖（A4 ⇄ A3）===');
function ctxWith(overrides) {
  return { journals: data.journals, meta: data.meta, idx: buildIndex(data.journals), overrides };
}
const { normBase } = require('./extension/core/judge.js');

const ovCases = [
  // [刊名, 覆盖表, 期望级别, 说明]
  ['中国农村观察', {}, 'A3', '无覆盖 → 走自动判定（社科院主办）'],
  ['经济学（季刊）', {}, 'A4', '无覆盖 → 上海社科院非国家级 → A4'],
  ['经济学（季刊）', { [normBase('经济学（季刊）')]: { level: 'A3', at: '2026-10-02', note: '人工核实' } }, 'A3', '覆盖为 A3 → 生效'],
  ['经济学（季刊）', { [normBase('经济学（季刊）')]: { level: 'A4', at: '2026-10-02' } }, 'A4', '覆盖为 A4 → 生效'],
  // 归一化：副标题不同也应命中同一覆盖
  ['经济学(季刊)', { [normBase('经济学（季刊）')]: { level: 'A3', at: '2026-10-02' } }, 'A3', '全半角括号差异不影响命中'],
  // 预警名单不受覆盖影响（一票否决）
  ['Sustainability', { [normBase('Sustainability')]: { level: 'A3', at: '2026-10-02' } }, 'C', '预警名单优先于覆盖，仍判 C'],
  // 非法级别被忽略
  ['经济学（季刊）', { [normBase('经济学（季刊）')]: { level: 'A1', at: 'x' } }, 'A4', '非法级别(A1)被忽略，回落自动判定'],
];

let op = 0, of = 0;
for (const [name, ov, expect, note] of ovCases) {
  const r = judge(name, ctxWith(ov));
  const ok = r.level === expect;
  ok ? op++ : of++;
  console.log(
    `${ok ? '✓' : '✗'} ${String(name).slice(0, 22).padEnd(24)} → ${(r.level || '-').padEnd(3)}  ${note}` +
    (ok ? '' : `\n     期望 ${expect}，实际理由: ${r.reasons.join(' / ')}`)
  );
}
console.log(`覆盖测试: ${op} 通过, ${of} 失败`);

// ---------------------------------------------------------------- 收录标签合并测试
console.log('\n=== 收录标签合并与同刊合并 ===');
const { normBase: nb2 } = require('./extension/core/judge.js');

function badges(n) {
  const r = judge(n, ctx);
  return r.badges.map((b) => b.t);
}

const badgeCases = [
  // [刊名, 期望的标签文本数组, 说明]
  ['经济研究', ['A1', 'CSSCI'], 'CSSCI来源 + A1目录'],
  ['长江流域资源与环境', ['A4', 'CSSCI+CSCD'], '双库 → 合并为一个标签'],
  ['古地理学报', ['A4', 'CSCD'], '仅CSCD核心'],
  ['热带地理', ['A4', 'CSSCI扩展+CSCD'], 'CSSCI扩展 + CSCD核心'],
];

let bp = 0, bf = 0;
for (const [name, want, note] of badgeCases) {
  const got = badges(name);
  // A 级是主标签，只比对收录标签部分
  const aux = got.filter((t) => !/^[ABC]\d?$/.test(t) || t === 'A1' || t === 'A2' || t === 'A3' || t === 'A4');
  const gotAux = got.filter((t) => /CSSCI|CSCD/.test(t));
  const ok = JSON.stringify(gotAux) === JSON.stringify(want.filter((t) => /CSSCI|CSCD/.test(t)));
  ok ? bp++ : bf++;
  console.log(
    `${ok ? '✓' : '✗'} ${name.padEnd(16)} 收录标签 [${gotAux.join(', ')}]  ${note}` +
    (ok ? '' : `\n     期望 [${want.filter((t) => /CSSCI|CSCD/.test(t)).join(', ')}]`)
  );
}

// 同刊合并的回归测试：CSSCI 用地域后缀、CSCD 不用
const data2 = require('./extension/data/journals.json');
function recOf(n) {
  const k = Object.keys(data2.journals).find((x) => data2.journals[x].n === n || x === n);
  return k ? data2.journals[k] : null;
}
const mergeCases = [
  ['地理学报', 'source', 'core', 'CSSCI(北京)+CSCD → 应合并到主条目'],
  ['北京工业大学学报(社会科学版)', 'source', undefined, '学科版必须保持独立'],
  ['北京工业大学学报', undefined, 'core', '理工版保持独立，只判 CSCD'],
];
for (const [name, c, d, note] of mergeCases) {
  const r = recOf(name);
  const ok = r && r.c === c && r.d === d;
  ok ? bp++ : bf++;
  console.log(
    `${ok ? '✓' : '✗'} ${name.padEnd(26)} c=${r ? r.c || '-' : '?'} d=${r ? r.d || '-' : '?'}  ${note}`
  );
}

console.log(`\n收录标签测试: ${bp} 通过, ${bf} 失败`);

// ---------------------------------------------------------------- 北核测试
console.log('\n=== 北核（中文核心期刊要目总览）===');
const bkAll = Object.values(data.journals).filter((v) => v.b);
console.log(`北核数据 ${bkAll.length} 种`);

const bkCases = [
  ['财经论丛', 'B1', '纯北核 → B1'],
  ['学术月刊', 'A3', 'CSSCI+北核 → A3（级别不被北核改变）'],
  ['中国农村观察', 'A3', 'CSSCI+北核 → A3'],
  ['经济研究', 'A1', 'A1 目录优先于北核'],
  ['Sustainability', 'C', '预警一票否决优先于北核'],
];
let kp = 0, kf = 0;
for (const [name, want, note] of bkCases) {
  const r = judge(name, ctx);
  const ok = r.level === want;
  ok ? kp++ : kf++;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(16)} → ${String(r.level).padEnd(3)} [${r.badges.map((b) => b.t).join(',')}]  ${note}`);
}

// 「纯北核」＝北核且自身无 CSSCI/CSCD/分区记录。
// 注意：judge 的 lookup 会先试精确键，失败后退副标题匹配（插件的基本假设：
// 「X(某版)」视为 X 的同一本刊）。因此这里用 lookup 的实际命中记录来判定，
// 而非用 bkAll 里那条记录自身的字段 —— 后者会因副标题归并而误判。
function primaryRec(v) {
  const r = judge(v.n, ctx);
  return r.record || v;
}
const pureBk = bkAll.filter((v) => {
  const p = primaryRec(v);
  return !p.c && !p.d && !p.z;
});
const wrongPure = pureBk.filter((v) => judge(v.n, ctx).level !== 'B1');
if (wrongPure.length === 0) {
  kp++;
  console.log(`✓ 纯北核 ${pureBk.length} 种全部判 B1`);
} else {
  kf++;
  console.log(`✗ 纯北核中 ${wrongPure.length} 种未判 B1，例：${wrongPure.slice(0, 3).map((v) => v.n).join('、')}`);
}

// 北核标签：按实际命中的主刊记录判断（副标题归并后主刊可能已带 b）
const hasBk = bkAll.filter((v) => judge(v.n, ctx).badges.some((b) => b.t === '北核')).length;
const ratio = (hasBk / bkAll.length * 100).toFixed(1);
if (hasBk / bkAll.length >= 0.99) {
  kp++;
  console.log(`✓ ${hasBk}/${bkAll.length}（${ratio}%）种北核带「北核」标签`);
} else {
  kf++;
  console.log(`✗ 仅 ${hasBk}/${bkAll.length}（${ratio}%）种带北核标签`);
  const noTag = bkAll.filter((v) => !judge(v.n, ctx).badges.some((b) => b.t === '北核'));
  noTag.slice(0, 5).forEach((v) => {
    const r = judge(v.n, ctx);
    console.log(`     ${v.n} → ${r.level} [${r.badges.map((b) => b.t).join(',')}]  命中记录: ${r.record ? r.record.n : '无'}`);
  });
}

console.log(`\n北核测试: ${kp} 通过, ${kf} 失败`);
