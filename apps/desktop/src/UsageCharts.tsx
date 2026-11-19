import { useState } from 'react';
import { USAGE_SLICE_MINUTES, type UsagePage } from '@cc-desk-tunnel/protocol';

type Bucket = UsagePage['series'][number];
const emptyBucket = {
  requests: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};
const bucketFields = Object.keys(emptyBucket) as (keyof typeof emptyBucket)[];

// A repeated hour has two distinct starts. A local calendar day can contain 23, 24 or 25 hours.
export function usageBars(page: UsagePage, minutes: number) {
  const slice = USAGE_SLICE_MINUTES * 60_000;
  const group = (at: number) => {
    const date = new Date(at);
    if (minutes === 1440) return date.toDateString();
    const offset = date.getTimezoneOffset();
    return `${Math.floor((at / 60_000 - offset) / minutes)}:${offset}`;
  };
  const from = Date.parse(page.from),
    to = Date.parse(page.to);
  const bars: Bucket[] = [];
  if (from >= to) return bars;
  let at = Math.floor(from / slice) * slice;
  const first = group(at);
  while (group(at - slice) === first) at -= slice;
  const values = new Map(page.series.map((point) => [Date.parse(point.at), point]));
  let previous: string | undefined;
  for (; at < to; at += slice) {
    const key = group(at);
    if (key !== previous) {
      if (bars.length === 400) break;
      bars.push({ at: new Date(at).toISOString(), ...emptyBucket });
      previous = key;
    }
    const point = values.get(at);
    if (point) {
      const bar = bars[bars.length - 1];
      for (const field of bucketFields) bar[field] += point[field];
    }
  }
  return bars;
}
type Kinds = Pick<
  Bucket,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
>;
const kinds = [
  ['inputTokens', '输入'],
  ['outputTokens', '输出'],
  ['cacheReadTokens', '缓存读取'],
  ['cacheCreationTokens', '缓存写入'],
] as const;

// The share of the prompt that was read from the cache instead of being processed again; null when nothing
// was sent at all.
export function cacheHitRate(item: Kinds) {
  const prompt = item.inputTokens + item.cacheReadTokens + item.cacheCreationTokens;
  return prompt ? item.cacheReadTokens / prompt : null;
}
export const percent = (value: number | null) =>
  value == null ? '—' : `${(value * 100).toFixed(value > 0.995 || value < 0.005 ? 0 : 1)}%`;

// A round number at or above the value, for the top of an axis.
function ceiling(value: number) {
  if (value <= 0) return 1;
  const unit = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((step) => step * unit).find((step) => step >= value)!;
}
const width = 1000;
// One line through the points that have a value; a gap where one has none.
function path(values: (number | null)[], top: number, height: number) {
  const x = (index: number) =>
    values.length > 1 ? (index / (values.length - 1)) * width : width / 2;
  let drawing = false;
  return values
    .map((value, index) => {
      if (value == null) {
        drawing = false;
        return '';
      }
      const point = `${drawing ? 'L' : 'M'}${x(index).toFixed(1)} ${(height - (value / top) * height).toFixed(1)}`;
      drawing = true;
      return point;
    })
    .join('');
}

