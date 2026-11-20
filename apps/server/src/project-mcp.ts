import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PROJECT_COMMAND_SECONDS, projectOperation } from '@cc-desk-tunnel/protocol';

const descriptions = {
  list: 'List entries in a directory. Use "." for the root and next for pagination.',
  read: 'Read UTF-8 text at a byte offset, or starting at a 1-based line (which overrides offset). Metadata includes the revision for editing and next byte offset for pagination, followed by the unescaped text. PNG, JPEG, WebP and GIF are read as complete images starting at offset 0. For attachments use the supplied reference.',
  search:
    'Search for literal text in project text files. Returns relative paths and line numbers. Version control, dependency and build output directories such as node_modules are left out and named in "skipped"; give one of them as the path to search inside it.',
  edit: 'Replace one unique exact excerpt in a previously read text file, using its revision. Set all to replace every occurrence. Returns the new revision for the next edit.',
  create:
    'Create a new UTF-8 text file. Fails if the path already exists. Returns its revision for editing.',
  output: 'Read the next page of a command result by its id and offset.',
  command: `Run a command from the project directory with the local user’s session grant. A command is stopped after ${PROJECT_COMMAND_SECONDS} seconds, and its result then has timedOut set; nothing can be left running in the background.`,
};
const server = new McpServer({ name: 'project', version: '1' });
let commandTool: RegisteredTool;
for (const variant of projectOperation.options) {
  const { op, ...shape } = variant.shape;
  const name = op.value;
  const tool = server.registerTool(
    name,
    {
      description: descriptions[name],
      inputSchema: shape,
      // `output` only turns the pages of a result a command already left: it runs nothing.
      annotations: { readOnlyHint: ['read', 'list', 'search', 'output'].includes(name) },
    },
    async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
      const request = (fields: Record<string, unknown>) =>
        new Promise<{ text?: string; error?: string }>((ok, fail) => {
          const socket = createConnection(process.argv[2]);
          let buffer = '';
          const stop = () => socket.destroy(new Error('Cancelled'));
          if (extra.signal.aborted) stop();
          extra.signal.addEventListener('abort', stop, { once: true });
          socket.on('connect', () => socket.write(JSON.stringify({ ...fields, op: name }) + '\n'));
          socket.setEncoding('utf8');
          socket.on('data', (s) => {
            buffer += s;
          });
          socket.on('error', fail);
          socket.on('end', () => {
            try {
              ok(JSON.parse(buffer));
            } catch {
              fail(new Error('Project operation outcome unknown'));
            }
          });
          socket.on('close', () => extra.signal.removeEventListener('abort', stop));
        }).catch(() => ({ error: '连接已中断，操作结果未知。', text: undefined }));
      const response = await request(args);
      if (name === 'read' && !response.error && response.text) {
        const first = JSON.parse(response.text);
        if (typeof first.base64 === 'string') {
          const mime: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
          };
          if (!mime[first.ext])
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    text: Buffer.from(first.base64, 'base64').toString('utf8'),
                    next: first.next,
                  }),
                },
              ],
            };
          if (args.offset) throw new Error('请从偏移量 0 读取完整图片。');
          const chunks = [Buffer.from(first.base64, 'base64')];
          let length = chunks[0].length,
            offset = first.next;
          while (offset && length <= 20 * 1024 * 1024) {
            const part = await request({ ...args, offset });
            if (part.error || !part.text) throw new Error('图片读取中断。');
            const next = JSON.parse(part.text);
            if (next.revision !== first.revision || (next.next && next.next <= offset))
              throw new Error('图片已变更，请重新读取。');
            const bytes = Buffer.from(next.base64, 'base64');
            chunks.push(bytes);
            length += bytes.length;
            offset = next.next;
          }
          if (length > 20 * 1024 * 1024) throw new Error('图片超过 20 MiB。');
          return {
            content: [
              {
                type: 'image' as const,
                data: Buffer.concat(chunks).toString('base64'),
                mimeType: mime[first.ext],
              },
            ],
          };
        }
      }
      if (
        !response.error &&
        response.text &&
        ['read', 'list', 'search', 'command', 'output'].includes(name)
      ) {
        const result = JSON.parse(response.text);
        const { text, output, ...metadata } = result;
        const body = name === 'command' || name === 'output' ? output : text;
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(metadata) },
            { type: 'text' as const, text: body ?? '' },
          ],
        };
      }
      return {
        isError: !!response.error,
        content: [{ type: 'text' as const, text: response.error ?? response.text ?? '' }],
      };
    },
  );
  if (name === 'command') {
    commandTool = tool;
    tool.disable();
  }
}
const watch = createConnection(process.argv[2]);
const changes = createInterface({ input: watch });
process.stdin.once('end', () => watch.destroy());
await new Promise<void>((resolve, reject) => {
  watch.on('connect', () => watch.write('{"watch":"commands"}\n'));
  watch.on('error', reject);
  watch.on('close', () => {
    if (commandTool.enabled) commandTool.disable();
    reject(new Error('项目设备权限通道已关闭。'));
  });
  changes.on('line', (line) => {
    const { commands } = JSON.parse(line);
    if (typeof commands !== 'boolean') return;
    if (commands !== commandTool.enabled) {
      if (commands) commandTool.enable();
      else commandTool.disable();
    }
    resolve();
  });
});
await server.connect(new StdioServerTransport());
