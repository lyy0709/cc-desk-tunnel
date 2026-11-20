export type ToolPicture = { type: string; data: string };

// Native and MCP results can contain text blocks as well as images. Decode the envelope once, without interpreting
// the file's own text as JSON. Older project results have one extra JSON envelope inside their single text block.
export function toolPictures(output: string, project = false) {
  if (!output.startsWith('[')) return null;
  let blocks: unknown;
  try {
    blocks = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const text: string[] = [];
  const pictures: ToolPicture[] = [];
  for (const block of blocks as {
    type?: unknown;
    text?: unknown;
    source?: { type?: unknown; media_type?: unknown; data?: unknown };
  }[]) {
    const source = block?.source;
    if (block?.type === 'text' && typeof block.text === 'string') {
      let value = block.text;
      if (project && blocks.length === 1) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const { text: body, output, ...metadata } = parsed;
            if (typeof body === 'string' || typeof output === 'string')
              value = [Object.keys(metadata).length ? JSON.stringify(metadata) : '', body ?? output]
                .filter((part) => part !== '')
                .join('\n');
          }
        } catch {
          /* Plain text, already readable. */
        }
      }
      text.push(value);
    } else if (
      block?.type === 'image' &&
      source?.type === 'base64' &&
      typeof source.media_type === 'string' &&
      /^image\/(?:png|jpeg|gif|webp)$/.test(source.media_type) &&
      typeof source.data === 'string'
    )
      pictures.push({ type: source.media_type, data: source.data });
    else return null;
  }
  return { text: text.join('\n'), pictures };
}
export const pictureUrl = (picture: ToolPicture) => `data:${picture.type};base64,${picture.data}`;
// What stands for a picture in text: its type and about how large it is.
export const pictureNote = (picture: ToolPicture) =>
  `[图片 ${picture.type} · ${Math.max(1, Math.round((picture.data.length * 3) / 4 / 1024))} KB]`;
