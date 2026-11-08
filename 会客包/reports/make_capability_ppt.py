"""生成客户老板版「企业 AI 化能力说明」PPT。

目的：让客户老板判断三件事——
1. 我们的企业 AI 化是否能覆盖他的业务需要；
2. 我们是否理解集卡/拖车业务，而不是只会讲模型；
3. 我们是否有可运行的系统、可复测的样本、可推进的方法。

结构沿用：好处 → 能做什么 → 怎么表现 → 怎么做 → 需要什么配合和条件。
不展示内部工程指标（测试数量、门禁数量、开发进度）。
所有演示数字与界面必须标注“合成演示”，不得写成客户真实结论。
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
OUT = Path(__file__).resolve().parent / "客户老板版_系统能力介绍_2026-11-08.pptx"

NAVY = RGBColor(0x0F, 0x27, 0x40)
NAVY_2 = RGBColor(0x16, 0x3A, 0x5C)
TEAL = RGBColor(0x0E, 0x7C, 0x7B)
ORANGE = RGBColor(0xD9, 0x77, 0x06)
RED = RGBColor(0xB9, 0x1C, 0x1C)
GREEN = RGBColor(0x15, 0x80, 0x3D)
BLUE = RGBColor(0x1F, 0x4E, 0x79)
GRAY = RGBColor(0x5B, 0x6B, 0x7C)
LIGHT = RGBColor(0xF4, 0xF6, 0xF9)
LIGHT_2 = RGBColor(0xEA, 0xEF, 0xF5)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
BLACK = RGBColor(0x16, 0x20, 0x2A)
GREEN_BG = RGBColor(0xE6, 0xF4, 0xEA)
ORANGE_BG = RGBColor(0xFF, 0xF4, 0xE5)
BLUE_BG = RGBColor(0xE8, 0xF0, 0xFB)
FONT = "PingFang SC"

TOTAL = 18

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)


# ------------------------------------------------------------------ 基础组件
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


def add_box(slide, left, top, width, height, title, detail, fill, line, title_color=NAVY,
            title_size=11.5, detail_size=9.2):
    shape = add_rect(slide, left, top, width, height, fill, line)
    tf = shape.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left = Inches(0.08)
    tf.margin_right = Inches(0.08)
    tf.margin_top = Inches(0.04)
    tf.margin_bottom = Inches(0.04)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.line_spacing = 1.08
    r = p.add_run(); r.text = title
    set_font(r, title_size, True, title_color)
    if detail:
        p2 = tf.add_paragraph()
        p2.alignment = PP_ALIGN.CENTER
        p2.line_spacing = 1.08
        r2 = p2.add_run(); r2.text = detail
        set_font(r2, detail_size, False, GRAY)
    return shape


def add_entry_card(slide, left, top, width, height, title, detail, title_color=NAVY,
                   fill=LIGHT, line=LIGHT_2):
    add_rect(slide, left, top, width, height, fill, line)
    add_text(slide, title, left + 0.12, top + 0.09, width - 0.24, 0.24, 9.5, True, title_color)
    add_text(slide, detail, left + 0.12, top + 0.36, width - 0.24, 0.22, 8.2, False, GRAY)


def add_arrow(slide, left, top, width=0.45, height=0.3, color=ORANGE):
    shape = slide.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(left), Inches(top), Inches(width), Inches(height))
    shape.fill.solid(); shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    shape.shadow.inherit = False
    return shape


def add_down_arrow(slide, left, top, width=0.28, height=0.22, color=ORANGE):
    shape = slide.shapes.add_shape(MSO_SHAPE.DOWN_ARROW, Inches(left), Inches(top), Inches(width), Inches(height))
    shape.fill.solid(); shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    shape.shadow.inherit = False
    return shape


def add_header(slide, eyebrow, title, subtitle=None):
    add_text(slide, eyebrow, 0.7, 0.45, 8.0, 0.3, 11, True, TEAL)
    add_text(slide, title, 0.7, 0.78, 11.9, 0.55, 27, True, NAVY)
    if subtitle:
        add_text(slide, subtitle, 0.7, 1.38, 11.9, 0.4, 12.5, False, GRAY)
    add_line(slide, 0.7, 1.82 if subtitle else 1.52, 1.15, ORANGE, 0.045)


def add_footer(slide, total=TOTAL):
    page = len(prs.slides)
    add_text(slide, "企业人工智能 · 能力说明", 0.7, 7.12, 5.5, 0.22, 9, False, GRAY)
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


def add_pill(slide, left, top, text, color, bg, width=0.86, height=0.24, size=7.5):
    add_rect(slide, left, top, width, height, bg, bg)
    add_text(slide, text, left, top + 0.03, width, height - 0.04, size, True, color, PP_ALIGN.CENTER)


def add_table(slide, headers, rows, left, top, width, col_widths, row_h=0.5,
              header_h=0.4, size=9.5, header_size=10, first_bold=True):
    shape = slide.shapes.add_table(len(rows) + 1, len(headers), Inches(left), Inches(top),
                                   Inches(width), Inches(header_h + row_h * len(rows)))
    table = shape.table
    for i, w in enumerate(col_widths):
        table.columns[i].width = Inches(w)
    table.rows[0].height = Inches(header_h)
    for i in range(1, len(rows) + 1):
        table.rows[i].height = Inches(row_h)
    for j, h in enumerate(headers):
        cell = table.cell(0, j)
        cell.text = h
        cell.fill.solid(); cell.fill.fore_color.rgb = NAVY
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        for p in cell.text_frame.paragraphs:
            for r in p.runs:
                set_font(r, header_size, True, WHITE)
    for i, row in enumerate(rows, start=1):
        for j, val in enumerate(row):
            cell = table.cell(i, j)
            cell.text = val
            cell.fill.solid(); cell.fill.fore_color.rgb = WHITE if i % 2 else LIGHT
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            for p in cell.text_frame.paragraphs:
                p.line_spacing = 1.08
                for r in p.runs:
                    set_font(r, size, first_bold and j == 0, NAVY if (first_bold and j == 0) else BLACK)
    return table


def add_card(slide, left, top, width, height, eyebrow, title, detail, color=TEAL,
             filled=False, status=None, status_color=GREEN, status_bg=GREEN_BG):
    fill = NAVY if filled else LIGHT
    line = NAVY if filled else LIGHT_2
    add_rect(slide, left, top, width, height, fill, line)
    add_text(slide, eyebrow, left + 0.22, top + 0.16, width - 0.44, 0.24, 9, True,
             RGBColor(0xF5, 0xB4, 0x5A) if filled else color)
    add_text(slide, title, left + 0.22, top + 0.42, width - 0.44, 0.38, 13.5, True,
             WHITE if filled else NAVY)
    add_text(slide, detail, left + 0.22, top + 0.88, width - 0.44, height - 0.98, 9.5, False,
             RGBColor(0xD7, 0xE3, 0xEF) if filled else GRAY, line_spacing=1.32)
    if status:
        add_pill(slide, left + 0.22, top + height - 0.34, status, status_color, status_bg,
                 width=0.8, height=0.22, size=7.2)


# ================================================================ 01 封面
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
add_line(s, 0.9, 1.0, 0.65, ORANGE, 0.06)
add_text(s, "给管理层的业务说明 ｜ 2026-11", 0.9, 1.3, 7.0, 0.35, 13, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "从一张托书开始\n把一条出口物流业务链变得可算账", 0.9, 1.9, 10.6, 1.7, 35, True, WHITE, line_spacing=1.12)
add_text(s, "企业 AI 化，不换货代系统，先从一个单据入口开始。",
         0.92, 3.9, 10.8, 0.4, 17, False, RGBColor(0xD7, 0xE3, 0xEF))
add_text(s, "不是买一个模型，是把单据、过程、经营数据变成可管理、可追溯、可算账的资产。",
         0.92, 4.45, 11.2, 0.4, 13, False, RGBColor(0xB8, 0xC9, 0xD9))

chips = ["单据与单证", "在途与调度", "对账与结算", "成本与经营", "知识与经验"]
for i, chip in enumerate(chips):
    x = 0.92 + i * 2.28
    add_rect(s, x, 5.25, 2.08, 0.46, NAVY_2, RGBColor(0x2B, 0x4F, 0x70))
    add_text(s, chip, x, 5.36, 2.08, 0.26, 9.5, True, RGBColor(0xCF, 0xE3, 0xF1), PP_ALIGN.CENTER)

add_text(s, "呈：顺德协丰物流有限公司管理层", 0.92, 5.92, 7.5, 0.3, 11, True,
         RGBColor(0xD7, 0xE3, 0xEF))
add_text(s, "文中界面与数字均为合成演示；真实效果以贵司样本复测为准。", 0.92, 6.55, 9.5, 0.3, 10,
         False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "开场定调：今天不是汇报开发进度，也不是让老板马上买什么。先让老板判断：我们的能力覆盖不覆盖他的业务、我们懂不懂这行、有没有可运行的东西和推进方法。")


# ================================================================ 02 好处
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "好处", "AI 带来的不是“更聪明”，是四件老板能看见的事",
           "少花时间、少出错、算清账、留下经验；每一件都能用贵司的单据和工时复测。")
benefits = [
    ("01", "少花时间", "托书、对账、催收都靠人翻。",
     "机器先读、先算，人只处理异常。", "可测：单均耗时、月结天数", TEAL),
    ("02", "少出错", "箱号、税号、金额、截港靠肉眼。",
     "规则先挑错，错单更早被拦住。", "可测：错单率、退回率、重复收费", GREEN),
    ("03", "算清账", "哪单赚钱、谁欠最久，靠拍脑袋。",
     "成本、毛利、账龄都追到单据。", "可测：毛利口径、逾期清单", ORANGE),
    ("04", "留下经验", "老单证员的判断只在脑子里。",
     "SOP、合同、报关口径可检索，难例变样本。", "可测：新人上手、重复问题", BLUE),
]
for i, (num, title, today, after, measure, color) in enumerate(benefits):
    x = 0.7 + i * 3.05
    add_rect(s, x, 1.98, 2.8, 4.05, LIGHT, LIGHT_2)
    add_text(s, num, x + 0.24, 2.14, 0.8, 0.4, 20, True, color)
    add_text(s, title, x + 0.24, 2.62, 2.35, 0.38, 15, True, NAVY)
    add_text(s, "今天", x + 0.24, 3.12, 2.3, 0.24, 9, True, GRAY)
    add_text(s, today, x + 0.24, 3.38, 2.32, 0.72, 9.6, False, BLACK, line_spacing=1.3)
    add_text(s, "之后", x + 0.24, 4.18, 2.3, 0.24, 9, True, color)
    add_text(s, after, x + 0.24, 4.44, 2.32, 0.72, 9.6, False, BLACK, line_spacing=1.3)
    add_text(s, measure, x + 0.24, 5.42, 2.32, 0.45, 8.6, True, color, line_spacing=1.25)

add_rect(s, 0.7, 6.22, 11.95, 0.55, NAVY, NAVY)
add_text(s, "这四件事都不需要先换系统：从一条业务链的一个环节接进去，跑通再扩。",
         0.95, 6.36, 11.45, 0.3, 12, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "先讲老板能感知的结果，不讲模型参数。四件事都可以用客户自己的单据和工时测，不用相信我们的口头承诺。")


# ================================================================ 03 全链路覆盖
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么 · 全貌", "一条出口物流业务链，九个环节，AI 的介入方式不一样",
           "协丰这类港口 + 货代 + 运输企业，单据不止托书；每个环节的介入方式不同。")
stages = [
    ("① 接单报价", "报价助手", "模型读文本\n+ 规则算价", "演示", ORANGE, ORANGE_BG),
    ("② 订舱 / 托书", "订舱委托 / 托书", "模型读图\n+ 规则校验", "已实现", GREEN, GREEN_BG),
    ("③ 单证核对", "单证一致性", "规则比对\n+ 模型说明", "已实现", GREEN, GREEN_BG),
    ("④ 拖车 / 驳船", "调度 / 装箱", "运筹优化\n（非大模型）", "已实现·合成", ORANGE, ORANGE_BG),
    ("⑤ 在途跟踪", "在途 / 客户查询", "规则抽事件\n+ 模型补充", "已实现·合成", ORANGE, ORANGE_BG),
    ("⑥ 报关放行", "关务 HS", "词库候选\n+ 模型选", "待数据", BLUE, BLUE_BG),
    ("⑦ 对账结算", "对账 / 结算", "规则匹配\n+ 模型解释", "已实现", GREEN, GREEN_BG),
    ("⑧ 应收催收", "账龄 / 催收", "规则分档\n+ 可选润色", "已实现", GREEN, GREEN_BG),
    ("⑨ 经营分析", "成本 / 毛利 / 预测", "规则 / 统计\n非大模型", "已实现/演示", ORANGE, ORANGE_BG),
]
col_w = 1.221
gap = 0.12
for i, (stage, cap, method, status, color, bg) in enumerate(stages):
    x = 0.7 + i * (col_w + gap)
    add_rect(s, x, 1.98, col_w, 2.42, LIGHT, LIGHT_2)
    add_rect(s, x, 1.98, col_w, 0.46, NAVY, NAVY)
    add_text(s, stage, x, 2.06, col_w, 0.28, 8.2, True, WHITE, PP_ALIGN.CENTER)
    add_text(s, cap, x + 0.06, 2.56, col_w - 0.12, 0.56, 8.0, True, NAVY,
             PP_ALIGN.CENTER, line_spacing=1.2)
    add_text(s, method, x + 0.06, 3.18, col_w - 0.12, 0.7, 7.4, False, GRAY,
             PP_ALIGN.CENTER, line_spacing=1.25)
    add_pill(s, x + (col_w - 0.92) / 2, 3.98, status, color, bg, width=0.92, height=0.24, size=6.8)

add_text(s, "绿＝大模型读/写/答　橙＝规则/运筹/统计　蓝＝待客户数据　「已实现·合成」＝代码已实现、合成回归通过、待客户接口",
         0.7, 4.58, 11.95, 0.28, 9.0, True, GRAY)

checks = [
    ("发生频率", "每天都要做、量大的环节，先做。"),
    ("单次工时", "超过 5 分钟、重复度高的先做。"),
    ("出错成本", "错了要退单、赔钱、丢客户的，先做。"),
]
for i, (title, detail) in enumerate(checks):
    x = 0.7 + i * 4.0
    add_rect(s, x, 5.0, 3.82, 0.9, WHITE, LIGHT_2)
    add_text(s, title, x + 0.18, 5.12, 1.2, 0.28, 10, True, TEAL)
    add_text(s, detail, x + 1.32, 5.10, 2.32, 0.62, 9, False, BLACK, line_spacing=1.25)

add_rect(s, 0.7, 6.22, 11.95, 0.55, NAVY, NAVY)
add_text(s, "贵司不需要一次全上：先选 1–2 段跑通，再把数据串起来。",
         0.95, 6.36, 11.45, 0.3, 12, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "这页回答“到底能覆盖哪些环节”。九个环节里，大模型只在读、写、答、选的位置；匹配、计算、调度、预测都不是大模型。先做哪段，用频率、工时、出错成本三个维度判断。")


# ================================================================ 04 四类 AI
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么 · 总览", "四类能力，四个 AI 岗位",
           "读单据、跟过程、算经营、存经验——四个岗位，底层是同一套能力。")
cats = [
    ("AI 单证员", "把非结构化变成结构化", "托书 / 订舱委托 / 发票 / 对账单 / 单证一致性",
     "读得准、校验得住；低置信转人工，确认后才入业务。", "已实现", GREEN, GREEN_BG),
    ("AI 调度 / 客服", "把过程信息变成可追踪的事件", "在途事件 / 客户查询 / 调度装箱 / 关务 HS",
     "代码与页面已实现；400 票/500 单/360 条消息合成回归通过；真实上线需接口。", "已实现·合成", ORANGE, ORANGE_BG),
    ("AI 财务 / 经营助理", "把单据和费用变成经营结论", "报价 / 成本归集 / 单票毛利 / 账龄 / 盈利 / 预测",
     "数字全部由规则/统计算；模型只写解释，不碰金额。", "已实现 + 演示", TEAL, GREEN_BG),
    ("AI 知识管理员", "把个人经验变成可检索资产", "客户知识库 / 学习队列 / 金标 / 运行月报",
     "回答带原文引用；没有就明确说没有，不编。", "已实现", BLUE, BLUE_BG),
]
for i, (title, sub, caps, detail, status, color, bg) in enumerate(cats):
    x = 0.7 + (i % 2) * 6.05
    y = 1.98 + (i // 2) * 2.12
    add_rect(s, x, y, 5.85, 1.92, LIGHT, LIGHT_2)
    add_line(s, x, y, 0.08, color, 1.92)
    add_text(s, title, x + 0.3, y + 0.18, 3.0, 0.34, 15, True, NAVY)
    add_text(s, sub, x + 0.3, y + 0.56, 4.4, 0.26, 9.5, True, color)
    add_text(s, caps, x + 0.3, y + 0.9, 5.3, 0.4, 9.8, False, BLACK, line_spacing=1.25)
    add_text(s, detail, x + 0.3, y + 1.32, 4.9, 0.42, 8.8, False, GRAY, line_spacing=1.25)
    add_pill(s, x + 4.82, y + 0.2, status, color, bg, width=0.86, height=0.22, size=7.0)

add_rect(s, 0.7, 6.22, 11.95, 0.55, NAVY, NAVY)
add_text(s, "能力是底层，岗位是入口；先配一个岗位，跑通再扩；不卖“全行业 AI 平台”。",
         0.95, 6.36, 11.45, 0.3, 12, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "四类不是产品菜单，是四种工作：读、跟、算、存。这样老板能把自己的业务往里面放，而不是听我们报功能名。")


# ================================================================ 05 文档与单证
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么 ①", "单证：机器读、规则查、人确认",
           "托书、订舱委托、装箱单、发票、对账单进来，先变成带置信度的字段，再让规则挑错。")
rows = [
    ("托书 / 订舱委托", "企微文字 / 图片、H5、批量、粘贴",
     "识别 + 抽字段；箱号、截港、地址校验；低置信转人工", "已实现"),
    ("发票识别", "图片、PDF、扫描件",
     "税号校验位、金额勾稽、抬头比对；异常票先拦", "已实现"),
    ("批量导入", "一次几十份图片 / PDF",
     "排队识别、失败重试、逐份确认、原件留存", "已实现"),
    ("单证一致性", "托书/订舱委托/装箱单/对账单任两份",
     "字段规则比对；模型只写差异说明，不改原值", "已实现"),
    ("异常费用", "费用明细、结算单",
     "重复收费、算术不符、未知费用、同批离群", "已实现"),
]
add_table(s, ["能力", "输入", "系统做什么", "状态"], rows, 0.7, 1.98, 11.95,
          [1.85, 3.15, 5.75, 1.2], row_h=0.56, header_h=0.4, size=9.4)
add_text(s, "共同边界：模型不发明格式字段（箱号、税号、金额），强格式一律以规则为准；对不上就转人工。",
         0.7, 5.35, 11.95, 0.3, 10, True, RED)
add_rect(s, 0.7, 6.02, 11.95, 0.62, LIGHT, LIGHT_2)
add_text(s, "入口数据不干净，后面的对账、账龄、毛利都不成立；所以第一步永远是单据。",
         0.95, 6.17, 11.45, 0.32, 12, True, NAVY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "单证是入口。托书和发票不是“识别一下就完了”，而是识别、校验、确认、留痕四件事。强格式字段用规则，模型只做语义理解。")


# ================================================================ 06 对账与结算
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么 ②", "对账与结算：先找差异，再解释差异，最后留痕",
           "匹配和金额由规则算；大模型只写“可能原因”，不碰数字。")
rows = [
    ("自动对账", "对账单 → 运单逐条匹配", "一致 / 金额不符 / 系统无此单 / 客户漏单"),
    ("三单匹配", "订单 → 运单 → 发票", "缺单、金额不一致、状态不符"),
    ("外协结算", "合同价 × 数量 → 车队报账", "应付差异、重复报账、单价不符"),
    ("异常费用", "重复、算术、未知、同批离群", "需核对清单，不直接判对错"),
    ("差异复核", "采纳 / 修改后采纳 / 忽略 + 备注", "可追溯的处理记录与导出"),
]
add_table(s, ["能力", "做什么", "产出"], rows, 0.7, 1.98, 8.0,
          [1.55, 3.15, 3.3], row_h=0.54, header_h=0.4, size=9.3)

add_rect(s, 8.95, 1.98, 3.7, 3.5, LIGHT, LIGHT_2)
add_text(s, "一笔差异怎么走完", 9.15, 2.12, 3.3, 0.32, 12, True, NAVY)
flow = [
    ("① 规则匹配", "先找出来，不靠人翻"),
    ("② 差异分类", "系统无此单 / 金额不符 / 客户漏单"),
    ("③ 模型解释", "只写可能原因，不改金额"),
    ("④ 人决定", "采纳 / 修改 / 忽略，全部留痕"),
]
for i, (title, detail) in enumerate(flow):
    y = 2.56 + i * 0.7
    add_text(s, title, 9.15, y, 1.15, 0.26, 9.2, True, TEAL)
    add_text(s, detail, 10.3, y - 0.01, 2.2, 0.62, 8.4, False, BLACK, line_spacing=1.2)

add_text(s, "以演示数据为例：11 条对账单，8 条一致、2 条金额不符、1 条系统无此单、1 条客户漏单。",
         0.7, 5.22, 7.9, 0.55, 9.6, True, NAVY, line_spacing=1.3)
add_text(s, "截图与数字均为演示；真实客户需用贵司对账单复测。", 8.95, 5.28, 3.7, 0.4, 8.6, False, GRAY, line_spacing=1.25)
add_rect(s, 0.7, 6.05, 11.95, 0.58, NAVY, NAVY)
add_text(s, "对账不是看总数，是把每条差异分到处理决定；财务的时间应该花在异常上。",
         0.95, 6.19, 11.45, 0.3, 12, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "对账是财务最痛的场景。先讲清匹配和解释是两件事：匹配是规则，解释是模型，决定是人。这样老板不用担心模型乱改金额。")


# ================================================================ 07 在途与客户
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么 ③", "在途与客户：把群里的口语，变成能查、能追、能提醒的事件",
           "规则先抽事件，模型只补充；没有数据就明确说没有，不编船期。")
items = [
    ("在途异常", "调度 / 司机群文字",
     "提箱、装柜、进港、报关、放行、压车、改单、甩柜 → 事件卡片；带原文证据；不自动改单。",
     "产出：事件卡片 + 原文证据 + 时间线", "已实现·合成"),
    ("客户查询", "箱号 / 单号 / 客户",
     "当前状态、ETA、报关、时间线；模型只改写措辞；真实上线需港口 / 船期 / 报关接口。",
     "产出：一条回答 + 状态卡片 + 时间线", "已实现·合成"),
    ("调度优化", "订单 / 车辆 / 驳船 / 箱型",
     "空驶、准时率、装箱率优化前后对比；启发式运筹，不是大模型；需订单/车辆/驳船/舱位/GPS。",
     "产出：优化前后对比 + 调度表", "已实现·合成"),
    ("关务 HS", "商品描述",
     "只从客户词库 / 历史报关记录里选候选；模型只在候选内选并解释；不自动申报。",
     "产出：HS 候选 + 置信度 + 依据", "待数据"),
]
for i, (title, inp, detail, out, status) in enumerate(items):
    x = 0.7 + (i % 2) * 6.05
    y = 1.98 + (i // 2) * 2.1
    add_rect(s, x, y, 5.85, 1.9, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.28, y + 0.16, 2.6, 0.34, 14, True, NAVY)
    add_text(s, "输入：" + inp, x + 0.28, y + 0.55, 4.3, 0.26, 9.2, True, TEAL)
    add_text(s, detail, x + 0.28, y + 0.86, 5.3, 0.62, 9.3, False, BLACK, line_spacing=1.3)
    add_text(s, out, x + 0.28, y + 1.52, 5.3, 0.28, 8.8, True, TEAL)
    synthetic = status in ("演示", "已实现·合成")
    add_pill(s, x + 4.78, y + 0.18, status, ORANGE if synthetic else BLUE,
             ORANGE_BG if synthetic else BLUE_BG, width=0.92, height=0.22, size=7.0)

add_rect(s, 0.7, 6.12, 11.95, 0.62, LIGHT, LIGHT_2)
add_text(s, "代码和页面都已实现；「能力回归」页可复跑 400 票/500 单/360 条消息/200 条 HS。真实上线仍需接港口/船期/订单/GPS 接口。",
         0.95, 6.27, 11.45, 0.32, 10.8, True, NAVY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "在途和客户查询是老板最容易兴奋、也最容易过度承诺的地方。必须当面讲清：没有港口、船期、报关接口，就只能演示，不能承诺实时。")


# ================================================================ 08 经营与决策
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么 ④", "经营：从“月底拍脑袋”到“每单可追、每客户可算”",
           "报价、成本、毛利、账龄、预测，全部由规则/统计计算；模型只做解释。")
items = [
    ("报价助手", "历史价 + 成本 + 目标毛利 → 建议价与风险；模型补线路/箱型并写解释，不自动对外报价。",
     "可测：报价耗时、成交毛利率", "演示"),
    ("成本归集", "费用按单号归集；没单号按“车辆 + 日期”找唯一订单；仍找不到进“待分摊”并提示。",
     "可测：待分摊比例、归集率", "已实现"),
    ("单票 / 线路毛利", "单票/线路收入 - 成本；亏损单先暴露；按车辆归集，驳船/线路需确认。",
     "可测：亏损单占比、单票毛利", "已实现"),
    ("账龄催收", "按逾期天数分档、客户风险、催收优先级；话术可人工编辑，AI 润色默认关闭。",
     "可测：逾期金额、回款天数", "已实现"),
    ("盈利分析", "客户 / 线路的收入、成本、毛利、集中度、趋势；先看结论，再看明细。",
     "可测：客户/线路毛利、集中度", "演示"),
    ("预测信用", "回款、线路趋势、客户风险；规则/简单统计，需 12–24 个月历史回测。",
     "可测：回测误差、命中率", "演示"),
]
for i, (title, detail, measure, status) in enumerate(items):
    x = 0.7 + (i % 3) * 4.0
    y = 1.98 + (i // 3) * 2.08
    add_rect(s, x, y, 3.82, 1.88, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.24, y + 0.16, 2.4, 0.34, 13.5, True, NAVY)
    add_text(s, detail, x + 0.24, y + 0.56, 3.35, 0.95, 9.2, False, BLACK, line_spacing=1.32)
    add_text(s, measure, x + 0.24, y + 1.58, 3.35, 0.26, 8.2, True, TEAL)
    add_pill(s, x + 2.78, y + 0.18, status, ORANGE if status == "演示" else GREEN,
             ORANGE_BG if status == "演示" else GREEN_BG, width=0.8, height=0.22, size=7.2)

add_rect(s, 0.7, 6.12, 11.95, 0.62, LIGHT, LIGHT_2)
add_text(s, "经营结论必须可复现、可审计；所以不让模型算数字，只让它把规则算出的结果讲清楚。",
         0.95, 6.27, 11.45, 0.32, 12, True, NAVY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "经营类功能解决的是老板自己的问题：哪单亏、哪个客户赚钱、谁该先催。数字必须能追到单据，不能由模型生成。")


# ================================================================ 09 知识与经验
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能做什么 ⑤", "知识与经验：让“老单证员脑子里的东西”留下来",
           "SOP、合同、报关口径可检索；人改过的难例可以变成下一轮样本。")
cols = [
    ("客户知识库", "上传 SOP / 合同 / 报关口径；提问返回原文引用；没有就明确说“没有找到”。",
     "回答带引用；无引用回退原文摘录；无模型也能用。", "已实现"),
    ("学习队列 / 金标", "人工修正过的单据进入队列；标注成金标；用于回归测试和版本对比。",
     "人改一次，系统记住一次；不重复犯同样的错。", "已实现"),
    ("运行月报", "工时、准确率、绕过率、异常类型；按月出，能拿给老板和客户看。",
     "不靠人回忆；每个月的效果有据可查。", "已实现"),
]
for i, (title, detail, note, status) in enumerate(cols):
    x = 0.7 + i * 4.0
    add_rect(s, x, 1.98, 3.82, 2.45, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.26, 2.16, 3.2, 0.36, 14.5, True, NAVY)
    add_text(s, detail, x + 0.26, 2.62, 3.3, 1.2, 9.6, False, BLACK, line_spacing=1.35)
    add_text(s, note, x + 0.26, 3.55, 3.3, 0.62, 8.8, True, TEAL, line_spacing=1.25)
    add_pill(s, x + 2.78, 2.0, status, GREEN, GREEN_BG, width=0.8, height=0.22, size=7.2)

add_rect(s, 0.7, 4.85, 11.95, 1.68, NAVY, NAVY)
add_text(s, "为什么这对老板重要", 0.98, 5.03, 3.2, 0.3, 11, True, RGBColor(0xF5, 0xB4, 0x5A))
add_text(s, "不是“回答多聪明”，而是：新人少问、老人少救火、口径不靠口口相传。",
         0.98, 5.37, 8.2, 0.4, 15, True, WHITE)
add_text(s, "人走了，经验还在系统里；换人、扩编、接新客户，不用从零再教一遍。",
         0.98, 5.83, 10.8, 0.35, 11, False, RGBColor(0xC9, 0xD8, 0xE6))
add_footer(s)
add_notes(s, "知识库不是聊天机器人。它的价值是把老员工的判断、客户口径、报关规则留下来，减少对个人的依赖。")


# ================================================================ 10 表现：托书
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么表现 ①", "一张托书，从群里到结构化草稿",
           "企微文字可直接发、支持分条；字段带置信度，规则先挑错，低置信转人工。")
add_image_fit(s, "wecom-chat-demo.png", 4.55, 1.95, 3.95, 4.9)
add_entry_card(s, 0.7, 2.0, 1.7, 0.66, "企业微信文字", "直接发、可分条",
               GREEN, RGBColor(0xE8, 0xF8, 0xEE), RGBColor(0x9F, 0xD8, 0xB0))
add_entry_card(s, 2.55, 2.0, 1.7, 0.66, "H5 拍照 / 上传", "手机拍托书")
add_entry_card(s, 0.7, 2.78, 1.7, 0.66, "批量导入", "一次几十份")
add_entry_card(s, 2.55, 2.78, 1.7, 0.66, "网页粘贴", "临时试单")
add_bullets(s, [
    ("少抄", "客户、箱号、截港等字段自动带出"),
    ("少错", "箱号校验位、截港、地址冲突先提示"),
    ("可追溯", "人工确认与修正全部留痕"),
], 0.7, 3.7, 3.55, 1.25, 10.5, BLACK, TEAL, 7)
add_rect(s, 0.7, 5.05, 3.55, 1.55, LIGHT, LIGHT_2)
add_text(s, "老板看到的不是“模型多强”，而是“单证员少抄多少、错单少多少”。",
         0.95, 5.3, 3.05, 1.0, 11.5, True, NAVY, line_spacing=1.35)
flow = [
    ("① 发", "文字直接发，分几条也行"),
    ("② 看", "字段、置信度、规则提示"),
    ("③ 确认", "回复「确认」入库"),
]
for i, (title, detail) in enumerate(flow):
    y = 2.0 + i * 1.45
    add_box(s, 8.85, y, 3.9, 1.15, title, detail, LIGHT, LIGHT_2, TEAL)
    if i < 2:
        add_down_arrow(s, 10.66, y + 1.17, 0.28, 0.22)
add_text(s, "企微图片支持直接发图（需配置 Secret / AgentID），也可走 H5 / 批量；确认后才入业务。",
         8.85, 6.35, 3.9, 0.45, 8.5, False, GRAY, line_spacing=1.25)
add_text(s, "截图：企业微信对话；内容为【合成演示】数据。", 4.55, 6.9, 3.95, 0.2, 8, False, GRAY)
add_footer(s)
add_notes(s, "这张是企业微信对话截图，内容是合成演示数据，不是客户真实托书。入口不同，后面是同一套解析、规则校验和人工确认。改进点：企微图片已支持直接发图，需要配置 Secret/AgentID。")


# ================================================================ 11 表现：对账
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么表现 ②", "对账不是“看个总数”，而是把差异分到处理决定",
           "对账单、运单、结算单逐条比对；每条差异有原因、有处理记录。")
add_image_fit(s, "ui-copilot-reconcile.png", 4.55, 1.9, 8.2, 5.05)
add_bullets(s, [
    ("差异分类", "系统无此单 / 金额不符 / 客户漏单"),
    ("可解释", "每条给原因，不只是标红"),
    ("可导出", "差异表直接给财务跟进"),
], 0.7, 2.0, 3.55, 1.55, 10.5, BLACK, TEAL, 7)
add_rect(s, 0.7, 3.2, 3.55, 1.15, WHITE, LIGHT_2)
add_text(s, "差异从哪来", 0.9, 3.28, 1.6, 0.24, 9, True, NAVY)
add_text(s, "金额不符：单价、数量、附加费口径", 0.9, 3.55, 3.2, 0.22, 8.2, False, GRAY)
add_text(s, "系统无此单：漏录、错单、重复计费", 0.9, 3.79, 3.2, 0.22, 8.2, False, GRAY)
add_text(s, "客户漏单：客户没报或运单未关联", 0.9, 4.03, 3.2, 0.22, 8.2, False, GRAY)
add_rect(s, 0.7, 4.55, 3.55, 1.9, LIGHT, LIGHT_2)
add_text(s, "以演示数据为例：11 条对账单，8 条一致、2 条金额不符、1 条系统无此单、1 条客户漏单；每条都有建议动作和处理记录。",
         0.95, 4.73, 3.05, 1.2, 10.2, True, NAVY, line_spacing=1.32)
add_text(s, "差异表可导出，直接给财务跟进。", 0.95, 6.02, 3.05, 0.24, 9, True, TEAL)
add_text(s, "截图：演示数据；真实客户需用贵司对账单复测。", 4.55, 7.0, 7.0, 0.2, 8.5, False, GRAY)
add_footer(s)
add_notes(s, "对账页要讲“差异分类 + 建议动作 + 人工决定”，不是讲界面多漂亮。演示数据 11 条，和截图一致。")


# ================================================================ 12 表现：在途/调度/经营
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么表现 ③", "在途、调度、经营，也都能打开看",
           "以下均为合成演示数据；真实上线需要贵司的接口与历史数据。")
shots = [
    ("客户查询", "箱号 / 单号 / 客户 → 状态、ETA、报关、时间线", "ai-track.png"),
    ("调度优化", "500 单 / 60 车回归；页面展示 160 单样本", "ai-dispatch.png"),
    ("盈利分析", "客户 / 线路收入、成本、毛利、集中度", "ai-profit.png"),
]
for i, (title, detail, img) in enumerate(shots):
    x = 0.7 + i * 4.07
    add_image_fit(s, img, x, 1.98, 3.82, 2.2)
    add_text(s, title, x, 4.3, 3.82, 0.3, 12, True, NAVY)
    add_text(s, detail, x, 4.62, 3.82, 0.4, 8.8, False, GRAY, line_spacing=1.25)

add_rect(s, 0.7, 5.35, 11.95, 1.05, LIGHT, LIGHT_2)
add_text(s, "这三页不是“AI 万能”，是“先做到哪、下一步要什么”", 0.98, 5.52, 8.5, 0.36, 14, True, NAVY)
add_text(s, "客户查询要港口 / 船期 / 报关接口；调度要订单 / 车辆 / 驳船 / 舱位 / GPS；盈利要客户成本科目与 12–24 个月历史。没有这些，只能演示，不能承诺。",
         0.98, 5.94, 11.2, 0.5, 9.8, False, GRAY, line_spacing=1.3)
add_text(s, "全部为合成演示数据，不代表真实客户结论；调度 78.1% 为 160 单小样本，500 单/60 车回归为 22.6%→35.0%。", 0.7, 6.72, 11.95, 0.3, 8.5, False, GRAY)
add_footer(s)
add_notes(s, "这一页用来看广度：除了托书和对账，在途、调度、经营也有可打开的页面。但必须同时讲清数据前提，避免老板以为已经能实时接港口。")


# ================================================================ 13 边界
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "边界", "AI 用在哪、不用在哪：一条线划清楚",
           "读、写、答、选可以交给模型；算、匹配、审批、对外承诺不行。")

add_rect(s, 0.7, 1.98, 5.85, 2.55, GREEN_BG, RGBColor(0xC9, 0xE8, 0xD4))
add_text(s, "交给模型", 0.98, 2.14, 2.0, 0.34, 15, True, GREEN)
add_bullets(s, [
    "读图、读扫描件，把字认出来并归位",
    "把长文本压成事件、摘要、差异说明",
    "在检索到的原文里回答问题，并给引用",
    "在客户词库的候选里选一个，并解释",
    "把规则算好的结果，改写成业务能读懂的话",
], 0.98, 2.58, 5.25, 2.6, 10, BLACK, GREEN, 8)

add_rect(s, 6.8, 1.98, 5.85, 2.55, ORANGE_BG, RGBColor(0xF3, 0xD3, 0xA8))
add_text(s, "不交给模型", 7.08, 2.14, 2.4, 0.34, 15, True, ORANGE)
add_bullets(s, [
    "箱号、税号、金额、截港的校验",
    "对账匹配、三单匹配、外协结算",
    "账龄、成本、毛利、经营指标",
    "调度、装箱/驳船（运筹）与回款趋势（统计）",
    "审批、对外报价、申报、扣费",
], 7.08, 2.58, 5.25, 2.6, 10, BLACK, ORANGE, 8)

three = [
    ("可复现", "同一张单，今天和明天结果一致"),
    ("可追溯", "每个数字都能追到单据和原文"),
    ("可回退", "模型失败或无数据，回到规则或人工"),
]
for i, (title, detail) in enumerate(three):
    x = 0.7 + i * 4.07
    add_rect(s, x, 4.75, 3.82, 0.62, WHITE, LIGHT_2)
    add_text(s, title, x + 0.2, 4.85, 1.2, 0.26, 10.5, True, TEAL)
    add_text(s, detail, x + 1.35, 4.83, 2.3, 0.4, 8.8, False, BLACK, line_spacing=1.2)

add_rect(s, 0.7, 5.6, 11.95, 0.62, RED, RED)
add_text(s, "不自动改单、不自动派车、不自动扣费、不自动申报、不自动对外报价；所有对外动作都要人确认。",
         0.95, 5.74, 11.45, 0.32, 11.5, True, WHITE, PP_ALIGN.CENTER)
add_text(s, "模型失败必须能回退规则；没有数据必须说“没有”，不能编。",
         0.7, 6.38, 11.95, 0.3, 10.5, True, NAVY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "这页是信任的基础。老板最怕模型乱来。把“模型做什么、不做什么”讲清楚，比堆功能更有用。")


# ================================================================ 14 怎么做：方法
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么做 · 方法", "四步把 AI 变成可验收的流程",
           "先做入口数据，再做规则，最后人确认和分析；顺序不能反。")
steps = [
    ("第一步", "读进来", "托书 / 发票 / 对账单 / 群消息\n→ 字段 + 置信度", "模型只出草稿"),
    ("第二步", "查得住", "箱号 / 税号 / 金额 / 截港 / 匹配\n→ 异常清单", "规则先挑错"),
    ("第三步", "人确认", "低置信 / 异常 / 审批\n→ 确认、修正、撤销留痕", "确认后才入业务"),
    ("第四步", "用起来", "对账 / 账龄 / 成本 / 洞察 / 预测\n→ 结论 + 动作", "规则算，人解读"),
]
for i, (step, title, detail, note) in enumerate(steps):
    x = 0.7 + i * 3.12
    add_rect(s, x, 2.0, 2.72, 2.7, LIGHT, LIGHT_2)
    add_text(s, step, x + 0.25, 2.15, 1.4, 0.28, 10.5, True, ORANGE)
    add_text(s, title, x + 0.25, 2.5, 2.2, 0.4, 18, True, NAVY)
    add_text(s, detail, x + 0.25, 3.02, 2.25, 0.95, 10, False, GRAY, line_spacing=1.3)
    add_text(s, note, x + 0.25, 4.12, 2.25, 0.35, 9.5, True, TEAL)
    if i < 3:
        add_arrow(s, x + 2.78, 3.05, 0.28, 0.3)

add_rect(s, 0.7, 5.1, 11.95, 1.55, NAVY, NAVY)
add_text(s, "入口数据不干净，后面的对账、账龄、毛利都不成立。",
         0.98, 5.3, 8.0, 0.4, 16, True, WHITE)
add_text(s, "所以先做单据和规则，不先做“大屏”和“预测”；先把可验收的地基打牢。",
         0.98, 5.82, 11.2, 0.35, 11.5, False, RGBColor(0xC9, 0xD8, 0xE6))
add_text(s, "验收标准：准确率、召回率、采纳率、工时，四项都用贵司数据测。",
         0.98, 6.22, 11.2, 0.3, 10.5, True, RGBColor(0xF5, 0xB4, 0x5A))
add_footer(s)
add_notes(s, "四步法是我们的实施顺序，也是判断一个供应商靠不靠谱的标准：上来就讲预测和 Agent 的，通常没有把入口数据做干净。")


# ================================================================ 15 怎么做：路径
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "怎么做 · 路径", "三个阶段：先单点跑通，再同类扩展，最后跨环节串联",
           "推进节奏由数据就绪度决定，不由合同大小决定；每一阶段都可以停。")
phases = [
    ("阶段一", "单点跑通", "2–4 周", [
        "选 1 个最痛场景",
        "50 份样本先跑",
        "定字段、口径、验收人",
    ], "看：字段准确率 / 差异召回 / 单均耗时", "产出：准确率 / 工时 / 错误类型报告",
     "进入下一阶段：达到约定阈值", TEAL, GREEN_BG),
    ("阶段二", "同类扩展", "1–2 月", [
        "托书 → 发票 → 对账 → 账龄",
        "共用解析 / 规则 / 确认底座",
        "学习队列开始积累",
    ], "看：场景覆盖率 / 采纳率 / 月结天数", "产出：多场景上线、运行月报",
     "进入下一阶段：数据稳定、人愿意用", ORANGE, ORANGE_BG),
    ("阶段三", "跨环节串联", "季度", [
        "在途、调度、成本、预测",
        "接 TMS / 港口 / 财务接口",
        "经营视图与异常闭环",
    ], "看：逾期金额 / 空驶率 / 毛利率", "产出：经营视图、异常闭环",
     "前提：接口与历史数据就绪", BLUE, BLUE_BG),
]
for i, (phase, title, dur, bullets, metric, out, gate, color, bg) in enumerate(phases):
    x = 0.7 + i * 4.05
    add_rect(s, x, 1.98, 3.82, 3.95, LIGHT, LIGHT_2)
    add_rect(s, x, 1.98, 3.82, 0.46, color, color)
    add_text(s, phase, x + 0.22, 2.06, 1.0, 0.28, 9, True, WHITE)
    add_text(s, title, x + 1.15, 2.06, 2.45, 0.28, 9, True, WHITE)
    add_text(s, dur, x + 0.22, 2.58, 1.2, 0.28, 11, True, color)
    add_bullets(s, bullets, x + 0.22, 2.9, 3.4, 1.0, 9.3, BLACK, color, 4)
    add_text(s, metric, x + 0.22, 3.72, 3.4, 0.28, 8.4, True, color)
    add_text(s, out, x + 0.22, 4.5, 3.4, 0.55, 8.6, True, NAVY, line_spacing=1.25)
    add_text(s, gate, x + 0.22, 5.15, 3.4, 0.6, 8.6, False, GRAY, line_spacing=1.25)

add_text(s, "判断先做哪个：频率高 × 单次工时长 × 出错成本大 × 数据拿得到。",
         0.7, 6.02, 11.95, 0.3, 10.5, True, NAVY)
add_rect(s, 0.7, 6.42, 11.95, 0.4, LIGHT, LIGHT_2)
add_text(s, "能力演进：P0 感知/结构化 → P1 规则自动化 + 生成辅助 → P2 预测 → P3 优化；P4 自动执行 + 审批暂不做。",
         0.9, 6.5, 11.6, 0.26, 9, False, GRAY)
add_footer(s)
add_notes(s, "三阶段不是合同阶段，是能力阶段。每一阶段都有明确的产出和进入下一阶段的条件；达不到就停，不扩大。")


# ================================================================ 16 需要什么
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "需要什么", "四类条件：样本、接口、人、环境",
           "不需要先买系统；先给样本和一个人，就能开始验证。")
needs = [
    ("样本与单据", [
        "脱敏托书 / 发票 / 对账单 / 结算单",
        "费用明细、合同价、科目映射",
        "现有报表、台账、历史工时",
    ], "没有真实样本，只能演示，不能验收。", TEAL),
    ("系统与接口", [
        "TMS / 财务 / OMS",
        "港口 / 船期 / 箱动态 / 报关状态",
        "订单 / 车辆 / 驳船 / 舱位 / GPS",
    ], "接口决定能不能实时，模型决定不了。", ORANGE),
    ("人", [
        "1 名负责人：能拍板、能协调",
        "业务骨干：解释口径、确认异常",
        "IT 接口人 + 安全/法务",
    ], "没有负责人，项目会停在“再看看”。", GREEN),
    ("环境与安全", [
        "客户内网 / 客户云 / 我们云",
        "账号、权限、网络策略",
        "脱敏规则、数据边界、审计",
    ], "默认数据不出客户边界。", BLUE),
]
for i, (title, bullets, note, color) in enumerate(needs):
    x = 0.7 + (i % 2) * 6.05
    y = 1.98 + (i // 2) * 2.1
    add_rect(s, x, y, 5.85, 1.9, LIGHT, LIGHT_2)
    add_line(s, x, y, 0.08, color, 1.9)
    add_text(s, title, x + 0.3, y + 0.16, 3.0, 0.34, 14, True, NAVY)
    add_bullets(s, bullets, x + 0.3, y + 0.56, 5.25, 0.85, 8.9, BLACK, color, 3)
    add_text(s, note, x + 0.3, y + 1.5, 5.25, 0.28, 8.6, True, color)

add_rect(s, 0.7, 6.02, 11.95, 0.9, NAVY, NAVY)
add_text(s, "最需要的不是预算，是一个能拍板的负责人和一批真实的单据。",
         0.95, 6.12, 11.45, 0.32, 11.5, True, WHITE, PP_ALIGN.CENTER)
add_text(s, "三个不被锁定：数据可导出、模型可换、规则可审计。",
         0.95, 6.52, 11.45, 0.3, 9.5, False, RGBColor(0xC9, 0xD8, 0xE6), PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "把条件讲在前面，避免后面扯皮。样本、接口、人、环境四类，缺哪类就明确说哪类做不了。")


# ================================================================ 17 让老板放心
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "让老板放心", "四不承诺、四条底线、两次拍板",
           "先小范围、可回滚；达不到验收就停，不扩大。")
cards = [
    ("不换系统", "不替换货代 TMS / 财务，只做上层增强。", TEAL),
    ("不替人做决定", "模型只出草稿；人工确认后才进入业务，可撤销、可回滚。", GREEN),
    ("不拿数据冒险", "默认客户内网 / 客户云；数据不出边界，外部模型调用单独确认。", ORANGE),
    ("不一次性投入", "先单点验证；不达标就停，不扩阶段。", RED),
]
for i, (title, detail, color) in enumerate(cards):
    x = 0.7 + (i % 2) * 6.05
    y = 1.98 + (i // 2) * 1.15
    add_rect(s, x, y, 5.75, 1.0, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.28, y + 0.14, 2.5, 0.34, 13.5, True, color)
    add_text(s, detail, x + 2.55, y + 0.14, 2.95, 0.75, 9.8, False, NAVY, line_spacing=1.3)

meetings = [
    ("启动会", "定范围、定负责人、定验收口径"),
    ("阶段结果会", "看数据，决定继续 / 暂停 / 调整"),
]
for i, (title, detail) in enumerate(meetings):
    x = 0.7 + i * 6.05
    add_rect(s, x, 4.35, 5.75, 0.65, WHITE, LIGHT_2)
    add_text(s, title, x + 0.28, 4.48, 1.6, 0.3, 11, True, TEAL)
    add_text(s, detail, x + 1.95, 4.46, 3.6, 0.42, 9.5, False, BLACK, line_spacing=1.2)

add_rect(s, 0.7, 5.3, 11.95, 0.62, NAVY, NAVY)
add_text(s, "老板只需要做两件事：指定一名负责人；参加这两次会。",
         0.95, 5.44, 11.45, 0.32, 12.5, True, WHITE, PP_ALIGN.CENTER)
add_text(s, "不裁人，先让同样的人处理更多单；省下来的工时由贵司决定怎么用。",
         0.7, 6.05, 11.95, 0.3, 10.5, True, NAVY, PP_ALIGN.CENTER)
add_text(s, "不承诺裁人，不承诺“省几个人”；只承诺用贵司单据和工时，给出可复核的区间。",
         0.7, 6.4, 11.95, 0.3, 9.5, False, GRAY, PP_ALIGN.CENTER)
add_footer(s)
add_notes(s, "老板最关心风险。四不：不换系统、不替人做决定、不拿数据冒险、不一次性投入。老板本人只做两件事：指定负责人，参加两次会。")


# ================================================================ 18 下一步
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
add_text(s, "下一步", 0.9, 0.64, 4.0, 0.35, 12, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "先做一次“能力映射”\n不谈合同，先判断值不值得一起做", 0.9, 1.05, 11.2, 1.5, 31, True, WHITE, line_spacing=1.12)

steps = [
    ("1", "2 小时业务映射会", "哪几段最痛、数据在哪、谁负责、哪些明确不做。"),
    ("2", "50 份样本试跑", "选 1–2 个场景，用贵司单据跑，不先用演示数据下结论。"),
    ("3", "一页结论", "现在能做 / 需要数据 / 不建议做 + 下一阶段建议。"),
]
for i, (num, title, detail) in enumerate(steps):
    x = 0.9 + i * 3.95
    add_rect(s, x, 3.05, 3.65, 1.55, NAVY_2, RGBColor(0x2B, 0x4F, 0x70))
    add_text(s, num, x + 0.28, 3.2, 0.5, 0.5, 22, True, RGBColor(0xF5, 0xB4, 0x5A))
    add_text(s, title, x + 0.8, 3.26, 2.65, 0.34, 13.5, True, WHITE)
    add_text(s, detail, x + 0.28, 3.82, 3.1, 0.95, 9.8, False, RGBColor(0xC9, 0xD8, 0xE6), line_spacing=1.3)

add_text(s, "会前准备：近 3 个月托书 / 对账单样本、现有报表、最想解决的两个问题。",
         0.9, 4.9, 11.5, 0.35, 10.5, False, RGBColor(0xB8, 0xC9, 0xD9))
add_text(s, "目的不是让贵司马上决定买什么，而是双方判断：这件事值不值得做、先做哪一段。",
         0.9, 5.5, 11.5, 0.45, 14.5, True, WHITE)
add_text(s, "不做全行业 AI；只做港口、货代、拖车的单证、对账、应收。别人给 Demo，我们给用你 50 份单据跑的报告。",
         0.9, 6.0, 11.5, 0.45, 10.5, False, RGBColor(0xB8, 0xC9, 0xD9), line_spacing=1.2)
add_text(s, "企业人工智能 ｜ 能力说明 ｜ 2026-11-08", 0.9, 6.6, 6.0, 0.3, 10, False, RGBColor(0x8F, 0xA6, 0xBA))
add_notes(s, "收尾不要合同。要一次 2 小时的业务映射会、50 份样本、一页结论。先让双方判断值不值得做、先做哪一段。")


prs.save(OUT)
print(f"saved {OUT} ({len(prs.slides)} slides)")
