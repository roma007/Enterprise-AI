"""生成客户老板版系统能力介绍 PPT。

数据口径：2026-11-05 核验结果；对外只讲已跑通能力和边界，不把样例/规则包装成真实客户结论。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(__file__).resolve().parent / "ppt_assets"
OUT = Path(__file__).resolve().parent / "客户老板版_系统能力介绍_2026-11-05.pptx"

NAVY = RGBColor(0x0F, 0x27, 0x40)
NAVY_2 = RGBColor(0x16, 0x3A, 0x5C)
TEAL = RGBColor(0x0E, 0x7C, 0x7B)
ORANGE = RGBColor(0xD9, 0x77, 0x06)
RED = RGBColor(0xB9, 0x1C, 0x1C)
GREEN = RGBColor(0x15, 0x80, 0x3D)
GRAY = RGBColor(0x5B, 0x6B, 0x7C)
LIGHT = RGBColor(0xF4, 0xF6, 0xF9)
LIGHT_2 = RGBColor(0xEA, 0xEF, 0xF5)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
BLACK = RGBColor(0x16, 0x20, 0x2A)

FONT = "PingFang SC"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)


def set_font(run, size=14, bold=False, color=BLACK, font=FONT):
    run.font.name = font
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color


def add_text(slide, text, left, top, width, height, size=14, bold=False, color=BLACK,
             align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, line_spacing=1.15):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.alignment = align
    p.line_spacing = line_spacing
    r = p.add_run()
    r.text = text
    set_font(r, size, bold, color)
    return box


def add_bullets(slide, items, left, top, width, height, size=14, color=BLACK,
                bullet_color=TEAL, spacing=6):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    for i, item in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(spacing)
        p.line_spacing = 1.18
        r1 = p.add_run()
        r1.text = "• "
        set_font(r1, size, True, bullet_color)
        if isinstance(item, tuple):
            head, tail = item
            r2 = p.add_run()
            r2.text = head if head.endswith(("：", ":", " ")) else head + "："
            set_font(r2, size, True, color)
            r3 = p.add_run()
            r3.text = tail
            set_font(r3, size, False, color)
        else:
            r2 = p.add_run()
            r2.text = item
            set_font(r2, size, False, color)
    return box


def add_rect(slide, left, top, width, height, fill, line=None, radius=True,
             shadow=False):
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(shape_type, Inches(left), Inches(top), Inches(width), Inches(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.color.rgb = line if line else fill
    shape.line.width = Pt(0.8)
    if radius:
        shape.adjustments[0] = 0.06
    if not shadow:
        # 去掉默认阴影
        shape.shadow.inherit = False
    return shape


def add_line(slide, left, top, width, color=TEAL, height=0.035):
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(left), Inches(top), Inches(width), Inches(height))
    bar.fill.solid()
    bar.fill.fore_color.rgb = color
    bar.line.fill.background()
    bar.shadow.inherit = False
    return bar


def add_header(slide, eyebrow, title, subtitle=None):
    add_text(slide, eyebrow, 0.7, 0.45, 6.0, 0.3, 11, True, TEAL)
    add_text(slide, title, 0.7, 0.78, 11.9, 0.55, 27, True, NAVY)
    if subtitle:
        add_text(slide, subtitle, 0.7, 1.38, 11.9, 0.4, 12.5, False, GRAY)
    add_line(slide, 0.7, 1.82 if subtitle else 1.52, 1.15, ORANGE, 0.045)


def add_footer(slide, index=None, total=18):
    page = len(prs.slides)
    add_text(slide, "Enterprise AI · 客户能力说明", 0.7, 7.12, 5.5, 0.22, 9, False, GRAY)
    add_text(slide, f"{page:02d} / {total:02d}", 12.0, 7.12, 0.65, 0.22, 9, False, GRAY, PP_ALIGN.RIGHT)


def add_image_fit(slide, filename, left, top, max_w, max_h):
    path = ASSETS / filename
    with Image.open(path) as im:
        iw, ih = im.size
    ratio = min(max_w / iw, max_h / ih)
    w, h = iw * ratio, ih * ratio
    x = left + (max_w - w) / 2
    y = top + (max_h - h) / 2
    return slide.shapes.add_picture(str(path), Inches(x), Inches(y), width=Inches(w), height=Inches(h))


def add_notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


def stat_card(slide, left, top, width, height, number, label, detail, color=TEAL):
    add_rect(slide, left, top, width, height, LIGHT, LIGHT_2)
    add_text(slide, number, left + 0.25, top + 0.22, width - 0.5, 0.55, 27, True, color)
    add_text(slide, label, left + 0.25, top + 0.82, width - 0.5, 0.3, 13, True, NAVY)
    add_text(slide, detail, left + 0.25, top + 1.16, width - 0.5, height - 1.25, 10.5, False, GRAY)


# ---------------------------------------------------------------- 01 封面
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
add_line(s, 0.9, 1.15, 0.65, ORANGE, 0.06)
add_text(s, "客户能力说明 ｜ 2026-11", 0.9, 1.45, 7.0, 0.35, 13, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "把 AI 变成\n可验收的生产力", 0.9, 2.05, 8.0, 1.8, 44, True, WHITE, line_spacing=1.08)
add_text(s, "集卡 / 拖车企业：从托书、对账到经营分析的落地路线", 0.92, 4.1, 9.5, 0.45, 18, False, RGBColor(0xD7, 0xE3, 0xEF))
add_text(s, "不是买一个模型，是把业务数据变成可管理、可追溯、可算账的资产。", 0.92, 4.72, 10.5, 0.4, 13.5, False, RGBColor(0xB8, 0xC9, 0xD9))
add_text(s, "内部评审版 ｜ 数据与结论以真实试点为准", 0.92, 6.55, 8.0, 0.3, 10.5, False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "开场只讲一句话：今天不是讲模型，是讲一条能验收的落地路径。先用 30 秒说明边界：内部样例已验证，真实客户数据还没跑。")


# ---------------------------------------------------------------- 02 老板三件事
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "老板视角", "先回答三个问题：省什么、少错什么、算清什么", "不谈技术名词，只谈经营结果。")
cards = [
    ("01", "少花时间", "托书、发票、对账先从\n“人找数、人抄数”里解放出来", TEAL),
    ("02", "少出错", "箱号 / 金额 / 税号 / 截港\n规则先挑错，人只处理异常", ORANGE),
    ("03", "算清账", "对账、账龄、外协结算\n能追到单据、指标与责任人", GREEN),
]
for i, (num, label, detail, color) in enumerate(cards):
    x = 0.7 + i * 4.12
    add_rect(s, x, 2.0, 3.82, 2.55, LIGHT, LIGHT_2)
    add_text(s, num, x + 0.3, 2.18, 0.8, 0.45, 24, True, color)
    add_text(s, label, x + 0.3, 2.72, 3.2, 0.4, 18, True, NAVY)
    add_text(s, detail, x + 0.3, 3.2, 3.25, 1.0, 11.5, False, GRAY, line_spacing=1.3)
add_rect(s, 0.7, 5.0, 11.95, 1.2, NAVY, NAVY)
add_text(s, "一句话：AI 负责“读”和“提示”，规则负责“查”和“算”，系统负责“流程、权限、审计”。", 1.0, 5.35, 11.35, 0.5, 14, True, WHITE, PP_ALIGN.CENTER)
add_footer(s, 2)
add_notes(s, "老板不会为“大模型”买单，只会为省时间、少出错、算清账买单。这一页把后面所有能力都挂到这三个结果上。")


# ---------------------------------------------------------------- 03 两张系统
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "今天已经能跑", "不是一个 Demo，是两套已经能交付的系统", "客户只装其中一个；另一个是我们内部交付管理工具。")
# 左：ai-copilot
add_rect(s, 0.7, 2.0, 5.85, 4.45, LIGHT, LIGHT_2)
add_text(s, "客户侧 ｜ AI 应用", 0.98, 2.18, 4.8, 0.3, 11, True, TEAL)
add_text(s, "ai-copilot", 0.98, 2.5, 4.8, 0.45, 22, True, NAVY)
add_text(s, "单证员 / 财务每天用", 0.98, 2.98, 4.8, 0.28, 11, False, GRAY)
add_bullets(s, [
    ("托书结构化：", "微信 / 图片 / PDF / Excel → 订单字段"),
    ("发票识别：", "税号、金额勾稽、异常票拦截"),
    ("自动对账：", "对账单 / 运单 / 结算单差异解释"),
    ("账龄催收：", "应收分层、催收优先级"),
    ("外协结算：", "合同价 vs 车队报账"),
], 0.98, 3.42, 5.25, 2.55, 12, BLACK, TEAL, 7)
# 右：交付平台
add_rect(s, 6.78, 2.0, 5.85, 4.45, LIGHT, LIGHT_2)
add_text(s, "供应商侧 ｜ 交付平台", 7.06, 2.18, 4.8, 0.3, 11, True, ORANGE)
add_text(s, "诊断 → 方案 → POC → 交付 → 运营", 7.06, 2.5, 5.2, 0.45, 18, True, NAVY)
add_text(s, "顾问 / 项目经理用，客户不装", 7.06, 2.98, 4.8, 0.28, 11, False, GRAY)
add_bullets(s, [
    ("多租户：", "供应商、客户、项目数据隔离"),
    ("方案与报价：", "版本对比、客户版脱敏、G2 门禁"),
    ("POC / 交付：", "实验、样本、UAT、上线检查"),
    ("运营与价值：", "指标快照、价值记录、续约建议"),
    ("审计与权限：", "谁改了什么、何时改、能否回滚"),
], 7.06, 3.42, 5.2, 2.55, 12, BLACK, ORANGE, 7)
add_footer(s, 3)
add_notes(s, "这一页要打消一个误解：客户不需要学我们的交付平台。客户只用 ai-copilot；交付平台是我们保证项目不烂尾的内部系统。")



# ---------------------------------------------------------------- 04 界面：客户侧
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "系统界面 ①", "客户侧：一张托书进来，右侧直接变成结构化草稿", "字段带置信度；规则先挑错；低置信转人工。")
add_image_fit(s, "ui-copilot-index.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("逐字段置信度", "客户、箱号、截港、费用都有分数"),
    ("规则先挑错", "箱号校验位、截港、地址冲突"),
    ("人确认才入业务", "确认与修正全部留痕"),
], 0.7, 2.0, 3.55, 2.5, 11.5, BLACK, TEAL, 10)
add_rect(s, 0.7, 4.9, 3.55, 1.55, LIGHT, LIGHT_2)
add_text(s, "老板看到的不是“模型多强”，而是“单证员少抄多少、错单少多少”。", 0.95, 5.15, 3.05, 1.0, 11.5, True, NAVY, line_spacing=1.35)
add_text(s, "截图：本地演示数据；真实客户需用客户样本复测。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s, 4)
add_notes(s, "这一页让老板看到真实界面：左边原文，右边结构化字段和置信度。强调规则先挑错、人工确认后才入业务。")

# ---------------------------------------------------------------- 04 能力全景
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "端到端", "从一张托书，到一张能算账的经营报表", "上半段决定数据质量，下半段决定财务 AI 的上限。")
add_image_fit(s, "data-flow.png", 7.55, 1.85, 5.1, 5.05)
add_bullets(s, [
    ("AI 真正介入：", "托书 / 发票的“读”"),
    ("规则负责：", "箱号、税号、金额、截港、账龄"),
    ("系统负责：", "确认、留痕、权限、审计、回滚"),
    ("当前边界：", "对账/账龄已跑；单车毛利卡在费用数据源"),
], 0.7, 2.05, 6.45, 2.6, 13, BLACK, TEAL, 10)
add_rect(s, 0.7, 4.85, 6.35, 1.65, LIGHT, LIGHT_2)
add_text(s, "关键判断", 0.95, 5.0, 2.0, 0.3, 12, True, ORANGE)
add_text(s, "业务数据还躺在微信里，财务 AI 就永远算不清。\n先把托书变成结构化数据，后面的对账、毛利、分析才成立。", 0.95, 5.32, 5.85, 0.95, 12.5, False, NAVY, line_spacing=1.35)
add_footer(s, 4)
add_notes(s, "这张图是全场的主线：上游结构化决定下游财务。不要一上来卖“经营分析大屏”，没有过程数据，大屏只是把 Excel 搬到墙上。")


# ---------------------------------------------------------------- 05 五个场景
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "已跑通的场景", "五个场景，都是“人今天就在做”的活", "每个场景都能用客户自己的样本复测。")
scenes = [
    ("托书结构化", "微信/图片/PDF → 箱号、客户、截港、费用", "规则校验 + 低置信转人工", TEAL),
    ("发票识别", "税号、金额、抬头、勾稽关系", "异常票先拦，减少退回", ORANGE),
    ("自动对账", "对账单 / 运单 / 结算单三方差异", "差异分类 + 解释 + 人工确认", TEAL),
    ("账龄催收", "应收分层、逾期天数、催收优先级", "规则自动化，不靠人翻表", GREEN),
    ("外协结算", "合同价 vs 车队报账", "异常费用、重复费用、算术错误", ORANGE),
]
for i, (title, desc, evidence, color) in enumerate(scenes):
    col = i % 3
    row = i // 3
    if row == 0:
        x = 0.7 + col * 4.12
        w = 3.82
    else:
        x = 0.7 + col * 6.08
        w = 5.85
    y = 2.0 + row * 2.35
    add_rect(s, x, y, w, 2.05 if row == 0 else 1.85, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.25, y + 0.18, w - 0.5, 0.35, 15, True, NAVY)
    add_text(s, desc, x + 0.25, y + 0.62, w - 0.5, 0.55, 11, False, GRAY, line_spacing=1.25)
    add_text(s, "证据：" + evidence, x + 0.25, y + 1.35, w - 0.5, 0.4, 10, True, color)
add_footer(s, 5)
add_notes(s, "五个场景按“客户今天就在做”的顺序讲，不按技术模块讲。每个都补一句：可以用你们的样本复测。")



# ---------------------------------------------------------------- 07 界面：对账分析
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "系统界面 ② / 分析", "分析不是大屏：先把四类账算清，再谈经营洞察", "对账差异、账龄催收、外协结算、运营价值；每一类都能落到动作。")
add_image_fit(s, "ui-copilot-reconcile.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("对账差异", "系统无此单 / 金额不符 / 客户漏单"),
    ("账龄催收", "逾期分层、重点客户、催收优先级"),
    ("外协结算", "合同价 vs 报账、重复/算术/未知费用"),
    ("运营价值", "指标快照、价值兑现、续约/二期"),
], 0.7, 1.98, 3.55, 2.6, 10.5, BLACK, TEAL, 7)
add_rect(s, 0.7, 4.65, 3.55, 1.8, LIGHT, LIGHT_2)
add_text(s, "以对账为例", 0.95, 4.8, 2.5, 0.25, 10.5, True, ORANGE)
add_text(s, "11 条对账单，2 条金额不符、9 条系统无此单；每条有说明、可导出，直接分给财务跟进。", 0.95, 5.1, 3.05, 1.05, 10.5, True, NAVY, line_spacing=1.3)
add_text(s, "截图：本地演示数据；真实客户需用客户对账单复测。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s, 7)
add_notes(s, "这页回答“分析到底是什么”。四类：对账差异、账龄催收、外协结算、运营价值。以对账为例：11 条、2 条金额不符、9 条系统无此单，每条有说明、能分给财务处理。")

# ---------------------------------------------------------------- 06 AI 边界
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "边界", "AI 只做三件事，不替老板做决定", "把“模型能力”拆成可验收的分工，避免过度承诺。")
cols = [
    ("大模型 ｜ 读", "托书、发票、聊天、图片", ["字段抽取", "摘要/解释", "低置信标注"], TEAL),
    ("规则 ｜ 查 / 算", "行业规则 + 业务口径", ["箱号校验位", "金额勾稽", "账龄/差异"], ORANGE),
    ("系统 ｜ 流程", "权限、审计、确认", ["人工确认才算数", "每次修改留痕", "可撤销/可追溯"], GREEN),
]
for i, (title, sub, items, color) in enumerate(cols):
    x = 0.7 + i * 4.12
    add_rect(s, x, 2.0, 3.82, 3.55, LIGHT, LIGHT_2)
    add_line(s, x + 0.28, 2.22, 0.55, color, 0.05)
    add_text(s, title, x + 0.28, 2.4, 3.3, 0.4, 17, True, NAVY)
    add_text(s, sub, x + 0.28, 2.85, 3.25, 0.35, 10.5, False, GRAY)
    add_bullets(s, items, x + 0.28, 3.35, 3.15, 1.8, 12, BLACK, color, 8)
add_rect(s, 0.7, 5.85, 11.95, 0.75, NAVY, NAVY)
add_text(s, "AI 产出是草稿；人确认后才进入业务。错一次能追溯到人、到单、到字段。", 1.0, 6.05, 11.35, 0.35, 13, True, WHITE, PP_ALIGN.CENTER)
add_footer(s, 6)
add_notes(s, "这页是防过度承诺的关键。老板最怕的是“AI 胡说但没人负责”。明确：AI 只出草稿，人确认，系统留痕。")


# ---------------------------------------------------------------- 07 业务主线
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "业务主线", "AI 在业务链路上的真实位置", "绿色=已实现；黄色=部分实现；红色=被前置条件阻塞；灰色=输入源/范围外。")
add_image_fit(s, "business-flow.png", 9.55, 1.75, 2.95, 5.15)
add_bullets(s, [
    ("① 接单：", "托书解析已跑通，AI 只出结构化草稿"),
    ("② 单证：", "箱号/封号/重量核对部分实现"),
    ("③ 执行：", "在途异常（压车/等候/改单）仍是人工"),
    ("④ 收尾：", "运单完成、结算清单进入财务链路"),
], 0.7, 2.0, 8.45, 2.6, 13.5, BLACK, TEAL, 12)
add_rect(s, 0.7, 4.75, 8.45, 1.9, LIGHT, LIGHT_2)
add_text(s, "老板要看到的事实", 0.95, 4.92, 3.0, 0.3, 12, True, ORANGE)
add_text(s, "AI 不是把整条链路“自动掉”，而是先把最脏、最重复的入口数据变成可用数据。\n入口结构化之后，财务的对账、账龄、分析才有可靠输入。", 0.95, 5.25, 7.8, 1.15, 12.5, False, NAVY, line_spacing=1.35)
add_footer(s, 7)
add_notes(s, "这张图不要逐节点讲，只讲两个点：AI 在入口，财务在出口；入口不干净，出口一定算不清。")


# ---------------------------------------------------------------- 08 财务链路
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "财务链路", "对账、账龄能算；单车毛利还差客户数据", "不把“算不出来”说成 AI 不行，很多时候是数据源不在一个地方。")
add_image_fit(s, "cost-chain.png", 7.35, 1.85, 5.35, 4.8)
add_bullets(s, [
    ("已能算：", "客户对账单、运单、结算单差异"),
    ("已能算：", "应收账龄、逾期分层、催收优先级"),
    ("已能算：", "外协合同价 vs 车队报账差异"),
    ("还算不了：", "单车毛利（油卡/路桥/维修/港杂分散）"),
], 0.7, 2.0, 6.2, 2.75, 13, BLACK, TEAL, 11)
add_rect(s, 0.7, 5.0, 6.2, 1.35, RGBColor(0xFD, 0xE8, 0xE8), RGBColor(0xF5, 0xC2, 0xC2))
add_text(s, "前置条件", 0.95, 5.15, 2.0, 0.3, 11, True, RED)
add_text(s, "客户能导出油卡、路桥、维修、港杂明细，并能按车/按单映射。\n拿到这三类数据后，再做成本归集，不先做“毛利大屏”。", 0.95, 5.45, 5.55, 0.8, 11.5, False, NAVY, line_spacing=1.3)
add_footer(s, 8)
add_notes(s, "这页体现专业度：敢说“现在算不了”。单车毛利卡在客户费用数据源，不是模型能力。先把能算的对账/账龄做出来。")



# ---------------------------------------------------------------- 10 界面：管理侧
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "系统界面 ③ / 管理", "管理侧：项目、门禁、校验证据在同一条链上", "不是一张大屏，是每个项目都能追到门禁和校验结果。")
add_image_fit(s, "ui-platform-overview.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("项目总览", "机会点、痛点、交付物、客户"),
    ("门禁", "G1–G5 与 14 项一致性校验"),
    ("证据", "生成、确认、导出全部留痕"),
], 0.7, 2.0, 3.55, 2.2, 11.5, BLACK, TEAL, 10)
add_rect(s, 0.7, 4.4, 3.55, 2.0, LIGHT, LIGHT_2)
add_text(s, "老板不需要学这套系统；它保证项目不靠人记忆，而靠门禁和证据推进。", 0.95, 4.65, 3.05, 1.45, 11.5, True, NAVY, line_spacing=1.35)
add_text(s, "截图：内部演示项目；客户不安装交付平台。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s, 10)
add_notes(s, "管理侧界面给老板看“项目有没有按门禁走”，不是给客户用的。强调客户不装这套系统。")

# ---------------------------------------------------------------- 09 证据
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "验证", "不是 PPT：这套东西已经跑过回归", "内部样例 + 合成样本，不等于真实客户准确率。")
stats = [
    ("51", "后端闭环回归", "权限、门禁、导出、对比、租户", TEAL),
    ("25", "端到端页面用例", "登录到报价对比、审计、分享", GREEN),
    ("13", "前端组件单测", "版本对比、报价差异纯函数", ORANGE),
    ("15", "AI 应用自检", "登录、解析、OCR、回写、企微", TEAL),
]
for i, (num, label, detail, color) in enumerate(stats):
    x = 0.7 + i * 3.12
    stat_card(s, x, 2.0, 2.88, 2.25, num, label, detail, color)
add_rect(s, 0.7, 4.65, 11.95, 1.65, LIGHT, LIGHT_2)
add_text(s, "口径说明", 0.95, 4.82, 2.0, 0.3, 12, True, ORANGE)
add_text(s, "规则评测（合成样本）：调优集字段 100%、留出集字段 98.7%、整单 87.5%。\n真实客户准确率必须用客户 200 份托书/对账单重跑；今天不拿合成样本冒充真实结论。", 0.95, 5.12, 11.25, 0.95, 12, False, NAVY, line_spacing=1.35)
add_footer(s, 9)
add_notes(s, "老板会问“真的假的”。这页给可验证的证据，同时主动说明口径：合成样本不是客户数据。这反而增加可信度。")


# ---------------------------------------------------------------- 10 价值测算
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "价值测算", "先算一笔账，再谈做不做", "以下为测算口径，不是承诺；试点用客户真实工时校准。")
rows = [
    ("对账", "2 人 × 5 天/月", "规则匹配 + 差异解释", "目标 50–70% 工时下降"),
    ("托书录入", "5–8 秒/单（模型）", "规则先校验，异常转人工", "目标 60% 录入时间下降"),
    ("发票审核", "人工逐张核对", "税号/金额/抬头勾稽", "目标 50% 退回率下降"),
    ("账龄催收", "手工翻表", "自动分层 + 催收优先级", "目标 1 天内出清单"),
]
table_shape = s.shapes.add_table(len(rows) + 1, 4, Inches(0.7), Inches(2.0), Inches(11.95), Inches(2.9))
table = table_shape.table
headers = ["场景", "今天的做法", "系统怎么做", "试点目标"]
widths = [1.75, 3.1, 4.1, 3.0]
for i, w in enumerate(widths):
    table.columns[i].width = Inches(w)
for j, h in enumerate(headers):
    cell = table.cell(0, j)
    cell.text = h
    cell.fill.solid(); cell.fill.fore_color.rgb = NAVY
    for p in cell.text_frame.paragraphs:
        for r in p.runs:
            set_font(r, 11, True, WHITE)
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
for i, row in enumerate(rows, start=1):
    for j, val in enumerate(row):
        cell = table.cell(i, j)
        cell.text = val
        cell.fill.solid(); cell.fill.fore_color.rgb = WHITE if i % 2 else LIGHT
        for p in cell.text_frame.paragraphs:
            for r in p.runs:
                set_font(r, 10.5, j == 0, NAVY if j == 0 else BLACK)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
add_rect(s, 0.7, 5.2, 11.95, 1.0, LIGHT, LIGHT_2)
add_text(s, "不承诺“省几个人”。只承诺：试点结束时，用你们的单据、工时和错误率，给出可复核的节省区间。", 1.0, 5.48, 11.35, 0.45, 12.5, True, NAVY, PP_ALIGN.CENTER)
add_footer(s, 10)
add_notes(s, "这页的关键不是数字，是口径。不要承诺裁人，承诺用客户真实数据测出区间。老板更信“可复核”。")


# ---------------------------------------------------------------- 11 三周试点
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "落地路径", "3 周试点：先跑一份用你们数据的结果", "不先谈大合同；先证明一票货、一张对账单能跑通。")
steps = [
    ("第 1 周", "样本与基线", "200 份托书 / 对账单\n确定字段、口径、验收人"),
    ("第 2 周", "跑评测 + 调规则", "规则/模型双通道\n差异解释 + 人工复核"),
    ("第 3 周", "出报告 + 决策", "字段准确率、工时、错误率\nGo / No-Go"),
]
for i, (week, title, detail) in enumerate(steps):
    x = 0.8 + i * 4.1
    add_rect(s, x, 2.0, 3.55, 2.4, NAVY if i == 2 else LIGHT, NAVY if i == 2 else LIGHT_2)
    add_text(s, week, x + 0.3, 2.18, 2.8, 0.3, 11, True, ORANGE if i < 2 else RGBColor(0xF5, 0xB4, 0x5A))
    add_text(s, title, x + 0.3, 2.55, 2.95, 0.4, 17, True, WHITE if i == 2 else NAVY)
    add_text(s, detail, x + 0.3, 3.1, 2.95, 1.0, 11.5, False, RGBColor(0xD7, 0xE3, 0xEF) if i == 2 else GRAY, line_spacing=1.35)
    if i < 2:
        add_text(s, "→", x + 3.62, 2.95, 0.4, 0.4, 20, True, ORANGE)
add_rect(s, 0.8, 4.85, 11.95, 1.4, LIGHT, LIGHT_2)
add_text(s, "试点结束必须交付", 1.05, 5.02, 3.0, 0.3, 12, True, ORANGE)
add_text(s, "一份可复核的评测报告：字段准确率、整单正确率、人工修正耗时、错误类型分布，以及下一期建议。", 1.05, 5.35, 11.2, 0.55, 12.5, False, NAVY)
add_footer(s, 11)
add_notes(s, "老板最怕“做三个月看不到结果”。3 周试点是最小闭环：给样本、跑评测、出报告、做 Go/No-Go。")


# ---------------------------------------------------------------- 12 试点一
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "试点一", "对账单抽取与差异解释（2 周可验收）", "选财务最痛、但数据最容易拿到的一刀。")
cols = [
    ("客户给什么", ["对账单 / 结算单（PDF / Excel）", "对应运单或台账", "1 名财务验收人"], TEAL),
    ("系统产出什么", ["结构化对账数据", "差异分类 + 解释", "需人工确认的异常清单"], ORANGE),
    ("怎么算通过", ["字段准确率 ≥ 95%", "差异解释采纳率 ≥ 70%", "人工复核耗时下降 ≥ 50%"], GREEN),
]
for i, (title, items, color) in enumerate(cols):
    x = 0.7 + i * 4.12
    add_rect(s, x, 2.0, 3.82, 3.35, LIGHT, LIGHT_2)
    add_line(s, x + 0.28, 2.2, 0.55, color, 0.05)
    add_text(s, title, x + 0.28, 2.4, 3.25, 0.35, 14.5, True, NAVY)
    add_bullets(s, items, x + 0.28, 2.92, 3.1, 2.1, 11.5, BLACK, color, 8)
add_rect(s, 0.7, 5.65, 11.95, 0.85, NAVY, NAVY)
add_text(s, "先做“对账差异解释”，不先做“自动付款/自动开票”——合规风险更低，价值更快被看见。", 1.0, 5.88, 11.35, 0.4, 12.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s, 12)
add_notes(s, "试点一选对账，不选开票/付款：数据拿得到、风险低、财务痛感强。验收指标写成可测量的数字。")


# ---------------------------------------------------------------- 13 系统边界
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "系统边界", "客户只装一个 AI 应用，不装我们的交付平台", "交付平台是供应商内部工具；客户侧只部署 ai-copilot。")
add_image_fit(s, "system-boundary.png", 0.7, 1.85, 8.1, 3.8)
add_rect(s, 9.0, 1.95, 3.55, 3.55, LIGHT, LIGHT_2)
add_text(s, "客户侧", 9.25, 2.12, 3.0, 0.3, 12, True, TEAL)
add_text(s, "ai-copilot", 9.25, 2.45, 3.0, 0.4, 18, True, NAVY)
add_bullets(s, [
    "单租户 / 单实例",
    "内网或客户云",
    "企微 / H5 入口",
    "数据不出客户边界",
], 9.25, 2.95, 3.0, 1.8, 11, BLACK, TEAL, 7)
add_rect(s, 9.0, 5.7, 3.55, 0.85, NAVY, NAVY)
add_text(s, "交付平台不交付给客户", 9.2, 5.9, 3.15, 0.4, 11.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s, 13)
add_notes(s, "这一页消除“是不是要换掉我的 TMS/财务系统”的担心。客户只装一个 AI 应用，交付平台不进入客户环境。")


# ---------------------------------------------------------------- 14 数据与安全
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "数据与安全", "先讲清数据边界，再谈 AI 能力", "客户老板最关心的不是模型参数，是数据会不会出去、出错谁负责。")
items = [
    ("数据不出境", "默认私有化/内网部署；模型调用需单独确认合规与脱敏方案。", TEAL),
    ("权限与审计", "角色权限、项目成员、操作留痕；谁改了什么可追溯到请求 ID。", ORANGE),
    ("人工确认", "AI 只出草稿；确认后才进入业务，可撤销、可回滚。", GREEN),
    ("备份与恢复", "数据库备份、PITR 演练、PDF/导出清理；故障有 Runbook。", TEAL),
]
for i, (title, detail, color) in enumerate(items):
    x = 0.7 + (i % 2) * 6.05
    y = 2.0 + (i // 2) * 1.95
    add_rect(s, x, y, 5.75, 1.65, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.28, y + 0.2, 5.0, 0.35, 14, True, NAVY)
    add_text(s, detail, x + 0.28, y + 0.65, 5.15, 0.8, 11, False, GRAY, line_spacing=1.3)
add_text(s, "原则：客户数据默认不出客户边界；任何外部模型/云服务调用，单独做合规确认，不默认开启。", 0.7, 6.0, 11.95, 0.4, 12.5, True, NAVY, PP_ALIGN.CENTER)
add_footer(s, 14)
add_notes(s, "安全这页不要讲技术细节，讲四个老板能听懂的承诺：数据不出境、权限可追、人工确认、能恢复。")


# ---------------------------------------------------------------- 15 下一步
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
add_text(s, "下一步", 0.9, 0.7, 4.0, 0.35, 12, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "今天不谈合同，先跑一份\n用你们数据的结果", 0.9, 1.15, 9.5, 1.55, 34, True, WHITE, line_spacing=1.12)
asks = [
    ("200 份", "真实托书 / 对账单", "覆盖主要格式与异常"),
    ("1 名", "内部 owner", "能拍板、能协调数据"),
    ("1 套", "验收口径", "字段、工时、错误率"),
]
for i, (num, title, detail) in enumerate(asks):
    x = 0.9 + i * 4.05
    add_rect(s, x, 3.15, 3.7, 1.65, NAVY_2, RGBColor(0x2B, 0x4F, 0x70))
    add_text(s, num, x + 0.28, 3.32, 3.15, 0.45, 24, True, RGBColor(0xF5, 0xB4, 0x5A))
    add_text(s, title, x + 0.28, 3.85, 3.15, 0.35, 15, True, WHITE)
    add_text(s, detail, x + 0.28, 4.2, 3.15, 0.3, 10.5, False, RGBColor(0xB8, 0xC9, 0xD9))
add_text(s, "拿到这三样，3 周后我带一份用你们数据跑出来的准确率报告回来。", 0.9, 5.45, 11.5, 0.45, 15, True, WHITE)
add_text(s, "Enterprise AI ｜ 内部评审版 ｜ 2026-11-05", 0.9, 6.6, 6.0, 0.3, 10, False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "收尾只要三样东西，不要合同。要样本、要 owner、要验收口径。拿到这三样，3 周后带结果回来。")


prs.save(OUT)
print(f"saved {OUT} ({len(prs.slides)} slides)")
