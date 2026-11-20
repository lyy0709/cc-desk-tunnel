import { useEffect, useState } from 'react';
import type { SessionTools } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { sessionToolFields as fields } from './setting-fields.ts';
import { Row, Switch } from './ui.tsx';

// The service's own setting, kept with its sessions and not in the CLI's file: the optional built-in tools of a session
// whose project is on a device. Each change is saved at once and applies from the next run or terminal.
export default function SessionToolSettings({ client }: { client: ProxyClient }) {
  const [values, setValues] = useState<SessionTools | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'tools.get' }).then(
      (reply) => current && setValues(reply.values),
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [client]);
  async function save(change: Partial<SessionTools>) {
    setFailure(null);
    setSaving(true);
    try {
      setValues((await client.fetch({ type: 'tools.update', values: change })).values);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <h2 className="page-heading">子代理</h2>
      <p className="muted page-section-note">
        项目在设备上的会话默认不启用子代理。开启后，Claude
        可以把搜索、分析这类子任务交给子代理：每个子代理有自己的上下文，只能使用项目工具、网页搜索和网页读取，不能读写服务器上的文件；通用子代理还可以再启动子代理。它们各自发起模型请求，计入同一份用量。正在进行的运行和已打开的终端沿用开始时的设置；在服务端执行的普通会话不受这个开关影响。
      </p>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {values && (
        <div className="settings-list card">
          <Row title={fields.subagents.title} detail={fields.subagents.detail}>
            <Switch
              label={fields.subagents.title}
              checked={values.subagents}
              disabled={saving}
              onChange={(subagents) => void save({ subagents })}
            />
          </Row>
        </div>
      )}
    </>
  );
}
