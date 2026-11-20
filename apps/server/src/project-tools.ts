import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { projectOperation, sessionToolsSchema } from '@cc-desk-tunnel/protocol';
import type { ProjectOperation, SessionTools } from '@cc-desk-tunnel/protocol';

// Both the SDK and the interactive CLI start this stdio MCP server using their public MCP option.
// The socket belongs to a single native run, with its device and project captured by its handler.
export const projectPrompt =
  'Use the project MCP tools for all project files and commands. Paths are relative to the project. The command tool is there while the computer the project is on is connected. If an operation was interrupted, check its result before acting again. A file read returns a revision for editing, and an edit returns the revision the file then has.';
// Said as well where the built-in file tools are there (see `OWN_FILE_TOOLS`).
export const ownFilesPrompt =
  'The built-in Read, Write and Edit tools do not reach the project. They work only on the plan file of plan mode and on the files of your memory directory, by the absolute paths you are given for those.';
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
// The built-in file tools, for what Claude Code keeps on this host for the session and has Claude write itself: the
// plan of plan mode and the project's memory. They are given only where every call of theirs is checked first (see
// `ownFile`), through an SDK hook in chat and a command hook in the terminal.
export const OWN_FILE_TOOLS = ['Read', 'Write', 'Edit'];
export const OWN_FILES_REFUSAL =
  'Here the built-in Read, Write and Edit tools reach only the plan file of plan mode and your memory directory. Use the project MCP tools (read, edit, create) for the files of the project.';
// With subagents, the tool Claude starts them through. A subagent draws its tools from this same set and the
// session's MCP servers, as CLI 2.1.328 was seen to do for its general-purpose, Explore and Plan agents: it has the
// project and web tools and none for this host's files either. Each makes model requests of its own.
export function projectBuiltinTools({ subagents }: SessionTools, ownFiles = false) {
  return [...builtinTools, ...(ownFiles ? OWN_FILE_TOOLS : []), ...(subagents ? ['Agent'] : [])];
}
// The directories of this host the built-in file tools may work in: where Claude Code keeps its plans, and the memory
// of the project the session works in, which the CLI names after its working directory with every character that
// is neither a letter nor a digit made a dash.
export function ownDirectories(config: string, cwd: string) {
  return [
    join(config, 'plans'),
    join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'),
  ];
}
// Whether a call of a built-in file tool names a file inside one of them. Anything else of this host is not the
// session's to read or change, whatever its approval mode allows.
export function ownFile(input: unknown, directories: string[], stored = directories) {
  const path = (input as { file_path?: unknown } | null)?.file_path;
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path.includes('\0') ||
    path.split(/[\\/]/).includes('..')
  )
    return false;
  const target = resolve(path);
  return directories.some((directory, index) => {
    const inside = relative(resolve(directory), target);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))
      return false;
    // Check the allowed directory itself and every existing descendant. Missing descendants may be created, but
    // neither a file link nor a linked parent may redirect a built-in tool outside this directory.
    // The runtime overlays project history into the personal home; the SDK callback runs in the broker and must
    // inspect the backing directory there, while the terminal hook sees the overlay directly.
    let current = resolve(stored[index]);
    const inspected = join(current, inside);
    for (const part of ['', ...inside.split(sep)]) {
      current = join(current, part);
      try {
        const entry = lstatSync(current);
        if (entry.isSymbolicLink() || (current !== inspected && !entry.isDirectory())) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
      }
    }
    return true;
  });
}

// The terminal uses the same guard as the SDK. A hook failure must deny, since an unsuccessful command hook can
// otherwise let the CLI continue. Allowed calls keep the CLI's normal permission decision.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--guard-own-files') {
  let allowed = false;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    allowed =
      !OWN_FILE_TOOLS.includes(input.tool_name) || ownFile(input.tool_input, process.argv.slice(3));
  } catch (error) {
    process.stderr.write(
      `File access check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.stdout.write(
    JSON.stringify(
      allowed
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: OWN_FILES_REFUSAL,
            },
          },
    ) + '\n',
  );
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
