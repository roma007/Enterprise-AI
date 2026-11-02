# ai-copilot · 集卡托书 AI 录入（会客 demo）

> 一句话：**客户发来的一段微信 / 邮件 / 截图文本，5 秒内变成一张带置信度、已被行业规则挑过错的结构化订单。**
>
> 用途：售前会客时现场跑，证明"我们能做"，并换回客户的真实托书样本。
> 不是产品，不是平台，不许加登录 / 权限 / 多租户。

---

## 文档索引

| 文档 | 什么时候看 |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | 想知道"什么时候改了什么" |
| [docs/决策记录.md](./docs/决策记录.md) | 想知道"**为什么这么定**"，或想推翻某个决定 |
| [docs/问题与修复.md](./docs/问题与修复.md) | 遇到类似 bug，先查这里 |
| [docs/运维手册.md](./docs/运维手册.md) | 启动、备份、重置、密钥轮换、故障排查 |
| [samples/real/README.md](./samples/real/README.md) | 真实样本怎么入库、怎么标金标 |
| [../会客包/](../会客包/) | 售前材料、实施计划、模拟演练 |

---


## 一、这个 demo 到底证明了什么

| 客户会怀疑的 | 这里的回答 |
|---|---|
| "你是不是只会调 API？" | 有 ISO 6346 校验位、箱型合法性、封号格式、截港过期判断——这些是行业规则，不是通用能力 |
| "准不准？" | `跑评测` 一键出字段级准确率、整单完全正确率、必填字段准确率 |
| "错了怎么办？" | AI 只出草稿，每字段带置信度，人工改完才算数，修正全部留痕 |
| "以后能算钱吗？" | 每次解析记录耗时与 token，配合人工修正率 → 单均成本与节省工时 |

**它不能证明的**：真实客户数据上的准确率。那必须拿客户的 200 份托书重跑，这正是会客时唯一要向客户索要的东西。

---

## 二、快速开始

```bash
cd ai-copilot
cp .env.example .env        # 不填 API Key 也能跑（自动降级到规则引擎）
make dev                    # → http://127.0.0.1:8790
```

> 已有 `.venv`（Python 3.11）时 `make dev` 自动使用它。
> 全新环境：`make setup`（用 uv 装，需 Python 3.11/3.12，onnxruntime 尚无 3.14 wheel）。

打开 <http://127.0.0.1:8790>，点左侧任意样本 → 解析；或把托书截图/PDF 拖进左侧。

### 生成 OCR 测试图

```bash
PYTHONPATH=. .venv/bin/python scripts/make_test_image.py
```

产出 `samples/fixtures/booking_sample.png`，用于 `smoke.sh` 的 OCR 用例。

### 配置真实模型

任何 OpenAI 兼容接口都能用。**本项目当前接的是 OpenCode Go 推理网关**：

```env
LLM_BASE_URL=https://opencode.ai/inference/go/openai/v1
LLM_API_KEY=<你的 OpenCode Go Key>
LLM_MODEL=claude-haiku-5-5
LLM_USER_AGENT=ai-copilot/1.0
LLM_SESSION_HEADER=x-opencode-session
```

**这个网管有两个必须满足的条件，否则会报 403 / 400：**

| 现象 | 原因 | 解决 |
|---|---|---|
| `HTTP 403: error code 1010` | Cloudflare 拦截默认 UA（如 python-urllib） | 设置非空 `LLM_USER_AGENT` |
| `HTTP 400: MissingSessionID` | 网关要求会话头 | 设置 `LLM_SESSION_HEADER=x-opencode-session`（值自动生成） |

模型选型依据（2 份最难的样本实测）：

| 模型 | 准确率 | 单条耗时 |
|---|---|---|
| **claude-haiku-5-5** | **92%** | **5.2s** ← 选它 |
| mimo-v2.6-flash | 92% | 10.2s |
| gemini-4-argon | 92% | 14.4s |
| minimax-m3.1-flash | 38% | 11.1s |
| gpt-6-luna | 0%（返回空） | 2.0s |

其他平台（DeepSeek / 通义 / 智谱 / 本地 vLLM）直接改 `LLM_BASE_URL` + `LLM_MODEL` 即可，不需要那两个额外头。

不配置时使用 `rule-based-v1`（纯规则），页面右上角会明确显示**"规则引擎（未配置模型）"**——演示时不要藏这一点。

### 命令行跑评测

```bash
make eval
# 或
PYTHONPATH=. .venv/bin/python -m app.evalrun
```

### 演示前预热（必做）

```bash
make prewarm
```

把全部样本的模型结果预先写入缓存。不预热的话，现场每条要等 5–8 秒。

