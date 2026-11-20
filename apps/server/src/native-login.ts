import { spawn as spawnPty } from 'node-pty';
import { ACCOUNT_LAUNCH } from './runtime-environment.ts';
import { definedEnvironment } from './native-terminal.ts';
import type { TerminalSpawner } from './native-terminal.ts';

// Terminal hyperlink (OSC) and styling (CSI) sequences; only the visible text is read.
const controlSequences = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

// The official `claude auth login`, as it runs in a terminal: it prints an authorization link and waits for the code the
// browser page shows. The client passes the code on as typed. The CLI exchanges it itself and keeps the sign-in in its
// own store; this process sees neither.
export class NativeLogin {
  url: Promise<string>;
  error?: string;
  cancelled = false;
  private process: ReturnType<TerminalSpawner>;
  private output = '';
  private timer: ReturnType<typeof setTimeout>;
  private submitted?: { code: string; reply: string; timer?: ReturnType<typeof setTimeout> };
  // `reply` carries what the command prints after a code and keeps waiting, such as its invalid-code message.
  constructor(
    executable: string,
    exit: (succeeded: boolean) => void,
    reply: (text: string) => void = () => {},
    options: { spawn?: TerminalSpawner; timeoutMs?: number } = {},
  ) {
    let found!: (url: string) => void, failed!: (error: Error) => void;
    this.url = new Promise((resolve, reject) => {
      found = resolve;
      failed = reject;
    });
    this.url.catch(() => {});
    // A wide terminal keeps the link on one line.
    this.process = (options.spawn ?? spawnPty)(executable, ['auth', 'login'], {
      cwd: process.cwd(),
      cols: 4000,
      rows: 24,
      env: { ...definedEnvironment(process.env), ...ACCOUNT_LAUNCH, TERM: 'dumb' },
      name: 'dumb',
    });
    this.timer = setTimeout(
      () => {
        this.error = '等待官方授权超时，请重新获取链接。';
        try {
          this.process.kill();
        } catch {}
      },
      options.timeoutMs ?? 10 * 60 * 1000,
    );
    this.process.onData((text) => {
      this.output = (this.output + text).slice(-16384);
      const link = /https:\/\/[^\s\x00-\x1f]+(?=\s)/.exec(
        this.output.replace(controlSequences, ''),
      );
      if (link) found(link[0]);
      const submitted = this.submitted;
      if (!submitted) return;
      submitted.reply += text;
      clearTimeout(submitted.timer);
      submitted.timer = setTimeout(() => {
        const lines = submitted.reply
          .replace(controlSequences, '')
          .split(/[\r\n]+/)
          .map((line) =>
            line
              .replace(/^Paste code here if prompted >/, '')
              .replaceAll(submitted.code, '')
              .replace(/https:\/\/[^\s]+|sk-ant-[A-Za-z0-9_-]+/g, '[已省略]')
              .trim(),
          )
          .filter(Boolean);
        submitted.reply = '';
        if (lines.length) reply(lines.join(' ').slice(0, 300));
      }, 400);
    });
    this.process.onExit(({ exitCode }) => {
      clearTimeout(this.timer);
      clearTimeout(this.submitted?.timer);
      const succeeded = exitCode === 0;
      if (!succeeded && !this.cancelled && !this.error) {
        // Only secrets are left out; the CLI's explanation stays, network and policy errors included.
        let output = this.output
          .replace(controlSequences, '')
          .replace(/https:\/\/[^\s]+|sk-ant-[A-Za-z0-9_-]+/g, '[已省略]');
        if (this.submitted?.code) output = output.replaceAll(this.submitted.code, '[授权码已省略]');
        const errorAt = output.lastIndexOf('OAuth error:');
        if (errorAt >= 0) output = output.slice(errorAt).split('Press Enter to retry.')[0];
        this.error =
          output.trim() || `官方登录命令异常退出（退出码 ${exitCode}），未提供错误输出。`;
      }
      failed(new Error(this.error ?? '官方登录命令在给出授权链接前已结束。'));
      this.output = '';
      exit(succeeded && !this.cancelled);
    });
  }
  submit(code: string) {
    clearTimeout(this.submitted?.timer);
    this.output = '';
    this.submitted = { code, reply: '' };
    this.process.write(`${code}\r`);
  }
  cancel() {
    this.cancelled = true;
    try {
      this.process.kill();
    } catch {}
  }
}
