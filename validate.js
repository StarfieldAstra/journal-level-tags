/**
 * manifest 合法性校验 + 扩展完整性检查
 * node validate.js
 *
 * 本脚本存在的意义：Chrome 对 content_scripts.matches 的 host 通配符规则极严，
 * 「* 只能出现在主机名最前面」。写成 scholar.google.* 会直接导致扩展加载失败，
 * 且报错信息（Invalid host wildcard）不指出具体行号，极难排查。
 * 故把规则固化为自动检查，改完 manifest 立刻跑一次。
 */
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, 'extension');
let errors = 0;
let warns = 0;

function err(msg) { console.log('  ✗ ' + msg); errors++; }
function warn(msg) { console.log('  ⚠ ' + msg); warns++; }
function ok(msg) { console.log('  ✓ ' + msg); }

// ---------------------------------------------------------------- manifest
let m;
try {
  m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
} catch (e) {
  console.log('✗ manifest.json 解析失败: ' + e.message);
  process.exit(1);
}
console.log('=== manifest.json ===');
ok('JSON 格式正确，Manifest V' + m.manifest_version);

/**
 * Chrome match pattern 语法：
 *   <scheme>://<host><path>
 *   scheme ∈ {*, http, https, file, ftp}
 *   host  = "*" | "*." + 域名 | 完整域名     ← 通配符只能在前缀
 *   path  必须以 / 开头
 */
const PATTERN = /^(\*|https?|file|ftp):\/\/(\*|\*\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)\/.*/;

