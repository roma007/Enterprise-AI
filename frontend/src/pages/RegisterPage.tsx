import { useState } from 'react';
import { api } from '../api';
import type { StoredUser } from '../auth';
import { Button, ErrorBox, Field, Input, Notice } from '../ui';

export function RegisterPage({
  onRegistered,
}: {
  onRegistered: (token: string, user: StoredUser) => void;
}) {
  const [form, setForm] = useState({
    org_name: '',
    org_slug: '',
    name: '',
    email: '',
    password: '',
    confirm: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError(new Error('两次输入的密码不一致'));
      return;
    }
    setLoading(true);
    try {
      const res = await api.register({
        org_name: form.org_name.trim(),
        org_slug: form.org_slug.trim() || undefined,
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      onRegistered(res.token, res.user);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">AI</span>
          <div>
            <strong>交付云</strong>
            <small>供应商诊断平台</small>
          </div>
        </div>

        <h1>注册供应商</h1>
        <p className="login-sub">每个供应商是独立租户，客户与项目数据互相隔离。</p>

        {error ? <ErrorBox error={error} /> : null}

        <form onSubmit={submit} className="login-form">
          <Field label="供应商/组织名称" required>
            <Input
              value={form.org_name}
              onChange={(e) => setForm({ ...form, org_name: e.target.value })}
              placeholder="如：某某 AI 咨询"
            />
          </Field>
          <Field label="组织标识" hint="3–32 位小写字母/数字/连字符；用于登录区分">
            <Input
              value={form.org_slug}
              onChange={(e) => setForm({ ...form, org_slug: e.target.value })}
              placeholder="如 acme-ai；留空自动生成"
            />
          </Field>
          <Field label="管理员姓名" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="登录邮箱" required>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="username"
            />
          </Field>
          <Field label="密码" required hint="至少 10 位，大小写/数字/符号至少 3 类">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认密码" required>
            <Input
              type="password"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Button variant="primary" type="submit" disabled={loading}>
            {loading ? '创建中…' : '创建供应商租户'}
          </Button>
        </form>

        <Notice tone="blue">
          注册后你将成为该租户的管理员，可在「用户管理」中继续添加同事。
        </Notice>
        <a className="link-btn" href="#/login">已有账号？去登录 →</a>
      </div>
    </div>
  );
}
