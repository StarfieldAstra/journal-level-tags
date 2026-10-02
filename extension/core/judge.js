/**
 * 期刊级别判定引擎
 *
 * 依据：本校科研成果管理办法
 * 级别体系：A1 / A2 / A3 / A4 / B1 / B2 / C（七级，由高到低）
 *
 * 数据字段（journals.json 主表）：
 *   n=刊名  c=CSSCI(source/ext)  d=CSCD(core/ext)  s=校级静态目录(A1/A2)
 *   i=ISSN  j=学科  w=预警年份  u=关联985高校  U=该985是否为社科类
 *   z=中科院大类分区  M=大类名  T=Top  W=WOS收录类型  R=Review  O=OA
 *   y=预警原因
 */

// ---------------------------------------------------------------- 名称归一化
/** 基础归一化：去空白、全角转半角、统一括号、小写 */
function norm(s) {
  if (!s) return '';
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 0x3000) out += ' ';
    else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else out += ch;
  }
  return out
    .replace(/\s+/g, '')
    .replace(/[（【［]/g, '(')
    .replace(/[）】］]/g, ')')
    .replace(/[，、]/g, ',')
    .toLowerCase();
}

/** 去副标题：用于精确匹配的兜底键 */
function normBase(s) {
  let t = norm(s);
  // 去掉末尾括号内容
  while (t.endsWith(')') && t.includes('(')) {
    t = t.slice(0, t.lastIndexOf('(')).replace(/,$/, '');
  }
  for (const suf of ['英文版', '英文', '中英文版', '专辑', '增刊', '专刊', ' journals']) {
    if (t.endsWith(suf)) t = t.slice(0, -suf.length);
  }
  return t;
}

/** 构建多级查找索引：精确 → 去副标题 → ISSN */
function buildIndex(journals) {
  const exact = new Map();   // norm(name) -> key
  const base = new Map();    // normBase(name) -> key
  const issn = new Map();    // 规范化 ISSN -> key
  for (const [k, v] of Object.entries(journals)) {
    if (!exact.has(k)) exact.set(k, k);
    const b = normBase(v.n);
    if (b && !base.has(b)) base.set(b, k);
    if (v.i) {
      const t = String(v.i).toUpperCase().replace(/[^0-9Xx]/g, '');
      if (t.length >= 8 && !issn.has(t)) issn.set(t, k);
    }
  }
  return { exact, base, issn };
}

/** 查找期刊：返回主表 key 或 null */
function lookup(name, idx) {
  if (!name) return null;
  const k = norm(name);
  if (k && idx.exact.has(k)) return idx.exact.get(k);
  const b = normBase(name);
  if (b && idx.base.has(b)) return idx.base.get(b);
  return null;
}

/** 按 ISSN 查找（走索引，O(1)） */
function lookupIssn(issnCode, idx) {
  if (!issnCode) return null;
  const t = String(issnCode).toUpperCase().replace(/[^0-9Xx]/g, '');
  if (t.length < 8) return null;
  return idx.issn.get(t) || null;
}

// ---------------------------------------------------------------- A3 附条件
/**
 * 省级主管部门"国家级学术刊物"认定（山财办法 A3 附条件）
 *
 * 认定看的是**主办单位性质**。该信息不在任何公开免费接口里，故数据集里
 * 维护一份显式白名单（字段 H=主办单位、B=认定依据），只有命中白名单才判 A3。
 * 未命中 → 判 A4 并标注「待人工核实」，宁可保守不虚高。
 */
function checkA3Condition(rec, meta) {
  // 显式白名单命中：主办单位已核实
  if (rec.H && rec.B) {
    // 985 院校中，理工农医类的"社科版"不计入 A3，需人工确认
    const uncertain = /需确认/.test(rec.B) || /需核实/.test(rec.B);
    return {
      ok: true,
      reasons: [`${rec.H}（${rec.B}）`],
      uncertain,
    };
  }
  return { ok: false, reasons: [], uncertain: false };
}

