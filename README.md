# 期刊级别标签（Journal Level Tags）

在 **知网、Web of Science、Google 学术** 等学术检索平台的检索结果里，直接在刊名旁显示期刊评价标签：

- **CSSCI** 来源版 / 扩展版
- **CSCD** 核心库 / 扩展库
- **中科院分区**（含大类与小类）
- **期刊级别** A1 / A2 / A3 / A4 / B1 / B2 / C（依据本校科研成果管理办法）

**完全本地运行** —— 不发起任何网络请求，数据内置，断网可用，检索记录不外泄。

---

## 安装（Chrome / Edge / 其他 Chromium 内核浏览器）

1. 前往 [Releases](../../releases) 下载最新版本的 `journal-level-tags-v*.zip`
2. 解压到任意目录
3. 打开扩展管理页
   - Chrome / Edge：地址栏输入 `chrome://extensions` 或 `edge://extensions`
   - 其他 Chromium 内核浏览器：`about:extensions`
4. 开启右上角 **「开发者模式」**
5. 点击 **「加载已解压的扩展程序」**，选择刚才解压出的目录
6. 完成。打开知网检索，刊名后即出现标签

> 更新版本后在扩展卡片上点「刷新」；若标签没变化，再刷新目标页面。

---

## 使用

### 基本操作

检索结果页的刊名后会显示级别标签：

| 标签 | 含义 |
|---|---|
| `A1` `A2` `A3` `A4` | 校级期刊级别（由高到低） |
| `B1` `B2` | 扩展版 / AMI 核心 |
| `C` | 其他 CN/ISSN 报刊 |
| `CSSCI` `CSCD核心` | 收录情况 |
| `中科院1区` … | 中科院分区（2025 终版） |

**点击任一标签**展开详情浮层：ISSN、收录库、主办单位、中科院大类与小类分区、完整判定理由。

设置面板（点击工具栏图标）提供开关、级别图例、数据版本、覆盖记录管理与本页诊断。

### 校级 WebVPN 用户

通过校园 WebVPN 访问学术数据库时，地址栏域名会变成 VPN 代理域名，插件可能无法自动识别。
解决办法：在 `extension/manifest.json` 的 `content_scripts.matches` 与 `host_permissions` 中
补上你所在学校的 VPN 域名（两处都要加），站点识别逻辑无需改动。

---

## 功能说明

### 级别判定规则

| 级别 | 认定口径 |
|---|---|
| **A1** | 附件所列 11 种期刊；或被《新华文摘》全文转载 |
| **A2** | 附件所列 46 种期刊；或中科院 SCI/SSCI **1 区** |
| **A3** | 附件目录外的 CSSCI 来源 / CSCD 核心期刊，**且**满足省级主管部门「国家级学术刊物」认定；或中科院 **2 区** |
| **A4** | 附件目录外的 CSSCI 来源 / CSCD 核心期刊；或中科院 **3、4 区** |
| **B1** | CSSCI 扩展版、CSCD 扩展库、北大核心、EI（JA）、A&HCI |
| **B2** | 社科院 AMI 核心期刊 |
| **C** | 其他 CN/ISSN 报刊；**列入中科院国际期刊预警名单者直接按 C** |

判定优先级：**预警名单（一票否决 → C）> A1 目录 > A2 目录 > 中科院1区 > A3 附条件 > 中科院2区 > A4 > B1**

### A3 人工覆盖

A3 要求核实期刊的**主办单位性质**，而该数据无法自动获取（知网、维普等平台均有反爬验证）。
因此插件采用「白名单 + 人工覆盖」双轨：

- 命中内置白名单 → 判 A3
- 未命中 → 判 A4，此时**详情浮层里会出现「主办单位属国家级 → 升为 A3」按钮**

覆盖规则：

- 只允许在 **A3 ↔ A4** 之间调整（收录状态由数据决定，不允许人为改 A1/A2/B1/C）
- **预警名单的一票否决优先于覆盖**
- 记录存于浏览器本地，永久生效，不上传任何数据
- 设置面板可查看、逐条删除、导出/导入备份、清空

---

## 数据版本