---

## 三、架构（故意做小）

```
static/index.html        单页 UI，无框架，无构建
app/schema.py            字段清单 + 置信度模型（唯一事实来源）
app/extract.py           两条通道：LLM 语义抽取 / 规则格式抽取
app/rules.py             行业规则引擎（ISO 6346、箱型、截港时间…）
app/llm.py               模型网关（OpenAI 兼容 + 脱敏 + token 计量）
app/store.py             SQLite 遥测：解析记录 + 人工修正
app/evalrun.py           评测跑批
app/main.py              FastAPI，7 个端点
samples/bookings.jsonl   20 份调优用合成托书 + 金标
samples/bookings_holdout.jsonl  8 份留出集（写完后未回头调规则）
```

### 一个关键设计：规则有最终裁决权

模型负责理解语义（"毛重大概 19 吨""送到春晓码头"），
规则负责裁决强格式字段（箱号、封号、箱型、电话、时间）。

`RULE_AUTHORITATIVE` 中的字段，只要规则命中就以规则为准。
**因为模型最危险的错误是"把箱号编得像真的"。** 这条规则直接把这类风险封死。

### 合并策略

```
规则先抽 → LLM 补充语义字段 → 强格式字段回滚到规则值 → 规则引擎挑错
```

---

## 四、验证策略（演示前必读）

### 4.1 当前数字

| 样本集 | 份数 | 字段级 | 必填字段 | 整单全对 | 能不能对外讲 |
|---|---|---|---|---|---|
| 调优集 | 20 | 100% | 100% | 100% | ❌ **已饱和，无信息量** |
| 留出集 | 8 | 98.7% | 96.9% | 87.5% | 🟡 仅内部回归 |
| 客户模拟集 | 3 | 100% | 100% | 100% | ❌ **已污染，只作回归** |
| 真实集 | 0 | — | — | — | ✅ 唯一可对外（待 G2） |

> ⚠️ **调优集 100% 不是好消息，是它已经没有信息量了。**
> 客户模拟集也一样：修完 bug 之后它变成了调优集，不再具备盲测价值。
> **现在唯一有意义的数字，是拿到客户真实样本之后跑出来的那一个。**

三模式对照（留出集，`claude-haiku-5-5`）：

| 引擎 | 字段级 | 说明 |
|---|---|---|
| 仅规则 | 97.4% | 10–30ms，不花钱 |
| 仅模型 | 92.2% | ~5s，单条约 2000 tokens |
| 合并（fill_only） | 97.4%–98.7% | 规则先跑，模型只补空 |

### 4.2 合并策略是实验选出来的，不是拍脑袋

我用 28 份样本把三种合并策略都跑了一遍：

| 策略 | 留出集 | 调优集 | 结论 |
|---|---|---|---|
| **fill_only**（模型只补空） | **98.7%** | **98.7%** | ✅ 采用 |
| floor 0.9 | 98.7% | 98.7% | 持平 |
| floor 0.8 / 0.7 / 0.6 | 97.4% | 98.7% | 下降 |
| llm_wins（模型优先） | 97.4% | 98.7% | 下降，且不可控 |

**关键发现：模型单独用（92%）不如规则（97%），强行让模型覆盖正确值会掉分。**
所以默认策略是「规则先跑，模型只补规则漏掉的」——**这是一个可以拿给客户看的证据，不是宣传话术。**

> 注意：这是在我们的合成样本上得出的。真实脏数据上规则会明显变弱，那时模型的价值会真正显现——
> 这正是 POC 要验证的事，现在下结论为时过早。

### 4.3 按需调用（`LLM_STRATEGY=auto`）

规则已经抽全必填、且置信度都 ≥0.6 时，**不调模型**：

| 情况 | 行为 | 实测 |
|---|---|---|
| 结构化托书 | 跳过模型 | 18ms，`note` 写明"规则已覆盖…跳过模型" |
| 口语/改单消息 | 调模型补 | ~5s，补出规则漏的字段 |

代价：约 1pp 精度（97.4% vs 98.7%）。收益：快 100 倍、成本接近 0。
要全量对照时设 `LLM_STRATEGY=always`。

### 4.4 怎么讲，怎么不能讲

能讲：

> "在我们自建的 28 份样本上，字段级 97–98%。模型单独用只有 92%，所以我们让它只补规则漏掉的字段——这个策略是拿数据选出来的。你们真实托书的准确率，我要 200 份样本跑完才能给数字，目标 ≥95%、人工修正 ≤1 分钟/单。"

不能讲：

> ❌ "准确率 98%，你放心。"
> ❌ "某某客户已经上线，效果很好。"

