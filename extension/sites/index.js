/**
 * 站点适配器
 *
 * 每个适配器负责：从页面 DOM 中找出「期刊名」所在��元素与结果条目容器。
 * 核心接口：
 *   match()  → 判断当前 URL 是否属于本站（入参是「站点标识」，非裸 host）
 *   find()   → 返回 [{ nameEl, container }]，nameEl 是刊名文本节点所在元素
 *
 * ── WebVPN 适配 ──────────────────────────────────────────────
 * 走学校 WebVPN 时，地址栏 host 会变成 webvpn.xxx.edu.cn，真实站点被编码进
 * 路径，形如：
 *   https://webvpn.xxx.edu.cn/https/77726476706e69737468656265737421.../kns.cnki.net/kns8/...
 * 此时裸 host 匹配必然失效，故先做一次「站点标识提取」：
 *   1) 若 host 本身是已知站点 → 直接用
 *   2) 否则在路径中搜索已知域名 → 用它
 * 这样 content.js 传入的 h 已是真实站点标识，各适配器无需关心 VPN。
 */

/** 已知站点域名（用于 WebVPN 路径反查） */
const KNOWN_HOSTS = [
  'kns.cnki.net',
  'www.cnki.net',
  'cnki.net',
  'webofscience.com',
  'clarivate.com',
  'scholar.google.com',
  'xueshu.baidu.com',
  'sciencedirect.com',
  'pubmed.ncbi.nlm.nih.gov',
  'link.springer.com',
  'semanticscholar.org',
];

/**
 * 从 href 提取真实站点标识（WebVPN 场景下会从路径里反查）
 * @returns {string} 站点标识；识别不出时返回原始 hostname
 */
function extractSiteKey(href) {
  let u;
  try {
    u = new URL(href);
  } catch (e) {
    return '';
  }
  const host = u.hostname;
  // 路径里先找已知域名（WebVPN 编码后仍会保留原始主机名）
  const path = decodeURIComponent(u.pathname || '');
  for (const kh of KNOWN_HOSTS) {
    if (path.includes(kh)) return kh;
  }
  return host;
}

/**
 * 按表头文字定位列序号（知网页面改版时的兜底方案）
 * 遍历 thead 里的 th，找文字含「来源 / 刊名 / 期刊」的列，返回其索引。
 * 找不到时返回 -1。
 */
let _srcColCache = null;
function sourceColIndex(doc) {
  const d = doc || document;
  if (_srcColCache !== null) return _srcColCache;
  let idx = -1;
  const heads = d.querySelectorAll(
    'table.result-table-list thead th, table.result-table-list thead td, thead th'
  );
  heads.forEach((th, i) => {
    if (idx >= 0) return;
    const t = (th.textContent || '').replace(/\s+/g, '');
    if (/^(来源|来源期刊|刊名|期刊|期刊名)$/.test(t) || /来源期刊|刊名/.test(t)) {
      idx = i;
    }
  });
  _srcColCache = idx;
  return idx;
}

