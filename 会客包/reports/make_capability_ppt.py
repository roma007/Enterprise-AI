"""生成客户老板版 人工智能价值介绍 PPT。

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
    add_text(slide, "企业人工智能 · 客户价值说明", 0.7, 7.12, 5.5, 0.22, 9, False, GRAY)
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
add_text(s, "让人工智能从一张托书开始\n变成可验收的经营结果", 0.9, 1.95, 9.2, 1.75, 36, True, WHITE, line_spacing=1.12)
add_text(s, "集卡 / 拖车企业：少花时间、少出错、算清账", 0.92, 3.95, 9.0, 0.45, 19, False, RGBColor(0xD7, 0xE3, 0xEF))
add_text(s, "不是买一个模型，是把业务数据变成可管理、可追溯、可算账的资产。", 0.92, 4.62, 10.5, 0.4, 14, False, RGBColor(0xB8, 0xC9, 0xD9))
add_text(s, "今天只谈：好处、能做什么、怎么表现、怎么做、需要什么配合。", 0.92, 5.65, 10.5, 0.35, 12, True, RGBColor(0xF5, 0xB4, 0x5A))
add_text(s, "内部评审版 ｜ 真实客户效果以试点数据为准", 0.92, 6.6, 7.5, 0.3, 10, False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "开场先定调：今天不汇报开发进度，只谈老板关心的五件事：好处、能做什么、怎么表现、怎么做、需要什么配合。")


# ---------------------------------------------------------------- 02 三个好处
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "好处", "引入人工智能到底带来什么：省时间、少出错、算清账", "不谈技术名词，只谈经营结果。")
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
    ("托书结构化", "微信 / 图片 / 扫描件 / 表格 → 订单字段", "单证员少抄、少录", TEAL),
    ("发票识别", "税号、金额、抬头、勾稽关系", "异常票先拦、少退回", ORANGE),
    ("自动对账", "对账单 / 运单 / 结算单三方差异", "差异分类、可解释", TEAL),
    ("账龄催收", "应收分层、逾期天数、催收优先级", "催收有清单、有优先级", GREEN),
    ("外协结算", "合同价与车队报账", "多付、重复、算术错误先发现", ORANGE),
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
add_header(s, "怎样表现 ③", "从数据到结论：3–5 句话 + 指标差距 + 建议动作", "每条结论可追到指标、方案、试点验证、交付与风险记录。")
add_image_fit(s, "ui-platform-insights.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("结论", "机会点、试点验证、指标、签收、风险"),
    ("差距", "录入耗时、对账工时、回款天数"),
    ("动作", "逐项复盘，明确责任人与下月目标"),
], 0.7, 2.0, 3.55, 2.2, 11, BLACK, TEAL, 10)
add_rect(s, 0.7, 4.35, 3.55, 2.0, LIGHT, LIGHT_2)
add_text(s, "洞察不是“再做一个大屏”，而是把指标差距翻译成下一步动作。", 0.95, 4.6, 3.05, 1.5, 11.5, True, NAVY, line_spacing=1.35)
add_text(s, "截图：演示数据；真实客户需按客户口径重跑。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s)
add_notes(s, "这是整套系统的分析出口：结论、指标差距、建议动作。强调可追溯，不是大模型拍脑袋。")


# ---------------------------------------------------------------- 07 AI 介入点
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "大模型介入点", "只有这几步用大模型，其他靠规则和人", "先把“哪里用了大模型、哪里只是规则、哪里必须人确认”画清楚。")
add_image_fit(s, "ai-intervention-map.png", 0.7, 1.8, 11.95, 3.9)
# 图例
legend = [
    ("大模型", "托书、发票字段抽取；对账差异原因解释", TEAL),
    ("规则 / 系统", "箱号/税号/金额校验、对账匹配、账龄、结算、指标", ORANGE),
    ("人工确认", "确认、修正、审批、签收；大模型只出草稿", RGBColor(0x1F, 0x4E, 0x79)),
]
for i, (title, detail, color) in enumerate(legend):
    x = 0.7 + i * 4.0
    add_rect(s, x, 6.12, 3.8, 0.72, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.18, 6.22, 1.6, 0.26, 10, True, color)
    add_text(s, detail, x + 1.55, 6.22, 2.1, 0.5, 8.3, False, NAVY, line_spacing=1.15)
add_text(s, "大模型不参与：对账匹配、账龄计算、结算规则、经营指标计算。", 0.7, 5.8, 11.95, 0.25, 10.5, True, RED)
add_footer(s)
add_notes(s, "这页回答“AI 到底介入哪几步”。绿色才是大模型：托书、发票字段抽取，对账差异原因解释。对账匹配、账龄、结算、指标都是规则；人工确认后才入业务。")


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
add_text(s, "业务数据还躺在微信里，财务分析就永远算不清。先做入口，再做分析。", 0.95, 5.6, 5.85, 0.75, 11.5, True, NAVY, line_spacing=1.3)
add_footer(s)
add_notes(s, "这页讲路径：不要一上来卖经营分析大屏；先把托书、发票变成结构化数据，后面的对账、账龄、洞察才成立。")


# ---------------------------------------------------------------- 09 三周试点
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么做", "3 周试点：第 1 周拿样本，第 2 周跑对账，第 3 周出报告", "先证明一张对账单能跑通，再谈扩大。")
steps = [
    ("第 1 周", "样本与基线", "200 份托书 / 对账单\n确定字段、口径、验收人"),
    ("第 2 周", "跑对账 + 人工复核", "差异分类 + 解释\n低置信转人工"),
    ("第 3 周", "出报告 + 决策", "准确率、工时、错误率\n继续 / 暂停"),
]
for i, (week, title, detail) in enumerate(steps):
    x = 0.7 + i * 4.12
    add_rect(s, x, 1.95, 3.82, 1.85, NAVY if i == 2 else LIGHT, NAVY if i == 2 else LIGHT_2)
    add_text(s, week, x + 0.3, 2.1, 2.8, 0.3, 11, True, ORANGE if i < 2 else RGBColor(0xF5, 0xB4, 0x5A))
    add_text(s, title, x + 0.3, 2.45, 3.2, 0.4, 15.5, True, WHITE if i == 2 else NAVY)
    add_text(s, detail, x + 0.3, 2.95, 3.2, 0.7, 10.5, False, RGBColor(0xD7, 0xE3, 0xEF) if i == 2 else GRAY, line_spacing=1.3)
    if i < 2:
        add_text(s, "→", x + 3.62, 2.65, 0.4, 0.4, 18, True, ORANGE)
add_rect(s, 0.7, 4.05, 11.95, 2.25, LIGHT, LIGHT_2)
add_text(s, "第一刀：对账差异解释（第 1–2 周）", 0.95, 4.22, 5.0, 0.35, 15, True, NAVY)
cols = [
    ("客户给什么", "对账单 / 结算单\n对应运单或台账"),
    ("系统产出什么", "差异分类 + 解释\n需确认的异常清单"),
    ("怎么算通过", "字段准确率 ≥95%\n解释采纳率 ≥70%\n复核工时下降 ≥50%"),
]
for i, (title, detail) in enumerate(cols):
    x = 0.95 + i * 3.9
    add_text(s, title, x, 4.62, 3.4, 0.3, 11, True, TEAL if i < 2 else GREEN)
    add_text(s, detail, x, 4.95, 3.45, 0.85, 10.5, False, BLACK, line_spacing=1.3)
add_text(s, "第 3 周把结果写成可复核的报告：字段准确率、差异解释采纳率、人工耗时与错误类型。", 0.95, 5.9, 11.4, 0.3, 10.5, True, GRAY)
add_footer(s)
add_notes(s, "3 周试点合并了“试点一”：第 1 周拿样本，第 2 周跑对账差异解释，第 3 周出报告做 结果拍板会。第一刀只做对账，不碰付款/开票。")


# ---------------------------------------------------------------- 10 谁参与
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "需要什么", "老板给三样东西，负责人找齐四类人", "负责人是总协调人；老板只参加启动会和结果拍板会。")
asks = [
    ("200 份", "真实托书 / 对账单", "覆盖主要格式与异常"),
    ("1 名", "内部负责人", "能拍板、能协调数据"),
    ("1 套", "验收口径", "字段、工时、错误率"),
]
for i, (num, title, detail) in enumerate(asks):
    x = 0.7 + i * 4.12
    add_rect(s, x, 1.85, 3.82, 1.05, LIGHT, LIGHT_2)
    add_text(s, num, x + 0.25, 1.95, 1.75, 0.38, 20, True, ORANGE)
    add_text(s, title, x + 1.2, 1.98, 2.4, 0.3, 11, True, NAVY)
    add_text(s, detail, x + 1.2, 2.28, 2.4, 0.45, 9.3, False, GRAY)
roles = [
    ("业务负责人", "单证 / 财务主管", "每周 30 分钟", "拍板范围与验收、协调样本、主持复盘"),
    ("一线骨干", "单证员 / 财务专员", "首周 2 小时 + 试用", "解释单据、确认差异、反馈误判"),
    ("信息化接口人", "客户信息化", "首周 2–3 小时", "环境、账号、接口、网络与权限"),
    ("数据 / 安全", "安全或法务", "1 次评审", "脱敏规则、数据边界与合规确认"),
]
table_shape = s.shapes.add_table(len(roles) + 1, 4, Inches(0.7), Inches(3.15), Inches(11.95), Inches(3.05))
table = table_shape.table
for i, w in enumerate([2.3, 2.7, 2.2, 4.75]):
    table.columns[i].width = Inches(w)
for j, h in enumerate(["角色", "找谁", "投入", "负责什么"]):
    cell = table.cell(0, j); cell.text = h
    cell.fill.solid(); cell.fill.fore_color.rgb = NAVY
    for p in cell.text_frame.paragraphs:
        for r in p.runs: set_font(r, 10.3, True, WHITE)
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
for i, row in enumerate(roles, start=1):
    for j, val in enumerate(row):
        cell = table.cell(i, j); cell.text = val
        cell.fill.solid(); cell.fill.fore_color.rgb = WHITE if i % 2 else LIGHT
        for p in cell.text_frame.paragraphs:
            for r in p.runs: set_font(r, 9.8, j == 0, NAVY if j == 0 else BLACK)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
add_text(s, "负责人不需要老板每天盯：每周 30 分钟复盘，关键节点再拉老板拍板。采购/商务暂不参与，试点后再进场。", 0.7, 6.4, 11.95, 0.3, 10.5, True, NAVY)
add_footer(s)
add_notes(s, "老板给三样东西：样本、负责人、验收口径。负责人 去找四类人：业务负责人、一线骨干、信息化接口人、数据/安全。老板本人只参加 kickoff 和 结果拍板会 两次会。")


# ---------------------------------------------------------------- 11 分阶段配合
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么配合", "配合分三个阶段：每个阶段谁出现、做什么、交什么", "不是所有人都全程参与；按阶段拉人，减少对日常业务的打扰。")
rows = [
    ("第 1 周\n样本与基线", "业务负责人、单证/财务骨干、信息化、数据/安全",
     "提供 200 份脱敏样本；解释字段与口径；开通环境/账号；确认数据边界",
     "样本清单、基线、验收口径"),
    ("第 2 周\n跑对账 + 复核", "一线单证/财务、业务负责人",
     "抽检差异；确认解释；反馈误判；参加 1 次复核会",
     "差异分类、准确率、问题清单"),
    ("第 3 周\n报告与决策", "老板、业务负责人、财务、信息化",
     "参加结果拍板会；确认下一期范围/预算；确认上线条件",
     "评测报告、决策纪要"),
    ("试点后（可选）", "采购/商务、信息化、安全",
     "商务条款、部署方案、安全评审",
     "合同/上线计划"),
]
table_shape = s.shapes.add_table(len(rows) + 1, 4, Inches(0.7), Inches(1.95), Inches(11.95), Inches(4.05))
table = table_shape.table
for i, w in enumerate([2.1, 3.6, 4.5, 1.75]):
    table.columns[i].width = Inches(w)
for j, h in enumerate(["阶段", "谁参与", "需要配合什么", "产出"]):
    cell = table.cell(0, j); cell.text = h
    cell.fill.solid(); cell.fill.fore_color.rgb = NAVY
    for p in cell.text_frame.paragraphs:
        for r in p.runs: set_font(r, 10, True, WHITE)
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
for i, row in enumerate(rows, start=1):
    for j, val in enumerate(row):
        cell = table.cell(i, j); cell.text = val
        cell.fill.solid(); cell.fill.fore_color.rgb = WHITE if i % 2 else LIGHT
        for p in cell.text_frame.paragraphs:
            for r in p.runs: set_font(r, 9.3, j == 0, NAVY if j == 0 else BLACK)
            p.line_spacing = 1.1
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
add_text(s, "第 1 周最关键：样本和验收口径定不下来，后面都白跑；采购/商务不用现在进场。", 0.7, 6.35, 11.95, 0.3, 11, True, NAVY)
add_footer(s)
add_notes(s, "配合分三个阶段：第 1 周拿样本、定口径、开环境；第 2 周抽检差异、确认解释；第 3 周老板参加结果拍板会。采购/商务试点后再进场。")


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


# ---------------------------------------------------------------- 12 让老板放心
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "让老板放心", "四不承诺、四条底线、两次拍板", "先小范围、可回滚；达不到验收就停，不扩大。")
cards = [
    ("不换系统", "不替换运输管理系统 / 财务系统，只做上层增强，业务照常跑。", TEAL),
    ("不替人做决定", "大模型只出草稿；人工确认后才进入业务，可撤销、可回滚。", GREEN),
    ("不拿数据冒险", "默认客户内网/客户云；数据不出边界，外部模型调用单独确认。", ORANGE),
    ("不一次性投入", "3 周试点先验证；准确率不达标就停，不进入下一阶段。", RED),
]
for i, (title, detail, color) in enumerate(cards):
    x = 0.7 + (i % 2) * 6.05
    y = 1.95 + (i // 2) * 1.55
    add_rect(s, x, y, 5.75, 1.3, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.28, y + 0.17, 2.6, 0.35, 14, True, color)
    add_text(s, detail, x + 2.7, y + 0.18, 2.8, 0.95, 10.3, False, NAVY, line_spacing=1.3)
add_rect(s, 0.7, 5.25, 11.95, 0.9, NAVY, NAVY)
add_text(s, "老板只需要做两件事：指定一名负责人；参加启动会和结果拍板会。", 0.95, 5.48, 11.45, 0.4, 13, True, WHITE, PP_ALIGN.CENTER)
add_text(s, "不承诺裁人，不承诺“省几个人”；只承诺用你们的单据和工时，给出可复核的节省区间。", 0.7, 6.35, 11.95, 0.3, 11, True, NAVY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "老板最关心的是风险。四不：不换系统、不替人做决定、不拿数据冒险、不一次性投入。老板本人只做两件事：指定 负责人，参加两次会。")


# ---------------------------------------------------------------- 14 下一步
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
add_text(s, "下一步", 0.9, 0.7, 4.0, 0.35, 12, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "今天不谈合同，先跑一份\n用你们数据的结果", 0.9, 1.15, 9.5, 1.55, 34, True, WHITE, line_spacing=1.12)
asks = [
    ("200 份", "真实托书 / 对账单", "覆盖主要格式与异常"),
    ("1 名", "内部负责人", "能拍板、能协调数据"),
    ("1 套", "验收口径", "字段、工时、错误率"),
]
for i, (num, title, detail) in enumerate(asks):
    x = 0.9 + i * 4.05
    add_rect(s, x, 3.15, 3.7, 1.65, NAVY_2, RGBColor(0x2B, 0x4F, 0x70))
    add_text(s, num, x + 0.28, 3.32, 3.15, 0.45, 24, True, RGBColor(0xF5, 0xB4, 0x5A))
    add_text(s, title, x + 0.28, 3.85, 3.15, 0.35, 15, True, WHITE)
    add_text(s, detail, x + 0.28, 4.2, 3.15, 0.3, 10.5, False, RGBColor(0xB8, 0xC9, 0xD9))
add_text(s, "拿到这三样，3 周后我带一份用你们数据跑出来的准确率报告回来。", 0.9, 5.45, 11.5, 0.45, 15, True, WHITE)
add_text(s, "企业人工智能 ｜ 客户价值说明 ｜ 2026-11-05", 0.9, 6.6, 6.0, 0.3, 10, False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "收尾只要三样东西，不要合同。要样本、要 负责人、要验收口径。拿到这三样，3 周后带结果回来。")


prs.save(OUT)
print(f"saved {OUT} ({len(prs.slides)} slides)")
