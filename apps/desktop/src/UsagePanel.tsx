import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { UsagePage, UsageSummary } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton } from './ui.tsx';
import { ModelBreakdown, TokenTrend, cacheHitRate, percent, usageBars } from './UsageCharts.tsx';

const pageSize = 50;
const quotaNames: Record<string, string | undefined> = {
  five_hour: '5 小时额度',
  seven_day: '每周额度',
  seven_day_opus: 'Opus 每周额度',
  seven_day_sonnet: 'Sonnet 每周额度',
  seven_day_oauth_apps: '应用每周额度',
  // Read from a long-lived token's replies, which do not name the models it counts.
  seven_day_overage_included: '按模型计的每周额度',
};
// The service names a per-model weekly window `seven_day:<model>`, as the account's plan reports it.
export const quotaName = (name: string) =>
  quotaNames[name] ?? (name.startsWith('seven_day:') ? `${name.slice(10)} 每周额度` : undefined);
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
export const tokens = (value: number) =>
  value < 10000 ? value.toLocaleString('zh-CN') : compact.format(value);
export const dollars = (value: number) =>
  `$${value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(value >= 0.01 || value === 0 ? 2 : 4)}`;
export const seconds = (ms: number | null) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const total = (item: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}) => item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheCreationTokens;
const hour = 3600_000;
const presets = [
  ['today', '代理今日'],
  ['24h', '24 小时'],
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['custom', '自定义'],
] as const;
const measures = { costUsd: '等价费用', tokens: 'Token', requests: '请求数' } as const;
type Measure = keyof typeof measures;
function serverInput(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

export default function UsagePanel({
  client,
  summary,
  initial,
  back,
}: {
  client: ProxyClient;
  summary: UsageSummary | null;
  initial: string;
  back: () => void;
}) {
  const [preset, setPreset] = useState(initial);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [model, setModel] = useState('');
  const [measure, setMeasure] = useState<Measure>('costUsd');
  const [page, setPage] = useState<UsagePage | null>(null);
  const [paging, setPaging] = useState<{ index: number; range?: { from: string; to: string } }>({
    index: 0,
  });
  const { index } = paging;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const quotaStart = summary?.windows.find((item) => item.name === preset)?.startedAt;
  const range = useMemo(() => {
    if (preset === 'today' || preset === '24h' || preset === '7d' || preset === '30d')
      return preset;
    if (preset === 'custom')
      return customFrom && customTo ? { serverFrom: customFrom, serverTo: customTo } : null;
    return quotaStart ? { from: quotaStart } : null;
  }, [preset, customFrom, customTo, quotaStart]);
  useEffect(() => {
    const requested = paging.range ?? range;
    setError(null);
    if (!requested) {
      setPage(null);
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    void client
      .fetch({
        type: 'usage.query',
        ...(quotaStart && { accountPeriod: true as const }),
        range: requested,
        ...(model && { model }),
        offset: paging.index * pageSize,
        limit: pageSize,
      })
      .then(
        (result) => {
          if (current) setPage(result);
        },
        (cause) => {
          if (current) {
            setPage(null);
            setError(cause instanceof Error ? cause.message : '读取失败。');
          }
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, model, range, paging, quotaStart]);
  const turnPage = (index: number) => {
    if (page) setPaging({ index, range: { from: page.from, to: page.to } });
  };
  const span = page ? Date.parse(page.to) - Date.parse(page.from) : 0;
  const bucketMinutes = span <= 6 * hour ? 30 : span <= 48 * hour ? 60 : 1440;
  const bars = useMemo(() => (page ? usageBars(page, bucketMinutes) : []), [page, bucketMinutes]);
  const peak = Math.max(...bars.map((bar) => bar[measure]), 0);
  const format = (value: number) =>
    measure === 'costUsd'
      ? dollars(value)
      : measure === 'tokens'
        ? tokens(value)
        : value.toLocaleString('zh-CN');
  const bucketLabel = (at: string) =>
    new Date(at).toLocaleString(
      'zh-CN',
      bucketMinutes >= 1440
        ? { month: 'numeric', day: 'numeric' }
        : {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'shortOffset',
          },
    );
  const totals = page?.totals;
  const pages = Math.max(Math.ceil((totals?.requests ?? 0) / pageSize), 1);
  return (
    <section className="account-page" aria-label="调用日志">
      <header className="account-heading">
        <IconButton title="返回账号" onClick={back}>
          <ArrowLeft />
        </IconButton>
        <h1>调用日志</h1>
        <IconButton title="刷新调用日志" disabled={loading} onClick={() => setPaging({ index: 0 })}>
          <RefreshCw className={loading ? 'spinning' : ''} />
        </IconButton>
      </header>
      <div className="account-body usage-body">
        <div className="usage-filters">
          <div className="segmented" role="group" aria-label="时间范围">
            {[
              ...(summary?.windows
                .filter((window) => quotaName(window.name))
                .map((window) => [window.name, `本期${quotaName(window.name)}`] as const) ?? []),
              ...presets,
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={preset === value}
                disabled={value === 'custom' && !page && !customTo}
                onClick={() => {
                  if (value === 'custom' && !customTo && page) {
                    const end = Date.parse(page.to);
                    setCustomFrom(serverInput(end - 24 * hour, page.timeZone));
                    setCustomTo(serverInput(end, page.timeZone));
                  }
                  setPreset(value);
                  setPaging({ index: 0 });
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            aria-label="模型"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              setPaging({ index: 0 });
            }}
          >
            <option value="">全部模型</option>
            {[...new Set([...(page?.models ?? []), ...(model ? [model] : [])])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {preset === 'custom' && (
            <div className="usage-custom">
              <input
                type="datetime-local"
                aria-label="开始时间"
                value={customFrom}
                max={customTo}
                onChange={(event) => {
                  setCustomFrom(event.target.value);
                  setPaging({ index: 0 });
                }}
              />
              <span>至</span>
              <input
                type="datetime-local"
                aria-label="结束时间"
                value={customTo}
                min={customFrom}
                onChange={(event) => {
                  setCustomTo(event.target.value);
                  setPaging({ index: 0 });
                }}
              />
            </div>
          )}
        </div>
        {page && (
          <p className="muted">
            今日和自定义范围使用代理时区 {page.timeZone}，图表和记录按本机时间显示。
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="usage-tiles">
          <div>
            <span>请求数</span>
            <strong>{totals ? totals.requests.toLocaleString('zh-CN') : '—'}</strong>
          </div>
          <div
            title={
              totals
                ? `输入 ${totals.inputTokens.toLocaleString()} · 输出 ${totals.outputTokens.toLocaleString()} · 缓存读取 ${totals.cacheReadTokens.toLocaleString()} · 缓存写入 ${totals.cacheCreationTokens.toLocaleString()}`
                : undefined
            }
          >
            <span>总 Token</span>
            <strong>{totals ? tokens(total(totals)) : '—'}</strong>
            <small>
              {totals
                ? `输入 ${tokens(totals.inputTokens)} · 输出 ${tokens(totals.outputTokens)} · 缓存 ${tokens(totals.cacheReadTokens + totals.cacheCreationTokens)}`
                : ''}
            </small>
          </div>
          <div title="缓存读取 ÷（输入 + 缓存读取 + 缓存写入）">
            <span>缓存命中率</span>
            <strong>{percent(totals ? cacheHitRate(totals) : null)}</strong>
            <small>{totals ? `读取 ${tokens(totals.cacheReadTokens)}` : ''}</small>
          </div>
          <div>
            <span>等价 API 费用</span>
            <strong>{totals ? dollars(totals.costUsd) : '—'}</strong>
            <small>官方 CLI 按 API 价格估算，非订阅账单</small>
          </div>
          <div>
            <span>平均首字延迟</span>
            <strong>{seconds(totals?.ttftMs ?? null)}</strong>
          </div>
          <div>
            <span>平均输出速度</span>
            <strong>
              {totals?.outputPerSecond != null ? `${totals.outputPerSecond.toFixed(1)} tok/s` : '—'}
            </strong>
          </div>
        </div>
        <figure className="usage-chart">
          <figcaption>
            <span>
              {bucketMinutes >= 1440 ? '每日' : bucketMinutes === 60 ? '每小时' : '每 30 分钟'}
              {measures[measure]}
            </span>
            <div className="segmented" role="group" aria-label="图表指标">
              {(Object.keys(measures) as Measure[]).map((key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={measure === key}
                  onClick={() => setMeasure(key)}
                >
                  {measures[key]}
                </button>
              ))}
            </div>
          </figcaption>
          <div className="usage-plot" onMouseLeave={() => setHover(null)}>
            <span className="usage-peak">{peak ? format(peak) : ''}</span>
            <div className="usage-bars">
              {bars.map((bar, index) => (
                <div
                  key={bar.at}
                  className={hover === index ? 'hovered' : ''}
                  onMouseEnter={() => setHover(index)}
                >
                  <i
                    style={{
                      height:
                        peak && bar[measure] ? `max(2px, ${(bar[measure] / peak) * 100}%)` : 0,
                    }}
                  />
                </div>
              ))}
            </div>
            {hover !== null && bars[hover] && (
              <div
                className="usage-tip"
                role="tooltip"
                style={
                  hover < bars.length / 2
                    ? { left: `${(hover / bars.length) * 100}%` }
                    : { right: `${(1 - (hover + 1) / bars.length) * 100}%` }
                }
              >
                <strong>{bucketLabel(bars[hover].at)}</strong>
                <span>{bars[hover].requests.toLocaleString('zh-CN')} 次请求</span>
                <span>{tokens(bars[hover].tokens)} tokens</span>
                <span>{dollars(bars[hover].costUsd)}</span>
              </div>
            )}
          </div>
          <div className="usage-axis">
            <span>{bars[0] && bucketLabel(bars[0].at)}</span>
            <span>{bars.length > 1 && bucketLabel(bars.at(-1)!.at)}</span>
          </div>
        </figure>
        <TokenTrend buckets={bars} label={bucketLabel} format={tokens} />
        {page && page.byModel.length > 0 && (
          <ModelBreakdown models={page.byModel} tokens={tokens} dollars={dollars} />
        )}
        <div className="usage-table usage-log">
          <h2 className="usage-section">调用记录</h2>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>会话</th>
                <th>模型</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存读取</th>
                <th>缓存写入</th>
                <th>等价费用</th>
                <th>首字</th>
                <th>总用时</th>
                <th>速度</th>
              </tr>
            </thead>
            <tbody>
              {page?.rows.map((row) => {
                const streaming =
                  row.ttftMs != null && row.durationMs > row.ttftMs
                    ? row.durationMs - row.ttftMs
                    : null;
                return (
                  <tr key={row.id}>
                    <td>
                      {new Date(row.at).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td title={row.sessionTitle ?? row.sessionId ?? undefined}>
                      {row.sessionTitle ?? (row.source && row.source !== 'sdk' ? row.source : '—')}
                    </td>
                    <td>{row.model}</td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    <td>{row.cacheReadTokens.toLocaleString()}</td>
                    <td>{row.cacheCreationTokens.toLocaleString()}</td>
                    <td>{dollars(row.costUsd)}</td>
                    <td>{seconds(row.ttftMs)}</td>
                    <td>{seconds(row.durationMs)}</td>
                    <td>
                      {streaming
                        ? `${(row.outputTokens / (streaming / 1000)).toFixed(1)} tok/s`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {page && !page.rows.length && <p className="muted">这个范围内没有调用记录。</p>}
          {page && pages > 1 && (
            <nav className="usage-pager" aria-label="调用记录翻页">
              <IconButton
                title="上一页"
                disabled={loading || index === 0}
                onClick={() => {
                  turnPage(index - 1);
                }}
              >
                <ChevronLeft />
              </IconButton>
              <label>
                第
                <input
                  key={index}
                  aria-label="页码"
                  inputMode="numeric"
                  defaultValue={index + 1}
                  disabled={loading}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    const wanted = Math.round(Number(event.currentTarget.value));
                    if (wanted >= 1 && wanted <= pages) turnPage(wanted - 1);
                    else event.currentTarget.value = String(index + 1);
                  }}
                  onBlur={(event) => {
                    event.currentTarget.value = String(index + 1);
                  }}
                />
                / {pages} 页
              </label>
              <IconButton
                title="下一页"
                disabled={loading || !page.hasMore}
                onClick={() => {
                  turnPage(index + 1);
                }}
              >
                <ChevronRight />
              </IconButton>
              <span>
                共 {totals!.requests.toLocaleString('zh-CN')} 条，每页 {pageSize} 条
              </span>
            </nav>
          )}
        </div>
        {summary && (
          <p className="account-updated">
            调用记录保留 {summary.retentionDays} 天
            {summary.firstRecordAt
              ? `，最早一条：${new Date(summary.firstRecordAt).toLocaleString('zh-CN')}`
              : ''}
            。
          </p>
        )}
      </div>
    </section>
  );
}