### 已知会让准确率掉下来的情况

| 情况 | 现状 | 影响 |
|---|---|---|
| 单行无分隔的极简消息（"客户：XX 单号 YY 40HQ 一个 箱号 ZZ"） | 会串值 | 留出集 H6 就是这么错的 |
| 图片 / PDF 托书 | 不支持 | 需要 OCR，+1 周 |
| 多票混在一条消息里 | 不支持 | 需要拆分逻辑 |
| 地址只抽不校验 | 无行政区划库 | 错地址拦不住 |

---

## 五、演示脚本（5 分钟）

| 步骤 | 动作 | 说这句话 |
|---|---|---|
| 1 | 点样本 `S04 微信口语·简` | "客户就是这么发的，连字段名都没有。" |
| 2 | 点解析 | "2 秒出草稿，每个字段带置信度。" |
| 3 | 点样本 `S10 截港已过` | "注意这条红色——截港时间已经过了，这单要改配。上周你们被罚的那笔，就是这个原因。" |
| 4 | 点样本 `S11 箱号校验位错误` | "箱号最后一位是校验位，录错一位系统立刻拦下，不用等到码头才发现。" |
| 5 | 改一个字段 → 确认并记录 | "AI 只出草稿，人改完才算数，改了什么都留痕。" |
| 6 | 点跑评测 | "20 份样本，字段级 XX%。你们给 200 份真实托书，我 3 周后带你们的数据版本回来。" |

---

## 六、下一步（按顺序，不要跳）

| 阶段 | 内容 |
|---|---|
| 现在 | 单箱/多箱解析 + 规则挑错 + 人工确认 + 评测（**已完成**） |
| +1 周 | 图片/PDF 上传（OCR）→ 走同一套抽取管线 |
| +1 周 | 04b 发票识别：复用底座，只换 schema / 规则 / 结果页 |
| 拿到真实样本后 | 重跑评测，替换 `samples/bookings.jsonl`，出真实准确率报告 |
| 之后 | 写入 TMS / 导出 CSV → 人工修正数据回流评测集 |

---

## 七、纪律

- 不加登录、权限、多租户
- 不做工具库、插件机制、配置化
- 不接客户 TMS / 财务软件
- 不编造客户案例
- 所有对外数字必须标注样本来源与口径
- **每改一次就 commit 一次，message 写"为什么改"，不是"改了什么"**
  - 修 bug 时在 `docs/问题与修复.md` 补一条
  - 改了策略/阈值时在 `docs/决策记录.md` 补一条 ADR

---

## 八、能力现状（与代码一致，改代码必须同步改本表）

### 8.1 已实现

