"""经营驾驶舱（老板/客户演示样张）。

只做聚合展示：
- 经营结果：来自 `/insight` 演示数据（应收/成本/毛利/逾期）
- 客户/线路：来自 `/profit` 演示数据
- 能源/线路：来自 `/fleet` 演示数据

边界：
- 各模块是独立合成数据集，不能相加；页面必须明确标注。
- 驾驶舱只读，不替代各业务页；点击卡片进入详情。
- 真实结论要等客户数据接入；AI 摘要只做解读，不改数。
"""
from __future__ import annotations

import datetime as dt

from . import fleet, insight, profit


def _money(value: float) -> float:
    return round(float(value or 0), 0)


def _pct(value: float) -> float:
    return round(float(value or 0), 4)


def _owner(text: str) -> str:
    if any(w in text for w in ("电动", "补能", "充电", "车型", "马力")):
        return "运营"
    if any(w in text for w in ("空驶", "线路", "调度", "派车", "车辆")):
        return "调度"
    if any(w in text for w in ("催", "逾期", "回款", "成本", "毛利", "亏损", "报价")):
        return "财务"
    return "老板/总经理"


def _when(level: str) -> str:
    return {"high": "本周", "warn": "本月", "ok": "下季度"}.get(level, "本月")


def _decisions(fin: dict, prof: dict, energy: dict) -> list[dict]:
    out: list[dict] = []

    def add(source: str, link: str, item: dict) -> None:
        out.append({
            "source": source,
            "link": link,
            "level": item.get("level", "warn"),
            "title": item.get("title", ""),
            "detail": item.get("detail", ""),
            "action": item.get("action", ""),
            "owner": _owner(f"{item.get('title', '')}{item.get('detail', '')}"),
            "when": _when(item.get("level", "warn")),
        })

    for item in (fin.get("insights") or [])[:3]:
        add("经营结果", "/insight", item)
    for item in (prof.get("insights") or [])[:2]:
        add("客户/线路", "/profit", item)
    for item in (energy.get("insights") or [])[:3]:
        add("能源/线路", "/fleet", item)

    # 去重，保留最高优先级，限制 6 条
    order = {"high": 0, "warn": 1, "ok": 2}
    seen: set[str] = set()
    unique = []
    for item in sorted(out, key=lambda x: order.get(x["level"], 9)):
        key = item["title"]
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique[:6]


def _modules(fin: dict, prof: dict, energy: dict) -> list[dict]:
    fs = fin.get("summary") or {}
    ps = prof.get("summary") or {}
    es = energy.get("summary") or {}
    return [
        {
            "key": "finance",
            "title": "经营结果",
            "tag": "合成演示",
            "link": "/insight",
            "kpis": [
                {"label": "应收", "value": _money(fs.get("revenue")), "kind": "money"},
                {"label": "毛利", "value": _money(fs.get("profit")), "kind": "money"},
                {"label": "毛利率", "value": _pct(fs.get("margin")), "kind": "pct"},
                {"label": "逾期未收", "value": _money(fs.get("overdue")), "kind": "money"},
            ],
        },
        {
            "key": "profit",
            "title": "客户 / 线路盈利",
            "tag": "合成演示",
            "link": "/profit",
            "kpis": [
                {"label": "客户数", "value": ps.get("customers", 0), "kind": "count"},
                {"label": "亏损客户", "value": ps.get("loss_customers", 0), "kind": "count"},
                {"label": "低毛利客户", "value": ps.get("low_margin_customers", 0), "kind": "count"},
                {"label": "前5客户占比", "value": _pct(ps.get("top5_share")), "kind": "pct"},
            ],
        },
        {
            "key": "energy",
            "title": "能源 / 线路",
            "tag": "合成演示",
            "link": "/fleet",
            "kpis": [
                {"label": "单箱成本", "value": _money(es.get("cost_per_teu")), "kind": "money"},
                {"label": "能源占比", "value": _pct(es.get("energy_share")), "kind": "pct"},
                {"label": "空驶率", "value": _pct(es.get("empty_ratio")), "kind": "pct"},
                {"label": "可减重复工时", "value": _money(es.get("release_hours")), "kind": "money"},
            ],
        },
    ]


def _data_status(public: dict) -> list[dict]:
    sources = public.get("sources") or []
    mode = {"live": "已抓取缓存", "seed": "仓库种子", "fallback": "内置兜底"}.get(
        public.get("source_mode"), "未知")
    return [
        {"module": "应收 / 费用 / 台账", "status": "合成演示", "source": "/insight 演示数据",
         "gap": "真实成本科目 + TMS/财务数据"},
        {"module": "客户 / 线路历史", "status": "合成演示", "source": "/profit 24 个月合成",
         "gap": "12–24 个月真实经营数据"},
        {"module": "车辆 / 能耗 / 工时", "status": "合成演示", "source": "/fleet 合成运营数据",
         "gap": "每车每趟加油/充电、工时、路桥、TCO"},
        {"module": "公开资料", "status": mode, "source": f'{len(sources)} 个来源 / 成功 '
                                                        f'{public.get("source_ok", 0)} 个',
         "gap": "只用于会前研究，事实需客户确认"},
        {"module": "AI 运行指标", "status": "真实（本机）", "source": "/report 运行月报",
         "gap": "样本量不足时不作结论"},
    ]


def demo() -> dict:
    fin = insight.demo()["result"]
    prof = profit.demo()
    energy = fleet.demo()
    public = energy.get("public") or {}
    fs = fin.get("summary") or {}
    decisions = _decisions(fin, prof, energy)
    modules = _modules(fin, prof, energy)

    headline = {
        "revenue": _money(fs.get("revenue")),
        "cost": _money(fs.get("cost")),
        "profit": _money(fs.get("profit")),
        "margin": _pct(fs.get("margin")),
        "orders": int(fs.get("orders") or 0),
        "receivable": _money(fs.get("receivable")),
        "outstanding": _money(fs.get("outstanding")),
        "overdue": _money(fs.get("overdue")),
        "overdue_clients": int(fs.get("overdue_clients") or 0),
        "unallocated": _money(fs.get("unallocated")),
    }

    return {
        "synthetic": True,
        "as_of": dt.date.today().isoformat(),
        "company": public.get("company") or "目标客户",
        "headline": headline,
        "modules": modules,
        "decisions": decisions,
        "data_status": _data_status(public),
        "links": [
            {"label": "经营洞察", "href": "/insight"},
            {"label": "盈利分析", "href": "/profit"},
            {"label": "能源决策", "href": "/fleet"},
            {"label": "账龄催收", "href": "/aging"},
            {"label": "运行月报", "href": "/report"},
        ],
        "warning": "演示样张：经营结果、客户/线路、能源/线路三个模块使用独立合成数据，"
                   "不可加总；真实结论待客户数据接入。AI 摘要只用于展示表现，不是经营承诺。",
    }
