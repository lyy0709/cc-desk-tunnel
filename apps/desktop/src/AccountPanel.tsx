import { useEffect, useState } from 'react';
import { UserRound, RefreshCw, ListOrdered } from 'lucide-react';
import type {
  AccountState,
  NativeCapabilities,
  NativeMetrics,
  UsageSummary,
} from '@cc-desk-tunnel/protocol';
import UsagePanel, { dollars, quotaName, tokens } from './UsagePanel.tsx';
import type { ProxyClient } from './client.ts';
import { IconButton, Page, Row, Switch } from './ui.tsx';
import { useQuota } from './quota.ts';
import { setPrefs, usePrefs } from './prefs.ts';
export default function AccountPanel({
  client,
  account: state,
  capabilities,
  metrics,
  refreshing,
  disabled,
  error,
  refresh,
  openTerminal,
  usageOnly = false,
  quotaUnavailable,
}: {
  client: ProxyClient;
  account: AccountState | null;
  capabilities: NativeCapabilities | null;
  metrics: NativeMetrics | null;
  refreshing: boolean;
  disabled: boolean;
  error: string | null;
  refresh: (sdkQuota: boolean) => void;
  openTerminal?: () => void;
  usageOnly?: boolean;
  quotaUnavailable?: string;
}) {
  const account = capabilities?.account;
  const { quotaReads } = usePrefs();
  const [profile, setProfile] = useState<'terminal' | 'sdk'>('terminal');
  const personal = profile === 'terminal';
  const identity = personal ? state?.terminal : state;
  const readKey = JSON.stringify([
    profile,
    identity?.loggedIn,
    identity?.email,
    identity?.organization,
  ]);
  const [reading, setReading] = useState<{ key: string; summary: UsageSummary } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [revision, refreshReading] = useState(0);
  const summary = reading?.key === readKey ? reading.summary : null;
  const limits = useQuota(
    personal
      ? summary && { available: true, windows: summary.windows, measuredAt: summary.measuredAt }
      : metrics?.rateLimits,
  );
  const runningTerminal = client.state.sessions.some(
    (session) => session.activeRun?.surface === 'terminal',
  );
  const sdkMeasured = personal ? undefined : metrics?.rateLimits?.measuredAt;
  const [log, setLog] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await client.fetch({
          type: 'usage.summary',
          ...(personal && { profile: 'terminal' as const }),
        });
        if (current) {
          setReading({ key: readKey, summary: result });
          setReadError(null);
        }
      } catch (cause) {
        if (current) {
          setReading(null);
          setReadError(cause instanceof Error ? cause.message : '读取额度失败。');
        }
      } finally {
        pending = false;
      }
    };
    void read();
    const timer =
      personal && quotaReads && runningTerminal
        ? window.setInterval(() => void read(), 60000)
        : undefined;
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [client, personal, readKey, quotaReads, runningTerminal, sdkMeasured, revision, log]);
  if (log && !usageOnly)
    return (
      <UsagePanel
        client={client}
        summary={summary}
        profile={profile}
        initial={log}
        back={() => setLog(null)}
      />
    );
  return (
    <Page
      title={usageOnly ? '订阅用量' : '账号与额度'}
      label={usageOnly ? '订阅用量' : '账号信息'}
      intro={!usageOnly && '服务器为此应用配置的模型服务与用量。'}
      actions={
        <IconButton
          title={usageOnly ? '刷新订阅用量' : '刷新账号信息'}
          className={usageOnly ? 'quota-page-refresh' : undefined}
          disabled={disabled}
          onClick={() => {
            refreshReading((n) => n + 1);
            refresh(!personal);
          }}
        >
          <RefreshCw className={refreshing ? 'spinning' : ''} />
        </IconButton>
      }
    >
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!usageOnly && (
        <div className="card account-card">
          <div className="account-identity">
            <div className="account-avatar">
              <UserRound />
            </div>
            <div>
              <h2>
                {state
                  ? state.loggedIn
                    ? 'GUI 模型服务已登录'
                    : 'GUI 模型服务尚未登录'
                  : 'GUI 认证状态未读取'}
              </h2>
              <p>在服务器配置自己的 Console API key 或受支持的云提供方。</p>
            </div>
          </div>
          <Row title="认证来源">
            <span className="setting-value">{state?.authMethod ?? '未读取'}</span>
          </Row>
          <Row
            title="ccdt 原生终端"
            detail={
              state?.terminal?.loggedIn
                ? (state.terminal.email ?? state.terminal.authMethod ?? '已登录')
                : state?.terminal
                  ? '尚未登录。按原生终端提示在浏览器授权，若出现回调码，粘贴到同一终端。'
                  : '可在 ccdt 原生终端查看账号。'
            }
          >
            {openTerminal && (
              <button type="button" className="button secondary" onClick={openTerminal}>
                {state?.terminal?.loggedIn ? '重新登录（ccdt）' : '普通登录（ccdt）'}
              </button>
            )}
          </Row>
          <Row title="模型服务">
            <span className="setting-value">
              {account?.apiProvider === 'firstParty'
                ? 'Anthropic'
                : (account?.apiProvider ?? '未读取')}
            </span>
          </Row>
        </div>
      )}
      {!usageOnly && (
        <div className="page-heading account-section-title">
          <h2>{personal ? '订阅用量' : '模型服务用量'}</h2>
          <button type="button" className="button secondary" onClick={() => setLog('today')}>
            <ListOrdered />
            调用日志
          </button>
        </div>
      )}
      <div className={`card account-card${usageOnly ? ' quota-card' : ''}`}>
        <div className="segmented" role="group" aria-label="额度来源">
          <button type="button" aria-pressed={personal} onClick={() => setProfile('terminal')}>
            个人订阅
          </button>
          <button type="button" aria-pressed={!personal} onClick={() => setProfile('sdk')}>
            模型服务
          </button>
        </div>
        {limits ? (
          <div className="quota-list">
            {limits.windows.map((window, index) => (
              <div className="quota-row" key={`${window.name}:${index}`}>
                <div>
                  <strong>{quotaName(window.name) ?? window.name}</strong>
                  <span>
                    {window.utilization == null
                      ? '使用量未提供'
                      : `${window.utilization}% 已用 · ${Math.max(0, 100 - window.utilization)}% 剩余`}
                  </span>
                </div>
                {window.utilization != null && (
                  <progress max={100} value={Math.min(100, window.utilization)} />
                )}
                <small>
                  {window.resetsAt
                    ? `重置：${new Date(window.resetsAt).toLocaleString('zh-CN')}`
                    : '重置时间未提供'}
                </small>
                {(() => {
                  const period = summary?.windows.find((item) => item.name === window.name);
                  if (!period) return null;
                  const text = (
                    <>
                      本周期 {period.requests.toLocaleString('zh-CN')} 次请求 ·{' '}
                      {tokens(
                        period.inputTokens +
                          period.outputTokens +
                          period.cacheReadTokens +
                          period.cacheCreationTokens,
                      )}{' '}
                      tokens · 等价 {dollars(period.costUsd)}
                    </>
                  );
                  return usageOnly ? (
                    <span className="quota-period">{text}</span>
                  ) : (
                    <button
                      type="button"
                      className="quota-period"
                      title="查看本周期的调用日志"
                      onClick={() => setLog(window.name)}
                    >
                      {text}
                    </button>
                  );
                })()}
              </div>
            ))}
            <p className="account-updated">
              {limits.measuredAt &&
                `更新于 ${new Date(limits.measuredAt).toLocaleTimeString('zh-CN')}`}
            </p>
          </div>
        ) : (
          <p className="muted">
            {readError ??
              (personal ? '暂无可归属到当前订阅的终端读数。' : metrics?.errors?.usage) ??
              quotaUnavailable ??
              (usageOnly
                ? metrics?.rateLimits
                  ? '当前账号未提供模型服务额度'
                  : '等待读取原生额度'
                : '尚无额度数据')}
          </p>
        )}
        {personal && (
          <a
            href="https://claude.ai/settings/usage"
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (window.desktop) {
                event.preventDefault();
                void window.desktop.openExternal('https://claude.ai/settings/usage');
              }
            }}
          >
            完整订阅用量（含按模型额度）
          </a>
        )}
        <Row
          title="运行中每分钟读取一次额度"
          detail={
            personal
              ? '此页打开且原版终端运行时，每分钟更新它已报告的五小时和每周额度。手动刷新也会读取最新报告。'
              : 'SDK 运行时每分钟最多读取一次模型服务额度。手动刷新会重新读取。'
          }
        >
          <Switch
            label="运行中每分钟读取一次额度"
            checked={quotaReads}
            onChange={(value) => setPrefs((prefs) => ({ ...prefs, quotaReads: value }))}
          />
        </Row>
      </div>
      <h2 className="page-heading">当前会话</h2>
      <div className="card">
        <Row title="输入 / 输出">
          <span className="setting-value">
            {metrics?.usage
              ? `${metrics.usage.inputTokens.toLocaleString()} / ${metrics.usage.outputTokens.toLocaleString()} tokens`
              : '等待读取'}
          </span>
        </Row>
        <Row
          title="缓存读取 / 写入"
          detail={
            metrics?.usage?.cacheWrite1hTokens !== undefined &&
            `写入中 1 小时缓存 ${metrics.usage.cacheWrite1hTokens.toLocaleString()}、5 分钟缓存 ${(metrics.usage.cacheWrite5mTokens ?? 0).toLocaleString()} tokens；1 小时缓存的写入单价是 5 分钟的 1.6 倍`
          }
        >
          <span className="setting-value">
            {metrics?.usage
              ? `${metrics.usage.cacheReadTokens.toLocaleString()} / ${metrics.usage.cacheWriteTokens.toLocaleString()} tokens`
              : '等待读取'}
          </span>
        </Row>
        <Row title="原生费用估算">
          <span className="setting-value">
            {metrics?.usage?.costUsd != null
              ? `${metrics.usage.costUsd.toFixed(4)}（非订阅账单）`
              : '未提供'}
          </span>
        </Row>
      </div>
    </Page>
  );
}
