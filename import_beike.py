"""
导入北大核心期刊名单

数据源：fenqijun/cnki-Scholar 的 cnki_journals.json（GitHub，MIT）
该文件含 32661 条期刊记录，其中 1983 条带「北大核心」标签。

用法：
    python import_beike.py            # 默认下载并导入
    python import_beike.py <file>     # 用本地已有的 json 文件

产��：
    在 journals.json 中为对应条目加 "b": 1 字段（北核）
    北核属于 B1 级认定依据之一（见山财办法），但优先级低于 CSSCI/CSCD，
    因此只在 CSSCI/CSCD 标签之外作为独立辅助标签展示。
"""

import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "extension", "data", "journals.json")
SRC_URL = "https://raw.githubusercontent.com/fenqijun/cnki-Scholar/main/cnki_journals.json"


def norm(s):
    """刊名归一化，须与 build_data.py 的 norm 保持一致"""
    if not s:
        return ""
    s = str(s).strip()
    out = []
    for ch in s:
        code = ord(ch)
        if code == 0x3000:
            out.append(" ")
        elif 0xFF01 <= code <= 0xFF5E:
            out.append(chr(code - 0xFEE0))
        else:
            out.append(ch)
    s = "".join(out).lower()
    s = re.sub(r"[\s\-—–,，、_·:：;；'\"“”‘’()（）\[\]【】<>《》/\\|]+", "", s)
    return s


def norm_base(s):
    """去副标题，用于跨刊名变体匹配"""
    s = norm(s)
    s = re.sub(r"[（(][^）)]*[）)]$", "", s)
    for suf in ("英文版", "英文", "中英文版", "专辑", "增刊", "专刊"):
        if s.endswith(suf):
            s = s[: -len(suf)]
    return s


def load_source(path=None):
    if path and os.path.exists(path):
        print("  本地文件: %s" % path)
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    print("  下载: %s" % SRC_URL)
    req = urllib.request.Request(SRC_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    src_file = sys.argv[1] if len(sys.argv) > 1 else None
    if not src_file:
        # 优先用已下载到项目根的副本
        local = os.path.join(ROOT, "bk_raw.json")
        src_file = local if os.path.exists(local) else None

    print("[1/3] 载入北核数据 ...")
    raw = load_source(src_file)
    beike = [x for x in raw if "北大核心" in (x.get("tags") or [])]
    print("      源数据 %d 条，其中北核 %d 种" % (len(raw), len(beike)))

    print("[2/3] 载入现有数据集 ...")
    with open(DATA, encoding="utf-8") as f:
        data = json.load(f)
    journals = data["journals"]
    before = len(journals)

    # 建立查找索引：精确名 + 去副标题名
    idx_exact = {}
    idx_base = {}
    for k, v in journals.items():
        idx_exact.setdefault(norm(v["n"]), k)
        idx_base.setdefault(norm_base(v["n"]), k)

    print("[3/3] 匹配入库 ...")
    hit_exact, hit_base, merged, added = 0, 0, 0, 0
    miss = []

    # ---- 3b. 匹配北核标记 ----
    for x in beike:
        title = (x.get("title") or "").strip()
        if not title:
            continue
        k = idx_exact.get(norm(title))
        if k:
            journals[k]["b"] = 1
            hit_exact += 1
            continue
        k = idx_base.get(norm_base(title))
        if k:
            journals[k]["b"] = 1
            hit_base += 1
            continue
        miss.append(title)

    # ---- 3c. 新增：源数据有、数据集没有的中文刊 ----
    for x in beike:
        title = (x.get("title") or "").strip()
        if not title or norm(title) in idx_exact:
            continue
        # 纯西文刊不补（插件面向中文社科场景）
        if not re.search(r"[一-鿿]", title):
            continue
        k = norm(title)
        if not k or k in journals:
            continue
        journals[k] = {"n": title, "b": 1}
        idx_exact[k] = k
        added += 1

    # ---- 3a. 先处理「同一本刊的不同写法」----
    # 北核源数据与 CSSCI/CSCD 的刊名写法偶有差异（同一本刊两个名字），
    # 典型：中英文版 vs 无后缀、哲社版 vs 哲学社会科学版。
    # 这类必须合并，否则该刊会分裂成两条记录（一条有北核无 CSSCI，一条反之），
    # 导致级别判错、标签缺失。
    # ⚠️ 只合并「明确同义」的后缀，学科版（社科/自然科学）绝不合并 —— 那是不同的刊。
    SAME_JOURNAL_SUFFIX = [
        # (北核源数据的后缀, CSSCI/CSCD 中的写法)
        ("中英文", ""), ("中英文版", ""), ("英文版", ""),
        ("哲社版", "哲学社会科学版"),      # 缩写 → 全称（需替换）
        ("社科版", "社会科学版"),
    ]
    for k in list(journals.keys()):
        v = journals[k]
        nm = v["n"]
        m = re.search(r"[（(]([^）)]+)[）)]\s*$", nm)
        if not m:
            continue
        suffix = m.group(1).strip()
        base = nm[: m.start()].strip()
        target_name = None
        for short, full in SAME_JOURNAL_SUFFIX:
            if suffix != short:
                continue
            # 写法一：直接去掉后缀（「X(中英文)」→「X」）
            cand = base + ("(" + full + ")" if full else "")
            ck = norm(cand)
            if ck in journals and ck != k:
                target_name = cand
                break
            # 写法二：后缀是缩写，展开成全称（「X(哲社版)」→「X(哲学社会科学版)」）
            if full:
                cand2 = base + "(" + full + ")"
                ck2 = norm(cand2)
                if ck2 in journals and ck2 != k:
                    target_name = cand2
                    break
        if not target_name:
            continue
        tk = norm(target_name)
        tgt = journals[tk]
        for fld in ("cssci", "cscd", "issn", "cas", "univ", "a3", "subject"):
            if fld in v and fld not in tgt:
                tgt[fld] = v[fld]
        if v.get("b") and not tgt.get("b"):
            tgt["b"] = 1
        del journals[k]
        merged += 1

    # 合并后重建索引（键有变动）
    idx_exact = {}
    idx_base = {}
    for k, v in journals.items():
        idx_exact.setdefault(norm(v["n"]), k)
        idx_base.setdefault(norm_base(v["n"]), k)

    print("      同刊别名合并 %d 条" % merged)

    data["meta"]["sources"]["beike"] = "北大中文核心期刊要目总览（1983 种）"
    data["meta"]["counts"]["beike"] = sum(1 for v in journals.values() if v.get("b"))

    with open(DATA, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    print()
    print("  精确匹配 %d 条，去副标题匹配 %d 条，新增 %d 条" % (hit_exact, hit_base, added))
    print("  未匹配上（源数据有但未入库）%d 种，例：%s" % (len(miss), "、".join(miss[:5])))
    print("  主表 %d → %d 条，北核共 %d 种" % (before, len(journals), data["meta"]["counts"]["beike"]))
    print("  ✓ 已写入 %s" % DATA)
    print()
    print("下一步：node validate.js && node test_judge.js")


if __name__ == "__main__":
    main()
