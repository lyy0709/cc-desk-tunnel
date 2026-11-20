import { z } from 'zod';

export const projectOperation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('list'),
    path: z.string().max(2048),
    offset: z.number().int().nonnegative().default(0),
  }),
  z.object({
    op: z.literal('search'),
    path: z.string().max(2048),
    query: z.string().min(1).max(2048),
    offset: z.number().int().nonnegative().default(0),
  }),
  z.object({
    op: z.literal('read'),
    path: z.string().min(1).max(2048),
    offset: z.number().int().nonnegative().default(0),
    // A line to begin at, counted from 1, in place of the byte offset.
    line: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('create'),
    path: z.string().min(1).max(2048),
    new: z.string().max(24000),
  }),
  z.object({
    op: z.literal('edit'),
    path: z.string().min(1).max(2048),
    old: z.string().min(1).max(12000),
    new: z.string().max(24000),
    revision: z.string().min(1).max(120),
    // Every occurrence of `old`, where it occurs more than once.
    all: z.boolean().optional(),
  }),
  z.object({ op: z.literal('output'), id: z.uuid(), offset: z.number().int().nonnegative() }),
  z.object({
    op: z.literal('command'),
    shell: z.enum(['bash', 'pwsh', 'zsh']).optional(),
    command: z.string().min(1).max(12000),
  }),
]);
export type ProjectOperation = z.infer<typeof projectOperation>;
// The longest a command runs on a project device before it is stopped there. The tool's description tells Claude of
// it, and the service waits a little longer than this for the device's answer.
export const PROJECT_COMMAND_SECONDS = 120;
export const projectCommands = z
  .object({
    type: z.literal('project.commands'),
    sessionId: z.uuid(),
    project: z.templateLiteral(['project:', z.uuid()]),
    enabled: z.boolean(),
  })
  .strict();
export const projectCall = z.object({
  type: z.literal('project.call'),
  sessionId: z.uuid(),
  requestId: z.uuid(),
  project: z.string().max(2048),
  operation: projectOperation,
});
// The longest result a device sends back for one operation; the device answers with an error past it.
export const PROJECT_REPLY_CHARS = 120000;
export const projectReply = z
  .object({
    type: z.literal('project.result'),
    requestId: z.uuid(),
    sessionId: z.uuid(),
    text: z.string().max(PROJECT_REPLY_CHARS),
    error: z.boolean().optional(),
  })
  .strict();
