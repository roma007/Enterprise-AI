import { useState } from 'react';
import { api } from '../api';
import type { StoredUser } from '../auth';
import { Button, ErrorBox, Field, Input, Notice } from '../ui';

export function LoginPage({
  onLogin,
  onBack,
}: {
  onLogin: (token: string, user: StoredUser) => void;
  onBack?: () => void;
}) {
  const [email, setEmail] = useState('zhang@hengzhi.ai');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(email.trim(), password);
      onLogin(res.token, res.user);
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
            <small>诊断工作台</small>
          </div>
        </div>

        <h1>登录</h1>
        <p className="login-sub">用供应商侧账号进入内部工作台。</p>

        {error ? <ErrorBox error={error} /> : null}

        <form onSubmit={submit} className="login-form">
          <Field label="邮箱" required>
            <Input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="密码" required>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="演示密码：demo1234"
            />
          </Field>
          <Button variant="primary" type="submit" disabled={loading}>
            {loading ? '登录中…' : '登录'}
          </Button>
        </form>

        <Notice tone="blue">
          演示账号：<code>zhang@hengzhi.ai</code> / <code>demo1234</code>
        </Notice>

        {onBack && (
          <button type="button" className="link-btn" onClick={onBack}>
            ← 返回项目列表
          </button>
        )}
      </div>
    </div>
  );
}