| 数据 | 版本 | 规模 |
|---|---|---|
| CSSCI | 2025–2026 | 来源版 671 + 扩展版 261 |
| CSCD | 2025–2026 | 核心库 1110 + 扩展库 366 |
| 中科院分区 | **2025 年版（终版）** | 21772 条 |
| 校级 A 级期刊目录 | — | A1 目录 11 种 + A2 目录 46 种 |
| 国际期刊预警 | 2020–2025 累计 | 134 种 |

> **关于中科院分区表**：中国科学院文献情报中心已公告，自 2026 年起不再更新与发布期刊分区表。
> 本插件内置的 2025 年 3 月 20 日版本是**最后一版**，此后不会过期，但也不会再有新版。

---

## 隐私

**本扩展不收集、不传输、不共享任何用户个人信息。**

- 运行时不发起任何网络请求，所有数据内置于安装包
- 不采集浏览历史、检索关键词、论文内容
- 站点权限仅用于读取结果页中已公开展示的**刊名文本**
- 本地存储仅含开关状态与手动调整的级别记录，卸载即彻底删除
- 不含任何远程代码

详见 [`extension/privacy-policy.html`](extension/privacy-policy.html)。

---

## 开发者文档

### 目录结构

```
extension/              ← 「加载已解压的扩展程序」选这一层
├── manifest.json       扩展清单（Manifest V3）
├── content.js          注入主逻辑：扫描刊名 → 判定 → 挂标签
├── style.css           标签与浮层样式
├── background.js       Service Worker（数据代读兜底）
├── core/judge.js       级别判定引擎（纯函数，可独立测试）
├── sites/index.js      站点 DOM 适配器 + WebVPN 路径反查
├── selftest.html/js    适配器自检页
├── privacy-policy.html 隐私政策
├── data/
│   ├── journals.json   主数据（判定必需）
│   └── cas_detail.json 中科院小类分区明细
└── popup/              设置面板与使用说明

build_data.py           数据构建脚本
validate.js             扩展完整性校验（40+ 项）
test_judge.js           判定引擎单元测试（21 项）
test_e2e.js             站点适配器端到端测试（jsdom）
```

### 本地开发

```bash
node validate.js        # manifest 语法 / 站点覆盖 / 配色一致性等
node test_judge.js      # 判定引擎

npm i jsdom && node test_e2e.js

# 本地预览（必须走 HTTP，file:// 会被浏览器拦截 JSON 请求）
cd extension && python -m http.server 8899 --bind 127.0.0.1
# 打开 http://127.0.0.1:8899/selftest.html
```

### 重建数据集

需自行准备 CSSCI / CSCD 原始索引文件（`CSSCI2025_索引.md`、`CSCD2025_2026_提取.txt`），然后：

```bash
export SXFU_SRC_DIR=/path/to/数据目录     # macOS / Linux
set SXFU_SRC_DIR=D:\path\to\数据目录      # Windows CMD

python build_data.py
node test_judge.js
```

扩充 A3 名单：编辑 `build_data.py` 中的 `A3_LIST`，每行 `(期刊名, 主办单位, 认定依据)`。

### 新增站点适配

在 `extension/sites/index.js` 的 `SITES` 数组追加：

```js
{
  id: 'xxx',
  name: '站点名',
  match: (h) => h.includes('xxx.com'),
  find() {
    const out = [];
    document.querySelectorAll('结果行选择器').forEach((row) => {
      const nameEl = row.querySelector('刊名所在元素选择器');
      if (nameEl) out.push({ nameEl, container: row, kind: 'xxx' });
    });
    return out;
  },
}
```

同时在 `manifest.json` 的 `content_scripts.matches` 与 `host_permissions` 补上该域名。

> ⚠️ 务必确认选择器抓到的是**刊名**而非论文标题——两者在多数平台结构中相邻且相似。

---

## 已知局限

- **CSSCI 集刊未收录**（约 200 余种），遇到集刊时显示为 C
- **北大核心、AMI 核心未收录**，影响 B2 级与部分 B1 判定
- 少数期刊在不同平台刊名写法不一致，可能匹配失败（不显示标签，不报错）
- 网站改版可能导致选择器失效，设置面板的「本页诊断」可查看识别情况
- 级别判定仅供参考，正式认定以本校科研处文件为准

---

## 致谢

交互思路参考了 [easyScholar](https://github.com/easy-scholar/easy-scholar)，
在其基础上补充了期刊级别判定与中科院分区标注。

## 许可

MIT
