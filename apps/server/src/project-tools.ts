import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { projectOperation } from '@cc-desk-tunnel/protocol';
import type { ProjectOperation } from '@cc-desk-tunnel/protocol';

// Both the SDK and the interactive CLI start this stdio MCP server using their public MCP option.
// The socket belongs to a single native run, with its device and project captured by its handler.
export const projectPrompt =
  'Use the project MCP tools for all project files and commands. Paths are relative to the project. The command tool requires a grant on the project device. If an operation was interrupted, check its result before acting again. File reads return a revision for editing.';
export async function projectTools(
  directory: string,
  invoke: (operation: ProjectOperation, signal: AbortSignal) => Promise<string>,
) {
  const path = join(directory, randomUUID() + '.sock');
  const lifetime = new AbortController();
  let commands = false;
  const watchers = new Set<Socket>();
  const server = createServer((socket) => {
    const reader = createInterface({ input: socket });
    const call = new AbortController();
    socket.on('close', () => {
      watchers.delete(socket);
      call.abort();
    });
    socket.on('error', () => socket.destroy());
    reader.once('line', async (line) => {
      reader.close();
      if (lifetime.signal.aborted || call.signal.aborted) return;
      try {
        if (Buffer.byteLength(line) > 240000) throw new Error('Input too large');
        const message = JSON.parse(line);
        if (message?.watch === 'commands') {
          watchers.add(socket);
          socket.write(JSON.stringify({ commands }) + '\n');
          return;
        }
        const operation = projectOperation.parse(message);
        const text = await invoke(operation, AbortSignal.any([lifetime.signal, call.signal]));
        socket.end(JSON.stringify({ text }) + '\n');
      } catch (e) {
        socket.end(
          JSON.stringify({ error: e instanceof Error ? e.message : 'Project call failed' }) + '\n',
        );
      }
    });
    lifetime.signal.addEventListener('abort', () => socket.destroy(), {
      once: true,
      signal: call.signal,
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(path, () => {
      server.removeListener('error', fail);
      ok();
    });
  });
  chmodSync(path, 0o600);
  return {
    setCommands(enabled: boolean) {
      if (commands === enabled) return;
      commands = enabled;
      for (const socket of watchers) socket.write(JSON.stringify({ commands }) + '\n');
    },
    config: {
      type: 'stdio' as const,
      command: 'node',
      args: [fileURLToPath(new URL('./project-mcp.ts', import.meta.url)), path],
    },
    close() {
      lifetime.abort();
      server.close();
    },
  };
}
