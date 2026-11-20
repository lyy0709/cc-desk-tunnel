import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { projectOperation, sessionToolsSchema } from '@cc-desk-tunnel/protocol';
import type { ProjectOperation, SessionTools } from '@cc-desk-tunnel/protocol';

// Both the SDK and the interactive CLI start this stdio MCP server using their public MCP option.
// The socket belongs to a single native run, with its device and project captured by its handler.
export const projectPrompt =
  'Use the project MCP tools for all project files and commands. Paths are relative to the project. The command tool requires a grant on the project device. If an operation was interrupted, check its result before acting again. File reads return a revision for editing.';
// The built-in tools of a session whose project is on a device. Those that read or write this host's files, or run
// its commands, stay out: the project is reached through the MCP tools. The ones here touch no project file.
const builtinTools = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
];
// With subagents, the tool Claude starts them through. A subagent draws its tools from this same set and the
// session's MCP servers, as CLI 2.1.328 was seen to do for its general-purpose, Explore and Plan agents: it has the
// project and web tools and none for this host's files either. Each makes model requests of its own.
export function projectBuiltinTools({ subagents }: SessionTools) {
  return subagents ? [...builtinTools, 'Agent'] : [...builtinTools];
}

export const SESSION_TOOLS: SessionTools = { subagents: false };
const settingsFile = (directory: string) => join(directory, 'session-tools.json');
// The service's own setting, kept with its sessions. A file it cannot read is the defaults.
export function readSessionTools(directory: string): SessionTools {
  try {
    return sessionToolsSchema.parse({
      ...SESSION_TOOLS,
      ...JSON.parse(readFileSync(settingsFile(directory), 'utf8')),
    });
  } catch {
    return { ...SESSION_TOOLS };
  }
}
export function writeSessionTools(directory: string, values: Partial<SessionTools>) {
  const next = sessionToolsSchema.parse({ ...readSessionTools(directory), ...values });
  writeFileSync(`${settingsFile(directory)}.new`, JSON.stringify(next, null, 2) + '\n', {
    mode: 0o600,
  });
  renameSync(`${settingsFile(directory)}.new`, settingsFile(directory));
  return next;
}
export async function projectTools(
  directory: string,
  invoke: (operation: ProjectOperation, signal: AbortSignal) => Promise<string>,
  inRuntimeContainer: boolean,
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
      command: inRuntimeContainer ? '/usr/local/bin/ccdt-project-mcp' : process.execPath,
      // Broker updates may live in /data/program, which is private to its container.
      args: [
        inRuntimeContainer
          ? '/app/apps/server/src/project-mcp.ts'
          : fileURLToPath(new URL('./project-mcp.ts', import.meta.url)),
        path,
      ],
    },
    close() {
      lifetime.abort();
      server.close();
    },
  };
}
