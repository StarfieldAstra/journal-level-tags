/**
 * 生成可发布的干净副本并打包
 * node build_release.js
 *
 * 产出：
 *   release/extension/         干净的扩展目录（可直接「加载已解压」）
 *   release/journal-level-tags-v<版本>.zip   安装包（manifest.json 在包根）
 *   release/SHA256SUMS.txt     校验和
 *
 * 同时做发布前隐私扫描：命中即中止打包。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'release');
const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

/* ---------------- 1. 隐私扫描（硬门禁） ---------------- */
/**
 * 命中即拒绝打包。
 *
 * ⚠️ 规则要窄而准：像「北京大学」「中国科学院」这类**期刊主办单位**属公共学术信息，
 *    不是隐私；`xxx.edu.cn` / `example.edu.cn` 是占位符。
 *    早期版本用 `[一-龥]{2,4}(大学|学院)` 粗匹配，结果把 A3 白名单里几百所高校全部误报。
 *    因此只匹配「与使用者身份直接相关」的内容。
 *
 * ⚠️ 身份类关键词（校名、缩写、真实署名、本机目录名）**不写在本文件里** ——
 *    本文件会进公开仓库，写死等于自我泄露。改由环境变量注入：
 *
 *    SXF_PRIVACY_TERMS   用 | 分隔的额外禁用词，例："<你的学校全称>|<合作者姓名>|<本机目录名>"
 *    SXF_PRIVACY_PATTERN 额外正则（可选），用于匹配缩写，例："\\b<缩写>\\b"
 *
 *    未设置时仅执行下面的通用规则（仍能拦住路径、邮箱、手机号等）。
 */
const EXTRA_TERMS = (process.env.SXF_PRIVACY_TERMS || '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);
const EXTRA_PATTERN = process.env.SXF_PRIVACY_PATTERN || '';

const FORBIDDEN = [
  // —— 机构身份 ——
  { re: /webvpn\.[a-z0-9-]+\.edu\.cn/i, why: '真实学校 VPN 域名', except: /(xxx|example|your)\./i },

  // —— 本机路径（会暴露 Windows 用户名）——
  { re: /[A-Za-z]:\\Users\\[^\\/:*?"<>|\r\n]+/i, why: 'Windows 本机绝对路径', except: /<你的用户名>|Users\\\\?\$|example/i },
  { re: /\/home\/[A-Za-z0-9._-]+\//, why: 'Linux 家目录路径' },
  { re: /\/Users\/[A-Za-z0-9._-]+\//, why: 'macOS 家目录路径' },

  // —— 联系方式与身份标识 ——
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, why: '邮箱地址', except: /example|your-name|your\.email|test\.com|@qq\.com\/s\/?$/i },
  { re: /\b1[3-9]\d{9}\b/, why: '手机号' },
  { re: /\b\d{17}[\dXx]\b/, why: '疑似身份证号' },
  { re: /\b\d{8,12}\b(?=\s*[,，]?\s*(学号|工号|QQ|qq))/, why: '学号/工号/QQ' },

  // —— 真实论文署名（示例数据里最容易被忽略的一类）——
  // 具体姓名由 SXF_PRIVACY_TERMS 注入，此处不写死
];

// 追加来自环境变量的身份类禁用词
EXTRA_TERMS.forEach((t) => {
  FORBIDDEN.push({
    re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    why: '注入的身份关键词',
  });
});
if (EXTRA_PATTERN) {
  try {
    FORBIDDEN.push({ re: new RegExp(EXTRA_PATTERN, 'i'), why: '注入的自定义规则' });
  } catch (e) {
    console.log('  ⚠ SXF_PRIVACY_PATTERN 正则无效，已忽略: ' + e.message);
  }
}

console.log('=== 发布前隐私扫描 ===');
if (EXTRA_TERMS.length) {
  console.log(`  · 已注入 ${EXTRA_TERMS.length} 个身份关键词（来自 SXF_PRIVACY_TERMS）`);
} else {
  console.log('  提示：设置 SXF_PRIVACY_TERMS 可追加身份关键词，扫描更严');
}
const skipDirs = new Set(['data', 'node_modules', '.git', '.workbuddy', 'release']);
// 这些文件不会进发布包，跳过以免误报
const skipFiles = new Set(['build_release.js', 'build_release.md']);
let leaks = [];

function walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (skipDirs.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), path.join(rel, e.name));
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (!['.js', '.json', '.html', '.md', '.py', '.css'].includes(ext)) continue;
      if (skipFiles.has(e.name)) continue;
      const p = path.join(dir, e.name);
      const text = fs.readFileSync(p, 'utf8');
      for (const rule of FORBIDDEN) {
        const m2 = text.match(rule.re);
        if (!m2) continue;
        if (rule.except && rule.except.test(m2[0])) continue;
        const line = text.slice(0, m2.index).split('\n').length;
        leaks.push({ file: path.join(rel, e.name), line, hit: m2[0].slice(0, 40), why: rule.why });
      }
    }
  }
}
walk(ROOT);

if (leaks.length) {
  console.log('  ✗ 发现 ' + leaks.length + ' 处隐私信息，拒绝打包：\n');
  leaks.forEach((l) => console.log(`    ${l.file}:${l.line}  「${l.hit}」 —— ${l.why}`));
  console.log('\n请先清理上述位置再打包。');
  process.exit(1);
}
console.log('  ✓ 未发现个人隐私信息');

