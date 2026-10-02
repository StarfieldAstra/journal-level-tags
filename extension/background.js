/**
 * Service Worker（Manifest V3）
 *
 * 职责：
 *  1. 首次安装时打开说明页
 *  2. **代读数据集**（readData）——content script 直接 fetch 扩展内资源在 MV3 下
 *     需依赖 web_accessible_resources，且可能受目标站点 CSP 限制；由 SW 代读可绕开。
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/guide.html') });
  }
});

// 数据缓存，避免每次都读盘
let cache = null;

async function readDataFile(name) {
  // 只允许读 data/ 下的白名单文件，避免被当成任意文件读取通道
  const ALLOW = { 'journals.json': 1, 'cas_detail.json': 1 };
  if (!ALLOW[name]) throw new Error('不允许的文件: ' + name);

  if (cache && cache[name]) return cache[name];

  const res = await fetch(chrome.runtime.getURL('data/' + name));
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();

  if (!cache) cache = {};
  cache[name] = json;
  return json;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'readData') {
    readDataFile(msg.name)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }
  return false;
});