// ---------------------------------------------------------------- 主判定
const LEVELS = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'C'];

/**
 * 人工覆盖表
 *
 * 用途：A3 需核实主办单位，而主办单位数据无法自动获取（知网/维普均有反爬）。
 * 用户人工核实后可在插件里把某刊从 A4 提升为 A3，此处存放其决定并优先生效。
 *
 * 存储键用 normBase(刊名)（去副标题后的归一化名），覆盖一经设置永久有效，
 * 除非用户在设置面板里撤销。
 *
 * @param {object} ctx { overrides: { [归一化刊名]: {level, at, note} } }
 */
function getOverride(name, ctx) {
  const ov = ctx && ctx.overrides;
  if (!ov) return null;
  return ov[normBase(name)] || ov[norm(name)] || null;
}

/**
 * 判定期刊级别
 * @param {string|object} nameOrRec 刊名字符串，或带 name/issn 的对象
 * @param {object} ctx  { journals, idx, meta, detail, overrides }
 * @returns {object} { level, reasons[], badges, record, a3, needVerify, overridden }
 */
function judge(nameOrRec, ctx) {
  const { journals, idx, meta } = ctx;
  const isObj = typeof nameOrRec === 'object' && nameOrRec !== null;
  const name = isObj ? (nameOrRec.name || nameOrRec.journal || '') : nameOrRec;
  const issn = isObj ? (nameOrRec.issn || '') : '';

  let key = lookup(name, idx);
  if (!key && issn) key = lookupIssn(issn, idx);
  const rec = key ? journals[key] : null;

  const out = {
    level: null,
    reasons: [],
    badges: [],
    record: rec || null,
    key: key || null,
    name: name,
    a3: null,
    needVerify: false,
  };
  if (!rec) {
    out.level = 'C';
    out.reasons.push('未在任一目录中匹配到该刊，按 C 级处理');
    return out;
  }

  // ---- 0. 预警名单一票否决 → C ----
  // 《科研成果管理办法》第十四条：列入中科院《国际期刊预警名单》的期刊
  // 自发布之日起按 C 级认定。此处必须最先判定，否则会被中科院分区条款抢先。
  if (rec.w) {
    out.level = 'C';
    out.reasons.push(
      `列入中科院《国际期刊预警名单》（${rec.w} 年）` +
      (rec.y ? `：${rec.y}` : '') + '，按办法第十四条直接认定为 C 级'
    );
    return out;
  }

  // ---- 收集标签 ----
  if (rec.c === 'source') out.badges.push({ t: 'CSSCI', k: 'cssci-source' });
  if (rec.c === 'ext') out.badges.push({ t: 'CSSCI扩展', k: 'cssci-ext' });
  if (rec.d === 'core') out.badges.push({ t: 'CSCD核心', k: 'cscd-core' });
  if (rec.d === 'ext') out.badges.push({ t: 'CSCD扩展', k: 'cscd-ext' });
  if (rec.z) {
    out.badges.push({
      t: `中科院${rec.z}区`,
      k: 'cas-' + rec.z,
      top: !!rec.T,
    });
  }
  if (rec.T) out.badges.push({ t: 'Top', k: 'top' });

  // ---- 1. A1 静态目录 ----
  if (rec.s === 'A1') {
    out.level = 'A1';
    out.reasons.push('列入校级 A 级期刊目录（附件1）（A1 级，11 种之一）');
    return out;
  }

  // ---- 2. A2 静态目录 ----
  if (rec.s === 'A2') {
    out.level = 'A2';
    out.reasons.push('列入校级 A 级期刊目录（附件1）（A2 级，46 种之一）');
    return out;
  }

  // ---- 3. 中科院 1 区 → A2 ----
  if (rec.z === '1') {
    out.level = 'A2';
    out.reasons.push('中科院 SCI/SSCI 升级版 1 区（动态条款）');
    return out;
  }

  const isCoreCn = rec.c === 'source' || rec.d === 'core';

  // ---- 4. A3：CSSCI来源/CSCD核心 + 省级"国家级学术刊物"认定 ----
  if (isCoreCn) {
    const a3 = checkA3Condition(rec, meta);
    out.a3 = a3;
    if (a3.ok) {
      out.level = 'A3';
      out.reasons.push(
        (rec.c === 'source' ? 'CSSCI 来源期刊' : 'CSCD 核心库期刊') +
        '，且满足省级主管部门"国家级学术刊物"认定：' + a3.reasons.join('、')
      );
      if (a3.uncertain) {
        out.reasons.push('※ 需人工确认该 985 高校是否属理工农医类（其社科版不计入 A3）');
      }
      return out;
    }
  }

  // ---- 5. 中科院 2 区 → A3 ----
  if (rec.z === '2') {
    out.level = 'A3';
    out.reasons.push('中科院 SCI/SSCI 升级版 2 区（动态条款）');
    return out;
  }

  // ---- 5.5 人工覆盖 ----
  // 用户人工核实主办单位后手动提升的级别，优先于自动判定结果。
  // 说明：预警名单的一票否决（C）在最前面已处理，此处不受其影响。
  const ov = getOverride(name, ctx);
  if (ov && ov.level) {
    // 只允许在 A3 / A4 之间调整：
    //  A3→A4：撤销提升；A4→A3：人工核实后提升。
    // 不允许改成其他级别 —— 收录状态（CSSCI/CSCD/中科院分区）由数据决定，
    // 人为改 A1/A2/B1/C 会绕过办法的认定规则，意义不大且易出错。
    const allowed = ov.level === 'A3' || ov.level === 'A4';
    if (allowed) {
      out.level = ov.level;
      out.overridden = true;
      out.reasons.push(
        `人工核实后覆盖为 ${ov.level}` +
        (ov.note ? `（依据：${ov.note}）` : '') +
        '，设置于 ' + (ov.at || '未知时间')
      );
      if (ov.level === 'A3') out.needVerify = false;
      return out;
    }
  }

  // ---- 6. A4：其余 CSSCI来源 / CSCD核心，或中科院 3/4 区 ----
  if (isCoreCn) {
    out.level = 'A4';
    out.reasons.push(
      (rec.c === 'source' ? 'CSSCI 来源期刊' : 'CSCD 核心库期刊') +
      '，未列入 A3 认定白名单'
    );
    // 显式提示：本刊主办单位尚未核实，若属省级"国家级学术刊物"认定范围可升 A3
    out.needVerify = true;
    return out;
  }
  if (rec.z === '3' || rec.z === '4') {
    out.level = 'A4';
    out.reasons.push(`中科院 SCI/SSCI 升级版 ${rec.z} 区（动态条款）`);
    return out;
  }

  // ---- 7. B1：CSSCI扩展 / CSCD扩展 / EI / A&HCI ----
  if (rec.c === 'ext' || rec.d === 'ext') {
    out.level = 'B1';
    out.reasons.push(rec.c === 'ext' ? 'CSSCI 扩展版来源期刊' : 'CSCD 扩展库期刊');
    return out;
  }
  if (rec.W && /AHCI/i.test(rec.W)) {
    out.level = 'B1';
    out.reasons.push('A&HCI 收录期刊');
    return out;
  }

  // ---- 8. 兜底 ----
  out.level = 'C';
  out.reasons.push('其他具有 CN/ISSN 的报刊');
  return out;
}

// 挂到 window 供 content script 使用（manifest 中两者为独立 script 标签）
if (typeof window !== 'undefined') {
  window.SxfxJudge = { norm, normBase, buildIndex, lookup, lookupIssn, judge, getOverride, LEVELS };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { norm, normBase, buildIndex, lookup, lookupIssn, judge, getOverride, LEVELS };
}
