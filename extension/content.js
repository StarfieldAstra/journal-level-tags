/**
 * 内容脚本主逻辑
 *
 * 流程：加载数据 → 解析站点 → 扫描刊名 → 判定 → 注入标签
 * 全程本地，不发起任何网络请求。
 */
(function () {
  'use strict';

  if (window.__sxfxLoaded) return;
  window.__sxfxLoaded = true;

  // judge.js 与 sites/index.js 由 manifest 按序注入
  const { norm, buildIndex, judge } = window.SxfxJudge || {};
  const { resolveSite } = window.SxfxSites || {};

  if (!judge || !resolveSite) {
    console.warn('[山财期刊标签] 依赖未就绪');
    return;
  }

  const NS = 'sxfx';
  let CTX = null; // { journals, idx, meta, detail, overrides }
  let SITE = null;
  let enabled = true;
  const showAux = true; // 是否显示 CSSCI/CSCD/分区辅助标签
  let injected = new WeakSet(); // 防止同一元素重复注入（rerenderAll 时会重置）
  const OVERRIDE_KEY = 'overrides';

  /** 读取人工覆盖表（用户在设置面板里核实过的 A3/A4 调整） */
  async function loadOverrides() {
    try {
      const st = await chrome.storage.local.get({ [OVERRIDE_KEY]: {} });
      return st[OVERRIDE_KEY] || {};
    } catch (e) {
      return {};
    }
  }

  /** 写入一条覆盖；level 传 null 表示删除 */
  async function setOverride(journalName, level, note) {
    const map = await loadOverrides();
    const k = normBase(journalName);
    if (!k) return { ok: false, error: '刊名为空' };
    if (level) {
      map[k] = { level, at: new Date().toISOString().slice(0, 10), note: note || '' };
    } else {
      delete map[k];
    }
    await chrome.storage.local.set({ [OVERRIDE_KEY]: map });
    if (CTX) CTX.overrides = map;
    return { ok: true, count: Object.keys(map).length };
  }

  // ------------------------------------------------------------ 数据加载
  /**
   * 加载内置数据集。
   *
   * ⚠️ 两条路径都要留。Manifest V3 下 content script 用 fetch 读扩展内资源，
   *    该资源必须声明在 manifest 的 web_accessible_resources 里，否则被拦成
   *    `Failed to fetch`；而某些站点的 CSP 又可能进一步限制 fetch。
   *    所以：先直连 fetch，失败则改走 service worker 中转（不受页面 CSP 影响）。
   */
  async function fetchJson(name) {
    const url = chrome.runtime.getURL('data/' + name);
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      // 兜底：让 service worker 代读
      const viaMsg = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ type: 'readData', name }, (resp) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            if (!resp || !resp.ok) return reject(new Error(resp && resp.error) || 'no response');
            resolve(resp.data);
          });
        } catch (e2) {
          reject(e2);
        }
      });
      return viaMsg;
    }
  }

  async function loadData() {
    const main = await fetchJson('journals.json');
    // 明细文件缺失不致命（只影响悬停时的小类分区展示）
    let detail = {};
    try {
      detail = await fetchJson('cas_detail.json');
    } catch (e) {
      detail = {};
    }
    if (!main || !main.journals) throw new Error('journals.json 结构异常');
    const overrides = await loadOverrides();
    CTX = {
      journals: main.journals,
      meta: main.meta,
      detail,
      overrides,
      idx: buildIndex(main.journals),
    };
  }

  // ------------------------------------------------------------ 刊名清洗
  /** 从页面文本中提取干净刊名 */
  function cleanName(raw) {
    let s = (raw || '').trim();
    if (!s) return '';
    // 去掉常见的"年份,卷(期):页码"尾巴
    s = s.replace(/[,，]?\s*(19|20)\d{2}\s*年?.*$/, '');
    s = s.replace(/[,，]\s*\d+\s*卷.*$/, '');
    s = s.replace(/[,，]\s*第?\s*\d+\s*期.*$/, '');
    s = s.replace(/[,，]\s*\d+\s*[-,–]\s*\d+\s*页.*$/, '');
    // 去掉首尾的 · 空格 破折号
    s = s.replace(/^[\s·•\-–—|:：]+/, '').replace(/[\s·•\-–—|:：]+$/, '');
    // 去掉尾部多余括号（但保留"（英文版）"这类有信息的）
    return s.trim();
  }

  /** CNKI/WoS 详情页可能带副标题，截取主刊名做一次匹配 */
  function candidateNames(raw) {
    const base = cleanName(raw);
    const list = [base];
    if (!base) return list;
    // "经济学(季刊)" → 同时试 "经济学"
    const m = base.match(/^(.+?)[（(][^）)]*[）)]\s*$/);
    if (m && m[1]) list.push(m[1].trim());
    // "中国科学: 化学" → "中国科学"
    if (base.includes(':') || base.includes('：')) {
      list.push(base.split(/[:：]/)[0].trim());
    }
    return list.filter(Boolean);
  }

  // ------------------------------------------------------------ 标签渲染
  function levelClass(lv) {
    return NS + '-lv-' + (lv || 'none');
  }

  function makeTag(text, cls, title) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    if (title) el.title = title;
    el.setAttribute('data-sxfx', '1');
    return el;
  }

  function popRow(k, v) {
    return (
      '<div class="' + NS + '-pop-row"><span class="' + NS + '-pop-k">' +
      k + '</span><span class="' + NS + '-pop-v">' + v + '</span></div>'
    );
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 当前展开浮层的锚点与结果，供覆盖后重绘使用 */
  let curAnchor = null;
  let curRes = null;

  function buildPopup(res) {
    const rec = res.record;
    const lv = res.level || '—';
    const box = document.createElement('div');
    box.className = NS + '-pop';

    let html =
      '<div class="' + NS + '-pop-title">' +
      '<span class="' + NS + '-pop-lv ' + levelClass(res.level) + '">' + esc(lv) + '</span>' +
      '<span>' + esc(rec ? rec.n : res.name) + '</span></div>';

    if (rec) {
      if (rec.i) html += popRow('ISSN', esc(rec.i));
      if (rec.j) html += popRow('学科', esc(rec.j));

      // 收录库
      const dbs = [];
      if (rec.c === 'source') dbs.push('CSSCI 来源期刊');
      else if (rec.c === 'ext') dbs.push('CSSCI 扩展版');
      if (rec.d === 'core') dbs.push('CSCD 核心库');
      else if (rec.d === 'ext') dbs.push('CSCD 扩展库');
      if (rec.b) dbs.push('北大核心（中文核心期刊要目总览）');
      if (dbs.length) html += popRow('收录', esc(dbs.join('、')));

      // 中科院分区
      if (rec.z) {
        html += popRow(
          '中科院',
          '大类 ' + esc(rec.M || '—') + ' <b>' + esc(rec.z) + ' 区</b>' +
            (rec.T ? ' <span style="color:#B45309">Top</span>' : '')
        );
        const minors = CTX.detail && CTX.detail[res.key];
        if (minors && minors.length) {
          const lis = minors
            .map(
              (m) =>
                '<li><span>' + esc(m[0]) + '</span><span>' + esc(m[1]) + '区</span></li>'
            )
            .join('');
          html +=
            '<div class="' + NS + '-pop-row"><span class="' + NS + '-pop-k">小类</span>' +
            '<span class="' + NS + '-pop-v"><ul class="' + NS + '-pop-minors">' + lis + '</ul></span></div>';
        }
        html += popRow('WOS', esc(rec.W || '—'));
        html += popRow('版本', '中科院 2025 年版（终版）');
      }

      if (rec.H) html += popRow('主办', esc(rec.H));
      if (rec.w) html += popRow('预警', esc(rec.w) + ' 年' + (rec.y ? '：' + esc(rec.y) : ''));
    }

    if (res.reasons && res.reasons.length) {
      html +=
        '<div class="' + NS + '-pop-reason">' + esc(res.reasons.join('；')) + '</div>';
    }
    if (res.needVerify) {
      html +=
        '<div class="' + NS + '-pop-warn">本刊主办单位尚未录入 A3 认定名单。' +
        '若属山西省教育厅「国家级学术刊物」认定范围，实际可按 A3 认定，可在此手动升级。</div>';
    }
    if (res.overridden) {
      html +=
        '<div class="' + NS + '-pop-ov">已按人工核实的级别认定</div>';
    }

    // 人工覆盖按钮：仅对 A3 / A4 开放
    if (res.record && (res.level === 'A3' || res.level === 'A4')) {
      const toA3 = res.level === 'A4';
      // 「撤销」针对的是**白名单判错的 A3**，必须写入一条显式的 A4 覆盖；
      // 若只是删除覆盖记录，白名单仍会把它判回 A3，等于没点。
      const label = toA3
        ? '主办单位属国家级 → 升为 A3'
        : res.overridden
          ? '撤销人工提升，恢复自动判定'
          : '白名单有误 → 降为 A4';
      html +=
        '<div class="' + NS + '-pop-act">' +
        '<button class="' + NS + '-pop-btn' + (toA3 ? ' primary' : '') + '" data-sxfx-act="' +
        (toA3 ? 'to-a3' : 'to-a4') + '">' + label + '</button></div>';
    }

    html +=
      '<div class="' + NS + '-pop-foot">依据本校科研成果管理办法｜' +
      'CSSCI 2025-2026｜CSCD 2025-2026｜中科院 2025 终版</div>';

    box.innerHTML = html;

    // 绑定按钮
    const btn = box.querySelector('[data-sxfx-act]');
    if (btn) {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const name = (res.record && res.record.n) || res.name;
        const act = btn.getAttribute('data-sxfx-act');
        btn.disabled = true;
        btn.textContent = '保存中…';
        // 降为 A4 时写入显式的 A4 覆盖（而非删除记录），
        // 否则白名单命中时仍会判回 A3 —— 这正是此前按钮无效的原因。
        const target = act === 'to-a3' ? 'A3' : 'A4';
        const r = await setOverride(name, target, act === 'to-a3' ? '人工核实主办单位' : '白名单有误，人工降级');
        if (!r.ok) {
          btn.textContent = '保存失败：' + (r.error || '未知错误');
          return;
        }
        // 覆盖已保存：重绘标签让新级别立即生效。
        // 注意不能重开浮层——rerenderAll 会移除旧标签 DOM，锚点元素已失效。
        rerenderAll();
        flashHint('已将《' + name + '》认定为 ' + fresh.level);
      });
    }
    return box;
  }

  /** 短暂的提示条，告知覆盖已生效 */
  let hintTimer = null;
  function flashHint(text) {
    let el = document.getElementById(NS + '-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = NS + '-hint';
      el.className = NS + '-hint';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (el.style.display = 'none'), 2600);
  }

  /**
   * 重绘全部已注入的标签。
   * 覆盖级别后需要重算标签，WeakSet 不可遍历，故按标记反查并整体重建。
   * 标签本身用 [data-sxfx]，行容器用 [data-sxfx-line]，两者都要清。
   */
  function rerenderAll() {
    closePop();
    document.querySelectorAll('[data-sxfx-line]').forEach((el) => el.remove());
    document.querySelectorAll('[data-sxfx]').forEach((el) => el.remove());
    resetInjected();
    scan();
  }

  function resetInjected() {
    injected = new WeakSet();
  }

  let curPop = null;
  function closePop() {
    if (curPop) {
      curPop.remove();
      curPop = null;
    }
  }
  document.addEventListener(
    'click',
    (e) => {
      // 点在标签行容器的空白处也应关闭浮层，故两个标记都算
      if (curPop && !curPop.contains(e.target)) {
        const inTag = e.target.closest && (
          e.target.closest('[data-sxfx]') || e.target.closest('[data-sxfx-line]')
        );
        if (!inTag) closePop();
      }
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePop();
  });

  function openPop(anchor, res) {
    closePop();
    curAnchor = anchor;
    curRes = res;
    const box = buildPopup(res);
    document.body.appendChild(box);

    const r = anchor.getBoundingClientRect();
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    let left = r.left + window.scrollX;
    let top = r.bottom + window.scrollY + 5;

    // 边界修正
    if (left + bw > window.scrollX + document.documentElement.clientWidth - 8) {
      left = window.scrollX + document.documentElement.clientWidth - bw - 8;
    }
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    if (top + bh > window.scrollY + document.documentElement.clientHeight - 8) {
      top = r.top + window.scrollY - bh - 5;
    }
    if (top < window.scrollY + 8) top = window.scrollY + 8;

    box.style.left = left + 'px';
    box.style.top = top + 'px';
    curPop = box;
  }

  // ------------------------------------------------------------ 注入
  function injectOne(item) {
    const { nameEl, container } = item;
    if (!nameEl || injected.has(nameEl) || !nameEl.parentElement) return;

    const raw = nameEl.textContent;
    if (!raw || !raw.trim()) return;

    // 先用完整刊名试，再退化到候选名
    let res = null;
    for (const cand of candidateNames(raw)) {
      res = judge(cand, CTX);
      if (res.record) break;
    }
    if (!res) return;

    // 未收录且非预警的刊不显示标签（避免满屏 C 级噪声）
    const rec = res.record;
    // rec.b = 北大核心：虽无 CSSCI/CSCD，但可判 B1 级，故也需显示
    const isInteresting =
      rec &&
      (rec.c || rec.d || rec.z || rec.s || rec.w || rec.b);
    if (!isInteresting) return;

    // 整组标签放进一个 block 级容器 —— 必然另起一行，不受刊名长短影响。
    // 若直接作为刊名的兄弟节点插入，会跟着刊名文字流走：
    // 刊名短则与刊名同行，刊名长则被挤到第二行，位置参差不齐。
    const line = document.createElement('span');
    line.className = NS + '-tagline';
    line.setAttribute('data-sxfx-line', '1');   // 容器单独标记，避免与标签混算

    // 主标签：级别
    const main = makeTag(
      res.level || '未认定',
      NS + '-tag ' + levelClass(res.level),
      '本校期刊级别：' + (res.level || '未认定')
    );
    main.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPop(main, res);
    });
    line.appendChild(main);

    // 辅助标签
    if (showAux) {
      for (const b of res.badges) {
        if (b.k === 'top') continue; // Top 已并入分区标签
        const t = makeTag(b.t, NS + '-tag ' + NS + '-aux ' + NS + '-' + b.k, b.t);
        t.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPop(t, res);
        });
        line.appendChild(t);
      }
    }

    // 插到刊名之后、同一父元素内（保持 DOM 上下文，避免跨结构错位）
    nameEl.parentElement.insertBefore(line, nameEl.nextSibling);
    injected.add(nameEl);
  }

  function scan() {
    if (!CTX || !SITE || !enabled) return;
    let items;
    try {
      items = SITE.find() || [];
    } catch (e) {
      DIAG.error = 'find() 异常: ' + (e && e.message);
      items = [];
    }
    DIAG.found = items.length;

    let matched = 0;
    let tagged = 0;
    let auxTotal = 0;   // 应渲染的辅助标签总数
    let auxShown = 0;   // 实际在视口内可见的辅助标签数
    const misses = [];
    for (const it of items) {
      const before = document.querySelectorAll('[data-sxfx]').length;
      injectOne(it);
      const after = document.querySelectorAll('[data-sxfx]').length;
      if (after > before) tagged++;

      // 统计辅助标签：应渲染数 vs 实际可见数
      // 若 auxTotal > auxShown，说明标签被页面 CSS 裁剪（如 td 固定宽度 + overflow:hidden）
      if (after > before && showAux) {
        const raw2 = it.nameEl && it.nameEl.textContent ? cleanName(it.nameEl.textContent) : '';
        if (raw2) {
          let rr = null;
          for (const c of candidateNames(raw2)) {
            rr = judge(c, CTX);
            if (rr.record) break;
          }
          if (rr && rr.record) {
            const expect = (rr.badges || []).filter((b) => b.k !== 'top').length;
            auxTotal += expect;
            // 实际可见：元素存在且有非零尺寸
            const scope = it.nameEl.parentElement || it.nameEl;
            const rendered = (scope.querySelectorAll
              ? scope.querySelectorAll('.' + NS + '-aux')
              : []
            );
            for (let i = 0; i < rendered.length; i++) {
              const rect = rendered[i].getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) auxShown++;
            }
          }
        }
      }

      // 诊断：记录未命中的刊名样本
      const raw = it.nameEl && it.nameEl.textContent ? cleanName(it.nameEl.textContent) : '';
      if (raw) {
        let r = null;
        for (const c of candidateNames(raw)) {
          r = judge(c, CTX);
          if (r.record) break;
        }
        if (r && r.record) matched++;
        else if (misses.length < 12) misses.push(raw.slice(0, 30));
      }
    }
    DIAG.matched = matched;
    DIAG.tagged = tagged;
    DIAG.auxTotal = auxTotal;
    DIAG.auxShown = auxShown;
    DIAG.misses = misses;
  }

  /** 诊断信息：供 popup / 控制台排查"为什么不显示" */
  const DIAG = {
    site: null,
    found: 0,
    matched: 0,
    tagged: 0,
    auxTotal: 0,
    auxShown: 0,
    misses: [],
    error: null,
  };

  // ------------------------------------------------------------ 动态内容
  let moTimer = null;
  function observe() {
    const mo = new MutationObserver(() => {
      if (moTimer) clearTimeout(moTimer);
      moTimer = setTimeout(scan, 260);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ------------------------------------------------------------ 启动
  async function boot() {
    SITE = resolveSite(location.href);
    DIAG.site = SITE ? SITE.id : null;
    if (!SITE) {
      DIAG.error = '当前站点未适配：' + location.hostname;
      return;
    }

    try {
      const st = await chrome.storage.local.get({ enabled: true });
      enabled = st.enabled !== false;
    } catch (e) {
      /* 忽略存储异常 */
    }
    if (!enabled) {
      DIAG.error = '插件已在设置面板中关闭';
      return;
    }

    try {
      await loadData();
    } catch (e) {
      const msg = (e && e.message) || String(e);
      DIAG.error =
        '数据加载失败：' + msg +
        '。若提示 Failed to fetch，请检查 manifest.json 是否仍保留 ' +
        'web_accessible_resources 中的 data/journals.json（MV3 下必需）。';
      console.error('[山财期刊标签] 数据加载失败', e);
      return;
    }

    // 等页面真正渲染完（easyScholar 同思路：load 后再工作）
    if (document.readyState === 'complete') {
      setTimeout(scan, 400);
    } else {
      window.addEventListener('load', () => setTimeout(scan, 600), { once: true });
    }
    observe();
  }

  // 供 popup 触发即时重扫
  chrome.runtime.onMessage.addListener((msg, _s, sendResp) => {
    if (msg && msg.type === 'rescan') {
      closePop();
      scan();
      sendResp({
        ok: true,
        site: SITE ? SITE.id : null,
        diag: Object.assign({}, DIAG),
      });
    }
    if (msg && msg.type === 'getState') {
      sendResp({
        ok: true,
        site: SITE ? SITE.name : null,
        enabled,
        meta: CTX ? CTX.meta : null,
        diag: Object.assign({}, DIAG),
      });
    }
    return true;
  });

  // 控制台调试入口
  window.__sxfxDiag = () =>
    Object.assign(
      {
        site: SITE ? SITE.id : null,
        dataLoaded: !!CTX,
        totalJournals: CTX ? Object.keys(CTX.journals).length : 0,
        injectedTags: document.querySelectorAll('[data-sxfx]').length,
      },
      DIAG
    );

  boot();
})();
