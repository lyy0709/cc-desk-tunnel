// Files that replies link to. A link is one click away, and a reply may have been written to what a web page
// told the model, so what a click does to a file is decided here rather than by the page.
const { open, stat } = require('node:fs/promises');
const { isAbsolute } = require('node:path');

// Code editors that open a file at a line from an address of their own, e.g. vscode://file/C:/a.ts:12:3. They
// are offered where the system knows their scheme; none of them is started by hand.
const editors = [
  { scheme: 'vscode', name: 'VS Code' },
  { scheme: 'cursor', name: 'Cursor' },
  { scheme: 'windsurf', name: 'Windsurf' },
  { scheme: 'vscodium', name: 'VSCodium' },
];
function editorUrl(scheme, file, line, column) {
  const forward = file.replaceAll('\\', '/');
  const encoded = encodeURI(forward).replaceAll('#', '%23').replaceAll('?', '%3F');
  const position = line ? `:${line}${column ? `:${column}` : ''}` : '';
  return `${scheme}://file${forward.startsWith('/') ? '' : '/'}${encoded}${position}`;
}

// What the system would run, or follow elsewhere, when it opens a file: such a file is shown in its folder
// instead. The system says most of it itself: on Windows the types it runs as commands (PATHEXT, which an
// installed interpreter adds its own to), elsewhere the permission to execute, and on macOS an application
// bundle. The kinds it does not count there, though opening them installs, runs a script or goes where a
// shortcut points, are listed here, after the dangerous types of Chromium's download protection.
const fallbackPathext = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';
const unlisted = {
  win32: `.appinstaller .application .appref-ms .appx .appxbundle .chm .diagcab .gadget .hta .inf .jar .library-ms
    .lnk .msi .msix .msixbundle .msp .mst .pif .ps1 .psd1 .psm1 .reg .scf .scr .search-ms .searchconnector-ms
    .settingcontent-ms .url .website .ws .wsc .xll`,
  darwin:
    '.action .app .command .fileloc .inetloc .jar .mpkg .pkg .terminal .tool .webloc .workflow',
  linux: '.appimage .desktop .jar .run',
};
const extensionOf = (file) => /\.[^.\\/]+$/.exec(file)?.[0].toLowerCase() ?? '';
function runs(file, { platform, directory, mode = 0, pathext }) {
  const extension = extensionOf(file);
  if (directory) return platform === 'darwin' && extension === '.app';
  if (platform !== 'win32' && mode & 0o111) return true;
  const listed = (unlisted[platform] ?? '').split(/\s+/);
  if (platform === 'win32')
    listed.push(...(pathext || fallbackPathext).toLowerCase().split(';').filter(Boolean));
  return !!extension && listed.includes(extension);
}

// A path the page may ask about: absolute, on this computer. One on another computer's share is not touched at
// all, since even looking at it would have Windows sign in there.
function localPath(value, isAbsolute) {
  const written = String(value);
  if (!written || /^[\\/]{2}/.test(written) || written.includes('\0') || !isAbsolute(written))
    return null;
  return written;
}

// Pictures a reply shows from this computer reach the page by an address of their own, which serves nothing
// else.
const pictureTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
const pictureLimit = 20 * 1024 * 1024;
function pictureOf(url) {
  const address = new URL(url);
  if (address.host !== 'file') return null;
  const file = decodeURIComponent(address.pathname.slice(1));
  const type = pictureTypes[extensionOf(file)];
  return type ? { file, type } : null;
}

// Only a bounded prefix is read, and nothing is interpreted as HTML, Markdown or a command.
async function previewText(target) {
  const file = localPath(target, isAbsolute);
  if (!file) throw new Error('只能预览本机的绝对路径。');
  const found = await stat(file);
  if (!found.isFile()) throw new Error('这个路径不是普通文件。');
  const extension = extensionOf(file);
  if (
    pictureTypes[extension] ||
    /^\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|rar|7z|gz|tar|exe|dll|dmg)$/i.test(extension)
  )
    return { kind: 'unsupported' };
  const limit = 1024 * 1024;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncatedBytes = (await handle.stat()).size > bytesRead;
    const bytes = buffer.subarray(0, Math.min(bytesRead, limit));
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
    let text;
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncatedBytes });
    } catch {
      return { kind: 'unsupported' };
    }
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) return { kind: 'unsupported' };
    const lines = text.split('\n', 10001);
    const prefix = lines.slice(0, 10000).join('\n');
    const truncatedLines =
      lines.length > 10000 && (lines[10000] !== '' || prefix.length + 1 < text.length);
    return {
      kind: 'text',
      text: truncatedLines ? prefix : text,
      truncated: truncatedBytes || truncatedLines,
    };
  } finally {
    await handle.close();
  }
}

module.exports = { editors, editorUrl, runs, localPath, pictureOf, pictureLimit, previewText };
