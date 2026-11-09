"""生成客户老板版「企业 AI 化方案」PPT（21 页，2026-11-09）。

结构按老板判断顺序：
1. 前期准备（公开资料 + 需求假设）
2. 产品目标（在现有 TMS / 财务系统上做增强）
3. 产品优势（通用 AI vs 行业 AI）
4. AI 能力（六个 AI 岗位）
5. 能力表现（单证 / 对账 / 在途调度经营 / 运行保障）
6. 与 TMS / 财务系统的关系（图 + 节点表）
7. 落地预期（四阶段）
8. 落地协作（人 / 数据 / 条件）

字号：页标题保持 27–34pt；其余正文统一放大一档（8pt 以下提到 9pt，
8–12pt 加 1pt，12–14pt 加 0.8pt，14–15.5pt 加 0.6pt），由 `body_size()` 统一处理。

边界：
- 公开资料页只写可查到的信息，并标注“未经贵司核实”。
- 不展示内部工程指标（回归数量、准确率指标、开发进度）。
- 界面为演示界面；封面只保留一句说明，不逐页重复。
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
OUT = Path(__file__).resolve().parent / "客户老板版_企业AI化方案_2026-11-09.pptx"

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

TOTAL = 21

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)


# ------------------------------------------------------------------ 基础组件
def body_size(size):
    """正文统一放大一档；各页大标题（>=18pt）保持原样。"""
    if size >= 18:
        return size
    if size <= 8:
        return 9.0
    if size <= 12:
        return size + 1.0
    if size <= 14:
        return size + 0.8
    if size <= 15.5:
        return size + 0.6
    return size


def set_font(run, size=14, bold=False, color=BLACK, font=FONT):
    run.font.name = font
    run.font.size = Pt(body_size(size))
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


def add_two_way_arrow(slide, left, top, width=0.45, height=0.3, color=ORANGE):
    shape = slide.shapes.add_shape(MSO_SHAPE.LEFT_RIGHT_ARROW, Inches(left), Inches(top), Inches(width), Inches(height))
    shape.fill.solid(); shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    shape.shadow.inherit = False
    return shape


def add_updown_arrow(slide, left, top, width=0.34, height=0.72, color=ORANGE):
    shape = slide.shapes.add_shape(MSO_SHAPE.UP_DOWN_ARROW, Inches(left), Inches(top), Inches(width), Inches(height))
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
    add_text(slide, "企业 AI 化方案", 0.7, 7.12, 5.5, 0.22, 9, False, GRAY)
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
add_text(s, "企业 AI 化方案 ｜ 2026-11", 0.9, 1.3, 7.0, 0.35, 13, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "在现有系统上\n长出一个 AI 团队", 0.9, 1.9, 10.6, 1.7, 34, True, WHITE, line_spacing=1.12)
add_text(s, "面向顺德协丰物流：从单据、对账、应收，到在途与经营",
         0.92, 3.9, 10.8, 0.4, 17, False, RGBColor(0xD7, 0xE3, 0xEF))
add_text(s, "不换运输管理系统，不换财务系统；先从一个单据入口开始。",
         0.92, 4.45, 11.2, 0.4, 13, False, RGBColor(0xB8, 0xC9, 0xD9))

chips = ["前期研判", "产品目标", "行业对比", "AI 岗位", "运行保障", "落地路径"]
for i, chip in enumerate(chips):
    x = 0.92 + i * 1.92
    add_rect(s, x, 5.25, 1.78, 0.46, NAVY_2, RGBColor(0x2B, 0x4F, 0x70))
    add_text(s, chip, x, 5.36, 1.78, 0.26, 9, True, RGBColor(0xCF, 0xE3, 0xF1), PP_ALIGN.CENTER)

add_text(s, "呈：顺德协丰物流有限公司管理层", 0.92, 5.92, 7.5, 0.3, 11, True,
         RGBColor(0xD7, 0xE3, 0xEF))
add_text(s, "本方案基于公开资料与演示界面，未经贵司访谈确认；真实效果以贵司数据为准。", 0.92, 6.55, 9.5, 0.3, 10,
         False, RGBColor(0x8F, 0xA6, 0xBA))


# ================================================================ 02 目录
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "目录", "按八个问题展开", "先判断值不值得做，再谈怎么做。")
items = [
    ("01", "前期准备", "我们看到的协丰，以及由此做出的需求假设"),
    ("02", "产品目标", "在现有 TMS / 财务系统上做增强"),
    ("03", "产品优势", "通用 AI 和行业 AI，差别在哪"),
    ("04", "AI 能力", "六个岗位，对应六类产出"),
    ("05", "能力表现", "岗位怎么用、产出什么，系统怎么被看住"),
    ("06", "系统关系", "与 TMS / 财务怎么接、读写边界"),
    ("07", "落地预期", "分几步走，每步看什么"),
    ("08", "落地协作", "需要谁、给什么、具备什么条件"),
]
for i, (num, title, detail) in enumerate(items):
    x = 0.7 + (i % 2) * 6.05
    y = 1.95 + (i // 2) * 1.16
    add_rect(s, x, y, 5.85, 0.95, LIGHT, LIGHT_2)
    add_text(s, num, x + 0.24, y + 0.18, 0.8, 0.4, 18, True, ORANGE)
    add_text(s, title, x + 1.05, y + 0.16, 2.6, 0.3, 13.5, True, NAVY)
    add_text(s, detail, x + 1.05, y + 0.49, 4.55, 0.36, 9.5, False, GRAY, line_spacing=1.2)

add_rect(s, 0.7, 6.55, 11.95, 0.45, NAVY, NAVY)
add_text(s, "八个问题，先看功课和判断，再看产品与落地。", 0.95, 6.66, 11.45, 0.26, 11, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 03 前期准备 1
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "前期准备 ①", "先做功课：公开资料里的协丰",
           "来源：公开网页与企业信息页；未经贵司核实，不作为方案依据。")

add_rect(s, 0.7, 1.95, 5.9, 4.15, LIGHT, LIGHT_2)
add_text(s, "公司画像（公开资料）", 0.98, 2.12, 4.5, 0.34, 14, True, NAVY)
add_bullets(s, [
    ("公司", "佛山市顺德区协丰物流有限公司，2012 年成立，位于顺德北滘"),
    ("经营范围", "普通货运、装卸、仓储、汽车租赁；国际货运代理（海运 / 陆运 / 空运）；代理报关 / 报检"),
    ("行业身份", "顺德区跨境货运代理协会理事单位；北滘青企协会顾问单位"),
    ("公开报道", "集装箱、拼货箱、散货运输；北滘港 / 顺德新港；水泥罐船航线；参与“湾区一港通”"),
], 0.98, 2.58, 5.35, 2.2, 9.3, BLACK, TEAL, 7)
add_text(s, "对产品的含义", 0.98, 4.85, 3.0, 0.24, 9, True, TEAL)
add_text(s, "单据入口必须支持订舱委托、装箱单、报关资料，不能只会托书。", 0.98, 5.12, 5.3, 0.55, 8.8, False, BLACK, line_spacing=1.25)
add_text(s, "所以第一版先做 AI 单证员，不先做通用聊天。", 0.98, 5.72, 5.3, 0.3, 8.8, True, NAVY)

add_rect(s, 6.8, 1.95, 5.85, 4.15, WHITE, LIGHT_2)
add_text(s, "我们的判断", 7.08, 2.12, 3.0, 0.34, 14, True, NAVY)
add_bullets(s, [
    ("不是纯集卡", "更像“港口 + 货代 + 运输”的综合物流"),
    ("单据不止托书", "订舱委托、装箱单、报关资料、对账单、结算单都会出现"),
    ("成本不止“车”", "还可能涉及驳船、仓储、报关、外协，按“车”算会失真"),
    ("系统不会只有一套", "可能同时有货代 TMS、报关系统、财务软件，能不能对接需要确认"),
], 7.08, 2.58, 5.3, 2.2, 9.6, BLACK, ORANGE, 8)
add_text(s, "对产品的含义", 7.08, 4.85, 3.0, 0.24, 9, True, ORANGE)
add_text(s, "成本不能只看车，还要看驳船、仓储、报关、外协。", 7.08, 5.12, 5.3, 0.55, 8.8, False, BLACK, line_spacing=1.25)
add_text(s, "所以成本/毛利要能按车、驳船、线路、客户切换。", 7.08, 5.72, 5.3, 0.3, 8.8, True, NAVY)

add_rect(s, 0.7, 6.28, 11.95, 0.5, NAVY, NAVY)
add_text(s, "需要核实的四件事：自有车 / 外协 / 驳船各多少；TMS / 财务系统是什么；能不能对接；数据能不能脱敏出内网。",
         0.95, 6.4, 11.45, 0.26, 10.3, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 04 前期准备 2
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "前期准备 ②", "基于公开信息，先做一版需求假设",
           "假设不是结论；还要访谈老板和负责人，逐条确认。")

needs = [
    ("单据入口多", "托书、订舱委托、装箱单、报关资料、对账单格式杂，靠人抄、靠人核",
     "AI 单证员：识别、抽字段、校验、转人工"),
    ("对账与结算", "客户对账单、外协 / 驳船 / 仓储费用交叉，差异靠人翻",
     "AI 对账员：匹配、分类、写原因、复核留痕"),
    ("应收与账期", "客户多、账期不一，逾期靠 Excel，催收靠记性",
     "AI 应收员：账龄分档、客户风险、催收清单"),
    ("在途与查询", "港口、驳船、报关、拖车多段，信息散在群里",
     "AI 调度 / 客服：事件、状态、ETA、时间线"),
    ("经营与知识", "单票 / 线路 / 客户毛利算不清；报关口径、SOP 靠老人",
     "AI 经营助理 + 知识管理员：成本、毛利、可查资料"),
]
for i, (title, pain, ai) in enumerate(needs):
    if i < 3:
        x = 0.7 + i * 4.05
        y = 1.95
        w = 3.82
    else:
        x = 0.7 + (i - 3) * 6.05
        y = 4.12
        w = 5.85
    add_rect(s, x, y, w, 1.95, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.24, y + 0.16, w - 0.48, 0.32, 13.5, True, NAVY)
    add_text(s, "可能的表现", x + 0.24, y + 0.56, w - 0.48, 0.24, 8.8, True, GRAY)
    add_text(s, pain, x + 0.24, y + 0.82, w - 0.48, 0.6, 9.3, False, BLACK, line_spacing=1.25)
    add_text(s, ai, x + 0.24, y + 1.5, w - 0.48, 0.3, 9.0, True, TEAL)

add_rect(s, 0.7, 6.28, 11.95, 0.5, NAVY, NAVY)
add_text(s, "先确认四件事：哪几段最痛、数据在哪、谁负责、哪些明确不做。",
         0.95, 6.4, 11.45, 0.26, 10.8, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 05 产品目标
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "产品目标", "不换系统，长出 AI 能力",
           "基于前面的判断，在现有 TMS（运输管理系统）和财务系统之上，做一层增强。")

# 架构图：智单加在两个现有系统之上，不是夹在中间
add_rect(s, 0.7, 1.95, 9.1, 0.92, RGBColor(0xD4, 0xF4, 0xDD), GREEN)
add_text(s, "AI 增强层（新）", 0.95, 2.04, 3.2, 0.3, 13.5, True, NAVY)
add_text(s, "单据入口 · 规则校验 · AI 辅助 · 对账 · 账龄 · 成本 · 经营",
         0.95, 2.38, 7.2, 0.3, 9.6, False, GRAY)
add_text(s, "不改 TMS / 财务原流程", 6.55, 2.1, 3.1, 0.26, 8.8, True, GREEN, PP_ALIGN.RIGHT)

add_updown_arrow(s, 2.61, 2.87, 0.34, 0.73)
add_text(s, "读 / 确认后回写", 3.04, 3.12, 2.2, 0.3,
         8.0, False, GRAY, line_spacing=1.2)
add_updown_arrow(s, 7.56, 2.87, 0.34, 0.73)
add_text(s, "读 / 确认后导出", 7.99, 3.12, 1.85, 0.3,
         8.0, False, GRAY, line_spacing=1.2)

add_box(s, 0.7, 3.62, 4.15, 0.92, "现有 TMS（不动）", "运输管理系统（原样保留）", LIGHT, LIGHT_2, NAVY)
add_box(s, 5.65, 3.62, 4.15, 0.92, "财务系统（如有，不动）", "应收 / 发票 / 收款 / 科目", LIGHT, LIGHT_2, NAVY)

add_rect(s, 9.95, 1.95, 2.7, 2.6, WHITE, LIGHT_2)
add_text(s, "三个原则", 10.15, 2.1, 2.3, 0.3, 12, True, NAVY)
add_bullets(s, ["不换系统", "不双录", "不改审批"], 10.15, 2.5, 2.3, 1.5, 10, BLACK, TEAL, 7)
add_text(s, "AI 只出草稿；人确认后才入业务。", 10.15, 3.72, 2.25, 0.5, 8.8, False, GRAY, line_spacing=1.25)

add_text(s, "四个好处", 0.7, 4.78, 3.0, 0.3, 12, True, NAVY)
benefits = [("少花时间", "少抄、少翻、少等"), ("少出错", "系统先挑错"), ("算清账", "成本 / 毛利 / 账龄"), ("留下经验", "SOP / 口径 / 难例")]
for i, (title, detail) in enumerate(benefits):
    x = 0.7 + i * 3.02
    add_rect(s, x, 5.12, 2.82, 0.85, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.2, 5.22, 2.4, 0.28, 10.5, True, GREEN)
    add_text(s, detail, x + 0.2, 5.54, 2.4, 0.28, 9, False, GRAY)

add_rect(s, 0.7, 6.18, 11.95, 0.46, NAVY, NAVY)
add_text(s, "智单加在现有系统上面：两边都读，原流程不改。",
         0.95, 6.29, 11.45, 0.26, 11.2, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 06 产品优势
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "产品优势", "通用 AI 和行业 AI，差别不在功能数量",
           "六个维度，对着协丰的单据比。")
rows = [
    ("行业字段", "靠提示词临时教", "内置箱号、截港、箱型、地址、税号校验"),
    ("能读什么", "文本为主", "企微、图片、PDF、Excel、批量导入"),
    ("数字谁算", "AI 可能直接生成", "系统算，AI 只写解释，不碰金额"),
    ("出错怎么办", "重新生成，结果可能又变", "规则先拦、人工确认、修订留痕"),
    ("怎么证明", "案例海报、演示视频", "用贵司 50 份单据跑报告"),
    ("和现有系统", "另起一套，要求换系统", "做 TMS / 财务的增强层，不替换"),
]
add_table(s, ["维度", "通用 AI", "我们"], rows, 0.7, 1.98, 11.95, [1.7, 4.45, 5.8], row_h=0.62, header_h=0.4, size=9.8)
add_rect(s, 0.7, 6.28, 11.95, 0.52, NAVY, NAVY)
add_text(s, "通用 AI 卖“什么都能做”；我们卖“用你的单据跑给你看”。", 0.95, 6.41, 11.45, 0.28, 12.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 07 六个 AI 岗位
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "AI 能力", "六个 AI 岗位，对应六段活",
           "先配一个岗位，跑通再扩；不卖“全行业 AI 平台”。")
roles = [
    ("AI 单证员", "把图片和文字变成字段", "托书 / 订舱委托 / 发票 / 对账单", "产出：结构化草稿 / 异常清单"),
    ("AI 对账员", "把差异分到处理决定", "对账单 / 运单 / 结算单", "产出：差异表 / 复核记录"),
    ("AI 应收员", "把应收变成催收清单", "账龄 / 客户风险 / 回款", "产出：账龄表 / 催收清单"),
    ("AI 调度·客服", "把群里的话变成事件", "在途 / 查询 / 调度建议", "产出：事件卡片 / 查询回答"),
    ("AI 经营助理", "把单据和费用变成结论", "成本 / 毛利 / 报价 / 预测", "产出：毛利 / 盈利 / 报价参考"),
    ("AI 知识管理员", "把老人经验留下来", "SOP / 合同 / 报关口径", "产出：可查资料 / 标准答案"),
]
for i, (title, sub, scope, out) in enumerate(roles):
    x = 0.7 + (i % 3) * 4.05
    y = 1.98 + (i // 3) * 2.08
    add_rect(s, x, y, 3.82, 1.88, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.24, y + 0.18, 3.2, 0.34, 14.5, True, NAVY)
    add_text(s, sub, x + 0.24, y + 0.58, 3.3, 0.3, 10, True, TEAL)
    add_text(s, scope, x + 0.24, y + 0.98, 3.3, 0.4, 9.0, False, GRAY, line_spacing=1.2)
    add_text(s, out, x + 0.24, y + 1.45, 3.3, 0.26, 8.4, True, TEAL)

add_rect(s, 0.7, 6.12, 11.95, 0.5, NAVY, NAVY)
add_text(s, "不是让 AI 替人；是让 AI 先把脏活干一遍，人只做确认和决定。", 0.95, 6.24, 11.45, 0.26, 11.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 08 岗位 1-2
def role_panel(slide, left, top, width, title, sub, rows, color=TEAL):
    add_rect(slide, left, top, width, 4.25, LIGHT, LIGHT_2)
    add_text(slide, title, left + 0.26, top + 0.18, width - 0.52, 0.36, 15, True, NAVY)
    add_text(slide, sub, left + 0.26, top + 0.58, width - 0.52, 0.28, 9.5, True, color)
    y = top + 1.0
    for label, text in rows:
        add_text(slide, label, left + 0.26, y, 0.95, 0.24, 8.8, True, GRAY)
        add_text(slide, text, left + 1.2, y - 0.02, width - 1.45, 0.65, 9.2, False, BLACK, line_spacing=1.28)
        y += 0.78


s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "AI 能力 ①", "AI 单证员 + AI 对账员",
           "两个最脏的入口：单据和对账。")
role_panel(s, 0.7, 1.95, 5.85, "AI 单证员", "先识别，再校验", [
    ("输入", "企微文字 / 图片、手机拍照、PDF / Excel、批量导入"),
    ("做什么", "识别、抽字段；箱号 / 截港 / 地址 / 税号校验；没把握转人工"),
    ("产出", "结构化草稿、异常清单、确认记录"),
    ("和系统", "回写 TMS 订单（系统对接或模板）"),
], TEAL)
role_panel(s, 6.8, 1.95, 5.85, "AI 对账员", "逐条比对，差异有原因", [
    ("输入", "客户对账单、运单、结算单"),
    ("做什么", "逐条匹配；差异分类；AI 写原因；人工复核"),
    ("产出", "差异表、处理记录、导出"),
    ("和系统", "读 TMS 运单；结果回写或导出"),
], ORANGE)
add_rect(s, 0.7, 6.35, 11.95, 0.45, NAVY, NAVY)
add_text(s, "单证是入口，对账是财务最痛；两个跑通，后面的账龄、成本、经营才有数据。", 0.95, 6.46, 11.45, 0.26, 11, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 09 岗位 3-4
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "AI 能力 ②", "AI 应收员 + AI 调度·客服",
           "一个管钱，一个管过程。")
role_panel(s, 0.7, 1.95, 5.85, "AI 应收员", "账龄、风险、催收顺序", [
    ("输入", "应收台账、回款记录、客户账期"),
    ("做什么", "账龄分档；客户风险；催收优先级；话术可人工编辑"),
    ("产出", "催收清单、回款计划、逾期提醒"),
    ("和系统", "读财务应收 / 收款；清单导出或回写"),
], GREEN)
role_panel(s, 6.8, 1.95, 5.85, "AI 调度·客服", "群消息 → 事件、状态", [
    ("输入", "调度 / 司机群文字、箱号、单号、客户"),
    ("做什么", "事件抽取；状态 / ETA / 时间线；调度优化建议"),
    ("产出", "事件卡片、查询回答、调度前后对比"),
    ("和系统", "读 TMS 运单 / 车辆；事件可回写或通知"),
], ORANGE)
add_rect(s, 0.7, 6.35, 11.95, 0.45, NAVY, NAVY)
add_text(s, "应收员只出清单，不自动催收；调度客服只出建议，不自动派车。", 0.95, 6.46, 11.45, 0.26, 11, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 10 岗位 5-6
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "AI 能力 ③", "AI 经营助理 + AI 知识管理员",
           "一个算账，一个留经验。")
role_panel(s, 0.7, 1.95, 5.85, "AI 经营助理", "单票、线路、客户毛利", [
    ("输入", "运单、费用、财务科目、历史报价"),
    ("做什么", "成本归集；单票 / 线路 / 客户毛利；报价建议；趋势"),
    ("产出", "经营视图、亏损单、客户 / 线路盈利、报价参考"),
    ("和系统", "读 TMS 运单 / 费用、财务科目；结果导出"),
], TEAL)
role_panel(s, 6.8, 1.95, 5.85, "AI 知识管理员", "检索 + 引用回答", [
    ("输入", "SOP、合同、报关口径、历史单据"),
    ("做什么", "检索；带引用回答；没有就说没有；学习队列"),
    ("产出", "可查资料、标准答案、新人培训材料"),
    ("和系统", "不写 TMS / 财务；只做内部知识查询"),
], BLUE)
add_rect(s, 0.7, 6.35, 11.95, 0.45, NAVY, NAVY)
add_text(s, "经营助理不让 AI 算数字；知识管理员不让 AI 编答案。", 0.95, 6.46, 11.45, 0.26, 11, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 11 表现 1
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能力表现 ①", "单证：一张托书，从群里到结构化草稿",
           "企微文字可直接发、支持分条；每个字段带把握程度，系统先挑错，没把握的转人工。")
add_image_fit(s, "wecom-chat-demo.png", 4.55, 1.95, 3.95, 4.9)
add_entry_card(s, 0.7, 2.0, 1.7, 0.66, "企业微信文字", "直接发、可分条",
               GREEN, RGBColor(0xE8, 0xF8, 0xEE), RGBColor(0x9F, 0xD8, 0xB0))
add_entry_card(s, 2.55, 2.0, 1.7, 0.66, "手机拍照 / 上传", "手机拍托书")
add_entry_card(s, 0.7, 2.78, 1.7, 0.66, "批量导入", "一次几十份")
add_entry_card(s, 2.55, 2.78, 1.7, 0.66, "网页粘贴", "临时试单")
add_bullets(s, [
    ("少抄", "客户、箱号、截港等字段自动带出"),
    ("少错", "箱号校验位、截港、地址冲突先提示"),
    ("可追溯", "人工确认与修正全部留痕"),
], 0.7, 3.7, 3.55, 1.25, 10.5, BLACK, TEAL, 7)
add_rect(s, 0.7, 5.05, 3.55, 1.55, LIGHT, LIGHT_2)
add_text(s, "老板看到的不是“AI 多强”，而是“单证员少抄多少、错单少多少”。",
         0.95, 5.3, 3.05, 1.0, 11.5, True, NAVY, line_spacing=1.35)
flow = [("① 发", "文字直接发，分几条也行"), ("② 看", "字段、把握程度、系统提示"), ("③ 确认", "回复「确认」入库")]
for i, (title, detail) in enumerate(flow):
    y = 2.0 + i * 1.45
    add_box(s, 8.85, y, 3.9, 1.15, title, detail, LIGHT, LIGHT_2, TEAL)
    if i < 2:
        add_down_arrow(s, 10.66, y + 1.17, 0.28, 0.22)
add_text(s, "确认后才入业务。", 8.85, 6.35, 3.9, 0.3, 9.5, True, TEAL)
add_footer(s)


# ================================================================ 12 表现 2
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能力表现 ②", "对账：不是看总数，是把差异分到处理决定",
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
add_rect(s, 0.7, 4.55, 3.55, 1.6, LIGHT, LIGHT_2)
add_text(s, "以一张对账单为例：11 条对账单，8 条一致、2 条金额不符、1 条系统无此单、1 条客户漏单；每条都有建议动作和处理记录。",
         0.95, 4.73, 3.05, 1.2, 10.2, True, NAVY, line_spacing=1.32)
add_footer(s)


# ================================================================ 13 表现 3
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能力表现 ③", "在途、调度、经营：系统算什么，AI 改什么，人定什么",
           "三张界面不是“能看”，是“看完能做什么、谁拍板”。")
shots = [
    ("客户查询", [("系统", "按箱号 / 单号 / 客户取数"),
                  ("AI", "把事实改写成客户回答"),
                  ("人", "客服确认后回复")], "ai-track.png"),
    ("调度优化", [("系统", "算空驶 / 准时 / 装载率"),
                  ("输出", "优化前后对比 + 建议"),
                  ("人", "调度员决定采纳")], "ai-dispatch.png"),
    ("盈利分析", [("系统", "算客户 / 线路毛利"),
                  ("输出", "亏损 / 低毛利清单"),
                  ("人", "老板 / 财务判断")], "ai-profit.png"),
]
for i, (title, points, img) in enumerate(shots):
    x = 0.7 + i * 4.07
    add_image_fit(s, img, x, 1.95, 3.82, 2.15)
    add_text(s, title, x, 4.2, 3.82, 0.3, 12, True, NAVY)
    add_bullets(s, points, x, 4.54, 3.72, 0.95, 9.6, BLACK, TEAL, 4)

add_rect(s, 0.7, 5.55, 11.95, 1.0, LIGHT, LIGHT_2)
add_text(s, "三页共同的数据前提", 0.98, 5.67, 10.5, 0.3, 13.5, True, NAVY)
add_text(s, "真实上线要接港口 / 船期 / 报关、车辆 / GPS、成本科目；数据不到位，就先不出结论。",
         0.98, 6.0, 11.25, 0.45, 9.2, False, GRAY, line_spacing=1.28)
add_footer(s)

# ================================================================ 14 表现 4 运行
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "能力表现 ④", "系统运行：提前看见，坏了有人管",
           "不用等出了事故才知道；日常风险有人盯，突发故障有人接。")

add_rect(s, 0.7, 1.98, 5.78, 3.5, LIGHT, LIGHT_2)
add_text(s, "能提前看见的", 0.98, 2.12, 3.2, 0.3, 13, True, TEAL)
add_text(s, "慢慢变坏，最怕没人看", 0.98, 2.44, 4.6, 0.26, 9, False, GRAY)
add_bullets(s, [
    ("磁盘快满", "按最近增速推算，提前 1–4 周提醒"),
    ("备份超时", "超过 36 小时没成功，自动提醒"),
    ("证书到期", "提前 30 天进清单，不等到当天"),
    ("AI 额度见底", "按最近 7 天用量，算还能撑几天"),
], 1.0, 2.85, 5.2, 2.45, 10.5, BLACK, TEAL, 9)

add_rect(s, 6.85, 1.98, 5.8, 3.5, LIGHT, LIGHT_2)
add_text(s, "突然发生的", 7.13, 2.12, 3.2, 0.3, 13, True, ORANGE)
add_text(s, "预测不了，但可以快发现、快止损", 7.13, 2.44, 5.0, 0.26, 9, False, GRAY)
add_bullets(s, [
    ("服务突然停", "几分钟内发现并报警，先止损再查"),
    ("数据库连不上", "先保住能查能收单，再排查恢复"),
    ("大量报错", "按影响面分级，先保主要业务"),
    ("误操作 / 误删", "留操作记录，有备份和版本可退"),
], 7.15, 2.85, 5.25, 2.45, 10.5, BLACK, ORANGE, 9)

add_rect(s, 0.7, 5.7, 11.95, 1.1, NAVY, NAVY)
add_text(s, "AI 只做三件事：把系统报警翻成人话、给处置预案、写事故记录。",
         0.98, 5.86, 11.4, 0.32, 13.5, True, WHITE)
add_text(s, "低风险可授权自动处理；切服务器、退版本、重启这类动作，必须人确认。",
         0.98, 6.24, 11.4, 0.34, 9.8, False, RGBColor(0xD7, 0xE3, 0xEF))
add_footer(s)


# ================================================================ 15 运行保障
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "运行保障", "每天看什么、坏了找谁、多久练一次",
           "重复的事系统做；定责、判断和演练，人来定。")

beats = [
    ("每天", "看一眼", "谁来做：系统自动，值班复核",
     "自检、采集、备份 / 磁盘 / 证书 / 额度报警由系统做；值班只看未处理项。", TEAL),
    ("每周", "归一次类", "谁来做：系统归并，人定责",
     "系统去重、按类列出；人把 3–5 条真问题定人、定截止日。", BLUE),
    ("每月", "汇一次总", "谁来做：系统攒数，人看结论",
     "备份结果、额度与费用自动汇总；权限和恢复结果由人核对。", ORANGE),
    ("每半年 / 每年", "练一次恢复", "谁来做：双方一起，我方陪练",
     "每半年验证备份能恢复；每年建议做一次完整演练。", RED),
]
for i, (eyebrow, title, owner, detail, color) in enumerate(beats):
    x = 0.7 + i * 3.05
    add_rect(s, x, 1.95, 2.85, 2.2, LIGHT, LIGHT_2)
    add_text(s, eyebrow, x + 0.2, 2.08, 2.45, 0.24, 8.8, True, color)
    add_text(s, title, x + 0.2, 2.34, 2.45, 0.33, 13, True, NAVY)
    add_text(s, owner, x + 0.2, 2.74, 2.45, 0.24, 8.3, True, color)
    add_text(s, detail, x + 0.2, 3.02, 2.45, 1.0, 8.8, False, GRAY, line_spacing=1.28)

add_text(s, "出事了怎么升级", 0.7, 4.38, 4.0, 0.28, 12.5, True, NAVY)
chain = [
    ("系统发现", "自检 + 报警"),
    ("值班运维", "5 分钟内认领"),
    ("运维负责人", "15 分钟内决策"),
    ("客户 IT", "需要时介入"),
    ("管理层", "影响业务才上报"),
]
for i, (title, detail) in enumerate(chain):
    x = 0.7 + i * 2.45
    add_box(s, x, 4.72, 2.15, 0.82, title, detail, LIGHT, LIGHT_2, NAVY,
            title_size=10.5, detail_size=8.4)
    if i < len(chain) - 1:
        add_arrow(s, x + 2.18, 5.0, 0.24, 0.26)
add_text(s, "没按时认领，自动升到上一级；每一步留时间、留处理人。",
         0.7, 5.6, 11.9, 0.26, 9.0, False, GRAY)

add_rect(s, 0.7, 5.98, 6.85, 0.82, RGBColor(0xFD, 0xEC, 0xEC), RGBColor(0xF3, 0xC9, 0xC9))
add_text(s, "三条不做", 0.94, 6.06, 1.6, 0.24, 10.2, True, RED)
add_text(s, "不替客户改业务数据；不在没人确认时做危险操作；不承诺“永不出事”。",
         0.94, 6.32, 6.4, 0.4, 8.8, False, GRAY, line_spacing=1.2)
add_rect(s, 7.72, 5.98, 4.93, 0.82, GREEN_BG, RGBColor(0xBF, 0xE3, 0xCB))
add_text(s, "给老板的一页", 7.96, 6.06, 2.4, 0.24, 10.2, True, GREEN)
add_text(s, "每月一页：出了几次事、停了多久、谁处理的、下次怎么更快。",
         7.96, 6.32, 4.5, 0.4, 8.8, False, GRAY, line_spacing=1.2)
add_footer(s)



# ================================================================ 16 系统关系 图
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "系统关系", "产品接在 TMS 和财务两边，做增强，不做替代",
           "读什么、写什么、怎么接，先说清楚。")

add_rect(s, 0.7, 1.92, 11.95, 0.66, RGBColor(0xD4, 0xF4, 0xDD), GREEN)
add_text(s, "智单增强层（新）", 0.95, 2.0, 3.0, 0.28, 12.5, True, NAVY)
add_text(s, "单据入口 · 校验 · AI · 对账 · 账龄 · 成本 · 经营", 4.35, 2.03, 7.0, 0.24, 9.2, False, GRAY)
add_text(s, "不改两边原流程", 10.85, 2.0, 1.65, 0.26, 8.8, True, GREEN, PP_ALIGN.RIGHT)

add_updown_arrow(s, 2.96, 2.58, 0.34, 0.62)
add_text(s, "读：订单 / 运单 / 车辆 / 客户\n确认后回写订单 / 对账", 3.42, 2.62, 2.9, 0.52,
         8.2, False, GRAY, line_spacing=1.2)
add_updown_arrow(s, 9.71, 2.58, 0.34, 0.62)
add_text(s, "读：应收 / 收款 / 科目\n确认后导出差异 / 催收", 10.17, 2.62, 2.35, 0.52,
         8.2, False, GRAY, line_spacing=1.2)

add_box(s, 0.7, 3.22, 4.85, 0.72, "现有 TMS", "运输管理系统 · 订单 / 运单 / 车辆 / 客户", LIGHT, LIGHT_2)
add_box(s, 7.1, 3.22, 5.55, 0.72, "财务系统（如果有）", "应收 / 发票 / 收款 / 科目", LIGHT, LIGHT_2)

add_text(s, "TMS 与财务之间原有的对接不变；智单只读写自己需要的字段。",
         0.7, 3.98, 11.95, 0.22, 8.8, True, GRAY)

add_rect(s, 0.7, 4.3, 3.82, 1.15, LIGHT, LIGHT_2)
add_text(s, "系统对接 / 数据库视图", 0.92, 4.4, 3.0, 0.28, 10.5, True, NAVY)
add_text(s, "适合有 IT 团队、能开测试环境的客户；读写字段按对接文档约定。", 0.92, 4.72, 3.3, 0.65, 8.8, False, GRAY, line_spacing=1.25)
add_rect(s, 4.77, 4.3, 3.82, 1.15, LIGHT, LIGHT_2)
add_text(s, "文件 / 模板", 4.99, 4.4, 3.0, 0.28, 10.5, True, NAVY)
add_text(s, "没有系统对接时先用 Excel / CSV 导入导出；字段映射一次配好。", 4.99, 4.72, 3.3, 0.65, 8.8, False, GRAY, line_spacing=1.25)
add_rect(s, 8.84, 4.3, 3.82, 1.15, LIGHT, LIGHT_2)
add_text(s, "企微 / 手机入口", 9.06, 4.4, 3.0, 0.28, 10.5, True, NAVY)
add_text(s, "一线不用装新 App；文字、图片、确认都在企微 / 手机里完成。", 9.06, 4.72, 3.3, 0.65, 8.8, False, GRAY, line_spacing=1.25)

add_rect(s, 0.7, 6.1, 11.95, 0.55, NAVY, NAVY)
add_text(s, "写回 TMS / 财务前，必须经客户确认；不双录、不截断审批、不替客户记账。", 0.95, 6.24, 11.45, 0.26, 11.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 17 系统关系 表
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "系统关系 · 节点", "每个 AI 岗位，和 TMS / 财务怎么接",
           "具体对接方式按客户系统能力定。")
rows = [
    ("托书 / 订舱", "结构化、校验、人工确认", "回写订单", "—", "TMS ← 智单"),
    ("发票", "读票、校验、异常拦截", "—", "推送应付 / 发票", "财务 ← 智单"),
    ("对账", "匹配、差异、复核", "读运单", "读应收", "双向"),
    ("账龄 / 催收", "分档、风险、催收清单", "—", "读应收 / 收款", "财务 → 智单"),
    ("成本 / 毛利", "归集、单票 / 线路毛利", "读运单 / 费用", "读科目", "TMS / 财务 → 智单"),
    ("在途 / 查询", "事件、状态、时间线", "读运单 / 写事件", "—", "双向"),
    ("知识", "检索、引用回答", "不写", "不写", "内部"),
]
add_table(s, ["节点", "智单做什么", "与 TMS", "与财务", "数据方向"], rows, 0.7, 1.98, 11.95,
          [1.7, 3.45, 2.55, 2.35, 1.9], row_h=0.52, header_h=0.4, size=9.0)
add_text(s, "说明：写回 TMS / 财务的动作默认需要客户确认；没有系统对接时用文件 / 模板，不硬改客户系统。",
         0.7, 6.12, 11.95, 0.28, 9.5, True, GRAY)
add_footer(s)


# ================================================================ 18 落地预期
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "落地预期", "四个阶段：先对齐，再单点，再扩展，最后对接",
           "每一阶段都可停；达到标准再扩。")
phases = [
    ("阶段 0", "需求对齐", "1–2 周", ["访谈老板与负责人", "拆痛点、对现状", "定能力边界：留 / 去 / 调 / 增"], "产出：需求与方案边界", "再往下：值得做 + 1 个场景 + 1 名负责人", TEAL, GREEN_BG),
    ("阶段 1", "单点试跑", "2–4 周", ["选 1 个最痛场景", "50 份样本先跑", "定验收口径"], "产出：准确率 / 工时报告", "再往下：达到约定准确率 / 工时", ORANGE, ORANGE_BG),
    ("阶段 2", "同类扩展", "1–2 月", ["托书 → 发票 → 对账 → 账龄", "共用一套流程", "学习队列积累"], "产出：多场景上线、月报", "再往下：数据稳定、人愿意用", BLUE, BLUE_BG),
    ("阶段 3", "系统对接", "季度", ["对接 TMS / 财务 / 港口", "在途、调度、成本、预测", "经营视图与异常闭环"], "前提：系统对接与历史数据就绪", "再往下：上线运行 / 续约评估", GREEN, GREEN_BG),
]
for i, (phase, title, dur, bullets, out, gate, color, bg) in enumerate(phases):
    x = 0.7 + i * 3.03
    add_rect(s, x, 1.98, 2.85, 4.05, LIGHT, LIGHT_2)
    add_rect(s, x, 1.98, 2.85, 0.46, color, color)
    add_text(s, phase, x + 0.18, 2.06, 0.9, 0.28, 9, True, WHITE)
    add_text(s, title, x + 1.05, 2.06, 1.7, 0.28, 9, True, WHITE)
    add_text(s, dur, x + 0.2, 2.58, 1.4, 0.28, 11, True, color)
    add_bullets(s, bullets, x + 0.2, 2.95, 2.45, 1.4, 9.0, BLACK, color, 4)
    add_text(s, out, x + 0.2, 4.5, 2.45, 0.55, 8.6, True, NAVY, line_spacing=1.25)
    add_text(s, gate, x + 0.2, 5.25, 2.45, 0.55, 8.2, False, color, line_spacing=1.2)

add_rect(s, 0.7, 6.28, 11.95, 0.5, NAVY, NAVY)
add_text(s, "推进节奏由数据准备程度决定，不由合同大小决定。", 0.95, 6.4, 11.45, 0.26, 11.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 19 落地协作
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "落地协作", "需要谁、给什么、什么时候",
           "不是所有人都全程参与；按阶段拉人，减少对日常业务的打扰。")
rows = [
    ("需求对齐", "老板 / 总经理、业务负责人、单证 / 财务主管、IT", "公开资料、现状流程、系统清单、最痛的三件事", "1–2 周"),
    ("单点试跑", "1 名负责人、一线骨干、IT", "50 份脱敏样本、测试账号 / 环境、验收口径", "2–4 周"),
    ("同类扩展", "业务负责人、财务、IT", "更多样本、字段 / 科目口径、系统对接或模板", "1–2 月"),
    ("系统对接", "IT、TMS / 财务厂商、安全 / 法务", "对接文档、测试环境、安全评审、数据边界", "季度"),
]
add_table(s, ["阶段", "客户谁参与", "需要提供什么", "何时"], rows, 0.7, 1.98, 11.95,
          [1.6, 3.5, 5.15, 1.7], row_h=0.78, header_h=0.4, size=9.3)
add_rect(s, 0.7, 5.55, 11.95, 1.0, LIGHT, LIGHT_2)
add_text(s, "四个条件", 0.95, 5.68, 1.4, 0.28, 10.5, True, TEAL)
add_text(s, "1 名能拍板的负责人 ｜ 50 份脱敏样本 ｜ 系统清单 / 对接方式 ｜ 数据边界与安全要求",
         2.2, 5.68, 10.0, 0.3, 10, True, NAVY)
add_text(s, "不需要先买系统；先给样本和一个人，就能开始验证。", 0.95, 6.05, 11.2, 0.3, 9.5, False, GRAY)
add_footer(s)


# ================================================================ 20 边界
s = prs.slides.add_slide(prs.slide_layouts[6])
add_header(s, "边界与底线", "四条底线、三条边界",
           "四条底线管方向，三条边界管动作。")
cards = [
    ("不换系统", "不替换 TMS / 财务，只做上层增强。", TEAL),
    ("不替人做决定", "AI 只出草稿，人决定用不用。", GREEN),
    ("不拿数据冒险", "默认客户内网 / 客户云；数据不出边界。", ORANGE),
    ("不一次性投入", "先单点验证；不达标就停，不扩阶段。", RED),
]
for i, (title, detail, color) in enumerate(cards):
    x = 0.7 + (i % 2) * 6.05
    y = 1.95 + (i // 2) * 1.15
    add_rect(s, x, y, 5.75, 1.0, LIGHT, LIGHT_2)
    add_text(s, title, x + 0.28, y + 0.14, 2.5, 0.34, 13.5, True, color)
    add_text(s, detail, x + 2.55, y + 0.14, 2.95, 0.75, 9.8, False, NAVY, line_spacing=1.3)

add_text(s, "三条边界", 0.7, 4.55, 2.0, 0.3, 12, True, NAVY)
edges = [
    ("AI 不编数字", "金额、账龄、毛利由系统算"),
    ("没有数据就说没有", "不编船期、不编位置、不编放行"),
    ("不自动对外", "不改单、不派车、不扣费、不申报、不报价"),
]
for i, (title, detail) in enumerate(edges):
    x = 0.7 + i * 4.05
    add_rect(s, x, 4.95, 3.82, 0.9, WHITE, LIGHT_2)
    add_text(s, title, x + 0.2, 5.05, 3.4, 0.28, 10.5, True, TEAL)
    add_text(s, detail, x + 0.2, 5.38, 3.4, 0.28, 8.8, False, GRAY)

add_rect(s, 0.7, 6.1, 11.95, 0.55, NAVY, NAVY)
add_text(s, "不裁人，先让同样的人处理更多单；省下来的工时由贵司决定怎么用。", 0.95, 6.24, 11.45, 0.26, 11.5, True, WHITE, PP_ALIGN.CENTER)
add_footer(s)


# ================================================================ 21 下一步
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
bg.fill.solid(); bg.fill.fore_color.rgb = NAVY; bg.line.fill.background(); bg.shadow.inherit = False
add_text(s, "下一步", 0.9, 0.55, 4.0, 0.35, 12, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "从老板的想法，到 1–2 个能跑的场景", 0.9, 0.95, 11.8, 0.62, 29, True, WHITE)
add_text(s, "不谈合同；先判断值不值得做，再谈留下什么、去掉什么。",
         0.9, 1.62, 11.6, 0.34, 13, False, RGBColor(0xD7, 0xE3, 0xEF))

steps = [
    ("1", "老板访谈", "先听想法：最想改变什么、最担心什么、哪些不能动。"),
    ("2", "痛点拆解", "拆到业务环节：谁在做、卡在哪、多久一次、损失多大。"),
    ("3", "负责人访谈", "和老板指定的人对现状：数据在哪、系统是什么、谁能拍板。"),
    ("4", "双方研判", "值不值得做、先做哪一段；不值得就停，不硬推方案。"),
    ("5", "能力取舍", "留哪些、去哪些、调哪些、新增哪些，写清需求和方案边界。"),
    ("6", "场景开跑", "选 1–2 个场景，用贵司样本跑，不先看通用样例下结论。"),
]
for i, (num, title, detail) in enumerate(steps):
    col, row = i % 3, i // 3
    x = 0.9 + col * 3.95
    y = 2.22 + row * 1.3
    add_rect(s, x, y, 3.65, 1.15, NAVY_2, RGBColor(0x2B, 0x4F, 0x70))
    add_text(s, num, x + 0.24, y + 0.1, 0.45, 0.42, 19, True, RGBColor(0xF5, 0xB4, 0x5A))
    add_text(s, title, x + 0.72, y + 0.12, 2.75, 0.3, 12.5, True, WHITE)
    add_text(s, detail, x + 0.26, y + 0.5, 3.12, 0.55, 8.6, False,
             RGBColor(0xC9, 0xD8, 0xE6), line_spacing=1.25)

add_text(s, "研判只有两种结果：值得做 → 进入能力取舍；不值得 → 停，不进入试跑。",
         0.9, 4.82, 11.8, 0.3, 11, True, RGBColor(0x9F, 0xD8, 0xD6))
add_text(s, "需要准备：老板最想解决的两个问题、近 3 个月托书 / 对账单样本、现有系统清单。",
         0.9, 5.28, 11.8, 0.3, 9.6, False, RGBColor(0xB8, 0xC9, 0xD9))
add_text(s, "顺序不能反：先痛点，再边界，再场景；先场景，才谈效果和投入。",
         0.9, 5.85, 11.8, 0.4, 14.5, True, WHITE)
add_text(s, "企业 AI 化方案 ｜ 2026-11-09", 0.9, 6.55, 6.0, 0.3, 10, False, RGBColor(0x8F, 0xA6, 0xBA))


prs.save(OUT)
print(f"saved {OUT} ({len(prs.slides)} slides)")
