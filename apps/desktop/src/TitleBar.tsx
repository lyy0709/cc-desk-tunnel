import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react';
import { IconButton } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import { useEffect } from 'react';
import { usePopover } from './usePopover.ts';

export type BarMenu = { label: string; items: MenuItem[] };

// The window's own top edge: it is the drag handle of the frameless desktop window, and carries the way back,
// the side column's switch, the menus and the state of the connection.
export default function TitleBar({
  title,
  back,
  forward,
  sideOpen,
  toggleSide,
  menus,
  openMenu,
  connected,
  adapterName,
  statusRequest = 0,
  statusLabel,
  details = [],
}: {
  title: string;
  // Absent while there is nowhere to go.
  back?: () => void;
  forward?: () => void;
  sideOpen: boolean;
  toggleSide: () => void;
  menus: BarMenu[];
  openMenu: (menu: BarMenu, position: MenuPosition) => void;
  connected: boolean;
  adapterName: string;
  statusRequest?: number;
  statusLabel?: string;
  details?: { label: string; value: string }[];
}) {
  const { open, setOpen, container, card } = usePopover();
  useEffect(() => {
    if (statusRequest) setOpen(true);
  }, [statusRequest]);
  return (
    <header className="titlebar">
      <IconButton className="history-back" title="后退" disabled={!back} onClick={back}>
        <ArrowLeft />
      </IconButton>
      <IconButton className="history-button" title="前进" disabled={!forward} onClick={forward}>
        <ArrowRight />
      </IconButton>
      <IconButton
        className="sidebar-toggle"
        title={sideOpen ? '收起侧栏' : '展开会话列表'}
        onClick={toggleSide}
      >
        <PanelLeft />
      </IconButton>
      <nav className="titlebar-menus" aria-label="菜单">
        {menus.map((menu) => (
          <button
            type="button"
            key={menu.label}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              openMenu(menu, { x: box.left, y: box.bottom + 4 });
            }}
          >
            {menu.label}
          </button>
        ))}
      </nav>
      <h1>{title}</h1>
      <div className="connection-detail" ref={container}>
        <button
          type="button"
          className="connection-status"
          title="查看会话状态"
          aria-label="查看会话状态"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className={`connection-dot ${connected ? 'online' : ''}`} />
          <span>{statusLabel ?? (connected ? '已连接' : '重连中')}</span>
          <small>{adapterName}</small>
        </button>
        {open && (
          <div className="connection-card" role="dialog" aria-label="会话状态" ref={card}>
            <strong>会话状态</strong>
            <dl>
              {details.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </header>
  );
}
