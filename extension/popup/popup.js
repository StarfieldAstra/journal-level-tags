/**
 * Popup 逻辑：显示数据版本、开关、重扫
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** HTML 转义，防止错误信息里的特殊字符破坏面板结构 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  const LEVELS = ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'C'];

  // 级别色 —— iOS 系统语义色（须与 style.css 保持一致）
  const COLORS = {
    A1: '#FF3B30', // systemRed
    A2: '#FF9500', // systemOrange
    A3: '#30B0C7', // systemTeal
    A4: '#007AFF', // systemBlue
    B1: '#5856D6', // systemIndigo
    B2: '#AF52DE', // systemPurple
    C:  '#8E8E93', // systemGray
  };
  // 图例下方的简短说明
  const LEVEL_NOTE = {
    A1: '校级顶尖', A2: '校级重点', A3: '国家级', A4: '核心库',
    B1: '扩展版', B2: 'AMI', C: '其他',
  };

  // 图例
  $('legend').innerHTML = LEVELS.map(
    (l) =>
      '<div class="u"><div class="b" style="background:' + COLORS[l] + '">' + l + '</div>' +
      '<div class="n">' + (LEVEL_NOTE[l] || '') + '</div></div>'
  ).join('');

  // 开关
  const cb = $('enabled');
  chrome.storage.local.get({ enabled: true }, (st) => {
    cb.checked = st.enabled !== false;
  });
  cb.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: cb.checked }, () => {
      // 通知所有标签页刷新状态
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((t) => {
          if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'rescan' }, () => void chrome.runtime.lastError);
        });
      });
    });
  });

  // 重新扫描
  $('rescan').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (!t) return;
      chrome.tabs.sendMessage(t.id, { type: 'rescan' }, (resp) => {
        const btn = $('rescan');
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          btn.textContent = '当前页面未激活插件（请刷新页面后重试）';
        } else {
          renderDiag(resp.site, resp.diag);
          btn.textContent = '扫描完成';
        }
        setTimeout(() => (btn.textContent = '重新扫描当前页面'), 2200);
      });
    });
  });

  // ---- 诊断渲染 ----
  const SITE_CN = {
    cnki: '中国知网', wos: 'Web of Science', scholar: 'Google 学术',
    baidu: '百度学术', sd: 'ScienceDirect', pubmed: 'PubMed',
    springer: 'Springer', s2: 'Semantic Scholar',
  };

  function renderDiag(siteId, d) {
    const box = $('diag');
    const body = $('diagBody');
    if (!d) { box.style.display = 'none'; return; }
    box.style.display = 'block';

    const name = SITE_CN[siteId] || siteId || '未识别站点';
    const rows = [];

    rows.push(['站点', name, '']);
    if (d.error) {
      rows.push(['状态', d.error, 'bad']);
    } else {
      rows.push(['页面识别到结果', d.found || 0, d.found ? 'good' : 'bad']);
      rows.push(['匹配到数据集', d.matched || 0, d.matched ? 'good' : 'bad']);
      rows.push(['已挂标签', d.tagged || 0, d.tagged ? 'good' : 'bad']);
    }

    let html = rows
      .map(
        (r) =>
          '<div class="diag-r"><span class="k">' + r[0] + '</span><span class="v ' +
          (r[2] || '') + '">' + r[1] + '</span></div>'
      )
      .join('');

    if (!d.error && !d.found) {
      html +=
        '<div class="diag-err">没找到任何刊名元素 —— 该站点选择器可能已失效，' +
        '或页面结构与预期不同。请在控制台执行 <code>__sxfxDiag()</code> 查看详情。</div>';
    } else if (d.misses && d.misses.length) {
      html +=
        '<div class="diag-miss">未收录（不显示标签属正常）：' +
        d.misses.map((m) => esc(m)).join('、') +
        '</div>';
    }
    body.innerHTML = html;
  }

  // 打开 popup 即拉取当前页状态
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    if (!t) return;
    chrome.tabs.sendMessage(t.id, { type: 'getState' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      // getState 时页面可能还没扫过，主动补一次
      if (resp.diag && resp.diag.found) renderDiag(resp.diag.site, resp.diag);
      else chrome.tabs.sendMessage(t.id, { type: 'rescan' }, () => void chrome.runtime.lastError);
    });
  });

  // ---- 人工覆盖管理 ----
  const OV_KEY = 'overrides';
  const OV_COLORS = { A3: '#30B0C7', A4: '#007AFF' };

  function getOverrides() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [OV_KEY]: {} }, (st) => resolve(st[OV_KEY] || {}));
    });
  }
  function setOverrides(map) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [OV_KEY]: map }, () => resolve());
    });
  }

  async function renderOverrides() {
    const map = await getOverrides();
    const keys = Object.keys(map);
    const n = keys.length;
    $('ovCount').textContent = n ? n + ' 条记录' : '暂无调整记录';
    $('ovArrow').textContent = n ? '▾' : '▸';

    const list = $('ovList');
    if (!n) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = keys
      .map((k) => {
        const v = map[k];
        return (
          '<div class="ov-item" data-k="' + esc(k) + '">' +
          '<span class="ov-lv" style="background:' + (OV_COLORS[v.level] || '#6B7280') + '">' +
          esc(v.level) + '</span>' +
          '<span class="nm" title="' + esc(k) + '">' + esc(k) + '</span>' +
          '<span class="dt">' + esc(v.at || '') + '</span>' +
          '<button class="ov-del" title="删除这条记录">×</button>' +
          '</div>'
        );
      })
      .join('');

    // 删除单条
    list.querySelectorAll('.ov-del').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = btn.closest('.ov-item');
        const k = item.getAttribute('data-k');
        const m = await getOverrides();
        delete m[k];
        await setOverrides(m);
        await renderOverrides();
        notifyTabs();
      });
    });
  }

  function notifyTabs() {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((t) => {
        if (t.id != null) {
          chrome.tabs.sendMessage(t.id, { type: 'rescan' }, () => void chrome.runtime.lastError);
        }
      });
    });
  }

  $('ovToggle').addEventListener('click', () => {
    const p = $('ovPanel');
    const show = p.style.display === 'none';
    p.style.display = show ? 'block' : 'none';
    $('ovArrow').textContent = show ? '▾' : '▸';
  });

  $('ovExport').addEventListener('click', async () => {
    const map = await getOverrides();
    if (!Object.keys(map).length) {
      alert('暂无调整记录可导出。');
      return;
    }
    const blob = new Blob([JSON.stringify(map, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '山财期刊级别调整_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('ovImport').addEventListener('click', () => $('ovFile').click());
  $('ovFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('文件格式不是对象');
      }
      // 校验每条结构，只接受 A3 / A4
      const clean = {};
      let skipped = 0;
      Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (v && (v.level === 'A3' || v.level === 'A4')) {
          clean[k] = { level: v.level, at: v.at || new Date().toISOString().slice(0, 10), note: v.note || '导入' };
        } else {
          skipped++;
        }
      });
      const cur = await getOverrides();
      const merged = Object.assign({}, cur, clean);
      await setOverrides(merged);
      await renderOverrides();
      notifyTabs();
      alert(
        '导入完成：新增/更新 ' + Object.keys(clean).length + ' 条' +
        (skipped ? '，跳过 ' + skipped + ' 条非法记录' : '') +
        '\n当前共 ' + Object.keys(merged).length + ' 条'
      );
    } catch (err) {
      alert('导入失败：' + err.message);
    }
    e.target.value = '';
  });

  $('ovClear').addEventListener('click', async () => {
    const map = await getOverrides();
    const n = Object.keys(map).length;
    if (!n) return;
    if (!confirm('确定清空全部 ' + n + ' 条人工调整记录？\n此操作不可撤销。')) return;
    await setOverrides({});
    await renderOverrides();
    notifyTabs();
  });

  renderOverrides();

  // 数据版本信息（走 service worker 代读，避开 fetch/CSP 问题）
  function readData(name) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'readData', name }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || '无响应'));
        resolve(resp.data);
      });
    });
  }

  readData('journals.json')
    .then((d) => {
      const m = d.meta, c = m.counts;
      $('ver').textContent = 'v' + m.version + ' · 构建于 ' + m.built;
      const rows = [
        ['CSSCI 来源版', c.cssciSource],
        ['CSSCI 扩展版', c.cssciExt],
        ['CSCD 核心库', c.cscdCore],
        ['CSCD 扩展库', c.cscdExt],
        ['中科院分区', c.cas],
        ['A3 认定名单', m.a3count],
        ['预警名单', c.warning],
        ['条目合计', c.total],
      ];
      $('info').innerHTML = rows
        .map(
          (r) =>
            '<div class="stat"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>'
        )
        .join('');
      $('warn').style.display = 'block';
      $('warn').innerHTML =
        '中科院期刊分区表自 <b>2026 年起已停止更新</b>，本插件内置的是 <b>2025 年版（终版）</b>，' +
        '此后不会变化。级别判定依据本校科研成果管理办法。';
    })
    .catch((e) => {
      $('ver').textContent = '数据加载失败';
      $('warn').style.display = 'block';
      $('warn').innerHTML =
        '<b>无法读取内置数据集</b><br>' + esc(e.message) +
        '<br>请到扩展管理页确认 manifest.json 的 web_accessible_resources 仍包含 ' +
        'data/journals.json，然后点「重新加载」扩展。';
    });
})();
