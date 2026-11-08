from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "ppt_assets"
OUT = ROOT / "客户老板版_AI能力演示_2026-11-08.pptx"

BLUE = RGBColor(0x1F, 0x4E, 0x79)
DARK = RGBColor(0x1B, 0x24, 0x30)
MUTED = RGBColor(0x6B, 0x76, 0x84)
RED = RGBColor(0xC5, 0x30, 0x30)
GREEN = RGBColor(0x2F, 0x85, 0x5A)
WARN = RGBColor(0xB7, 0x79, 0x1F)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)


def text(slide, x, y, w, h, content, size=16, color=DARK, bold=False, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = content
    run.font.size = Pt(size)
    run.font.color.rgb = color
    run.font.bold = bold
    return box


def bullets(slide, x, y, w, h, items, size=14):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    for i, (txt, color) in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(7)
        run = p.add_run()
        run.text = "• " + txt
        run.font.size = Pt(size)
        run.font.color.rgb = color
    return box


def header(slide, title, sub):
    bar = slide.shapes.add_shape(1, Inches(0), Inches(0), Inches(13.333), Inches(0.08))
    bar.fill.solid(); bar.fill.fore_color.rgb = BLUE; bar.line.fill.background()
    text(slide, 0.6, 0.35, 9.5, 0.5, title, 26, DARK, True)
    text(slide, 0.6, 0.88, 11.8, 0.4, sub, 12, MUTED)
    line = slide.shapes.add_shape(1, Inches(0.6), Inches(1.28), Inches(12.1), Inches(0.01))
    line.fill.solid(); line.fill.fore_color.rgb = RGBColor(0xD9, 0xE2, 0xEC); line.line.fill.background()


def footer(slide):
    text(slide, 0.6, 7.05, 12.1, 0.3,
         "合成演示数据，不代表真实客户；真实效果需用客户数据校准。", 9, MUTED)


def image(slide, name, x, y, w, h):
    path = ASSETS / name
    if path.exists():
        slide.shapes.add_picture(str(path), Inches(x), Inches(y), width=Inches(w), height=Inches(h))


# 1. cover
s = prs.slides.add_slide(prs.slide_layouts[6])
bg = s.shapes.add_shape(1, Inches(0), Inches(0), Inches(13.333), Inches(7.5))
bg.fill.solid(); bg.fill.fore_color.rgb = RGBColor(0xF5, 0xF8, 0xFC); bg.line.fill.background()
text(s, 0.9, 2.0, 11.5, 0.8, "智单 · AI 能力演示", 40, BLUE, True)
text(s, 0.9, 2.9, 11.5, 0.6, "从“能读单据”到“能查在途、能调车、能看回款”", 20, DARK)
text(s, 0.9, 3.7, 11.5, 0.5, "客户老板版 · 合成数据演示 · 2026-11-08", 14, MUTED)
text(s, 0.9, 6.3, 11.5, 0.4, "所有页面数据均为合成演示，不代表真实客户结论。", 11, WARN)

# 2. track
s = prs.slides.add_slide(prs.slide_layouts[6])
header(s, "客户查询：到哪了、几时到、放行没有", "箱号 / 单号 / 客户 → 当前状态、ETA、报关、时间线")
image(s, "ai-track.png", 0.5, 1.5, 8.1, 4.9)
bullets(s, 8.9, 1.6, 3.9, 4.6, [
    ("客户不再反复问调度：一条查询出状态", DARK),
    ("ETA、报关、延误、最后节点都有出处", DARK),
    ("时间线可追：提箱→装柜→进港→报关→放行", DARK),
    ("没有数据就明确说没有，不编船期", WARN),
    ("真实上线需接港口/船期/报关接口", RED),
], 13)
footer(s)

# 3. dispatch
s = prs.slides.add_slide(prs.slide_layouts[6])
header(s, "调度优化：空驶、准时、装箱率", "160 单 / 30 台车 / 40HQ 装箱；启发式规则，不是大模型")
image(s, "ai-dispatch.png", 0.5, 1.5, 8.1, 4.9)
bullets(s, 8.9, 1.6, 3.9, 4.8, [
    ("空驶里程：14,460 → 13,713 km（-5.2%）", GREEN),
    ("准时率：29.4% → 78.1%（+48.7 个点）", GREEN),
    ("40HQ 装箱：80 → 52 个柜", GREEN),
    ("装载率：45.8% → 70.4%", GREEN),
    ("优化是运筹/规则，不是 AI 聊天", WARN),
], 13)
footer(s)

# 4. forecast
s = prs.slides.add_slide(prs.slide_layouts[6])
header(s, "预测信用：谁该先催、未来四周回多少", "20 客户 × 24 个月合成历史；规则/简单统计，不是生产级预测")
image(s, "ai-forecast.png", 0.5, 1.5, 8.1, 4.9)
bullets(s, 8.9, 1.6, 3.9, 4.8, [
    ("高风险客户 3 家，未收合计 119 万", RED),
    ("按平均回款天数 + 逾期率排优先级", DARK),
    ("未来 4 周预计回款：42 / 30 / 24 / 24 万", DARK),
    ("线路趋势：上升/下降/平稳 + 未来 3 个月", DARK),
    ("真实预测必须用客户 12–24 个月数据回测", WARN),
], 13)
footer(s)

# 5. customs
s = prs.slides.add_slide(prs.slide_layouts[6])
header(s, "关务 HS：编码只从客户词库里选", "商品描述 → HS 候选；模型只能在候选中选，不硬猜")
image(s, "ai-customs.png", 0.5, 1.5, 8.1, 4.9)
bullets(s, 8.9, 1.6, 3.9, 4.8, [
    ("客户词库/历史报关记录是唯一编码来源", DARK),
    ("命中关键词 + 置信度 + 依据", DARK),
    ("模型只在候选里选，不发明编码", GREEN),
    ("无候选就说没有，交给报关行", WARN),
    ("示例词库仅演示，真实申报需 10 位编码", RED),
], 13)
footer(s)

# 6. boundary
s = prs.slides.add_slide(prs.slide_layouts[6])
bar = s.shapes.add_shape(1, Inches(0), Inches(0), Inches(13.333), Inches(0.08))
bar.fill.solid(); bar.fill.fore_color.rgb = BLUE; bar.line.fill.background()
text(s, 0.8, 0.6, 11.8, 0.6, "这页不是“AI 万能”，是“先做到哪、下一步要什么”", 26, DARK, True)
bullets(s, 0.9, 1.6, 11.8, 5.0, [
    ("文档 AI：托书 / 发票 / 对账单 / 单证一致性 / 知识库 / 报价", DARK),
    ("过程 AI：在途事件 / 客户查询 / 调度优化（演示）", DARK),
    ("经营 AI：成本毛利 / 经营洞察 / 预测信用（演示）", DARK),
    ("真实上线需要：客户 HS 词库、船期/箱动态、订单/车辆/舱位、12–24 个月财务数据", WARN),
    ("没有数据就停在通用能力，不拿合成数据当客户结论", RED),
], 15)
text(s, 0.9, 6.4, 11.8, 0.4, "数据需求清单见《24 · 协丰数据需求清单（B4–B7）》。", 12, MUTED)
footer(s)

prs.save(OUT)
print("saved", OUT)