| 能力 | 位置 | 验证方式 |
|---|---|---|
| 20 字段抽取（中/英/全角/混写） | `app/extract.py` | `make eval` |
| 置信度 + 抽取来源标注（llm / rule / regex） | `app/schema.py` | UI 展示 |
| ISO 6346 箱号校验位 | `app/rules.py` | smoke 用例 |
| 箱型合法性、封号格式、电话格式 | `app/rules.py` | 规则单测 |
| 截港过期阻断 / 24 小时内预警 | `app/rules.py` | smoke 用例 |
| 箱号数量与箱量一致性 | `app/rules.py` | 规则单测 |
| 模型网关（OpenAI 兼容 + 脱敏 + token 计量 + 失败降级） | `app/llm.py` | 断网测试 |
| 人工修改 → 修正率记录 | `app/store.py` + UI | `/api/confirm` |
| **图片 OCR（RapidOCR / onnxruntime）** | `app/ocr.py` | `smoke.sh` OCR 用例 |
| **PDF 双路径（有文本层直读，无则 OCR）** | `app/ocr.py` | 上传文本层 PDF 验证 |
| **OCR 版面还原（y 聚行 + x 排序）** | `app/ocr.py` `_layout` | 合成截图验证 |
| **OCR 粘连字段切分**（"家用电器毛重：18600" → 两个字段） | `app/extract.py` `_cut_stop` | OCR 回归 |
| 上传接口（10MB 上限 / 类型分派 / 空结果 422） | `app/main.py` | curl 验证 |
| 双样本集评测（调优 / 留出） | `app/evalrun.py` | `/api/eval` |
| **三模式对照（仅规则 / 仅模型 / 合并）** | `app/evalrun.py` `run_compare` | `/api/eval` 的 `compare` |
| **分级审批（C1）**：auto / single / double / blocked 四档自动分流 | `app/rules.py` `decide_review_level` | 样本集分档验证 |
| **工时计时（D10）**：出稿到确认的真实耗时 | `app/main.py` `handle_ms` | 指标中心 |
| **指标中心（C3）**：自动通过率、修正率、节省工时、每日序列 | `app/store.py` `metrics` | `/api/metrics` |
| **月报（C3）**：一键生成 Markdown 报告 | `app/store.py` `report_md` | `/api/report.md` |
| **全链路留痕（C2）**：原文 + 模型/提示词/管线版本 + 逐字段 diff | `app/store.py` `audit` | `/api/audit/{id}`、`/api/audit.csv` |
| **绕过率（C4）**：入口捕获 + 未确认计数 + 20% 告警 | `app/store.py` `record_inbound` | `/api/inbound` |
| **风险模拟（C5）**：取消人工确认的损失测算 | `app/store.py` `risk_sim` | `/api/risk-sim` |
| **纸质↔TMS 配对（D4）**：单号 / 箱号 / 客户+日期 三级匹配 | `app/pairing.py` | `/api/pair`、`make pairing` |
| **弱金标评测（D6）**：TMS 记录当答案 + 10% 抽检校正 + 95% 置信区间 | `app/goldset.py` | `/api/goldset/eval`、`make goldset` |
| **字段归一（D7）**：箱型/箱号/时间/箱量/电话统一写法 | `app/normalize.py` | 抽取后自动执行 |
| **CSV 导入导出（D13）**：中文表头自动映射 | `app/csvio.py` | `/api/import/tms`、`/api/export.csv` |
| **入口唯一化（D3）**：企微回调 + 移动端 H5，先落库再解析 | `app/wecom.py` + `static/h5.html` | `/api/wecom/callback`、`/h5` |
| **图像增强（D2）**：纠偏/去噪/二值化多版本 + 规则裁决 | `app/enhance.py` + `app/ocr.py` | `make enhance` |
| **字段名容错（D14）**：标签相似度 + 值形态双重判定 | `app/fuzzy.py` | 抽取时自动补空 |
| **多票切分（D8）**：编号列表 / 单号行 / 空行三级切分 | `app/splitter.py` | `/api/split`、页面「多票拆分」 |
| **改单 diff（D9）**：检索原单 → 增/删/改语义 → 差异展示 | `app/amend.py` | `/api/extract` 返回 `amend`、`make amend` |
| **主动学习队列（D5）**：可疑样本进池，人工确认即产金标，可导出评测 | `app/store.py` `learn_*` | `/api/learn/stats`、`/api/learn/export.jsonl` |
| **改单反查（B1）**：没写原单号时按箱号/客户+近 3 天找原单，多候选不猜 | `app/store.py` `find_amend_candidates` | `/api/extract` 的 `amend.candidates` |
| **多票夹改单（B2）**：`原单 XX 有变` 也作为切分起点，拆完逐票判改单 | `app/splitter.py` + `/api/split` | `/api/split` |
| **并发幂等（B3）**：同内容重复提交幂等返回，不同内容 409 | `app/store.py` `AlreadyConfirmed` | `/api/confirm` |
| **脱敏（B4）**：公司/人名/手机/身份证/报关号自动替换，映射表持久化 | `app/masking.py` | `/api/mask` |
| **批量导入（B5）**：一次传 N 份，后台处理，进度与失败重试 | `app/batchproc.py` | `/batch`、`/api/batches/*` |
| **分层抽样（B6）**：月份×客户×格式分层，输出可打印清单 | `app/sampling.py` | `/api/sampling/*`、`make sample` |
| **跨批次失败队列（B7）**：失败项集中可见、一键重排 | `app/store.py` `failed_items` | `/api/batches/failed`、`retry-all` |
| **发票识别（04b）**：税号校验位、金额勾稽、税率合法性；规则够好自动跳过模型 | `app/invoice.py` | `/invoice`、`/api/invoice/*` |
| **三单匹配**：订单↔运单↔发票，箱号/金额/客户/箱量四维核对 | `app/threeway.py` | `/threeway`、`/api/threeway/*` |
| **账单级自动对账**：对账单 ↔ 系统运单双向比对，四类差异定位 | `app/reconcile.py` | `/reconcile`、`/api/reconcile/*` |
| **发票批量导入**：批次建单时选类型，按类型路由到发票抽取器 | `app/batchproc.py` | `/batch` 选「发票」 |
| **账龄与催收**：四档账龄 + 客户风险分级 + 催收话术 | `app/aging.py` | `/aging`、`/api/aging/*` |
| **外协结算**：合同价 × 数量 = 应付，与车队报账比对 | `app/settlement.py` | `/settlement`、`/api/settlement/*` |
| **一键演示页**：按会客顺序串起 10 步全链路 | `static/demo.html` | `/demo`、`make demo` |
| **登录与角色（A1）**：admin / operator / finance / viewer，会话可撤销 | `app/auth.py` | `/login`、`/api/auth/*` |
| **用户管理（A1）**：建用户、改角色、停用（停用即踢下线） | `app/main.py` | `/users`（仅管理员） |
| **操作者记录（A2）**：每次解析与确认记录 `actor` / `confirmed_by` | `app/store.py` | 审计与回写的基础 |
| **阈值可配置（A3）**：9 项阈值存 JSON，改完立即生效 | `app/thresholds.py` | `/settings`（仅管理员） |
| **原件留存（A4）**：单张上传的原图/PDF 落盘，可回读 | `app/storage.py` | `runs.source_file`、`GET /api/files/{rel}` |
| **批量可取消（A5）**：处理中可中断，未处理项保持 pending | `app/batchproc.py` | `POST /api/batches/{id}/cancel` |
| **对象存储（A6）**：local / s3 双后端，换后端不改业务代码 | `app/storage.py` | `STORAGE_BACKEND=s3`（需 `pip install boto3`） |
| **时间修复**：OCR 丢失分隔符（`2026110718:00`）也能解析 | `app/rules.py` `parse_datetime` | 单元验证 |
| **人工兜底队列**：需复核但未确认的单 | `app/store.py` `queue` | `/api/queue` |
| 模型网关（UA / 会话头 / 失败降级 / JSON 模式兼容） | `app/llm.py` | OpenCode 网关实测 |
| 结果缓存（同文本同模型同提示词命中缓存，演示秒出） | `app/llm.py` | 二次评测 <1s |
| 按需调用模型（规则够好就不花 5 秒） | `app/extract.py` `_needs_llm` | 结构化托书 18ms |
| 合并策略可切换（fill_only / floor / llm_wins） | `app/extract.py` | 28 份样本对照 |
| CSV 导出 | `static/index.html` | 手工验证 |
| 演示前自检 | `scripts/smoke.sh` | 5 项全绿 |

