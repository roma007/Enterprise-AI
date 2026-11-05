"""生成客户老板版 AI 化价值介绍 PPT。

老板只关心：带来什么好处、能做什么、怎样表现、打算怎么做、需要什么配合。
不展示开发进度、门禁数量、回归测试数量等内部工程指标。
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt

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


def add_rect(slide, left, top, width, height, fill, line=None, radius=True):
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(shape_type, Inches(left), Inches(top), Inches(width), Inches(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.color.rgb = line if line else fill
    shape.line.width = Pt(0.8)
    if radius:
        shape.adjustments[0] = 0.06
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
    add_text(slide, eyebrow, 0.7, 0.45, 7.0, 0.3, 11, True, TEAL)
    add_text(slide, title, 0.7, 0.78, 11.9, 0.55, 27, True, NAVY)
    if subtitle:
        add_text(slide, subtitle, 0.7, 1.38, 11.9, 0.4, 12.5, False, GRAY)
    add_line(slide, 0.7, 1.82 if subtitle else 1.52, 1.15, ORANGE, 0.045)


def add_footer(slide, total=14):
    page = len(prs.slides)
    add_text(slide, "Enterprise AI · 客户价值说明", 0.7, 7.12, 5.5, 0.22, 9, False, GRAY)
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
    add_text(slide, number, left + 0.25, top + 0.2, width - 0.5, 0.5, 25, True, color)
    add_text(slide, label, left + 0.25, top + 0.75, width - 0.5, 0.3, 13, True, NAVY)
    add_text(slide, detail, left + 0.25, top + 1.12, width - 0.5, height - 1.2, 10.5, False, GRAY)


# ---------------------------------------------------------------- 01 封面
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
add_line(s, 0.9, 1.05, 0.65, ORANGE, 0.06)
add_text(s, "客户价值说明 ｜ 2026-11", 0.9, 1.35, 7.0, 0.35, 13, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "让 AI 从一张托书开始\n变成可验收的经营结果", 0.9, 1.95, 9.2, 1.75, 36, True, WHITE, line_spacing=1.12)
add_text(s, "集卡 / 拖车企业：少花时间、少出错、算清账", 0.92, 3.95, 9.0, 0.45, 19, False, RGBColor(0xD7, 0xE3, 0xEF))
add_text(s, "不是买一个模型，是把业务数据变成可管理、可追溯、可算账的资产。", 0.92, 4.62, 10.5, 0.4, 14, False, RGBColor(0xB8, 0xC9, 0xD9))
add_text(s, "今天只谈：好处、能做什么、怎么表现、怎么做、需要什么配合。", 0.92, 5.65, 10.5, 0.35, 12, True, RGBColor(0xF5, 0xB4, 0x5A))
add_text(s, "内部评审版 ｜ 真实客户效果以试点数据为准", 0.92, 6.6, 7.5, 0.3, 10, False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "开场先定调：今天不汇报开发进度，只谈老板关心的五件事：好处、能做什么、怎么表现、怎么做、需要什么配合。")


# ---------------------------------------------------------------- 02 三个好处
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "好处", "AI 化到底带来什么：省时间、少出错、算清账", "不谈技术名词，只谈经营结果。")
cards = [
    ("01", "少花时间", "托书、发票、对账先从\n“人找数、人抄数”里解放出来\n重复工时目标下降 50–70%（试点校准）", TEAL),
    ("02", "少出错", "箱号、税号、金额、截港\n规则先挑错，人只处理异常\n错单和退回更早被发现", ORANGE),
    ("03", "算清账", "对账差异、账龄、续约风险\n能追到单据、客户、责任人\n经营会不再靠拍脑袋", GREEN),
]
for i, (num, label, detail, color) in enumerate(cards):
    x = 0.7 + i * 4.12
    add_rect(s, x, 1.95, 3.82, 2.75, LIGHT, LIGHT_2)
    add_text(s, num, x + 0.3, 2.12, 0.8, 0.45, 24, True, color)
    add_text(s, label, x + 0.3, 2.68, 3.2, 0.4, 18, True, NAVY)
    add_text(s, detail, x + 0.3, 3.15, 3.25, 1.35, 11.5, False, GRAY, line_spacing=1.3)
add_rect(s, 0.7, 5.2, 11.95, 0.95, NAVY, NAVY)
add_text(s, "老板不为“模型”买单，只为“省下来的时间、少掉的错误、算清的账”买单。", 0.95, 5.45, 11.45, 0.4, 14, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "这一页是全场总纲。后面所有能力都挂到省时间、少出错、算清账三个结果上。")


# ---------------------------------------------------------------- 03 能做什么
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么", "五个场景，都是“人今天就在做”的活", "每个场景都能用客户自己的样本复测。")
scenes = [
    ("托书结构化", "微信 / 图片 / PDF / Excel → 订单字段", "单证员少抄、少录", TEAL),
    ("发票识别", "税号、金额、抬头、勾稽关系", "异常票先拦、少退回", ORANGE),
    ("自动对账", "对账单 / 运单 / 结算单三方差异", "差异分类、可解释", TEAL),
    ("账龄催收", "应收分层、逾期天数、催收优先级", "催收有清单、有优先级", GREEN),
    ("外协结算", "合同价 vs 车队报账", "多付、重复、算术错误先发现", ORANGE),
]
for i, (title, desc, benefit, color) in enumerate(scenes):
    col = i % 3
    row = i // 3
    if row == 0:
        x = 0.7 + col * 4.12
        w = 3.82
    else:
        x = 0.7 + col * 6.08
        w = 5.85
    y = 1.95 + row * 2.35
    add_rect(s, x, y, w, 2.05 if row == 0 else 1.85, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.25, y + 0.18, w - 0.5, 0.35, 15, True, NAVY)
    add_text(s, desc, x + 0.25, y + 0.62, w - 0.5, 0.55, 11, False, GRAY, line_spacing=1.25)
    add_text(s, "客户得到：" + benefit, x + 0.25, y + 1.35, w - 0.5, 0.4, 10, True, color)
add_footer(s)
add_notes(s, "按客户今天在做的活讲，不按技术模块讲。每个场景都补一句：可以用你们的样本复测。")


# ---------------------------------------------------------------- 04 表现：托书
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎样表现 ①", "一张托书进来，右侧直接变成结构化草稿", "字段带置信度；规则先挑错；低置信转人工。")
add_image_fit(s, "ui-copilot-index.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("逐字段置信度", "客户、箱号、截港、费用都有分数"),
    ("规则先挑错", "箱号校验位、截港、地址冲突"),
    ("人确认才入业务", "确认与修正全部留痕"),
], 0.7, 2.0, 3.55, 2.5, 11.5, BLACK, TEAL, 10)
add_rect(s, 0.7, 4.9, 3.55, 1.55, LIGHT, LIGHT_2)
add_text(s, "老板看到的不是“模型多强”，而是“单证员少抄多少、错单少多少”。", 0.95, 5.15, 3.05, 1.0, 11.5, True, NAVY, line_spacing=1.35)
add_text(s, "截图：演示数据；真实客户需用客户样本复测。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s)
add_notes(s, "让老板看到真实界面：左边原文，右边结构化字段和置信度。强调规则先挑错、人工确认后才入业务。")


# ---------------------------------------------------------------- 05 表现：对账
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎样表现 ②", "对账不是“看个总数”，而是把差异分到动作", "对账单、运单、结算单逐条比对；每条差异有原因、有负责人。")
add_image_fit(s, "ui-copilot-reconcile.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("差异分类", "系统无此单 / 金额不符 / 客户漏单"),
    ("可解释", "每条给原因，不只是标红"),
    ("可导出", "差异表直接给财务跟进"),
], 0.7, 2.0, 3.55, 2.2, 11, BLACK, TEAL, 9)
add_rect(s, 0.7, 4.5, 3.55, 1.95, LIGHT, LIGHT_2)
add_text(s, "以演示数据为例：11 条对账单，2 条金额不符、9 条系统无此单；每条都能分给财务处理。", 0.95, 4.75, 3.05, 1.45, 10.5, True, NAVY, line_spacing=1.35)
add_text(s, "截图：演示数据；真实客户需用客户对账单复测。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s)
add_notes(s, "对账是财务最痛的场景。老板看到的是差异分类和动作，不是一张红红绿绿的大屏。")


# ---------------------------------------------------------------- 06 表现：洞察
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎样表现 ③", "从数据到结论：3–5 句话 + 指标差距 + 建议动作", "每条结论可追到指标、方案、POC、交付与风险记录。")
add_image_fit(s, "ui-platform-insights.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("结论", "机会点、POC、指标、签收、风险"),
    ("差距", "录入耗时、对账工时、回款天数"),
    ("动作", "逐项复盘，明确责任人与下月目标"),
], 0.7, 2.0, 3.55, 2.2, 11, BLACK, TEAL, 10)
add_rect(s, 0.7, 4.35, 3.55, 2.0, LIGHT, LIGHT_2)
add_text(s, "洞察不是“再做一个大屏”，而是把指标差距翻译成下一步动作。", 0.95, 4.6, 3.05, 1.5, 11.5, True, NAVY, line_spacing=1.35)
add_text(s, "截图：演示数据；真实客户需按客户口径重跑。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s)
add_notes(s, "这是整套系统的分析出口：结论、指标差距、建议动作。强调可追溯，不是大模型拍脑袋。")


# ---------------------------------------------------------------- 07 边界
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "边界", "AI 只做三件事，不替老板做决定", "把“模型能力”拆成可验收的分工，避免过度承诺。")
cols = [
    ("大模型 ｜ 读", "托书、发票、聊天、图片", ["字段抽取", "摘要/解释", "低置信标注"], TEAL),
    ("规则 ｜ 查 / 算", "行业规则 + 业务口径", ["箱号校验位", "金额勾稽", "账龄/差异"], ORANGE),
    ("系统 ｜ 流程", "权限、审计、确认", ["人工确认才算数", "每次修改留痕", "可撤销/可追溯"], GREEN),
]
for i, (title, sub, items, color) in enumerate(cols):
    x = 0.7 + i * 4.12
    add_rect(s, x, 1.95, 3.82, 3.55, LIGHT, LIGHT_2)
    add_line(s, x + 0.28, 2.17, 0.55, color, 0.05)
    add_text(s, title, x + 0.28, 2.35, 3.3, 0.4, 17, True, NAVY)
    add_text(s, sub, x + 0.28, 2.8, 3.25, 0.35, 10.5, False, GRAY)
    add_bullets(s, items, x + 0.28, 3.3, 3.15, 1.8, 12, BLACK, color, 8)
add_rect(s, 0.7, 5.8, 11.95, 0.75, NAVY, NAVY)
add_text(s, "AI 产出是草稿；人确认后才进入业务。错一次能追溯到人、到单、到字段。", 1.0, 6.0, 11.35, 0.35, 13, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "这页是防过度承诺的关键。老板最怕的是“AI 胡说但没人负责”。明确：AI 只出草稿，人确认，系统留痕。")


# ---------------------------------------------------------------- 08 怎么做
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么做", "先把入口数据做干净，再谈财务分析和经营洞察", "从一张托书开始，逐段接上业务与财务。")
add_image_fit(s, "data-flow.png", 7.55, 1.85, 5.1, 5.05)
add_bullets(s, [
    ("第一步：结构化", "托书/发票 → 字段、置信度、异常"),
    ("第二步：规则校验", "箱号、税号、金额、截港先挑错"),
    ("第三步：流程确认", "人工确认、留痕、可回滚"),
    ("第四步：经营分析", "对账、账龄、成本、续约与二期"),
], 0.7, 1.98, 6.45, 2.9, 12.5, BLACK, TEAL, 9)
add_rect(s, 0.7, 5.15, 6.35, 1.35, LIGHT, LIGHT_2)
add_text(s, "关键判断", 0.95, 5.3, 2.0, 0.3, 11, True, ORANGE)
add_text(s, "业务数据还躺在微信里，财务 AI 就永远算不清。先做入口，再做分析。", 0.95, 5.6, 5.85, 0.75, 11.5, True, NAVY, line_spacing=1.3)
add_footer(s)
add_notes(s, "这页讲路径：不要一上来卖经营分析大屏；先把托书、发票变成结构化数据，后面的对账、账龄、洞察才成立。")


# ---------------------------------------------------------------- 09 三周试点
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么做", "3 周试点：先跑一份用你们数据的结果", "不先谈大合同；先证明一票货、一张对账单能跑通。")
steps = [
    ("第 1 周", "样本与基线", "200 份托书 / 对账单\n确定字段、口径、验收人"),
    ("第 2 周", "跑评测 + 调规则", "规则/模型双通道\n差异解释 + 人工复核"),
    ("第 3 周", "出报告 + 决策", "字段准确率、工时、错误率\nGo / No-Go"),
]
for i, (week, title, detail) in enumerate(steps):
    x = 0.8 + i * 4.1
    add_rect(s, x, 1.95, 3.55, 2.4, NAVY if i == 2 else LIGHT, NAVY if i == 2 else LIGHT_2)
    add_text(s, week, x + 0.3, 2.13, 2.8, 0.3, 11, True, ORANGE if i < 2 else RGBColor(0xF5, 0xB4, 0x5A))
    add_text(s, title, x + 0.3, 2.5, 2.95, 0.4, 17, True, WHITE if i == 2 else NAVY)
    add_text(s, detail, x + 0.3, 3.05, 2.95, 1.0, 11.5, False, RGBColor(0xD7, 0xE3, 0xEF) if i == 2 else GRAY, line_spacing=1.35)
    if i < 2:
        add_text(s, "→", x + 3.62, 2.9, 0.4, 0.4, 20, True, ORANGE)
add_rect(s, 0.8, 4.8, 11.95, 1.35, LIGHT, LIGHT_2)
add_text(s, "试点结束必须交付", 1.05, 4.97, 3.0, 0.3, 12, True, ORANGE)
add_text(s, "一份可复核的评测报告：字段准确率、整单正确率、人工修正耗时、错误类型分布，以及下一期建议。", 1.05, 5.3, 11.2, 0.55, 12.5, False, NAVY)
add_footer(s)
add_notes(s, "老板最怕“做三个月看不到结果”。3 周试点是最小闭环：给样本、跑评测、出报告、做 Go/No-Go。")


# ---------------------------------------------------------------- 10 试点一
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么做", "试点一：对账单抽取与差异解释（2 周可验收）", "选财务最痛、但数据最容易拿到的一刀。")
cols = [
    ("客户给什么", ["对账单 / 结算单（PDF / Excel）", "对应运单或台账", "1 名财务验收人"], TEAL),
    ("系统产出什么", ["结构化对账数据", "差异分类 + 解释", "需人工确认的异常清单"], ORANGE),
    ("怎么算通过", ["字段准确率 ≥ 95%", "差异解释采纳率 ≥ 70%", "人工复核耗时下降 ≥ 50%"], GREEN),
]
for i, (title, items, color) in enumerate(cols):
    x = 0.7 + i * 4.12
    add_rect(s, x, 1.95, 3.82, 3.35, LIGHT, LIGHT_2)
    add_line(s, x + 0.28, 2.15, 0.55, color, 0.05)
    add_text(s, title, x + 0.28, 2.35, 3.25, 0.35, 14.5, True, NAVY)
    add_bullets(s, items, x + 0.28, 2.87, 3.1, 2.1, 11.5, BLACK, color, 8)
add_rect(s, 0.7, 5.6, 11.95, 0.85, NAVY, NAVY)
add_text(s, "先做“对账差异解释”，不先做“自动付款/自动开票”——合规风险更低，价值更快被看见。", 1.0, 5.83, 11.35, 0.4, 12.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "试点一选对账，不选开票/付款：数据拿得到、风险低、财务痛感强。验收指标写成可测量的数字。")


# ---------------------------------------------------------------- 11 需要配合
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "需要什么", "不需要客户换系统，需要三样东西 + 一个配合机制", "我们做 AI 应用，客户不用装交付管理平台。")
asks = [
    ("200 份", "真实托书 / 对账单", "覆盖主要格式与异常"),
    ("1 名", "内部 owner", "能拍板、能协调数据"),
    ("1 套", "验收口径", "字段、工时、错误率"),
]
for i, (num, title, detail) in enumerate(asks):
    x = 0.7 + i * 4.12
    add_rect(s, x, 1.95, 3.82, 2.35, LIGHT, LIGHT_2)
    add_text(s, num, x + 0.28, 2.12, 3.2, 0.45, 24, True, ORANGE)
    add_text(s, title, x + 0.28, 2.65, 3.2, 0.35, 14, True, NAVY)
    add_text(s, detail, x + 0.28, 3.05, 3.2, 0.5, 10.5, False, GRAY)
add_rect(s, 0.7, 4.6, 5.85, 1.55, NAVY, NAVY)
add_text(s, "部署与配合", 0.95, 4.75, 3.0, 0.3, 12, True, RGBColor(0xF5, 0xB4, 0x5A))
add_text(s, "客户内网 / 客户云部署；单租户、单实例；不替换 TMS/财务系统，只做上层增强。", 0.95, 5.05, 5.35, 0.9, 10.5, False, WHITE, line_spacing=1.3)
add_rect(s, 6.78, 4.6, 5.85, 1.55, LIGHT, LIGHT_2)
add_text(s, "客户侧配合", 7.02, 4.75, 3.0, 0.3, 12, True, ORANGE)
add_text(s, "1 名业务 owner + 1 名 IT 接口人；每周 30 分钟复盘；样本脱敏后提供。", 7.02, 5.05, 5.35, 0.9, 10.5, False, NAVY, line_spacing=1.3)
add_text(s, "客户只装 ai-copilot；交付管理平台是我们内部工具，不进入客户环境。", 0.7, 6.45, 11.95, 0.3, 11.5, True, NAVY)
add_footer(s)
add_notes(s, "这一页把“需要什么”讲清楚：样本、owner、验收口径，再加一个每周复盘机制。客户不用换 TMS/财务系统。")


# ---------------------------------------------------------------- 12 价值测算
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "好处怎么算", "先算一笔账，再谈做不做", "以下为测算口径，不是承诺；试点用客户真实工时校准。")
rows = [
    ("对账", "2 人 × 5 天/月", "规则匹配 + 差异解释", "目标 50–70% 工时下降"),
    ("托书录入", "5–8 秒/单（模型）", "规则先校验，异常转人工", "目标 60% 录入时间下降"),
    ("发票审核", "人工逐张核对", "税号/金额/抬头勾稽", "目标 50% 退回率下降"),
    ("账龄催收", "手工翻表", "自动分层 + 催收优先级", "目标 1 天内出清单"),
]
table_shape = s.shapes.add_table(len(rows) + 1, 4, Inches(0.7), Inches(1.95), Inches(11.95), Inches(2.9))
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
add_rect(s, 0.7, 5.15, 11.95, 1.0, LIGHT, LIGHT_2)
add_text(s, "不承诺“省几个人”。只承诺：试点结束时，用你们的单据、工时和错误率，给出可复核的节省区间。", 1.0, 5.42, 11.35, 0.45, 12.5, True, NAVY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "这页的关键不是数字，是口径。不要承诺裁人，承诺用客户真实数据测出区间。老板更信“可复核”。")


# ---------------------------------------------------------------- 13 数据与安全
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "信任条件", "先讲清数据边界，再谈 AI 能力", "老板最关心的不是模型参数，是数据会不会出去、出错谁负责。")
items = [
    ("数据不出境", "默认私有化/内网部署；模型调用需单独确认合规与脱敏方案。", TEAL),
    ("权限与审计", "角色权限、项目成员、操作留痕；谁改了什么可追溯。", ORANGE),
    ("人工确认", "AI 只出草稿；确认后才进入业务，可撤销、可回滚。", GREEN),
    ("备份与恢复", "数据库备份、时间点恢复演练；故障有处置手册。", TEAL),
]
for i, (title, detail, color) in enumerate(items):
    x = 0.7 + (i % 2) * 6.05
    y = 1.95 + (i // 2) * 1.95
    add_rect(s, x, y, 5.75, 1.65, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.28, y + 0.2, 5.0, 0.35, 14, True, NAVY)
    add_text(s, detail, x + 0.28, y + 0.65, 5.15, 0.8, 11, False, GRAY, line_spacing=1.3)
add_text(s, "原则：客户数据默认不出客户边界；任何外部模型/云服务调用，单独做合规确认，不默认开启。", 0.7, 6.0, 11.95, 0.4, 12.5, True, NAVY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "安全这页不要讲技术细节，讲四个老板能听懂的承诺：数据不出境、权限可追、人工确认、能恢复。")


# ---------------------------------------------------------------- 14 下一步
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
add_text(s, "Enterprise AI ｜ 客户价值说明 ｜ 2026-11-05", 0.9, 6.6, 6.0, 0.3, 10, False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "收尾只要三样东西，不要合同。要样本、要 owner、要验收口径。拿到这三样，3 周后带结果回来。")


prs.save(OUT)
print(f"saved {OUT} ({len(prs.slides)} slides)")
