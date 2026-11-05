# 企业微信绑定清单

> 目标：把企业微信自建应用接到 `ai-copilot`，员工把托书**文字**发给应用后自动解析并回复。
> 边界：当前只自动处理文字消息；图片消息还未接入，图片请走 H5 或批量导入。

## 0. 需要准备

- 企业微信管理员账号（扫码登录管理后台）
- 一个公网 HTTPS 回调地址（本机可用 Cloudflare Tunnel 临时生成）
- 自建应用的 `Token`、`EncodingAESKey`
- 企业 `CorpID`

## 1. 启动回调代理和公网隧道

本机只暴露回调路径，不把整个系统暴露到公网：

```bash
cd ai-copilot
node scripts/wecom_callback_proxy.mjs
```

另开一个终端：

```bash
cloudflared tunnel --url http://127.0.0.1:8791 --no-autoupdate
```

记下输出里的 `https://xxxx.trycloudflare.com` 地址。

## 2. 企业微信后台配置

1. 打开 `https://work.weixin.qq.com/wework_admin/frame`，扫码登录。
2. 应用管理 → 自建 → 创建应用（例如「托书录入助手」）。
3. 进入应用 → 接收消息 → 设置 API 接收：
   - URL：`https://xxxx.trycloudflare.com/api/wecom/callback`
   - Token：点随机获取，复制
   - EncodingAESKey：点随机获取，复制
4. 保存。
5. 在「我的企业」复制 CorpID。

## 3. 写入本地配置

编辑 `ai-copilot/.env`：

```env
WECOM_TOKEN=后台生成的 Token
WECOM_CORPID=企业 CorpID
WECOM_ENCODING_AES_KEY=后台生成的 43 位 Key
```

> Token / Key / CorpID 不要发到聊天里，直接写本地 `.env`。

## 4. 重启 ai-copilot

```bash
# 停掉旧进程后
cd ai-copilot
PYTHONPATH=. .venv/bin/python -m uvicorn app.main:app --port 8790 --host 127.0.0.1
```

## 5. 验证

1. 在企业微信里找到这个自建应用。
2. 发送一条托书文字，例如：

```text
客户：宏远国际货代
委托单号：HY2026110501
箱型：40HQ
箱量：1
箱号：CSQU3054383
提箱地：北仑港区二期堆场
卸货地：宁波北仑春晓工业园3号仓
截港时间：2026-11-07 18:00
```

3. 应用应回复结构化字段和置信度。
4. 在 `ai-copilot` 的「历史」里能看到这条解析记录。

## 5.1 分多条发送

托书不是一条消息发完时：

1. 先发 `分条`
2. 逐条发送内容
3. 最后发 `完成`
4. 系统合并后返回结构化字段
5. 回复 `确认` 入库；回复 `取消` 清空

如果直接发了一条不完整的信息，系统会先记草稿并提示继续补充。

## 6. 注意

- 普通自建应用只能收到**发给应用**的消息，不能读取员工与客户的已有聊天记录。
- 要读已有聊天，需要企业微信「会话内容存档」，涉及许可、授权、RSA 密钥和合规确认，当前未接入。
- 图片消息需要额外接 `media_id` 下载；当前图片请走 H5 或批量导入。
- Cloudflare 临时隧道地址每次重启会变，正式使用需要固定域名。