### 8.2 未实现（按计划排期）

| 缺口 | 影响 | 计划任务 | 目标 |
|---|---|---|---|
| 地址不校验（无行政区划库） | 错地址拦不住 | 未排期 | 二期 |
| 无 TMS / 财务软件写回 | 确认后只能导出 CSV | 明确不做 | — |
| 无登录 / 多租户 | 只能本机演示 | 明确不做 | — |
| 真实客户样本 | 评测数字不可对外 | **G2 门禁** | W4 |

### 8.3 已知会让准确率掉下来的情况

| 情况 | 现状 | 影响 |
|---|---|---|
| 单行无分隔的极简消息（"客户：XX 单号 YY 40HQ 一个 箱号 ZZ"） | 会串值 | 留出集 H6 即为此类 |
| 纯口语且无关键词（"老规矩那票，明天走"） | 抽不出 | 需上下文或模型 |
| 扫描件 / 手写托书 | 不支持手写 | OCR 只认印刷体 |
| 同一字段多种业务叫法（未收录的方言词） | 漏抽 | 需持续补词表 |
| **OCR 丢失拉丁文空格**（`COSCO SHIPPING ARIES` → `COSCOSHIPPINGARIES`） | 船名航次会粘在一起 | 已用 `_cut_stop` 缓解字段粘连，但英文内部的空格无法还原；需按字典纠错 |
| 手机翻拍（倾斜、阴影、水印） | 未测 | 必须用真实照片重测准确率 |
| 模型调用约 5 秒/单 | 现场感知明显 | `auto` 策略已让多数结构化托书跳过模型；缓存命中后 <50ms |
| **企业微信只支持明文模式** | 加密模式需接官方加解密库 | 上生产前必须补，当前仅够内部试点 |
| 企微图片消息未接 | 只处理 text 消息 | 图片需走 H5 或后续接 media_id 下载 |
| **坏图的真正瓶颈是字段名误识** | 已用 D14 容错匹配缓解（中档退化 2/5 → 3/5） | 剩下的失败是**数字级**误识（少一位、错一位），只能靠置信度提示 + 人工兜底 |
| 多版本 OCR 只保证不劣化 | 采用规则裁决 + 保守切换 | 实测增强版很少胜出，因为 RapidOCR 自带预处理已经很强 |
| 模型单独用只有 92% | 不能指望模型兜底 | 这是刻意设计的：规则优先，模型只补漏 |
| 免费额度/配额 | 评测会消耗 token | 结果已缓存，重复评测不再扣费 |
