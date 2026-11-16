import { memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { pathKey } from '@cc-desk-tunnel/protocol';
import type { FileAttachment } from '@cc-desk-tunnel/protocol';
import { File, FileCode, FileText, Image as ImageIcon, X } from 'lucide-react';
import { isPicture, localPicture } from './links.ts';
import { SearchExpanded } from './ConversationFind.tsx';
import { CopyButton } from './copy.tsx';
import { Modal } from './ui.tsx';

const attachmentKey = (file: FileAttachment) => `${file.deviceId}:${pathKey(file.path)}`;
const fileType = (name: string) =>
  name.split('.').length > 1 ? name.split('.').at(-1)!.toUpperCase() : '文件';
const fileSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
type PathInfo = Awaited<ReturnType<NonNullable<Window['desktop']>['inspectPath']>>;
type TextPreview = Awaited<ReturnType<NonNullable<Window['desktop']>['previewText']>>;

function AttachmentPreview({
  file,
  local,
  close,
}: {
  file: FileAttachment;
  local: boolean;
  close: () => void;
}) {
  const [info, setInfo] = useState<PathInfo | null>(null);
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(local);
  const [notice, setNotice] = useState('');
  const image = isPicture(file.path);
  useEffect(() => {
    if (!local) return;
    let current = true;
    void (async () => {
      try {
        const found = await window.desktop!.inspectPath(file.path);
        if (!current) return;
        setInfo(found);
        if (found.kind !== 'file') {
          setError(
            found.kind === 'missing'
              ? '本机找不到这个文件，它可能已被移动或删除。'
              : '这个路径不是文件。',
          );
        } else if (image) {
          if (found.size > 20 * 1024 * 1024) setError('图片超过 20 MB，无法在这里预览。');
        } else {
          const text = await window.desktop!.previewText(file.path);
          if (current) setPreview(text);
        }
      } catch (error) {
        if (current) setError(error instanceof Error ? error.message : '无法读取这个文件。');
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [file.path, image, local]);
  const act = async (action: 'open' | 'editor' | 'reveal') => {
    try {
      setNotice(
        await window.desktop!.actOnPath(
          action,
          file.path,
          action === 'editor' ? { editor: info!.editors[0].scheme } : undefined,
        ),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法打开这个文件。');
    }
  };
  return (
    <Modal title={file.name} onClose={close}>
      <div className="attachment-preview">
        <p className="attachment-path">{file.path}</p>
        <p className="muted">
          {fileType(file.name)}
          {(info?.size ?? file.size) !== undefined && ` · ${fileSize(info?.size ?? file.size!)}`}
        </p>
        {!local ? (
          <p className="muted">请在文件所属的电脑上预览。</p>
        ) : loading ? (
          <p role="status" className="muted">
            正在读取…
          </p>
        ) : error ? (
          <p className="attachment-error" role="alert">
            {error}
          </p>
        ) : image ? (
          <div className="picture-view">
            <img
              src={localPicture(file.path)}
              alt={file.name}
              onError={() => setError('无法预览这张图片，文件可能已失效或格式不受支持。')}
            />
          </div>
        ) : preview?.kind === 'text' ? (
          <>
            {preview.truncated && (
              <p className="muted">仅显示前 1 MiB / 10,000 行，可在编辑器中查看完整内容。</p>
            )}
            <pre tabIndex={0}>{preview.text}</pre>
          </>
        ) : (
          <p className="muted">此格式或文本编码暂不支持预览，可使用本机应用打开。</p>
        )}
        <div className="attachment-preview-actions">
          <CopyButton text={file.path} label="复制路径" />
          {local && info?.kind === 'file' && (
            <>
              {preview?.kind === 'text' && info.editors.length > 0 && (
                <button type="button" className="button" onClick={() => void act('editor')}>
                  在 {info.editors[0].name} 打开
                </button>
              )}
              {!info.runs && (
                <button type="button" className="button" onClick={() => void act('open')}>
                  用默认应用打开
                </button>
              )}
              <button type="button" className="button" onClick={() => void act('reveal')}>
                在文件夹中显示
              </button>
            </>
          )}
        </div>
        {notice && (
          <p role="status" className="muted">
            {notice}
          </p>
        )}
      </div>
    </Modal>
  );
}

const AttachmentCard = memo(function AttachmentCard({
  file,
  local,
  remove,
  disabled,
  open,
}: {
  file: FileAttachment;
  local: boolean;
  remove?: (file: FileAttachment) => void;
  disabled: boolean;
  open: (file: FileAttachment, trigger: HTMLButtonElement) => void;
}) {
  const [broken, setBroken] = useState(false);
  const picture = isPicture(file.path);
  const Icon = picture
    ? ImageIcon
    : /\.(sh|ps1|py|js|ts|tsx|jsx|json|css|html|c|cpp|rs|go)$/i.test(file.name)
      ? FileCode
      : /\.(txt|md|csv|log|yaml|yml)$/i.test(file.name)
        ? FileText
        : File;
  return (
    <div className={`attachment-card${remove ? ' removable' : ''}`}>
      <button
        type="button"
        className="attachment-open"
        title={file.path}
        aria-label={`预览 ${file.name}`}
        aria-haspopup="dialog"
        data-reading-control
        onClick={(event) => open(file, event.currentTarget)}
      />
      <span className="attachment-thumbnail" aria-hidden="true">
        {picture &&
        local &&
        !broken &&
        (file.size === undefined || file.size <= 20 * 1024 * 1024) ? (
          <img
            src={localPicture(file.path)}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
          />
        ) : (
          <Icon />
        )}
      </span>
      <span className="attachment-label" data-search-content>
        <strong>{file.name}</strong>
        <small>
          {file.reference && `#${file.reference} · `}
          {broken ? '无法预览图片' : fileType(file.name)}
          {file.size !== undefined && ` · ${fileSize(file.size)}`}
        </small>
      </span>
      {remove && (
        <button
          type="button"
          className="attachment-remove"
          title={`移除 ${file.name}`}
          aria-label={`移除 ${file.name}`}
          disabled={disabled}
          onClick={() => remove(file)}
        >
          <X />
        </button>
      )}
    </div>
  );
});

export default memo(function Attachments({
  files,
  deviceId,
  remove,
  disabled = false,
}: {
  files: FileAttachment[];
  deviceId?: string;
  remove?: (file: FileAttachment) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [columns, setColumns] = useState(1);
  const [selected, setSelected] = useState<FileAttachment | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const searching = useContext(SearchExpanded);
  useLayoutEffect(() => {
    if (files.length <= 2) return;
    const element = list.current!;
    // Do not synchronously measure skipped historical messages just to lay out their file cards.
    const observer = new ResizeObserver(([entry]) =>
      setColumns(Math.max(1, Math.floor((entry.contentRect.width + 8) / 188))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [files.length > 2]);
  const shown = expanded || searching ? files : files.slice(0, columns * 2);
  const open = (file: FileAttachment, button: HTMLButtonElement) => {
    trigger.current = button;
    setSelected(file);
  };
  const close = () => {
    setSelected(null);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };
  return (
    <div className="attachments">
      <div
        className={`attachment-list${expanded && !searching ? ' expanded' : ''}`}
        ref={list}
        style={
          files.length > 2
            ? ({
                '--attachment-width': `calc((100% - ${(columns - 1) * 8}px) / ${columns})`,
              } as CSSProperties)
            : undefined
        }
      >
        {shown.map((file) => (
          <AttachmentCard
            key={attachmentKey(file)}
            file={file}
            local={!!window.desktop && file.deviceId === deviceId}
            remove={remove}
            disabled={disabled}
            open={open}
          />
        ))}
      </div>
      {files.length > columns * 2 && !searching && (
        <button
          type="button"
          className="attachment-toggle"
          data-reading-control
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起附件' : `展开附件（还有 ${files.length - shown.length} 个）`}
        </button>
      )}
      {selected && (
        <AttachmentPreview
          key={attachmentKey(selected)}
          file={selected}
          local={!!window.desktop && selected.deviceId === deviceId}
          close={close}
        />
      )}
    </div>
  );
});
