"""生成 50 份合成托书，用于批量/格式回归，不是真实客户样本。

边界：
- 全部标注 `synthetic: true`，标题带「合成」。
- 只用于验证抽取管线与批量金标流程；**不能对外报真实准确率**。
- 需要真实准确率时，必须用客户脱敏托书替换。
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = ROOT / "samples" / "synthetic_batch50.jsonl"

from app.rules import iso6346_check_digit  # noqa: E402

CLIENTS = [
    "宁波宏运集卡运输有限公司", "海通国际物流", "中远海运物流", "东方国际货运",
    "泰隆国际", "顺捷国际", "宁波港东南物流", "浙江中外运", "上海亚东货代",
    "苏州工业园区物流",
]
PICKUPS = ["宁波北仑二期堆场", "北仑三期堆场", "穿山港区堆场", "上海洋山盛东堆场",
           "宁波梅山岛堆场", "乍浦港区堆场"]
DELIVERIES = [
    "宁波北仑春晓工业园3号仓", "宁波鄞州经济开发区金谷北路128号",
    "杭州萧山经济技术开发区桥南区块", "苏州工业园区唯亭镇亭荣街18号",
    "上海嘉定区安亭镇园大路55号", "绍兴柯桥区滨海工业区北八路",
]
CONTACTS = [("王主管", "13800001234"), ("李经理", "13900002222"),
            ("张工", "0574-88886666"), ("陈小姐", "13700003333"),
            ("赵师傅", "13600004444")]
CARGO = ["家用电器", "机械配件", "服装", "塑料粒子", "化工原料", "食品罐头",
         "家具", "纸制品", "汽车零部件"]
VESSELS = ["COSCO SHIPPING ARIES / 042E", "EVER GIVEN / 118W",
           "MAERSK EDINBURGH / 152E", "ONE APUS / 023E",
           "MSC ISABELLA / 210W"]
TYPES = ["20GP", "40GP", "40HQ", "45HQ", "20RF", "40RF"]


def container(rnd: random.Random) -> str:
    prefix = "".join(rnd.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(3)) + "U"
    serial = f"{rnd.randint(100000, 999999):06d}"
    code = prefix + serial + "0"
    check = iso6346_check_digit(code)
    return prefix + serial + str(check)


def one(idx: int, rnd: random.Random) -> dict:
    client = rnd.choice(CLIENTS)
    booking = f"SYN{idx:03d}-{rnd.randint(1000, 9999)}"
    ctype = rnd.choice(TYPES)
    qty = rnd.choice([1, 1, 1, 2])
    boxes = [container(rnd) for _ in range(qty)]
    seals = [f"SL{rnd.randint(1000000, 9999999)}" for _ in range(qty)]
    pickup = rnd.choice(PICKUPS)
    delivery = rnd.choice(DELIVERIES)
    contact, phone = rnd.choice(CONTACTS)
    day = rnd.randint(10, 28)
    hour = rnd.choice([8, 9, 10, 14])
    close_day = day + rnd.choice([1, 2])
    close_hour = rnd.choice([16, 18, 20])
    cargo = rnd.choice(CARGO)
    weight = rnd.randint(8000, 26000)
    freight = rnd.choice([1800, 2200, 2400, 2600, 2800, 3200])
    vessel = rnd.choice(VESSELS)
    remark = rnd.choice(["需报关，截港前必须进港", "两箱同车", "到场前联系工厂",
                         "注意箱体状况", "需要拍照回传"])

    gold = {
        "client": client,
        "booking_no": booking,
        "container_type": ctype,
        "container_qty": str(qty),
        "container_no": ",".join(boxes),
        "pickup_addr": pickup,
        "delivery_addr": delivery,
        "factory_contact": contact,
        "factory_phone": phone,
        "loading_window": f"2026-11-{day:02d} {hour:02d}:00",
        "closing_time": f"2026-11-{close_day:02d} {close_hour:02d}:00",
        "vessel_voyage": vessel,
        "cargo_desc": cargo,
        "gross_weight": str(weight),
        "freight": str(freight),
        "remark": remark,
    }
    style = idx % 3
    if style == 0:
        raw = "\n".join([
            f"客户：{client}", f"委托单号：{booking}", f"箱型：{ctype}",
            f"箱量：{qty}", f"箱号：{'、'.join(boxes)}",
            f"封号：{'、'.join(seals)}", f"提箱地：{pickup}",
            f"卸货地：{delivery}", f"联系人：{contact}", f"电话：{phone}",
            f"装柜时间：{gold['loading_window']}",
            f"截港时间：{gold['closing_time']}", f"船名航次：{vessel}",
            f"品名：{cargo}", f"毛重：{weight}", f"运费：{freight}",
            f"备注：{remark}",
        ])
    elif style == 1:
        raw = "\n".join([
            f"【拖车委托】{client}", f"单号 {booking}", f"箱型/箱量：{ctype} / {qty}",
            f"箱号：{'，'.join(boxes)}", f"封号：{'，'.join(seals)}",
            f"提箱点：{pickup}", f"送货地址：{delivery}",
            f"工厂联系人：{contact}  工厂电话：{phone}",
            f"装柜时间 {gold['loading_window']}  截关时间 {gold['closing_time']}",
            f"船名/航次：{vessel}", f"货物：{cargo}", f"毛重：{weight} KGS",
            f"报价：{freight} 元", f"要求：{remark}",
        ])
    else:
        raw = (
            f"客户 {client} 委托单号 {booking}，{ctype} {qty} 个柜。"
            f"箱号 {'、'.join(boxes)}，封号 {'、'.join(seals)}。"
            f"提箱地 {pickup}，卸货地 {delivery}。"
            f"联系人 {contact}，电话 {phone}。"
            f"装柜时间 {gold['loading_window']}，截港时间 {gold['closing_time']}。"
            f"船名航次 {vessel}，品名 {cargo}，毛重 {weight}，运费 {freight}。"
            f"备注：{remark}"
        )

    return {
        "id": f"SYN{idx:03d}",
        "title": f"合成样本 · 样式{style + 1}",
        "synthetic": True,
        "raw": raw,
        "gold": gold,
    }


def main() -> None:
    rnd = random.Random(20261108)
    rows = [one(i, rnd) for i in range(1, 51)]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                    encoding="utf-8")
    print(f"wrote {len(rows)} synthetic samples -> {OUT}")


if __name__ == "__main__":
    main()