/** 常见的错误写法：主机名中间出现通配符 */
function diagnose(p) {
  const m2 = p.match(/^[^:]+:\/\/([^/]+)\//);
  if (!m2) return null;
  const host = m2[1];
  if (host.includes('*') && !host.startsWith('*.')) {
    return '主机名中间使用了通配符 → Chrome 不允许。`a.*` 必须写成 `*.a` 或列出完整域名';
  }
  return null;
}

function checkPatterns(list, label) {
  (list || []).forEach((p, i) => {
    if (PATTERN.test(p)) return;
    const why = diagnose(p);
    err(`${label}[${i}] ${p}` + (why ? '\n      → ' + why : ''));
  });
}

checkPatterns(m.host_permissions, 'host_permissions');
ok('host_permissions 语法检查');

m.content_scripts.forEach((cs, i) => {
  checkPatterns(cs.matches, `content_scripts[${i}].matches`);
  (cs.js || []).forEach((f, j) => {
    if (!fs.existsSync(path.join(EXT, f))) err(`content_scripts[${i}].js[${j}] 指向的文件不存在: ${f}`);
  });
  (cs.css || []).forEach((f, j) => {
    if (!fs.existsSync(path.join(EXT, f))) err(`content_scripts[${i}].css[${j}] 指向的文件不存在: ${f}`);
  });
});
ok('content_scripts 语法与文件引用检查');

if (!m.action || !m.action.default_popup) {
  warn('未声明 action.default_popup');
} else if (!fs.existsSync(path.join(EXT, m.action.default_popup))) {
  err('action.default_popup 指向的文件不存在: ' + m.action.default_popup);
} else {
  ok('popup 文件存在');
}

// ---------------------------------------------------------------- 数据文件可达性
// ⚠️ 血泪教训：曾误以为 web_accessible_resources 是"给网页侧用的"而删掉，
//    结果 content script 用 fetch(chrome.runtime.getURL('data/journals.json'))
//    读数据直接被拦成 `Failed to fetch`，插件全瘫。MV3 下该声明是**必需**的。
console.log('\n=== 数据文件可达性（MV3 必需项）===');
const war = m.web_accessible_resources || [];
const warRes = new Set();
war.forEach((w) => (w.resources || []).forEach((r) => warRes.add(r)));

['data/journals.json', 'data/cas_detail.json'].forEach((f) => {
  if (!fs.existsSync(path.join(EXT, f))) {
    err(`数据文件不存在: ${f}`);
    return;
  }
  if (!warRes.has(f)) {
    err(`${f} 未声明在 web_accessible_resources 中` +
        '\n      → Manifest V3 下 content script 用 fetch(chrome.runtime.getURL()) 读它会被拦截' +
        '\n      → 表现为「数据加载失败: Failed to fetch」，插件完全不可用' +
        '\n      → 修复：在 manifest.json 加回 web_accessible_resources，resources 含 ' + f);
  } else {
    ok(`${f} 已声明为 web-accessible`);
  }
});

if (war.length) {
  war.forEach((w, i) => checkPatterns(w.matches, `web_accessible_resources[${i}].matches`));
  // WAR 的 matches 必须覆盖 content_scripts 的 matches，否则某些站点注入后仍读不到
  const csJoined = (m.content_scripts[0].matches || []).join(' ');
  const warJoined = war.map((w) => (w.matches || []).join(' ')).join(' ');
  const csHosts = new Set(
    (m.content_scripts[0].matches || []).map((p) => p.replace(/^https?:\/\//, '').split('/')[0])
  );
  csHosts.forEach((h) => {
    if (!warJoined.includes(h.replace('*.', ''))) {
      err(`web_accessible_resources 未覆盖 content script 的域名 ${h}` +
          '\n      → 该站点上 content script 能注入但读不到数据');
    }
  });
  ok('WAR 覆盖检查');
} else {
  err('manifest 未声明 web_accessible_resources —— MV3 下无法读取内置数据');
}

if (m.background && m.background.service_worker) {
  const sw = m.background.service_worker;
  if (!fs.existsSync(path.join(EXT, sw))) err('service_worker 不存在: ' + sw);
  else ok('service_worker 存在');
}

// ---------------------------------------------------------------- 站点覆盖
console.log('\n=== 站点覆盖一致性 ===');
const { SITES, resolveSite } = require('./extension/sites/index.js');
const mHosts = (m.content_scripts[0].matches || []).map((p) => {
  try { return new URL(p.replace('*://*.', 'https://')).hostname; } catch (e) { return p; }
});
const mJoined = mHosts.join(' ');

// 逐个确认适配器在 manifest 里有注入权限（WebVPN 单独处理）
const probes = [
  ['https://kns.cnki.net/kns8/defaultresult/index', 'cnki', '知网'],
  ['https://www.webofscience.com/wos/woscc/basic-search', 'wos', 'Web of Science'],
  ['https://scholar.google.com/scholar?q=carbon', 'scholar', 'Google 学术'],
  ['https://scholar.google.com.hk/scholar?q=x', 'scholar', 'Google 学术(HK)'],
  ['https://xueshu.baidu.com/s?wd=t', 'baidu', '百度学术'],
  ['https://www.sciencedirect.com/x', 'sd', 'ScienceDirect'],
  ['https://pubmed.ncbi.nlm.nih.gov/12345/', 'pubmed', 'PubMed'],
  ['https://link.springer.com/article/1', 'springer', 'Springer'],
  ['https://www.semanticscholar.org/search?q=x', 's2', 'Semantic Scholar'],
];

probes.forEach(([url, wantId, label]) => {
  const s = resolveSite(url);
  if (!s) { err(`${label}: resolveSite 未识别（适配器可能缺失）`); return; }
  if (s.id !== wantId) { err(`${label}: 识别为 ${s.id}，期望 ${wantId}`); return; }
  // 注入权限检查：manifest 的 matches 是否能覆盖该 host
  const host = new URL(url).hostname;
  const covered = (m.content_scripts[0].matches || []).some((p) => {
    const re = new RegExp(
      '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    return re.test(url);
  });
  if (!covered) err(`${label}: manifest matches 未覆盖 ${url} —— 插件能识别站点但不会注入`);
  else ok(`${label} → ${s.id}（manifest 已覆盖）`);
});

// WebVPN 路径反查能力（用占位域名，不含任何真实学校信息）
// 本仓库不内置任何学校 VPN 域名，故此处只验证 extractSiteKey 的反查逻辑可用。
const vpnUrl =
  'https://webvpn.example.edu.cn/https/77726476706e69737468656265737421fbf952d2243e635930068cb8/kns.cnki.net/kns8/defaultresult/index';
const vpnSite = resolveSite(vpnUrl);
if (!vpnSite) {
  err('WebVPN 路径反查失效：extractSiteKey 应能从 URL 路径中还原出 kns.cnki.net');
} else if (vpnSite.id !== 'cnki') {
  err(`WebVPN 路径反查得到 ${vpnSite.id}，期望 cnki`);
} else {
  ok('WebVPN 路径反查可用（通用逻辑，未内置具体学校域名）');
}

// ---------------------------------------------------------------- 适配器可达性
console.log('\n=== 适配器完整性 ===');
SITES.forEach((s) => {
  if (typeof s.match !== 'function') err(`${s.id}: 缺少 match()`);
  if (typeof s.find !== 'function') err(`${s.id}: 缺少 find()`);
});
ok(SITES.length + ' 个适配器接口完整');

// ---------------------------------------------------------------- 文件与语法
console.log('\n=== 文件与语法 ===');
const JS_FILES = [
  'background.js', 'content.js', 'style.css',
  'core/judge.js', 'sites/index.js',
  'popup/popup.js', 'selftest.js',
];
JS_FILES.forEach((f) => {
  const p = path.join(EXT, f);
  if (!fs.existsSync(p)) { err('缺失文件: ' + f); return; }
  if (!f.endsWith('.js')) return;
  try {
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    err('语法错误 ' + f + ': ' + e.message);
  }
});
ok(JS_FILES.length + ' 个文件就绪，JS 语法正常');

['manifest.json', 'popup/popup.html', 'popup/guide.html', 'selftest.html',
 'data/journals.json', 'data/cas_detail.json'].forEach((f) => {
  if (!fs.existsSync(path.join(EXT, f))) err('缺失文件: ' + f);
});
ok('数据与页面文件就绪');

// ---------------------------------------------------------------- 判定引擎
console.log('\n=== 判定引擎 ===');try {
  const { buildIndex, judge } = require('./extension/core/judge.js');
  const data = JSON.parse(fs.readFileSync(path.join(EXT, 'data/journals.json'), 'utf8'));
  const ctx = { journals: data.journals, meta: data.meta, idx: buildIndex(data.journals) };
  const spot = [
    ['经济研究', 'A1'], ['中国工业经济', 'A2'], ['中国农村观察', 'A3'],
    ['社会保障研究', 'B1'], ['Sustainability', 'C'],
    ['Energy Economics', 'A2'],
  ];
  spot.forEach(([n, want]) => {
    const r = judge(n, ctx);
    if (r.level !== want) err(`${n}: 判为 ${r.level}，期望 ${want}`);
  });
  ok(`数据集 ${Object.keys(data.journals).length} 条，抽查 ${spot.length} 项正确`);
} catch (e) {
  err('判定引擎加载失败: ' + e.message);
}

// ---------------------------------------------------------------- SW 代读通道
console.log('\n=== Service Worker 代读通道 ===');
try {
  const swSrc = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  if (swSrc.includes('readData')) ok('background.js 处理 readData 消息');
  else err('background.js 未处理 readData —— fetch 失败时将无兜底');

  const csSrc = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  if (csSrc.includes('readData')) ok('content.js 有 SW 代读兜底');
  else err('content.js 缺少 SW 代读兜底');

  const popSrc = fs.readFileSync(path.join(EXT, 'popup/popup.js'), 'utf8');
  if (/function esc/.test(popSrc)) ok('popup.js 的 esc() 已定义');
  else err('popup.js 使用了 esc() 但未定义 —— 会抛 ReferenceError');
  if (popSrc.includes('readData')) ok('popup.js 走 SW 读数据');
  else warn('popup.js 未走 SW 读数据（面板信息可能加载失败）');
} catch (e) {
  err('读取扩展源文件失败: ' + e.message);
}

// ---------------------------------------------------------------- 人工覆盖功能
console.log('\n=== 人工覆盖（A4 ⇄ A3）===');
try {
  const { buildIndex, judge, normBase } = require('./extension/core/judge.js');
  const data = JSON.parse(fs.readFileSync(path.join(EXT, 'data/journals.json'), 'utf8'));
  const base = { journals: data.journals, meta: data.meta, idx: buildIndex(data.journals) };
  const mk = (ov) => Object.assign({}, base, { overrides: ov });

  // 1. 提升为 A3 生效
  const k = normBase('经济学（季刊）');
  const r1 = judge('经济学（季刊）', mk({ [k]: { level: 'A3', at: '2026-10-02' } }));
  if (r1.level === 'A3' && r1.overridden) ok('覆盖为 A3 生效');
  else err(`覆盖为 A3 未生效（得到 ${r1.level}）`);

  // 2. 撤销覆盖回 A4
  const r2 = judge('经济学（季刊）', mk({}));
  if (r2.level === 'A4' && !r2.overridden) ok('撤销覆盖后回落 A4');
  else err(`撤销覆盖异常（得到 ${r2.level}）`);

  // 3. 预警名单优先于覆盖
  const kw = normBase('Sustainability');
  const r3 = judge('Sustainability', mk({ [kw]: { level: 'A3', at: 'x' } }));
  if (r3.level === 'C') ok('预警名单优先于人工覆盖（仍判 C）');
  else err(`覆盖越过了预警一票否决（得到 ${r3.level}）—— 违反办法第十四条`);

  // 4. 非法级别被忽略
  const r4 = judge('经济学（季刊）', mk({ [k]: { level: 'A1', at: 'x' } }));
  if (r4.level === 'A4') ok('非法级别（A1）被忽略');
  else err(`非法级别未被拦截（得到 ${r4.level}）`);

  // 5. 全半角归一化
  const r5 = judge('经济学(季刊)', mk({ [k]: { level: 'A3', at: 'x' } }));
  if (r5.level === 'A3') ok('全半角/副标题差异不影响覆盖命中');
  else err(`归一化失败，半角刊名未命中覆盖（得到 ${r5.level}）`);

  // 6. UI 入口
  const cSrc = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  if (cSrc.includes('to-a3') && cSrc.includes('setOverride')) ok('详情浮层提供「升为 A3」入口');
  else err('content.js 缺少覆盖设置入口');
  if (fs.readFileSync(path.join(EXT, 'style.css'), 'utf8').includes('sxfx-pop-btn'))
    ok('覆盖按钮样式已定义');
  else err('style.css 缺少覆盖按钮样式');
} catch (e) {
  err('覆盖功能检查失败: ' + e.message);
}

// ---------------------------------------------------------------- UI 配色一致性
console.log('\n=== UI 配色一致性（iOS 系统色）===');
try {
  // style.css / popup.js / selftest.js / selftest.html 四处都硬编码了级别色，
  // 改一处忘另一处会导致"面板图例与页面实际标签颜色不符"。
  const IO = {
    A1: '#FF3B30', A2: '#FF9500', A3: '#30B0C7', A4: '#007AFF',
    B1: '#5856D6', B2: '#AF52DE', C: '#8E8E93',
  };
  const files = {
    'style.css': 'extension/style.css',
    'popup.js': 'extension/popup/popup.js',
    'selftest.js': 'extension/selftest.js',
  };
  const src = {};
  Object.keys(files).forEach((k) => {
    src[k] = fs.readFileSync(path.join(__dirname, files[k]), 'utf8');
  });

  Object.keys(IO).forEach((lv) => {
    const miss = Object.keys(src).filter((f) => !src[f].includes(IO[lv]));
    if (miss.length === 0) ok(`${lv} = ${IO[lv]} 三处一致`);
    else warn(`${lv} = ${IO[lv]} 在 ${miss.join('、')} 中未找到 —— 配色可能不一致`);
  });

  // 苹果风关键特征抽查
  if (/backdrop-filter/.test(src['style.css'])) ok('浮层使用毛玻璃（backdrop-filter）');
  else warn('style.css 未使用 backdrop-filter');
  if (/border-radius:\s*6px/.test(src['style.css'])) ok('标签圆角 6px');
  else warn('标签圆角非 6px');
  if (/-apple-system/.test(src['style.css']) && /-apple-system/.test(src['popup.js'] === '' ? '' : fs.readFileSync(path.join(__dirname, 'extension/popup/popup.html'), 'utf8')))
    ok('SF Pro 字体栈已启用');
  else warn('未使用 -apple-system 字体栈');
  if (/prefers-reduced-motion/.test(src['style.css'])) ok('已适配 reduce-motion');
  else warn('未适配 prefers-reduced-motion');
} catch (e) {
  err('配色检查失败: ' + e.message);
}

// ---------------------------------------------------------------- 结果
console.log('\n' + '='.repeat(46));
if (errors) {
  console.log(`✗ ${errors} 个错误，${warns} 个警告 —— 扩展无法加载`);
  process.exit(1);
}
console.log(`✓ 全部通过${warns ? '（' + warns + ' 个警告）' : ''} —— 可正常加载`);
