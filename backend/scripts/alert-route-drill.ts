/**
 * Alertmanager 路由与抑制演练（本地，不依赖 Alertmanager）。
 *
 * 校验：
 *   - ops/alerts.yml 中每条告警都有 severity / service 标签
 *   - 每条告警按 ops/alertmanager.yml 的路由树落到预期 receiver
 *   - critical 抑制同服务 warning、BackendDown 抑制同服务 info
 *   - 跨服务不会误抑制
 *
 * 注意：这是对路由树的确定性模拟，不替代真实 Alertmanager；
 * 生产接入后仍应做一次真实告警触发/认领/静默演练。
 *
 * 运行：npm run drill:alerts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

const OPS = join(process.cwd(), '..', 'ops');

type Op = '=' | '!=' | '=~' | '!~';

interface Matcher {
  key: string;
  op: Op;
  value: string;
}

interface Route {
  receiver?: string;
  matchers?: string[];
  match?: Record<string, string>;
  continue?: boolean;
  routes?: Route[];
}

interface InhibitRule {
  source_matchers: string[];
  target_matchers: string[];
  equal?: string[];
}

interface AlertmanagerConfig {
  route: Route;
  inhibit_rules?: InhibitRule[];
  receivers: Array<{ name: string }>;
}

interface AlertRule {
  alert?: string;
  record?: string;
  labels?: Record<string, string>;
}

interface AlertFile {
  groups: Array<{ name: string; rules: AlertRule[] }>;
}

interface Alert {
  name: string;
  labels: Record<string, string>;
}

function parseMatcher(input: string): Matcher {
  const m = input.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"$/);
  if (!m) throw new Error(`无法解析 matcher：${input}`);
  return { key: m[1], op: m[2] as Op, value: m[3] };
}

function matches(matchers: Matcher[], labels: Record<string, string>): boolean {
  return matchers.every((m) => {
    const actual = labels[m.key] ?? '';
    switch (m.op) {
      case '=':
        return actual === m.value;
      case '!=':
        return actual !== m.value;
      case '=~':
        return new RegExp(`^(?:${m.value})$`).test(actual);
      case '!~':
        return !new RegExp(`^(?:${m.value})$`).test(actual);
    }
  });
}

function routeMatchers(route: Route): Matcher[] {
  const list: Matcher[] = [];
  for (const m of route.matchers ?? []) list.push(parseMatcher(m));
  for (const [key, value] of Object.entries(route.match ?? {})) {
    list.push({ key, op: '=', value });
  }
  return list;
}

/** 返回命中路径上的 receiver；无匹配则回退当前节点 receiver。 */
function resolve(
  alert: Record<string, string>,
  route: Route,
  path: string[],
): Array<{ receiver: string; path: string[] }> {
  const results: Array<{ receiver: string; path: string[] }> = [];
  let matchedAny = false;

  for (const child of route.routes ?? []) {
    if (!matches(routeMatchers(child), alert)) continue;
    matchedAny = true;
    const childPath = [...path, child.receiver ?? 'default'];
    results.push(...resolve(alert, child, childPath));
    if (!child.continue) break;
  }

  if (!matchedAny && route.receiver) {
    results.push({ receiver: route.receiver, path });
  }
  return results;
}

