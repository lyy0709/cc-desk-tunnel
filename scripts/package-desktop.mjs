import { builtinModules, createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { build as viteBuild } from 'vite';

// Both clients redistribute the project and a statically linked Go helper.
export function stageClientLicenses(root, directory) {
  mkdirSync(directory, { recursive: true });
  for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, name), join(directory, name));
  const goRoot = execFileSync('go', ['env', 'GOROOT'], {
    cwd: join(root, 'packages/project-files'),
    encoding: 'utf8',
  }).trim();
  cpSync(join(goRoot, 'LICENSE'), join(directory, 'LICENSE-Go'));
}

// A package the program loads by name while it runs, copied with what it depends on. Compiled add-ons are
// left out: they are optional speed-ups built for the Node of the machine that installed them, not for the
// Electron of the package, and the package falls back to its JavaScript.
function copyDependency(root, app, name, copied = new Set()) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = dirname(createRequire(join(root, 'package.json')).resolve(`${name}/package.json`));
  const destination = join(app, 'node_modules', name);
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !/(?:^|[\\/])(?:node_modules|test|tests|examples|build)(?:[\\/]|$)/.test(
        path.slice(source.length),
      ) && !path.endsWith('.node'),
  });
  const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  delete manifest.optionalDependencies;
  delete manifest.scripts;
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyDependency(root, app, dependency, copied);
  return manifest.version;
}

// Lays out what goes into the application archive, the same way for every system: the page, the connection
// bridge with what it imports bundled into one file, and the main process's own modules as written.
export async function stageDesktop(root, app, { description, files = [] }) {
  mkdirSync(app, { recursive: true });
  const licenses = join(app, 'licenses');
  stageClientLicenses(root, licenses);
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    cpSync(
      join(root, 'node_modules/electron/dist', name),
      join(licenses, name === 'LICENSE' ? 'LICENSE-Electron' : name),
    );
  }
  rmSync(join(app, 'node_modules'), { recursive: true, force: true });
  await viteBuild({
    root: join(root, 'apps/desktop'),
    build: { outDir: join(app, 'dist'), emptyOutDir: true },
  });
  await viteBuild({
    configFile: false,
    root,
    define: { 'process.platform': JSON.stringify(process.platform) },
    ssr: { noExternal: true },
    build: {
      ssr: true,
      license: { fileName: 'THIRD-PARTY-bridge.md' },
      target: 'node24',
      outDir: join(app, 'electron'),
      emptyOutDir: true,
      rolldownOptions: {
        input: join(root, 'apps/desktop/electron/proxy-bridge.mjs'),
        external: [
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
          'bufferutil',
          'utf-8-validate',
        ],
        output: { format: 'es', entryFileNames: 'proxy-bridge.mjs', codeSplitting: false },
      },
    },
  });
  // All CommonJS modules ship as written, including helpers required by main/preload.
  // The ESM bridge and its dependencies are already in the bundle above; the release download and opening a
  // session in ccdt need only Node.
  const commonjs = readdirSync(join(root, 'apps/desktop/electron')).filter((file) =>
    file.endsWith('.cjs'),
  );
  for (const file of [
    ...commonjs,
    'history-page.mjs',
    'release-download.mjs',
    'ccdt.mjs',
    'icon.png',
    ...files,
  ])
    cpSync(join(root, 'apps/desktop/electron', file), join(app, 'electron', file));
  // A file the main process loads by path is only missed when its feature is used, so each is looked for here.
  for (const file of commonjs)
    for (const [, name] of readFileSync(join(app, 'electron', file), 'utf8').matchAll(
      /path\.join\(__dirname, '([^']+)'\)/g,
    ))
      if (!name.startsWith('../vendor') && !existsSync(join(app, 'electron', name)))
        throw new Error(`${file} loads ${name}, which is not in the package.`);
  const runtime = ['diff', 'ignore'];
  const versions = Object.fromEntries(
    runtime.map((name) => [name, copyDependency(root, app, name)]),
  );
  const desktop = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
  // The staging manifest names only what was copied beside the bundle: the bridge and protocol are in it.
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'cc-desk-tunnel',
        productName: 'CC Desk Tunnel',
        // The desktop workspace manifest is the single source of the client version.
        version: desktop.version,
        repository: desktop.repository,
        description,
        author: 'CC Desk Tunnel contributors',
        private: true,
        main: 'electron/main.cjs',
        type: 'module',
        dependencies: versions,
      },
      null,
      2,
    ) + '\n',
  );
}
