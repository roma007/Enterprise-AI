# 托书结构化小评测模板

> 用于 20–50 份真实托书的小评测。不要用合成样本冒充真实客户结论。

## 目录

```
托书评测模板/
├── README.md
├── gold_template.csv
└── docs/            # 把脱敏后的托书 .txt 放这里
    ├── S01.txt
    ├── S02.txt
    └── ...
```

每份托书一个 `.txt` 文件，文件名去掉扩展名就是 `doc_id`。

## 金标

把 `gold_template.csv` 复制为 `gold.csv`，每行一个字段：

```csv
doc_id,field,expected
S01,client,宏远国际货代
S01,booking_no,HY2026110501
S01,container_no,CSQU3054383
S02,client,中远物流宁波分公司
```

- 可以只标你关心的字段，不必每个字段都标。
- 字段名用系统里的 key：`client`、`booking_no`、`bl_no`、`so_no`、`container_type`、`container_qty`、`container_no`、`seal_no`、`pickup_addr`、`delivery_addr`、`factory_contact`、`factory_phone`、`loading_window`、`closing_time`、`vessel_voyage`、`cargo_desc`、`gross_weight`、`freight`、`remark`。
- 不要写客户真实姓名/电话；脱敏后再放。

## 运行

```bash
cd ai-copilot
PYTHONPATH=. .venv/bin/python scripts/eval_booking_folder.py \
  --dir ../会客包/试点一/托书评测模板/docs \
  --gold ../会客包/试点一/托书评测模板/gold.csv \
  --out data/booking_eval.csv \
  --report data/booking_eval.md
```

## 看什么

- **字段准确率**：抽对字段 / 标注字段。
- **整单全对率**：一次不用改的单 / 有金标的单。
- **平均耗时**：每单解析时间。
- **阻断单**：规则发现的有问题单，不一定都是坏事，说明规则在挑错。
- `wrong_fields` 列列出具体错在哪个字段，优先补规则或补样本。

## 注意

- 这个脚本只做评测，不写入正式 `runs` / `inbound` 表，不会混进正式统计。
- 解析会走当前 `.env` 的模型配置；未配置模型时自动回退规则。
- 真实客户数据必须脱敏并取得授权。