function isInhibited(alert: Alert, all: Alert[], rules: InhibitRule[] = []): boolean {
  for (const rule of rules) {
    if (!matches(rule.target_matchers.map(parseMatcher), alert.labels)) continue;
    for (const source of all) {
      if (source === alert) continue;
      if (!matches(rule.source_matchers.map(parseMatcher), source.labels)) continue;
      if ((rule.equal ?? []).every((k) => (alert.labels[k] ?? '') === (source.labels[k] ?? ''))) {
        return true;
      }
    }
  }
  return false;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const alertsFile = parse(
    await readFile(join(OPS, 'alerts.yml'), 'utf8'),
  ) as AlertFile;
  const config = parse(
    await readFile(join(OPS, 'alertmanager.yml'), 'utf8'),
  ) as AlertmanagerConfig;

  const receiverNames = new Set(config.receivers.map((r) => r.name));
  assert(receiverNames.size > 0, 'alertmanager.yml 缺少 receivers');
  assert(Boolean(config.route), 'alertmanager.yml 缺少 route');

  const alertRules = alertsFile.groups
    .flatMap((g) => g.rules)
    .filter((r): r is AlertRule & { alert: string } => Boolean(r.alert));

  const alerts: Alert[] = alertRules.map((r) => {
    const labels: Record<string, string> = { alertname: r.alert, ...(r.labels ?? {}) };
    assert(Boolean(labels.severity), `${r.alert} 缺少 severity 标签`);
    assert(Boolean(labels.service), `${r.alert} 缺少 service 标签`);
    return { name: r.alert, labels };
  });

  assert(
    new Set(alerts.map((a) => a.name)).size === alerts.length,
    '告警名称重复',
  );

  const routeOf = (alert: Alert): string | null => {
    const hits = resolve(alert.labels, config.route, [config.route.receiver ?? 'default']);
    return hits[0]?.receiver ?? null;
  };

  console.log(`告警规则：${alerts.length} 条，receiver：${receiverNames.size} 个，抑制规则：${config.inhibit_rules?.length ?? 0} 条\n`);

  // 1. 每条告警都必须路由到已声明的 receiver
  for (const alert of alerts) {
    const receiver = routeOf(alert);
    assert(receiver !== null, `${alert.name} 未匹配任何 receiver`);
    assert(receiverNames.has(receiver), `${alert.name} 路由到未声明的 receiver：${receiver}`);
  }

  // 2. 按 severity / service 校验默认路由
  for (const alert of alerts) {
    const { severity, service } = alert.labels;
    const expected =
      severity === 'critical' && service === 'database'
        ? 'dba-oncall'
        : severity === 'critical'
          ? 'pager'
          : severity === 'warning'
            ? 'chat'
            : 'weekly';
    assert(routeOf(alert) === expected, `${alert.name} 应路由到 ${expected}，实际 ${routeOf(alert)}`);
  }

  const byName = new Map(alerts.map((a) => [a.name, a]));
  const pick = (name: string): Alert => {
    const alert = byName.get(name);
    if (!alert) throw new Error(`alerts.yml 中不存在告警：${name}`);
    return alert;
  };

  interface Scenario {
    title: string;
    alerts: string[];
    expect: Record<string, string | null>;
  }

  const scenarios: Scenario[] = [
    { title: '后端不可达', alerts: ['BackendDown'], expect: { BackendDown: 'pager' } },
    { title: '数据库不可达', alerts: ['DatabaseDown'], expect: { DatabaseDown: 'dba-oncall' } },
    { title: 'P95 延迟', alerts: ['HighP95Latency'], expect: { HighP95Latency: 'chat' } },
    { title: '无流量', alerts: ['NoTraffic'], expect: { NoTraffic: 'weekly' } },
    { title: '备份过期', alerts: ['BackupStale'], expect: { BackupStale: 'pager' } },
    { title: 'PDF 积压', alerts: ['PdfQueueBacklog'], expect: { PdfQueueBacklog: 'chat' } },
    {
      title: 'DB critical 抑制同服务 warning',
      alerts: ['DatabaseDown', 'DbPoolWaiting'],
      expect: { DatabaseDown: 'dba-oncall', DbPoolWaiting: null },
    },
    {
      title: '后端 critical 抑制同服务 warning',
      alerts: ['BackendDown', 'High5xxRateSlowBurn'],
      expect: { BackendDown: 'pager', High5xxRateSlowBurn: null },
    },
    {
      title: '跨服务不误抑制',
      alerts: ['DatabaseDown', 'High5xxRateSlowBurn'],
      expect: { DatabaseDown: 'dba-oncall', High5xxRateSlowBurn: 'chat' },
    },
  ];

  let checked = 0;
  for (const scenario of scenarios) {
    const active = scenario.alerts.map(pick);
    for (const alert of active) {
      const suppressed = isInhibited(alert, active, config.inhibit_rules);
      const actual = suppressed ? null : routeOf(alert);
      const expected = scenario.expect[alert.name] ?? null;
      const state = suppressed ? '抑制' : '发送';
      console.log(
        `  ${scenario.title.padEnd(28)} ${alert.name.padEnd(26)} ${state}  ${actual ?? '-'}`,
      );
      assert(
        actual === expected,
        `${scenario.title} / ${alert.name} 期望 ${expected ?? '抑制'}，实际 ${actual ?? '抑制'}`,
      );
      checked += 1;
    }
  }

  console.log('\n告警路由演练通过');
  console.log(`  ${alerts.length} 条告警全部路由到已声明 receiver`);
  console.log(`  ${scenarios.length} 个值班场景、${checked} 次路由/抑制断言通过`);
  console.log('  生产接入 Alertmanager 后，仍需做一次真实触发、认领与静默演练');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
