import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ChevronUp } from 'lucide-react';
import type { Turn } from './transcript.ts';
import { firstLine } from './transcriptView.ts';
import { IconButton } from './ui.tsx';

// A small map of the loaded turns. Scrolling only updates this map, not the transcript.
export default function ConversationNav({
  turns,
  root,
  scroll,
  partial,
  loading,
  loadEarlier,
  navigate,
}: {
  turns: Turn[];
  root: RefObject<HTMLDivElement | null>;
  scroll: RefObject<HTMLDivElement | null>;
  partial: boolean;
  loading: boolean;
  loadEarlier: () => void;
  navigate: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const anchors = useRef<HTMLElement[]>([]);
  const destination = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const [height, setHeight] = useState(0);
  const tooltip = useId();
  const last = turns.length - 1;
  const selected = Math.min(preview ?? active, last);
  const turn = turns[selected];
  const title =
    firstLine(
      turn.question?.text
        .slice(0, 1000)
        .replace(
          /\[文件 #(\d+)\]/g,
          (token, number) =>
            turn.question?.attachments?.find((file) => file.reference === Number(number))?.name ??
            token,
        ) ?? '',
    ) ||
    turn.question?.attachments?.map((file) => file.name).join('、') ||
    `第 ${selected + 1} 轮`;
  const answer = turn.answer ?? turn.steps.findLast((step) => step.kind === 'assistant');
  const excerpt = answer && 'text' in answer ? firstLine(answer.text.slice(0, 1600)) : '';
  // Sample the ticks, not the turns: the pointer and arrow keys can still select every loaded turn.
  const ticks = Math.min(turns.length, Math.max(2, Math.floor(height / 8)));

  useEffect(() => {
    const box = scroll.current!;
    const content = root.current!;
    anchors.current = [...content.querySelectorAll<HTMLElement>('.turn-anchor')];
    let frame = 0;
    const update = () => {
      frame = 0;
      const all = anchors.current;
      const bounds = box.getBoundingClientRect();
      // Nearby skipped replies acquire their real heights after a jump. Keep the chosen question in
      // place through that layout, until the reader next uses the mouse, keyboard or touch screen.
      if (destination.current) {
        const shift = destination.current.getBoundingClientRect().top - bounds.top - 20;
        if (Math.abs(shift) > 1) box.scrollTop += shift;
      }
      const top = bounds.top + 40;
      // Only logarithmically many anchor reads, even with thousands of turns. Reading anchors outside
      // the messages also leaves content-visibility free to skip their Markdown layout.
      let low = 0;
      let high = all.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (all[middle].getBoundingClientRect().top <= top) low = middle + 1;
        else high = middle;
      }
      const end = box.scrollHeight - box.scrollTop - box.clientHeight < 2;
      setActive(end ? all.length - 1 : Math.max(0, low - 1));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const release = () => {
      destination.current = null;
    };
    box.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('wheel', release, { passive: true, capture: true });
    document.addEventListener('pointerdown', release, true);
    document.addEventListener('keydown', release, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(box);
    observer.observe(content);
    schedule();
    return () => {
      box.removeEventListener('scroll', schedule);
      document.removeEventListener('wheel', release, true);
      document.removeEventListener('pointerdown', release, true);
      document.removeEventListener('keydown', release, true);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [turns.length, turns[0].id, root, scroll]);

  useLayoutEffect(() => {
    const element = track.current!;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const positionCard = () => {
    const element = card.current;
    if (!element) return;
    const bounds = track.current!.getBoundingClientRect();
    const body = scroll.current!.parentElement!.getBoundingClientRect();
    const y = bounds.top - body.top + 8 + (selected / last) * (bounds.height - 16);
    element.style.top = `${Math.max(8, Math.min(y - element.offsetHeight / 2, body.height - element.offsetHeight - 8))}px`;
  };
  const reposition = useRef(positionCard);
  reposition.current = positionCard;
  useLayoutEffect(positionCard, [preview, selected, height, last, scroll]);
  const showing = preview !== null;
  useLayoutEffect(() => {
    if (!showing) return;
    const observer = new ResizeObserver(() => reposition.current());
    observer.observe(card.current!);
    observer.observe(scroll.current!);
    return () => observer.disconnect();
  }, [showing, scroll]);

  const indexAt = (y: number) => {
    const bounds = track.current!.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(last, Math.round(((y - bounds.top - 8) / (bounds.height - 16)) * last)),
    );
  };
  const jump = (index: number) => {
    navigate();
    setPreview(null);
    destination.current = anchors.current[index];
    // Long animated jumps would render every intervening reply. Move directly to the turn instead.
    destination.current.scrollIntoView({ block: 'start', behavior: 'instant' });
  };

  return (
    <>
      <nav className="conversation-nav" aria-label="对话轮次导航">
        {partial && (
          <IconButton
            title="导航：加载更早记录"
            disabled={loading}
            onClick={() => {
              navigate();
              loadEarlier();
            }}
          >
            <ChevronUp />
          </IconButton>
        )}
        <div
          className="conversation-nav-track"
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="对话轮次（上下键预览，回车跳转）"
          aria-orientation="vertical"
          aria-valuemin={1}
          aria-valuemax={turns.length}
          aria-valuenow={selected + 1}
          aria-valuetext={`${selected + 1} / ${turns.length}：${title}`}
          aria-describedby={preview === null ? undefined : tooltip}
          style={{ height: Math.min(520, turns.length * 16) }}
          onPointerMove={(event) => {
            if (event.pointerType !== 'touch') setPreview(indexAt(event.clientY));
          }}
          onPointerLeave={() => setPreview(null)}
          onClick={(event) => jump(indexAt(event.clientY))}
          onFocus={() => setPreview(active)}
          onBlur={() => setPreview(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setPreview(null);
            else if (event.key === 'Enter' || event.key === ' ') jump(selected);
            else if (event.key === 'ArrowUp') setPreview(Math.max(0, selected - 1));
            else if (event.key === 'ArrowDown') setPreview(Math.min(last, selected + 1));
            else if (event.key === 'Home') setPreview(0);
            else if (event.key === 'End') setPreview(last);
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="conversation-nav-ticks" aria-hidden="true">
            {Array.from({ length: ticks }, (_, index) => (
              <i key={index} style={{ top: `${(index / (ticks - 1)) * 100}%` }} />
            ))}
            <i className="current" style={{ top: `${(active / last) * 100}%` }} />
            {preview !== null && (
              <i className="preview" style={{ top: `${(selected / last) * 100}%` }} />
            )}
          </div>
        </div>
      </nav>
      {preview !== null && (
        <div className="conversation-nav-preview" role="tooltip" id={tooltip} ref={card}>
          <small>
            {selected + 1} / {turns.length}
            {partial ? ' · 已加载' : ''}
          </small>
          <strong>{title.slice(0, 180)}</strong>
          <p>{excerpt.slice(0, 300) || (turn.endedAt ? '本轮没有文字回复' : '等待回复')}</p>
        </div>
      )}
    </>
  );
}