/* ---------------- 2. 复制到发布目录 ---------------- */
console.log('\n=== 准备发布目录 ===');
// 只清理 extension 子目录，保留已生成的 zip（避免每次重跑都删包）
const extOut = path.join(OUT, 'extension');
if (fs.existsSync(extOut)) fs.rmSync(extOut, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const EXT_KEEP = [
  'manifest.json', 'content.js', 'style.css', 'background.js',
  'privacy-policy.html', 'selftest.html', 'selftest.js',
  'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png',
  'core', 'sites', 'popup', 'data',
];
/** 递归复制（不用 fs.cpSync —— 沙箱环境下会报 EIO） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

let count = 0;
for (const item of EXT_KEEP) {
  const src = path.join(EXT, item);
  if (!fs.existsSync(src)) { console.log('  ⚠ 跳过缺失项: ' + item); continue; }
  const dst = path.join(OUT, 'extension', item);
  if (fs.statSync(src).isDirectory()) copyDir(src, dst);
  else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  count++;
}
console.log(`  · 复制 ${count} 项到 release/extension/`);

// 校验 manifest 里声明的资源都在
const csFiles = m.content_scripts[0].js.concat(m.content_scripts[0].css);
const warFiles = (m.web_accessible_resources || []).flatMap((w) => w.resources || []);
const missing = csFiles.concat(warFiles).filter((f) => !fs.existsSync(path.join(OUT, 'extension', f)));
if (missing.length) {
  console.log('  ✗ 缺少必需文件: ' + missing.join(', '));
  process.exit(1);
}
console.log('  ✓ 全部声明文件就绪');

/* ---------------- 3. 打包 ---------------- */
console.log('\n=== 打包 ===');
const zipName = `journal-level-tags-v${m.version}.zip`;
const zipPath = path.join(OUT, zipName);
const sevenZip = process.env.SEVENZIP || 'C:/CodexTools/bin/7z.exe';

// Node 在沙箱环境下无法 spawn 子进程（EBUSY），故只做校验，打包交给 Bash。
if (fs.existsSync(zipPath)) {
  // 已存在则跳过
  const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`  · 已存在 ${zipName}（${kb} KB），跳过打包`);
} else if (!fs.existsSync(sevenZip)) {
  console.log(`  ⚠ 未找到 7z（${sevenZip}），请在 Bash 中手动执行：`);
  console.log('    cd release/extension');
  console.log(`    "${sevenZip}" a -tzip -mx=9 "../${zipName}" ".\\*"`);
  process.exit(0);
} else {
  try {
    execFileSync(sevenZip, ['a', '-tzip', '-mx=9', zipPath, '.\\*'], {
      cwd: path.join(OUT, 'extension'),
      stdio: 'pipe',
    });
    const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
    console.log(`  ✓ ${zipName}  ${kb} KB`);
  } catch (e) {
    console.log(`  ⚠ 自动打包失败（${e.code || e.message}），请在 Bash 中手动执行：`);
    console.log('    cd release/extension');
    console.log(`    "${sevenZip}" a -tzip -mx=9 "../${zipName}" ".\\*"`);
    process.exit(0);
  }
}

// 校验包内结构 + 生成校验和
// 注意：调用 7z 列目录在沙箱下会 EBUSY，故用纯 Node 解析 zip 中央目录。
if (fs.existsSync(zipPath)) {
  const buf = fs.readFileSync(zipPath);
  // 找 End of Central Directory (EOCD, 签名 0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) {
    console.log('  ✗ zip 结构异常：未找到中央目录');
    process.exit(1);
  }
  const total = buf.readUInt16LE(eocd + 10);
  // 逐项扫描中央目录文件名
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nlen));
    off += 46 + nlen + elen + clen;
  }
  const hasManifest = names.some((n) => n.replace(/\\/g, '/') === 'manifest.json');
  if (!hasManifest) {
    console.log('  ✗ 包内根目录缺少 manifest.json —— 安装会失败');
    console.log('    实际根级条目: ' + names.filter((n) => !n.includes('/')).join(', '));
    process.exit(1);
  }
  console.log(`  ✓ 包内 ${total} 项，manifest.json 位于根目录`);

  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), `${sum}  ${zipName}\n`);
  console.log('  ✓ SHA256SUMS.txt 已生成');
  console.log('    sha256: ' + sum);
}

/* ---------------- 5. 结果 ---------------- */
console.log('\n' + '='.repeat(54));
console.log('发布包已就绪：');
console.log('  ' + OUT);
console.log('');
console.log('  extension/          可直接「加载已解压的扩展程序」');
console.log('  ' + zipName + '   安装包');
console.log('  SHA256SUMS.txt      校验和');
console.log('');
console.log('下一步：');
console.log('  1. 把 release/ 下的三个文件传到 GitHub 仓库');
console.log('     - extension/ 作为源码提交（或作为 Release 附件）');
console.log('     - ' + zipName + ' 作为 Release 附件（用户直接下载安装）');
console.log('  2. 在仓库 About 处填写简介与安装指引');
