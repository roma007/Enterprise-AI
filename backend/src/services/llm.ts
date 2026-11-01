/**
 * 可选的大模型接入（OpenAI 兼容 /chat/completions）。
 * 未配置 AI_BASE_URL + AI_API_KEY 时一律走本地规则草稿，不发起外部请求。
 */

export interface LlmConfig {
  configured: boolean;
  model: string;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function llmConfig(): LlmConfig {
  const base = (process.env.AI_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const key = (process.env.AI_API_KEY ?? '').trim();
  return {
    configured: Boolean(base && key),
    model: (process.env.AI_MODEL ?? 'gpt-4o-mini').trim() || 'gpt-4o-mini',
  };
}

async function complete(
  messages: ChatMessage[],
  timeoutMs: number,
): Promise<string | null> {
  const base = (process.env.AI_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const key = (process.env.AI_API_KEY ?? '').trim();
  if (!base || !key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: llmConfig().model,
        temperature: 0.2,
        messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const KIND_LABEL: Record<string, string> = {
  interview_summary: '访谈摘要',
  report_draft: '诊断报告草稿',
  solution_skeleton: '方案骨架',
  prd_skeleton: 'PRD 骨架',
  answer: '知识库问答',
};

export interface DraftEnhancement {
  content: string;
  model: string;
}

/**
 * 在规则草稿基础上让模型润色：
 * - 只允许使用给定上下文，不允许编造数字/客户承诺；
 * - 输出 Markdown，保留草稿结构；
 * - 调用失败自动回退规则草稿，并标记 fallback。
 */
export async function enhanceDraft(input: {
  kind: string;
  title: string;
  draft: string;
  prompt?: string;
  context: string;
}): Promise<DraftEnhancement> {
  const config = llmConfig();
  if (!config.configured) {
    return { content: input.draft, model: 'rule-based-v1' };
  }

  const system = [
    '你是企业 AI 咨询项目的中文写作助手。',
    '只能使用用户提供的项目数据、知识条目和草稿骨架，不得编造数字、客户承诺或来源。',
    '保留草稿的 Markdown 结构与标题；不确定的内容写“待确认”。',
    '开头保留“系统生成草稿，需人工确认；不替代顾问判断”的提示。',
  ].join('\n');

  const user = [
    `文档类型：${KIND_LABEL[input.kind] ?? input.kind}`,
    `标题：${input.title}`,
    input.prompt ? `用户问题：${input.prompt}` : '',
    '',
    '## 项目与知识库上下文',
    input.context.slice(0, 8000),
    '',
    '## 规则草稿骨架',
    input.draft.slice(0, 14000),
    '',
    '请在骨架上润色，输出完整 Markdown 正文。',
  ]
    .filter(Boolean)
    .join('\n');

  const content = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    Number(process.env.AI_TIMEOUT_MS ?? 25000),
  );

  if (!content) {
    return { content: input.draft, model: 'fallback-rule-based-v1' };
  }
  return { content, model: config.model };
}