// Tokens by kind over time and, below on the same time axis, how much of the prompt came from the cache. They
// are two plots because they are two scales.
export function TokenTrend({
  buckets,
  label,
  format,
}: {
  buckets: Bucket[];
  label: (at: string) => string;
  format: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const top = ceiling(Math.max(...buckets.flatMap((item) => kinds.map(([key]) => item[key])), 0));
  const rates = buckets.map(cacheHitRate);
  const position = (index: number) =>
    buckets.length > 1 ? (index / (buckets.length - 1)) * 100 : 50;
  const track = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const share = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    setHover(Math.round(share * (buckets.length - 1)));
  };
  const hovered = hover !== null ? buckets[hover] : undefined;
  // Every point is marked when there are too few of them to make a line.
  const marked =
    buckets.length < 3 ? buckets.map((_, index) => index) : hover !== null ? [hover] : [];
  return (
    <figure className="usage-chart usage-trend">
      <figcaption>
        <span>Token 构成</span>
        <ul className="usage-legend">
          {kinds.map(([key, name], index) => (
            <li key={key}>
              <i className={`series-${index + 1}`} />
              {name}
            </li>
          ))}
        </ul>
      </figcaption>
      <div className="usage-lines" onMouseMove={track} onMouseLeave={() => setHover(null)}>
        <div className="usage-scale">
          <span>{format(top)}</span>
          <span>{format(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="usage-canvas">
          <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden="true">
            {kinds.map(([key], index) => (
              <path
                key={key}
                className={`series-${index + 1}`}
                d={path(
                  buckets.map((item) => item[key]),
                  top,
                  100,
                )}
              />
            ))}
          </svg>
          {marked.flatMap((at) =>
            kinds.map(([key], index) => (
              <i
                key={`${at}-${key}`}
                className={`usage-point series-${index + 1}`}
                style={{
                  left: `${position(at)}%`,
                  top: `${100 - (buckets[at][key] / top) * 100}%`,
                }}
              />
            )),
          )}
          {hover !== null && <b className="usage-cross" style={{ left: `${position(hover)}%` }} />}
        </div>
        {hovered && (
          <div
            className="usage-tip"
            role="tooltip"
            style={
              position(hover!) < 50
                ? { left: `calc(${position(hover!)}% + 12px)` }
                : { right: `calc(${100 - position(hover!)}% + 12px)` }
            }
          >
            <strong>{label(hovered.at)}</strong>
            {kinds.map(([key, name], index) => (
              <span key={key}>
                <i className={`series-${index + 1}`} />
                {name} {format(hovered[key])}
              </span>
            ))}
            <span>
              <i className="series-rate" />
              缓存命中率 {percent(rates[hover!])}
            </span>
          </div>
        )}
      </div>
      <figcaption className="usage-second">
        <span>缓存命中率</span>
        <small>缓存读取 ÷（输入 + 缓存读取 + 缓存写入）</small>
      </figcaption>
      <div
        className="usage-lines usage-rate"
        onMouseMove={track}
        onMouseLeave={() => setHover(null)}
      >
        <div className="usage-scale">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <div className="usage-canvas">
          <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" aria-hidden="true">
            <path className="series-rate" d={path(rates, 1, 100)} />
          </svg>
          {marked.map(
            (at) =>
              rates[at] != null && (
                <i
                  key={at}
                  className="usage-point series-rate"
                  style={{ left: `${position(at)}%`, top: `${100 - rates[at]! * 100}%` }}
                />
              ),
          )}
          {hover !== null && <b className="usage-cross" style={{ left: `${position(hover)}%` }} />}
        </div>
      </div>
      <div className="usage-axis">
        <span>{buckets[0] && label(buckets[0].at)}</span>
        <span>{buckets.length > 1 && label(buckets.at(-1)!.at)}</span>
      </div>
    </figure>
  );
}

// What each model accounts for in the range. The bar is its share of the cost, or of the tokens when the
// range cost nothing.
export function ModelBreakdown({
  models,
  tokens,
  dollars,
}: {
  models: UsagePage['byModel'];
  tokens: (value: number) => string;
  dollars: (value: number) => string;
}) {
  const sum = (item: UsagePage['byModel'][number]) =>
    item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheCreationTokens;
  const byCost = models.some((item) => item.costUsd > 0);
  const weight = (item: UsagePage['byModel'][number]) => (byCost ? item.costUsd : sum(item));
  const whole = models.reduce((total, item) => total + weight(item), 0);
  return (
    <div className="usage-table usage-models">
      <h2 className="usage-section">按模型</h2>
      <table>
        <thead>
          <tr>
            <th>模型</th>
            <th>{byCost ? '费用占比' : 'Token 占比'}</th>
            <th>请求数</th>
            <th>Token</th>
            <th>缓存命中率</th>
            <th>等价费用</th>
          </tr>
        </thead>
        <tbody>
          {models.map((item) => {
            const share = whole ? weight(item) / whole : 0;
            return (
              <tr key={item.model}>
                <td>{item.model}</td>
                <td>
                  <span className="usage-share">
                    <i style={{ width: `${share * 100}%` }} />
                  </span>
                  {percent(share)}
                </td>
                <td>{item.requests.toLocaleString('zh-CN')}</td>
                <td>{tokens(sum(item))}</td>
                <td>{percent(cacheHitRate(item))}</td>
                <td>{dollars(item.costUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
