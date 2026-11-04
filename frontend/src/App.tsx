import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from './api';
import { clearAuth, getStoredUser, getToken, setAuth, setStoredUser, type StoredUser } from './auth';
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));
const BenchmarksPage = lazy(() =>
  import('./pages/BenchmarksPage').then((m) => ({ default: m.BenchmarksPage })),
);
const Dashboard = lazy(() =>
  import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const EngagementPage = lazy(() =>
  import('./pages/EngagementPage').then((m) => ({ default: m.EngagementPage })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const KnowledgePage = lazy(() =>
  import('./pages/KnowledgePage').then((m) => ({ default: m.KnowledgePage })),
);
const TrashPage = lazy(() =>
  import('./pages/TrashPage').then((m) => ({ default: m.TrashPage })),
);
const PublicSharePage = lazy(() =>
  import('./pages/PublicSharePage').then((m) => ({ default: m.PublicSharePage })),
);
const SessionsPage = lazy(() =>
  import('./pages/SessionsPage').then((m) => ({ default: m.SessionsPage })),
);
const UsersPage = lazy(() =>
  import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const RegisterPage = lazy(() =>
  import('./pages/RegisterPage').then((m) => ({ default: m.RegisterPage })),
);
const NotificationsPage = lazy(() =>
  import('./pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);
const CollabAuditPage = lazy(() =>
  import('./pages/CollabAuditPage').then((m) => ({
    default: m.CollabAuditPage,
  })),
);
const OrgPage = lazy(() =>
  import('./pages/OrgPage').then((m) => ({ default: m.OrgPage })),
);
const PlatformTenantsPage = lazy(() =>
  import('./pages/PlatformTenantsPage').then((m) => ({ default: m.PlatformTenantsPage })),
);
import { cn } from './utils';
import { Badge } from './ui';

type Route =
  | { page: 'dashboard' }
  | { page: 'engagement'; id: string }
  | { page: 'login' }
  | { page: 'benchmarks' }
  | { page: 'knowledge' }
  | { page: 'trash' }
  | { page: 'audit' }
  | { page: 'share'; token: string }
  | { page: 'sessions' }
  | { page: 'users' }
  | { page: 'register' }
  | { page: 'org' }
  | { page: 'tenants' }
  | { page: 'notifications' }
  | { page: 'collab-audits' };

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'engagements' && parts[1]) return { page: 'engagement', id: parts[1] };
  if (parts[0] === 'login') return { page: 'login' };
  if (parts[0] === 'benchmarks') return { page: 'benchmarks' };
  if (parts[0] === 'knowledge') return { page: 'knowledge' };
  if (parts[0] === 'trash') return { page: 'trash' };
  if (parts[0] === 'audit') return { page: 'audit' };
  if (parts[0] === 'share' && parts[1]) return { page: 'share', token: parts[1] };
  if (parts[0] === 'sessions') return { page: 'sessions' };
  if (parts[0] === 'users') return { page: 'users' };
  if (parts[0] === 'register') return { page: 'register' };
  if (parts[0] === 'org') return { page: 'org' };
  if (parts[0] === 'tenants') return { page: 'tenants' };
  if (parts[0] === 'notifications') return { page: 'notifications' };
  if (parts[0] === 'collab-audits') return { page: 'collab-audits' };
  return { page: 'dashboard' };
}

export function navigate(hash: string) {
  window.location.hash = hash;
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');
  const [user, setUser] = useState<StoredUser | null>(getStoredUser);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api
      .authConfig()
      .then((r) => setAuthRequired(r.required))
      .catch(() => setAuthRequired(false));
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((r) => {
        setUser(r.user);
        setStoredUser(r.user);
      })
      .catch(() => {
        clearAuth();
        setUser(null);
      });
  }, []);

  useEffect(() => {
    api
      .health()
      .then(() => setHealth('ok'))
      .catch(() => setHealth('down'));
  }, [route.page]);

  useEffect(() => {
    const refresh = () => {
      if (!user) {
        setUnread(0);
        return;
      }
      api
        .notificationsUnreadCount()
        .then((r) => setUnread(r.count))
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener('notifications-updated', refresh);
    return () => window.removeEventListener('notifications-updated', refresh);
  }, [user, route.page]);

  const canManage = !user || ['admin', 'director', 'pm'].includes(user.role);
  const canAdmin = !user || ['admin', 'director'].includes(user.role);

  const handleLogin = (token: string, nextUser: StoredUser) => {
    setAuth(token, nextUser);
    setUser(nextUser);
    navigate('#/');
  };

  const handleLogout = async () => {
    await api.logout().catch(() => undefined);
    clearAuth();
    setUser(null);
    if (!authRequired) navigate('#/');
  };

  // 客户只读分享页不需要登录，也不套工作台侧栏
  if (route.page === 'share') {
    return (
      <Suspense
        fallback={
          <div className="boot-screen">
            <span className="spinner-dot" />
            正在加载分享…
          </div>
        }
      >
        <PublicSharePage token={route.token} />
      </Suspense>
    );
  }

  if (route.page === 'register') {
    return (
      <Suspense
        fallback={
          <div className="boot-screen">
            <span className="spinner-dot" />
            正在加载…
          </div>
        }
      >
        <RegisterPage onRegistered={handleLogin} />
      </Suspense>
    );
  }

  if (authRequired === null) {
    return (
      <div className="boot-screen">
        <span className="spinner-dot" />
        正在连接…
      </div>
    );
  }

  if (authRequired && !user) {
    return <LoginPage onLogin={handleLogin} />;
  }

  if (route.page === 'login' && !user) {
    return <LoginPage onLogin={handleLogin} onBack={() => navigate('#/')} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brand-mark">AI</span>
          <span className="brand-text">
            <strong>交付云</strong>
            <small>诊断工作台</small>
          </span>
        </a>

        <nav className="nav">
          <a className={cn('nav-item', route.page === 'dashboard' && 'nav-active')} href="#/">
            <span className="nav-icon">▦</span>
            项目列表
          </a>
          {user ? (
            <a
              className={cn('nav-item', route.page === 'notifications' && 'nav-active')}
              href="#/notifications"
            >
              <span className="nav-icon">✉</span>
              通知
              {unread > 0 ? (
                <Badge tone="red">{unread > 99 ? '99+' : unread}</Badge>
              ) : null}
            </a>
          ) : null}
          {route.page === 'engagement' && (
            <a className="nav-item nav-active" href={`#/engagements/${route.id}`}>
              <span className="nav-icon">◈</span>
              当前项目
            </a>
          )}
          <a
            className={cn('nav-item', route.page === 'knowledge' && 'nav-active')}
            href="#/knowledge"
          >
            <span className="nav-icon">▤</span>
            知识库
          </a>
          <a
            className={cn('nav-item', route.page === 'benchmarks' && 'nav-active')}
            href="#/benchmarks"
          >
            <span className="nav-icon">◎</span>
            行业标杆
          </a>
          {canManage ? (
            <a
              className={cn('nav-item', route.page === 'trash' && 'nav-active')}
              href="#/trash"
            >
              <span className="nav-icon">⌫</span>
              回收站
            </a>
          ) : null}
          {canAdmin ? (
            <a
              className={cn(
                'nav-item',
                route.page === 'collab-audits' && 'nav-active',
              )}
              href="#/collab-audits"
            >
              <span className="nav-icon">✎</span>
              协作审计
            </a>
          ) : null}
          {canManage ? (
            <a
              className={cn('nav-item', route.page === 'audit' && 'nav-active')}
              href="#/audit"
            >
              <span className="nav-icon">≣</span>
              审计日志
            </a>
          ) : null}
          {user ? (
            <a
              className={cn('nav-item', route.page === 'sessions' && 'nav-active')}
              href="#/sessions"
            >
              <span className="nav-icon">⌁</span>
              登录会话
            </a>
          ) : null}
          {canAdmin ? (
            <a
              className={cn('nav-item', route.page === 'users' && 'nav-active')}
              href="#/users"
            >
              <span className="nav-icon">☷</span>
              用户管理
            </a>
          ) : null}
          {canAdmin ? (
            <a
              className={cn('nav-item', route.page === 'org' && 'nav-active')}
              href="#/org"
            >
              <span className="nav-icon">⌂</span>
              组织设置
            </a>
          ) : null}
          {user?.platform_admin ? (
            <a
              className={cn('nav-item', route.page === 'tenants' && 'nav-active')}
              href="#/tenants"
            >
              <span className="nav-icon">▥</span>
              平台租户
            </a>
          ) : null}
        </nav>

        {user ? (
          <div className="account-box">
            <div className="account-main">
              <strong>{user.name}</strong>
              <small>
                {user.org_name} · {user.role}
              </small>
            </div>
            <button className="link-btn" onClick={() => void handleLogout()}>
              退出
            </button>
          </div>
        ) : (
          <a className="nav-item" href="#/login">
            <span className="nav-icon">↪</span>
            登录
          </a>
        )}

        <div className="sidebar-foot">
          <span className={cn('dot', `dot-${health}`)} />
          <div>
            <strong>
              {health === 'ok' ? '后端已连接' : health === 'down' ? '后端未连接' : '正在连接'}
            </strong>
            <small>127.0.0.1:8788</small>
          </div>
        </div>
      </aside>

      <main className="main">
        <Suspense fallback={<div className="boot-screen"><span className="spinner-dot" />正在加载…</div>}>
        {route.page === 'engagement' ? (
          <EngagementPage
            key={route.id}
            id={route.id}
            onBack={() => navigate('#/')}
          />
        ) : route.page === 'knowledge' ? (
          <KnowledgePage />
        ) : route.page === 'benchmarks' ? (
          <BenchmarksPage />
        ) : route.page === 'trash' ? (
          <TrashPage />
        ) : route.page === 'audit' ? (
          <AuditPage />
        ) : route.page === 'sessions' ? (
          <SessionsPage />
        ) : route.page === 'users' ? (
          <UsersPage />
        ) : route.page === 'org' ? (
          <OrgPage />
        ) : route.page === 'tenants' ? (
          <PlatformTenantsPage />
        ) : route.page === 'notifications' ? (
          <NotificationsPage />
        ) : route.page === 'collab-audits' ? (
          <CollabAuditPage />
        ) : (
          <Dashboard onOpen={(id) => navigate(`#/engagements/${id}`)} />
        )}
        </Suspense>
      </main>
    </div>
  );
}