const SITES = [
  // ---------------------------------------------------------- 知网 CNKI
  {
    id: 'cnki',
    name: '中国知网',
    match: (h) => h.includes('cnki.net'),
    find() {
      const out = [];

      // ── 检索结果页 ──
      // 表格结构：table.result-table-list > tbody > tr
      //   td.name  → 题名（论文标题，**不是刊名**）
      //   td.source→ 来源（**这才是刊名**）
      //   td.author / td.date / td.data / td.quote / td.download
      // ⚠️ 历史教训：曾误抓 a.fz14（题名）当刊名，导致一条都匹配不上。
      document
        .querySelectorAll('table.result-table-list tbody tr, tr.Js_Result_Item')
        .forEach((tr) => {
          // 优先取「来源」列的链接；无链接时取该单元格本身
          const src =
            tr.querySelector('td.source a') ||
            tr.querySelector('td[class*="source"] a') ||
            tr.querySelector('td.source') ||
            tr.querySelector('td[class*="source"]');
          if (src && src.textContent.trim()) {
            out.push({ nameEl: src, container: tr, kind: 'cnki-row' });
            return;
          }
          // 兜底：按表头「来源」列的序号取单元格
          const tds = tr.querySelectorAll('td');
          if (tds.length >= 3) {
            const idx = sourceColIndex(tr.ownerDocument);
            const cell = tds[idx];
            if (cell && cell.textContent.trim()) {
              out.push({ nameEl: cell, container: tr, kind: 'cnki-row-col' });
            }
          }
        });

      // ── 详情页 / 出版物检索页 ──
      if (!out.length) {
        document
          .querySelectorAll('.wx-tit h1, .tit h1, h1.c-title, .top-tip h1, .brief-tit h1')
          .forEach((h1) => {
            if (h1.textContent.trim().length <= 60) {
              out.push({ nameEl: h1, container: h1.parentElement, kind: 'cnki-detail' });
            }
          });
      }

      // ── 期刊主页（导航页）：<span class="wx-tit-h"> 之类 ──
      if (!out.length) {
        document.querySelectorAll('.journal-title, .wx-tit-h, [class*="journalName"]').forEach((el) => {
          if (el.textContent.trim() && el.textContent.trim().length <= 60) {
            out.push({ nameEl: el, container: el, kind: 'cnki-journal' });
          }
        });
      }
      return out;
    },
  },

  // ---------------------------------------------------------- Web of Science
  {
    id: 'wos',
    name: 'Web of Science',
    match: (h) => h.includes('webofscience') || h.includes('clarivate'),
    find() {
      const out = [];
      // 新版：app-records-list / .journal-title
      document
        .querySelectorAll('.app-records-list .record, .records-list .record, .journal-title')
        .forEach((el) => {
          const nameEl = el.classList.contains('journal-title')
            ? el
            : el.querySelector('.journal-title, .title-link');
          if (nameEl) out.push({ nameEl, container: el.closest('.record') || el, kind: 'wos' });
        });
      // 经典版：#APP_ISSUE_BROWSE / ctd.journal-title
      if (!out.length) {
        document.querySelectorAll('td.journal-title, .journalTitle, .jTitle').forEach((el) => {
          out.push({ nameEl: el, container: el.closest('tr') || el, kind: 'wos-classic' });
        });
      }
      return out;
    },
  },

  // ---------------------------------------------------------- Google Scholar
  {
    id: 'scholar',
    name: 'Google 学术',
    match: (h) => h.includes('scholar.google'),
    throttled: true, // 需限速，避免触发人机验证
    find() {
      const out = [];
      document.querySelectorAll('.gs_r.gs_or, .gs_ri').forEach((r) => {
        const nameEl = r.querySelector('.gs_a');
        if (nameEl) {
          out.push({
            nameEl,
            container: r,
            kind: 'gs',
            // Scholar 的刊名常被 "…" 截断，标记需要时补全
            truncated: nameEl.textContent.includes('…') || nameEl.textContent.includes('...'),
          });
        }
      });
      return out;
    },
  },

  // ---------------------------------------------------------- 百度学术
  {
    id: 'baidu',
    name: '百度学术',
    match: (h) => h.includes('xueshu.baidu.com'),
    find() {
      const out = [];
      document
        .querySelectorAll('.result-content-default, .sc_content, .result h3, tpl-book-right')
        .forEach((el) => {
          const nameEl =
            el.querySelector('.sc_journal, .sc_info, .source, .tpl-book-right') ||
            (el.classList && el.classList.contains('source') ? el : null);
          if (nameEl && nameEl.textContent.trim()) {
            out.push({ nameEl, container: el.closest('.result') || el, kind: 'baidu' });
          }
        });
      return out;
    },
  },

  // ---------------------------------------------------------- ScienceDirect
  {
    id: 'sd',
    name: 'ScienceDirect',
    match: (h) => h.includes('sciencedirect.com'),
    find() {
      const out = [];
      document
        .querySelectorAll('.result-list-title, .article-title-serial, a.article-title, .scimago-journal')
        .forEach((el) => {
          const nameEl = el.matches('a') ? el : el.querySelector('a') || el;
          out.push({ nameEl, container: el.closest('article') || el, kind: 'sd' });
        });
      return out;
    },
  },

  // ---------------------------------------------------------- PubMed
  {
    id: 'pubmed',
    name: 'PubMed',
    match: (h) => h.includes('pubmed.ncbi.nlm.nih.gov'),
    find() {
      const out = [];
      // 结果列表：<span class="docsum-title"> 内的 <a> 后跟期刊名
      document.querySelectorAll('.docsum-content, .full-docsum').forEach((d) => {
        const j = d.querySelector('.docsum-journal-citation.full-journal-citation, .docsum-journal-citation');
        if (!j) return;
        // 期刊名在 citation 里是最后一个 span，通常是第 3 个
        const spans = j.querySelectorAll('span');
        let nameEl = spans[spans.length - 1] || j;
        // 也支持 <a class="journal-link">
        const a = j.querySelector('a.journal-link');
        if (a) nameEl = a;
        out.push({ nameEl, container: d, kind: 'pubmed' });
      });
      return out;
    },
  },

  // ---------------------------------------------------------- Springer
  {
    id: 'springer',
    name: 'Springer',
    match: (h) => h.includes('link.springer.com'),
    find() {
      const out = [];
      document
        .querySelectorAll('.title, .journal-title, .u-text-h4 a, [data-title="journal-title"]')
        .forEach((el) => {
          const nameEl = el.querySelector('a') || el;
          if (nameEl.textContent.trim().length < 80) {
            out.push({ nameEl, container: el.closest('article') || el, kind: 'springer' });
          }
        });
      return out;
    },
  },

  // ---------------------------------------------------------- Semantic Scholar
  {
    id: 's2',
    name: 'Semantic Scholar',
    match: (h) => h.includes('semanticscholar.org'),
    find() {
      const out = [];
      document
        .querySelectorAll('.venue, .venue-tooltip, [data-selenium-selector="title-link"]')
        .forEach((el) => {
          out.push({ nameEl: el, container: el.closest('div[data-selenium-selector]') || el, kind: 's2' });
        });
      return out;
    },
  },
];

/** 按当前 URL 找出匹配的适配器 */
function resolveSite(href) {
  // WebVPN 场景：host 是 webvpn.xxx.edu.cn，需从路径反查真实站点
  const key = extractSiteKey(href);
  if (!key) return null;
  for (const s of SITES) {
    try {
      if (s.match(key)) return s;
    } catch (e) {
      /* 忽略单个适配器的匹配异常 */
    }
  }
  return null;
}

if (typeof window !== 'undefined') {
  window.SxfxSites = { SITES, resolveSite, extractSiteKey };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SITES, resolveSite, extractSiteKey };
}
