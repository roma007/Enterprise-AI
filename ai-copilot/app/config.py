"""最小配置加载：支持 .env，不引入额外依赖。"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

VERSION = "0.27.0"
ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)


_load_dotenv(ROOT / ".env")
_load_dotenv(ROOT / ".env.example")


def _json_env(name: str) -> dict:
    raw = os.getenv(name, "").strip()
    if not raw:
        return {}
    try:
        val = json.loads(raw)
        return val if isinstance(val, dict) else {}
    except json.JSONDecodeError:
        return {}


class Settings:
    provider: str = os.getenv("LLM_PROVIDER", "auto").lower()
    base_url: str = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    api_key: str = os.getenv("LLM_API_KEY", "")
    model: str = os.getenv("LLM_MODEL", "gpt-4o-mini")
    timeout: float = float(os.getenv("LLM_TIMEOUT", "90"))
    max_tokens: int = int(os.getenv("LLM_MAX_TOKENS", "2000"))
    # auto：规则已经填满且都够自信时不调模型（演示要快、成本要低）
    # always：每条都调   off：合并模式下不调
    llm_strategy: str = os.getenv("LLM_STRATEGY", "auto").strip().lower()
    llm_conf_floor: float = float(os.getenv("LLM_BELOW_CONF", "0.6"))

    # 部分网关（如 OpenCode 推理网关）会校验 User-Agent / 要求会话头
    user_agent: str = os.getenv("LLM_USER_AGENT", "ai-copilot/1.0")
    session_header: str = os.getenv("LLM_SESSION_HEADER", "").strip()
    extra_headers: dict = _json_env("LLM_EXTRA_HEADERS")

    db_path: Path = ROOT / os.getenv("DB_PATH", "data/copilot.db")
    org_name: str = os.getenv("ORG_NAME", "").strip()

    # 价值口径：人工单票基线秒数、人工小时成本（元）
    baseline_manual_sec: float = float(os.getenv("BASELINE_MANUAL_SEC", "180"))
    hourly_cost: float = float(os.getenv("HOURLY_COST", "45"))

    # HTTPS 部署（D5）：反代终结 TLS 时，Cookie 必须带 Secure
    cookie_secure: bool = os.getenv("COOKIE_SECURE", "0").strip() not in {"0", "false", "off"}

    # 登录失败锁定（D3）：同一 邮箱+IP 在窗口内失败 N 次 → 锁 M 秒
    login_max_failures: int = int(os.getenv("LOGIN_MAX_FAILURES", "5"))
    login_lock_seconds: int = int(os.getenv("LOGIN_LOCK_SECONDS", "900"))
    login_window_seconds: int = int(os.getenv("LOGIN_WINDOW_SECONDS", "900"))

    # 企业微信入口（D3）：留空则跳过签名校验，便于本地调试
    wecom_token: str = os.getenv("WECOM_TOKEN", "").strip()
    wecom_corpid: str = os.getenv("WECOM_CORPID", "").strip()
    wecom_aes_key: str = os.getenv("WECOM_ENCODING_AES_KEY", "").strip()
    # 图片消息：下载临时素材 + 主动推送结果需要 Secret / AgentID
    wecom_secret: str = os.getenv("WECOM_SECRET", "").strip()
    wecom_agentid: str = os.getenv("WECOM_AGENTID", "").strip()
    wecom_api_base: str = os.getenv(
        "WECOM_API_BASE", "https://qyapi.weixin.qq.com"
    ).rstrip("/")
    wecom_image_max_mb: int = int(os.getenv("WECOM_IMAGE_MAX_MB", "10"))

    # 图像增强（D2）：多版本 OCR。关掉可省时间，但糊图识别率会明显下降
    ocr_enhance: bool = os.getenv("OCR_ENHANCE", "1").strip() not in {"0", "false", "off"}

    # 邮件告警（部署级）：SMTP 主机/账号放 .env；收件人放运行级配置
    smtp_host: str = os.getenv("SMTP_HOST", "").strip()
    smtp_port: int = int(os.getenv("SMTP_PORT", "587"))
    smtp_user: str = os.getenv("SMTP_USER", "").strip()
    smtp_password: str = os.getenv("SMTP_PASSWORD", "").strip()
    smtp_from: str = os.getenv("SMTP_FROM", "").strip()
    smtp_tls: bool = os.getenv("SMTP_TLS", "0").strip() not in {"0", "false", "off"}
    smtp_starttls: bool = os.getenv("SMTP_STARTTLS", "1").strip() not in {"0", "false", "off"}
    smtp_timeout: float = float(os.getenv("SMTP_TIMEOUT", "10"))

    # 模型资源（灰犀牛）：余额/额度/有效期由人工或供应商接口更新，见 app/llm_usage.py
    llm_quota_tokens: int = int(os.getenv("LLM_QUOTA_TOKENS", "0") or 0)
    llm_balance_cny: float = float(os.getenv("LLM_BALANCE_CNY", "0") or 0)
    llm_balance_asof: str = os.getenv("LLM_BALANCE_ASOF", "").strip()
    llm_price_per_1k: float = float(os.getenv("LLM_PRICE_PER_1K", "0") or 0)
    llm_key_expires_at: str = os.getenv("LLM_KEY_EXPIRES_AT", "").strip()
    llm_model_retires_at: str = os.getenv("LLM_MODEL_RETIRES_AT", "").strip()

    # 进程内固定，重启才变；用于网关侧的会话粘性与计费归集
    session_id: str = os.getenv("LLM_SESSION_ID", "").strip() or ("ses_" + uuid.uuid4().hex[:24])

    @property
    def llm_enabled(self) -> bool:
        if self.provider in {"rule", "rule-based", "off", "none"}:
            return False
        return bool(self.api_key)


settings = Settings()
settings.db_path.parent.mkdir(parents=True, exist_ok=True)
