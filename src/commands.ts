import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec as defaultExec, execFile as defaultExecFile, spawn as defaultSpawn, SpawnOptions, ChildProcess } from 'child_process';

type ExecFn = (cmd: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

// Quote an argument for cmd.exe when spawning with `shell: true` on Windows.
// Node does NOT auto-quote args when shell:true is set with an array form,
// so anything containing whitespace or cmd.exe metacharacters (parentheses,
// ampersands, pipes, redirects, carets, quotes) must be wrapped in double
// quotes manually, with embedded `"` doubled up. Without this, a path like
//   d:\folder\name (1).zip
// gets tokenised by cmd.exe as two tokens (`d:\folder\name` and `(1).zip`)
// and the receiving CLI sees a bogus second positional argument.
function quoteShellArg(a: string): string {
  if (/[\s()&|<>^"]/.test(a)) {
    return `"${a.replace(/"/g, '""')}"`;
  }
  return a;
}

type GitResult = { stdout: string; stderr: string; error: Error | null };
type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const defaultGitRunner: GitRunner = (args, cwd) => new Promise((resolve) => {
  defaultExecFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    resolve({
      stdout: stdout ? stdout.toString() : '',
      stderr: stderr ? stderr.toString() : '',
      error
    });
  });
});

async function resolveRepoRoot(target: string, runner: GitRunner): Promise<string | null> {
  const cwd = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const res = await runner(['rev-parse', '--show-toplevel'], cwd);
  if (res.error) { return null; }
  return res.stdout.trim();
}

export async function gitPush(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  runner: GitRunner = defaultGitRunner,
  promptMessage: (placeHolder: string) => Thenable<string | undefined> =
    (placeHolder) => vscode.window.showInputBox({
      prompt: 'Commit message',
      placeHolder,
      validateInput: (v) => v.trim().length === 0 ? 'Commit message cannot be empty' : null
    })
): Promise<void> {
  const target = resourceUri.fsPath;
  outputChannel.show(true);

  const repoRoot = await resolveRepoRoot(target, runner);
  if (!repoRoot) {
    vscode.window.showErrorMessage('Not a git repository.');
    return;
  }

  const status = await runner(['status', '--porcelain', '--', target], repoRoot);
  if (status.error) {
    outputChannel.appendLine(status.stderr);
    vscode.window.showErrorMessage('Failed to check git status.');
    return;
  }
  if (!status.stdout.trim()) {
    vscode.window.showInformationMessage('No uncommitted changes in the selected path.');
    return;
  }

  const msg = await promptMessage(`Update ${path.basename(target)}`);
  if (msg === undefined) { return; }
  const commitMessage = msg.trim();
  if (!commitMessage) { return; }

  const branchRes = await runner(['branch', '--show-current'], repoRoot);
  const branch = branchRes.stdout.trim();
  if (!branch) {
    vscode.window.showErrorMessage('Could not determine current branch (detached HEAD?).');
    return;
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Pushing ${path.basename(target)} to ${branch}`,
    cancellable: false
  }, async (progress) => {
    progress.report({ message: 'Staging changes...' });
    outputChannel.appendLine(`Running: git add -- ${target}`);
    const addRes = await runner(['add', '--', target], repoRoot);
    if (addRes.error) {
      outputChannel.appendLine(addRes.stderr);
      vscode.window.showErrorMessage('git add failed. See output for details.');
      return;
    }

    progress.report({ message: 'Committing...' });
    outputChannel.appendLine(`Running: git commit -m "${commitMessage}" -- ${target}`);
    const commitRes = await runner(['commit', '-m', commitMessage, '--', target], repoRoot);
    if (commitRes.stdout) { outputChannel.appendLine(commitRes.stdout); }
    if (commitRes.stderr) { outputChannel.appendLine(commitRes.stderr); }
    if (commitRes.error) {
      vscode.window.showErrorMessage('git commit failed. See output for details.');
      return;
    }

    progress.report({ message: `Pushing to origin/${branch}...` });
    outputChannel.appendLine(`Running: git push origin ${branch}`);
    const pushRes = await runner(['push', 'origin', branch], repoRoot);
    if (pushRes.stdout) { outputChannel.appendLine(pushRes.stdout); }
    if (pushRes.stderr) { outputChannel.appendLine(pushRes.stderr); }
    if (pushRes.error) {
      vscode.window.showErrorMessage('git push failed. See output for details.');
      return;
    }

    vscode.window.showInformationMessage(`Pushed "${path.basename(target)}" to ${branch}.`);
  });
}

export async function gitDiscard(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  runner: GitRunner = defaultGitRunner,
  confirm: (name: string) => Thenable<string | undefined> =
    (name) => vscode.window.showWarningMessage(
      `Discard all uncommitted changes in "${name}"? This cannot be undone.`,
      { modal: true },
      'Discard'
    )
): Promise<void> {
  const target = resourceUri.fsPath;
  outputChannel.show(true);

  const repoRoot = await resolveRepoRoot(target, runner);
  if (!repoRoot) {
    vscode.window.showErrorMessage('Not a git repository.');
    return;
  }

  const status = await runner(['status', '--porcelain', '--', target], repoRoot);
  if (status.error) {
    outputChannel.appendLine(status.stderr);
    vscode.window.showErrorMessage('Failed to check git status.');
    return;
  }
  if (!status.stdout.trim()) {
    vscode.window.showInformationMessage('No uncommitted changes in the selected path.');
    return;
  }

  const choice = await confirm(path.basename(target));
  if (choice !== 'Discard') { return; }

  outputChannel.appendLine(`Running: git restore --source=HEAD --staged --worktree -- ${target}`);
  const restoreRes = await runner(['restore', '--source=HEAD', '--staged', '--worktree', '--', target], repoRoot);
  if (restoreRes.stdout) { outputChannel.appendLine(restoreRes.stdout); }
  if (restoreRes.stderr) { outputChannel.appendLine(restoreRes.stderr); }

  outputChannel.appendLine(`Running: git clean -fd -- ${target}`);
  const cleanRes = await runner(['clean', '-fd', '--', target], repoRoot);
  if (cleanRes.stdout) { outputChannel.appendLine(cleanRes.stdout); }
  if (cleanRes.stderr) { outputChannel.appendLine(cleanRes.stderr); }
  if (cleanRes.error) {
    vscode.window.showErrorMessage('git clean failed. See output for details.');
    return;
  }

  vscode.window.showInformationMessage(`Discarded changes in "${path.basename(target)}".`);
}

export function clearNugetCache(
  outputChannel: vscode.OutputChannel,
  execFn: ExecFn = defaultExec as any
): Promise<void> {
  return new Promise((resolve) => {
    outputChannel.show(true);
    outputChannel.appendLine('Running: dotnet nuget locals all --clear ...');

    execFn('dotnet nuget locals all --clear', (error, stdout, stderr) => {
      if (error) {
        outputChannel.appendLine(`Error: ${error.message}`);
        if (stderr) {
          outputChannel.appendLine(stderr);
        }
        vscode.window.showErrorMessage('Failed to clear NuGet cache. See output for details.');
      } else {
        outputChannel.appendLine(stdout);
        vscode.window.showInformationMessage('NuGet cache cleared successfully.');
      }
      resolve();
    });
  });
}

export function killVBCSCompiler(
  outputChannel: vscode.OutputChannel,
  execFn: ExecFn = defaultExec as any
): Promise<void> {
  return new Promise((resolve) => {
    outputChannel.show(true);
    outputChannel.appendLine('Running: taskkill /IM VBCSCompiler.exe /F ...');

    execFn('taskkill /IM VBCSCompiler.exe /F', (error, stdout, stderr) => {
      if (error) {
        if (stderr && stderr.includes('not found')) {
          outputChannel.appendLine('No VBCSCompiler processes found running.');
          vscode.window.showInformationMessage('No VBCSCompiler processes found running.');
        } else {
          outputChannel.appendLine(`Error: ${error.message}`);
          if (stderr) {
            outputChannel.appendLine(stderr);
          }
          vscode.window.showErrorMessage('Failed to kill VBCSCompiler. See output for details.');
        }
      } else {
        outputChannel.appendLine(stdout);
        vscode.window.showInformationMessage('VBCSCompiler processes killed.');
      }
      resolve();
    });
  });
}

const PUBLISH_SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.svn', '.hg']);

function isSlnLike(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.sln') || lower.endsWith('.slnx');
}

function resolvePublishTargets(
  resourcePath: string,
  fsFns: { readdirSync: typeof fs.readdirSync; statSync: typeof fs.statSync }
): string[] {
  const stat = fsFns.statSync(resourcePath);
  if (!stat.isDirectory()) {
    const lower = resourcePath.toLowerCase();
    if (lower.endsWith('.csproj') || isSlnLike(resourcePath)) { return [resourcePath]; }
    return [];
  }

  let directEntries: string[];
  try { directEntries = fsFns.readdirSync(resourcePath) as string[]; } catch { return []; }
  const directSln = directEntries.find(isSlnLike);
  if (directSln) { return [path.join(resourcePath, directSln)]; }
  const directCsproj = directEntries.find((f) => f.toLowerCase().endsWith('.csproj'));
  if (directCsproj) { return [path.join(resourcePath, directCsproj)]; }

  const slns: string[] = [];
  const csprojs: string[] = [];
  const walk = (dir: string) => {
    let items: string[];
    try { items = fsFns.readdirSync(dir) as string[]; } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item);
      if (isSlnLike(item)) { slns.push(full); continue; }
      if (item.toLowerCase().endsWith('.csproj')) { csprojs.push(full); continue; }
      if (PUBLISH_SKIP_DIRS.has(item)) { continue; }
      let st: fs.Stats;
      try { st = fsFns.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); }
    }
  };
  walk(resourcePath);

  return slns.length > 0 ? slns : csprojs;
}

export async function dotnetPublish(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any,
  fsFns: { existsSync: typeof fs.existsSync; readdirSync: typeof fs.readdirSync; statSync: typeof fs.statSync } = fs
): Promise<void> {
  const targets = resolvePublishTargets(resourceUri.fsPath, fsFns);
  if (targets.length === 0) {
    vscode.window.showWarningMessage('Publish requires a .csproj, .sln, or .slnx file — none found at the selected path.');
    return;
  }

  outputChannel.show(true);
  if (targets.length > 1) {
    outputChannel.appendLine(`Publishing ${targets.length} project(s)/solution(s):`);
    for (const t of targets) { outputChannel.appendLine(`  ${t}`); }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: targets.length === 1
        ? `Publishing ${path.basename(targets[0])}`
        : `Publishing ${targets.length} targets`,
      cancellable: true
    },
    async (progress, token) => {
      let failed = 0;
      for (let i = 0; i < targets.length; i++) {
        if (token.isCancellationRequested) { break; }
        const target = targets[i];
        const prefix = targets.length > 1 ? `(${i + 1}/${targets.length}) ` : '';
        progress.report({ message: `${prefix}${path.basename(target)}` });
        outputChannel.appendLine(`Running: dotnet publish "${target}" -c Release ...`);

        const ok = await new Promise<boolean>((resolve) => {
          const child = spawnFn('dotnet', ['publish', target, '-c', 'Release'], { shell: true });
          let cancelled = false;
          const sub = token.onCancellationRequested(() => {
            cancelled = true;
            outputChannel.appendLine('Cancellation requested — stopping dotnet publish ...');
            child.kill();
          });

          const stream = (chunk: Buffer | string) => {
            const text = chunk.toString();
            for (const line of text.split(/\r?\n/)) {
              if (line.length > 0) {
                outputChannel.appendLine(line);
                progress.report({ message: `${prefix}${line.length > 80 ? line.slice(0, 77) + '...' : line}` });
              }
            }
          };

          child.stdout?.on('data', stream);
          child.stderr?.on('data', stream);
          child.on('error', (err) => {
            sub.dispose();
            outputChannel.appendLine(`Error: ${err.message}`);
            resolve(false);
          });
          child.on('close', (code) => {
            sub.dispose();
            if (cancelled) {
              outputChannel.appendLine(`Publish of "${path.basename(target)}" cancelled.`);
              resolve(false);
            } else if (code === 0) {
              outputChannel.appendLine(`Published "${path.basename(target)}".`);
              resolve(true);
            } else {
              outputChannel.appendLine(`Publish of "${path.basename(target)}" failed (exit ${code}).`);
              resolve(false);
            }
          });
        });

        if (!ok) { failed++; }
        if (token.isCancellationRequested) { break; }
      }

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('dotnet publish cancelled.');
      } else if (failed === 0) {
        vscode.window.showInformationMessage(`Published ${targets.length} target(s) successfully.`);
      } else {
        vscode.window.showErrorMessage(`dotnet publish failed for ${failed} of ${targets.length} target(s). See output for details.`);
      }
    }
  );
}

const WIPE_SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.svn', '.hg']);

function findCsprojFolders(
  root: string,
  fsFns: { readdirSync: typeof fs.readdirSync; statSync: typeof fs.statSync }
): string[] {
  const result = new Set<string>();

  const walk = (dir: string) => {
    let entries: string[];
    try { entries = fsFns.readdirSync(dir) as string[]; } catch { return; }

    let hasCsproj = false;
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.csproj')) {
        hasCsproj = true;
        continue;
      }
      if (WIPE_SKIP_DIRS.has(entry)) { continue; }
      const full = path.join(dir, entry);
      let st: fs.Stats;
      try { st = fsFns.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); }
    }

    if (hasCsproj) { result.add(dir); }
  };

  walk(root);
  return Array.from(result);
}

export async function dotnetWipe(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  execFn: ExecFn = defaultExec as any,
  fsFns: {
    existsSync: typeof fs.existsSync;
    readdirSync: typeof fs.readdirSync;
    statSync: typeof fs.statSync;
  } = fs
): Promise<void> {
  const resourcePath = resourceUri.fsPath;

  let targetFolders: string[];
  const stat = fsFns.statSync(resourcePath);
  if (!stat.isDirectory()) {
    if (!resourcePath.toLowerCase().endsWith('.csproj')) {
      vscode.window.showWarningMessage('.NET Wipe is only available for .csproj files or project folders.');
      return;
    }
    targetFolders = [path.dirname(resourcePath)];
  } else {
    targetFolders = findCsprojFolders(resourcePath, fsFns);
    if (targetFolders.length === 0) {
      vscode.window.showWarningMessage('No .csproj file found in this folder or any subfolder.');
      return;
    }
  }

  outputChannel.show(true);
  outputChannel.appendLine(`Target project folder(s) (${targetFolders.length}):`);
  for (const f of targetFolders) { outputChannel.appendLine(`  ${f}`); }

  await killVBCSCompiler(outputChannel, execFn);

  const foldersToDelete: string[] = [];
  for (const folder of targetFolders) {
    const binPath = path.join(folder, 'bin');
    const objPath = path.join(folder, 'obj');
    if (fsFns.existsSync(binPath)) { foldersToDelete.push(`"${binPath}"`); }
    if (fsFns.existsSync(objPath)) { foldersToDelete.push(`"${objPath}"`); }
  }

  if (foldersToDelete.length === 0) {
    outputChannel.appendLine('No bin/ or obj/ folders found. Nothing to delete.');
    vscode.window.showInformationMessage('No bin/ or obj/ folders to delete.');
    return;
  }

  const psCommand = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -Command ${foldersToDelete.map(f => `Remove-Item -Recurse -Force ${f}`).join('; ')}'`;

  outputChannel.appendLine(`Deleting ${foldersToDelete.length} bin/obj folder(s) as admin ...`);

  return new Promise((resolve) => {
    execFn(`powershell -NoProfile -Command "${psCommand}"`, (error, stdout, stderr) => {
      if (error) {
        outputChannel.appendLine(`Error: ${error.message}`);
        if (stderr) { outputChannel.appendLine(stderr); }
        vscode.window.showErrorMessage('Failed to delete bin/obj folders. See output for details.');
      } else {
        if (stdout) { outputChannel.appendLine(stdout); }
        outputChannel.appendLine('bin/ and obj/ folders deleted successfully.');
        vscode.window.showInformationMessage('.NET Wipe completed — bin/ and obj/ deleted.');
      }
      resolve();
    });
  });
}

function stripJsonComments(text: string): string {
  let result = text.replace(/\/\*[\s\S]*?\*\//g, '');
  result = result.split('\n').map(line => {
    let inString = false;
    let escape = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (!inString && c === '/' && line[i + 1] === '/') {
        return line.slice(0, i);
      }
    }
    return line;
  }).join('\n');
  result = result.replace(/,(\s*[}\]])/g, '$1');
  return result;
}

export async function generateSnippetPrefixes(
  folderUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  fsFns: {
    existsSync: typeof fs.existsSync;
    readdirSync: typeof fs.readdirSync;
    readFileSync: typeof fs.readFileSync;
    writeFileSync: typeof fs.writeFileSync;
    mkdirSync: typeof fs.mkdirSync;
  } = fs
): Promise<void> {
  const folderPath = folderUri.fsPath;
  outputChannel.show(true);

  if (path.basename(folderPath) !== '.vscode') {
    vscode.window.showWarningMessage('This command must be run on a .vscode folder.');
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder found for this path.');
    return;
  }
  const workspaceRoot = workspaceFolder.uri.fsPath;

  const snippetFiles = fsFns.readdirSync(folderPath).filter((f: string) => f.endsWith('.code-snippets'));
  if (snippetFiles.length === 0) {
    outputChannel.appendLine('No .code-snippets files found in this .vscode folder.');
    vscode.window.showWarningMessage('No .code-snippets files found.');
    return;
  }

  const outputDir = path.join(workspaceRoot, 'snippet-prefixes');
  if (!fsFns.existsSync(outputDir)) {
    fsFns.mkdirSync(outputDir, { recursive: true });
  }

  let written = 0;
  for (const file of snippetFiles) {
    const snippetPath = path.join(folderPath, file);
    const raw = fsFns.readFileSync(snippetPath, 'utf8').toString();

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch (err) {
      outputChannel.appendLine(`Failed to parse ${file}: ${(err as Error).message}`);
      continue;
    }

    const prefixes: string[] = [];
    for (const key of Object.keys(parsed)) {
      const snippet = parsed[key];
      if (!snippet || typeof snippet !== 'object') { continue; }
      const prefix = snippet.prefix;
      if (typeof prefix === 'string') {
        prefixes.push(prefix);
      } else if (Array.isArray(prefix)) {
        for (const p of prefix) {
          if (typeof p === 'string') { prefixes.push(p); }
        }
      }
    }

    const ps1Name = file.replace(/\.code-snippets$/, '.ps1');
    const ps1Path = path.join(outputDir, ps1Name);
    fsFns.writeFileSync(ps1Path, prefixes.join('\n'));
    outputChannel.appendLine(`Wrote ${prefixes.length} prefix(es) to ${ps1Path}`);
    written++;
  }

  vscode.window.showInformationMessage(`Generated ${written} PS1 file(s) in snippet-prefixes/.`);
}

export function killDotnetProcesses(
  outputChannel: vscode.OutputChannel,
  execFn: ExecFn = defaultExec as any
): Promise<void> {
  return new Promise((resolve) => {
    outputChannel.show(true);
    outputChannel.appendLine('Running: taskkill /IM dotnet.exe /F ...');

    execFn('taskkill /IM dotnet.exe /F', (error, stdout, stderr) => {
      if (error) {
        if (stderr && stderr.includes('not found')) {
          outputChannel.appendLine('No .NET processes found running.');
          vscode.window.showInformationMessage('No .NET processes found running.');
        } else {
          outputChannel.appendLine(`Error: ${error.message}`);
          if (stderr) {
            outputChannel.appendLine(stderr);
          }
          vscode.window.showErrorMessage('Failed to kill .NET processes. See output for details.');
        }
      } else {
        outputChannel.appendLine(stdout);
        vscode.window.showInformationMessage('All .NET processes killed.');
      }
      resolve();
    });
  });
}

export const DEVKIT_FOLDER_NAME = 'tools-devkit-build';
const DEFAULT_LOCAL_FEED = 'C:\\NuGetLocal';
const DEVKIT_CONFIG_FILE = 'zekelin-dotnet-tools.json';

export function getDevkitBuildRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (path.basename(folder.uri.fsPath) === DEVKIT_FOLDER_NAME) {
      return folder.uri.fsPath;
    }
  }
  return undefined;
}

export type DataverseEnvironment = { name: string; id: string; url: string };

export const dataverseEnvironmentsChanged = new vscode.EventEmitter<void>();

function getCacheRoot(): string | undefined {
  const devkit = getDevkitBuildRoot();
  if (devkit) { return devkit; }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) { return folders[0].uri.fsPath; }
  return undefined;
}

function readCacheConfig(root: string): { [key: string]: any } {
  const configPath = path.join(root, '.vscode', DEVKIT_CONFIG_FILE);
  if (!fs.existsSync(configPath)) { return {}; }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function writeCacheConfig(root: string, cfg: { [key: string]: any }): void {
  const configDir = path.join(root, '.vscode');
  const configPath = path.join(configDir, DEVKIT_CONFIG_FILE);
  if (!fs.existsSync(configDir)) { fs.mkdirSync(configDir, { recursive: true }); }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function getDataverseEnvironments(): DataverseEnvironment[] {
  const root = getCacheRoot();
  if (!root) { return []; }
  const cfg = readCacheConfig(root);
  const raw = cfg.environments;
  if (!Array.isArray(raw)) { return []; }
  return raw
    .filter((e) => e && typeof e === 'object')
    .map((e: any) => ({
      name: typeof e.name === 'string' ? e.name : '',
      id: typeof e.id === 'string' ? e.id : '',
      url: typeof e.url === 'string' ? e.url : ''
    }));
}

export async function addDataverseEnvironment(
  outputChannel: vscode.OutputChannel
): Promise<DataverseEnvironment | undefined> {
  const root = getCacheRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before adding a Dataverse environment.');
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Environment name',
    placeHolder: 'e.g. Dev, QA, Prod',
    validateInput: (v) => v.trim().length === 0 ? 'Name is required' : null
  });
  if (name === undefined) { return undefined; }

  const id = await vscode.window.showInputBox({
    prompt: 'Environment ID (GUID)',
    placeHolder: 'optional, e.g. 00000000-0000-0000-0000-000000000000'
  });
  if (id === undefined) { return undefined; }

  const url = await vscode.window.showInputBox({
    prompt: 'Environment URL',
    placeHolder: 'https://yourorg.crm.dynamics.com/'
  });
  if (url === undefined) { return undefined; }

  const env: DataverseEnvironment = { name: name.trim(), id: id.trim(), url: url.trim() };
  if (!env.url && !env.id && !env.name) {
    vscode.window.showErrorMessage('Environment must have at least a name, id, or url.');
    return undefined;
  }

  const cfg = readCacheConfig(root);
  const list: DataverseEnvironment[] = Array.isArray(cfg.environments) ? cfg.environments : [];
  list.push(env);
  cfg.environments = list;
  writeCacheConfig(root, cfg);

  const configPath = path.join(root, '.vscode', DEVKIT_CONFIG_FILE);
  outputChannel.appendLine(`Added environment "${env.name}" to ${configPath}`);
  vscode.window.showInformationMessage(`Added Dataverse environment "${env.name}".`);
  dataverseEnvironmentsChanged.fire();
  return env;
}

async function pickDataverseEnvironment(
  outputChannel: vscode.OutputChannel
): Promise<DataverseEnvironment | undefined> {
  const envs = getDataverseEnvironments();
  type Item = vscode.QuickPickItem & { env?: DataverseEnvironment; addNew?: boolean };
  const items: Item[] = envs.map((e) => ({
    label: e.name || '(unnamed)',
    description: e.url || e.id || '',
    env: e
  }));
  items.push({ label: '$(add) Add new environment...', addNew: true });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: envs.length === 0 ? 'No environments saved — add one to continue' : 'Select Dataverse environment'
  });
  if (!picked) { return undefined; }
  if (picked.addNew) { return addDataverseEnvironment(outputChannel); }
  return picked.env;
}

function dataverseEnvironmentTarget(env: DataverseEnvironment): string {
  return env.url || env.id || env.name;
}

async function runPacStream(
  args: string[],
  outputChannel: vscode.OutputChannel,
  title: string,
  spawnFn: SpawnFn
): Promise<{ ok: boolean; code: number | null }> {
  const res = await runPacCapture(args, outputChannel, title, spawnFn);
  return { ok: res.ok, code: res.code };
}

async function runPacCapture(
  args: string[],
  outputChannel: vscode.OutputChannel,
  title: string,
  spawnFn: SpawnFn
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  const quoted = args.map(quoteShellArg);
  const printable = `pac ${quoted.join(' ')}`;
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    },
    () =>
      new Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>((resolve) => {
        outputChannel.appendLine(`Running: ${printable}`);
        const child = spawnFn('pac', quoted, { shell: true });
        let stdout = '';
        let stderr = '';
        const streamOut = (chunk: Buffer | string) => {
          const text = chunk.toString();
          stdout += text;
          for (const line of text.split(/\r?\n/)) {
            if (line.length > 0) { outputChannel.appendLine(line); }
          }
        };
        const streamErr = (chunk: Buffer | string) => {
          const text = chunk.toString();
          stderr += text;
          for (const line of text.split(/\r?\n/)) {
            if (line.length > 0) { outputChannel.appendLine(line); }
          }
        };
        child.stdout?.on('data', streamOut);
        child.stderr?.on('data', streamErr);
        child.on('error', (err) => {
          outputChannel.appendLine(`Error: ${err.message}`);
          resolve({ ok: false, code: null, stdout, stderr: stderr + err.message });
        });
        child.on('close', (code) => {
          resolve({ ok: code === 0, code, stdout, stderr });
        });
      })
  );
}

function parsePacAdminCreateOutput(output: string): { url: string; id: string; name: string } | undefined {
  const lines = output.split(/\r?\n/);
  const expectedColumns = [
    'Environment Url',
    'Environment ID',
    'Friendly Name',
    'Domain Name',
    'Organization ID',
    'Version'
  ];

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('Environment Url') && l.includes('Environment ID') && l.includes('Friendly Name')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) { return undefined; }

  const header = lines[headerIdx];
  const positions: { name: string; start: number }[] = [];
  for (const col of expectedColumns) {
    const start = header.indexOf(col);
    if (start !== -1) { positions.push({ name: col, start }); }
  }
  positions.sort((a, b) => a.start - b.start);

  let dataLine: string | undefined;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { continue; }
    if (/^[-\s]+$/.test(l)) { continue; }
    dataLine = l;
    break;
  }
  if (!dataLine) { return undefined; }

  const fields: { [key: string]: string } = {};
  for (let i = 0; i < positions.length; i++) {
    const { name, start } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : dataLine.length;
    const slice = dataLine.slice(Math.min(start, dataLine.length), Math.min(end, dataLine.length));
    fields[name] = slice.trim();
  }

  const url = fields['Environment Url'] || '';
  const id = fields['Environment ID'] || '';
  const name = fields['Friendly Name'] || '';
  if (!url && !id && !name) { return undefined; }
  return { url, id, name };
}

export async function createDataverseEnvironment(
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any
): Promise<DataverseEnvironment | undefined> {
  const root = getCacheRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder before creating a Dataverse environment.');
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Environment name',
    placeHolder: 'e.g. Zektestenv2',
    validateInput: (v) => v.trim().length === 0 ? 'Name is required' : null
  });
  if (name === undefined) { return undefined; }
  const trimmedName = name.trim();
  if (!trimmedName) { return undefined; }

  outputChannel.show(true);

  const res = await runPacCapture(
    ['admin', 'create', '--name', trimmedName, '--currency', 'EUR', '--region', 'europe', '--type', 'Developer'],
    outputChannel,
    `Creating Dataverse environment "${trimmedName}"`,
    spawnFn
  );

  if (!res.ok) {
    outputChannel.appendLine(`Create failed (exit ${res.code}).`);
    vscode.window.showErrorMessage('Failed to create Dataverse environment. See output for details.');
    return undefined;
  }

  const parsed = parsePacAdminCreateOutput(res.stdout);
  if (!parsed) {
    outputChannel.appendLine('Could not parse Environment Url / ID / Friendly Name from pac output. Environment was not added to the cache.');
    vscode.window.showWarningMessage('Environment created, but its details could not be parsed from pac output. Add it manually via "Add environment".');
    return undefined;
  }

  const env: DataverseEnvironment = {
    name: parsed.name || trimmedName,
    id: parsed.id,
    url: parsed.url
  };

  const cfg = readCacheConfig(root);
  const list: DataverseEnvironment[] = Array.isArray(cfg.environments) ? cfg.environments : [];
  list.push(env);
  cfg.environments = list;
  writeCacheConfig(root, cfg);

  const configPath = path.join(root, '.vscode', DEVKIT_CONFIG_FILE);
  outputChannel.appendLine(`Created environment "${env.name}" (id=${env.id}, url=${env.url}) and saved to ${configPath}`);
  vscode.window.showInformationMessage(`Created Dataverse environment "${env.name}".`);
  dataverseEnvironmentsChanged.fire();
  return env;
}

function removeEnvironmentFromCache(root: string, target: DataverseEnvironment): boolean {
  const cfg = readCacheConfig(root);
  const list: DataverseEnvironment[] = Array.isArray(cfg.environments) ? cfg.environments : [];
  const before = list.length;
  const filtered = list.filter((e) => !(e.id === target.id && e.url === target.url && e.name === target.name));
  if (filtered.length === before) { return false; }
  cfg.environments = filtered;
  writeCacheConfig(root, cfg);
  return true;
}

export async function deleteDataverseEnvironment(
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any
): Promise<void> {
  const root = getCacheRoot();
  if (!root) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const envs = getDataverseEnvironments();
  if (envs.length === 0) {
    vscode.window.showInformationMessage('No Dataverse environments saved in the cache.');
    return;
  }

  type Item = vscode.QuickPickItem & { env: DataverseEnvironment };
  const items: Item[] = envs.map((e) => ({
    label: e.name || '(unnamed)',
    description: e.url || e.id || '',
    env: e
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select environment to delete'
  });
  if (!picked) { return; }
  const env = picked.env;

  const target = env.id || env.url;
  if (!target) {
    vscode.window.showErrorMessage('Selected environment has no id or url; cannot call pac admin delete.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete Dataverse environment "${env.name || target}"?\nThis runs "pac admin delete" and is irreversible.`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') { return; }

  outputChannel.show(true);
  const res = await runPacCapture(
    ['admin', 'delete', '--environment', target, '--async'],
    outputChannel,
    `Deleting Dataverse environment "${env.name || target}"`,
    spawnFn
  );

  const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
  const notFound =
    combined.includes('not found') ||
    combined.includes('does not exist') ||
    combined.includes('environmentnotfound') ||
    combined.includes('no environment');

  if (res.ok) {
    const removed = removeEnvironmentFromCache(root, env);
    outputChannel.appendLine(
      removed
        ? `Removed "${env.name || target}" from cache.`
        : `Environment "${env.name || target}" was already absent from cache.`
    );
    dataverseEnvironmentsChanged.fire();
    vscode.window.showInformationMessage(`Deleted Dataverse environment "${env.name || target}".`);
    return;
  }

  if (notFound) {
    outputChannel.appendLine(
      `pac reported the environment as not found (exit ${res.code}). Cleaning it from cache.`
    );
    const removed = removeEnvironmentFromCache(root, env);
    dataverseEnvironmentsChanged.fire();
    if (removed) {
      vscode.window.showInformationMessage(
        `Environment "${env.name || target}" was not found by pac — removed from cache.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Environment "${env.name || target}" was not found by pac and not in cache.`
      );
    }
    return;
  }

  outputChannel.appendLine(`Delete failed (exit ${res.code}). Environment kept in cache.`);
  vscode.window.showErrorMessage('Failed to delete Dataverse environment. See output for details.');
}

export async function dataverseSolutionImport(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any
): Promise<void> {
  const zipPath = resourceUri.fsPath;
  if (!zipPath.toLowerCase().endsWith('.zip')) {
    vscode.window.showWarningMessage('Dataverse Solutions Import requires a .zip file.');
    return;
  }

  const env = await pickDataverseEnvironment(outputChannel);
  if (!env) { return; }
  const target = dataverseEnvironmentTarget(env);
  if (!target) {
    vscode.window.showErrorMessage('Selected environment has no URL/ID/name.');
    return;
  }

  outputChannel.show(true);
  const res = await runPacStream(
    ['solution', 'import', '--path', zipPath, '--environment', target],
    outputChannel,
    `Importing ${path.basename(zipPath)} → ${env.name || target}`,
    spawnFn
  );
  if (res.ok) {
    outputChannel.appendLine(`Imported "${path.basename(zipPath)}" into "${env.name || target}".`);
    vscode.window.showInformationMessage(`Dataverse solution imported into "${env.name || target}".`);
  } else {
    outputChannel.appendLine(`Import failed (exit ${res.code}).`);
    vscode.window.showErrorMessage('Dataverse solution import failed. See output for details.');
  }
}

export async function dataversePackageDeploy(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any
): Promise<void> {
  const zipPath = resourceUri.fsPath;
  if (!zipPath.toLowerCase().endsWith('.zip')) {
    vscode.window.showWarningMessage('Dataverse Package deploy requires a .zip file.');
    return;
  }

  const env = await pickDataverseEnvironment(outputChannel);
  if (!env) { return; }
  const target = dataverseEnvironmentTarget(env);
  if (!target) {
    vscode.window.showErrorMessage('Selected environment has no URL/ID/name.');
    return;
  }

  outputChannel.show(true);
  const res = await runPacStream(
    ['package', 'deploy', '--package', zipPath, '--environment', target],
    outputChannel,
    `Deploying ${path.basename(zipPath)} → ${env.name || target}`,
    spawnFn
  );
  if (res.ok) {
    outputChannel.appendLine(`Deployed "${path.basename(zipPath)}" to "${env.name || target}".`);
    vscode.window.showInformationMessage(`Dataverse package deployed to "${env.name || target}".`);
  } else {
    outputChannel.appendLine(`Deploy failed (exit ${res.code}).`);
    vscode.window.showErrorMessage('Dataverse package deploy failed. See output for details.');
  }
}

function collectCsprojs(dir: string, results: string[]): void {
  let entries: string[];
  try { entries = fs.readdirSync(dir) as string[]; } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (entry.toLowerCase().endsWith('.csproj')) { results.push(full); continue; }
    if (entry === 'bin' || entry === 'obj' || entry === 'node_modules' || entry === '.git' || entry === '.vs') { continue; }
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) { collectCsprojs(full, results); }
  }
}

function runDotnet(args: string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    defaultExecFile('dotnet', args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ? stdout.toString() : '',
        stderr: stderr ? stderr.toString() : '',
        error
      });
    });
  });
}

function parseNugetSources(detailedOutput: string): { name: string; url: string }[] {
  const sources: { name: string; url: string }[] = [];
  const lines = detailedOutput.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\d+\.\s+(\S+)\s+\[(?:Enabled|Disabled)\]\s*$/);
    if (!header) { continue; }
    const name = header[1];
    let j = i + 1;
    while (j < lines.length && lines[j].trim().length === 0) { j++; }
    if (j < lines.length) {
      sources.push({ name, url: lines[j].trim() });
    }
  }
  return sources;
}

async function resolveLocalNugetFeed(outputChannel: vscode.OutputChannel): Promise<string | undefined> {
  outputChannel.appendLine('Listing NuGet sources ...');
  const list = await runDotnet(['nuget', 'list', 'source']);
  if (list.stdout) { outputChannel.appendLine(list.stdout.trimEnd()); }
  if (list.error) {
    outputChannel.appendLine(list.stderr || list.error.message);
    return undefined;
  }

  const sources = parseNugetSources(list.stdout);

  const byName = sources.find((s) => s.name.toLowerCase() === 'local');
  if (byName) {
    outputChannel.appendLine(`Found existing NuGet source "${byName.name}": ${byName.url}`);
    return byName.url;
  }

  const byPath = sources.find((s) => s.url.replace(/\/+$/, '').toLowerCase() === DEFAULT_LOCAL_FEED.toLowerCase());
  if (byPath) {
    outputChannel.appendLine(`Found existing NuGet source at ${byPath.url} (registered as "${byPath.name}") — using it.`);
    return byPath.url;
  }

  outputChannel.appendLine(`No "Local" NuGet source found — registering ${DEFAULT_LOCAL_FEED} as "Local" ...`);
  if (!fs.existsSync(DEFAULT_LOCAL_FEED)) {
    fs.mkdirSync(DEFAULT_LOCAL_FEED, { recursive: true });
  }
  const add = await runDotnet(['nuget', 'add', 'source', DEFAULT_LOCAL_FEED, '--name', 'Local']);
  if (add.stdout) { outputChannel.appendLine(add.stdout.trimEnd()); }
  if (add.stderr) { outputChannel.appendLine(add.stderr.trimEnd()); }
  if (add.error) { return undefined; }
  return DEFAULT_LOCAL_FEED;
}

async function readOrPromptVersion(devkitRoot: string, outputChannel: vscode.OutputChannel): Promise<string | undefined> {
  const configPath = path.join(devkitRoot, '.vscode', DEVKIT_CONFIG_FILE);
  const cfg = readCacheConfig(devkitRoot);

  if (typeof cfg.packLocalVersion === 'string' && cfg.packLocalVersion.trim().length > 0) {
    outputChannel.appendLine(`Using version from ${configPath}: ${cfg.packLocalVersion}`);
    return cfg.packLocalVersion.trim();
  }

  const entered = await vscode.window.showInputBox({
    prompt: 'Package version for "Install targets Nugets" (saved to .vscode/ for future runs)',
    placeHolder: 'e.g. 0.0.0.14',
    validateInput: (v) => v.trim().length === 0 ? 'Version is required' : null
  });
  if (entered === undefined) { return undefined; }
  const version = entered.trim();
  if (!version) { return undefined; }

  cfg.packLocalVersion = version;
  writeCacheConfig(devkitRoot, cfg);
  outputChannel.appendLine(`Saved version to ${configPath}`);
  return version;
}

function runStreamedDotnet(
  args: string[],
  outputChannel: vscode.OutputChannel,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
  messagePrefix: string,
  spawnFn: SpawnFn
): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) { resolve(false); return; }
    const child = spawnFn('dotnet', args, { shell: true });
    const sub = token.onCancellationRequested(() => child.kill());
    const stream = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) {
          outputChannel.appendLine(line);
          progress.report({ message: `${messagePrefix}${line.length > 80 ? line.slice(0, 77) + '...' : line}` });
        }
      }
    };
    child.stdout?.on('data', stream);
    child.stderr?.on('data', stream);
    child.on('error', (err) => {
      sub.dispose();
      outputChannel.appendLine(`Error: ${err.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      sub.dispose();
      resolve(code === 0);
    });
  });
}

export async function generateInstallScript(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const devkitRoot = getDevkitBuildRoot();
  if (!devkitRoot) {
    vscode.window.showErrorMessage(`No workspace folder named "${DEVKIT_FOLDER_NAME}" is open.`);
    return;
  }

  outputChannel.show(true);
  outputChannel.appendLine('=== Generate Install Script ===');

  const version = await readOrPromptVersion(devkitRoot, outputChannel);
  if (!version) { return; }

  const scriptsDir = path.join(devkitRoot, 'dev-scripts');
  try {
    if (!fs.existsSync(scriptsDir)) { fs.mkdirSync(scriptsDir, { recursive: true }); }
  } catch (err) {
    outputChannel.appendLine(`Failed to create ${scriptsDir}: ${(err as Error).message}`);
    vscode.window.showErrorMessage('Failed to create dev-scripts/ folder.');
    return;
  }

  const ps1Src = path.join(context.extensionPath, 'resources', 'dev-scripts', 'Install-TargetNugets.ps1');
  const readmeSrc = path.join(context.extensionPath, 'resources', 'dev-scripts', 'README.md');
  const ps1Dst = path.join(scriptsDir, 'Install-TargetNugets.ps1');
  const readmeDst = path.join(scriptsDir, 'README.md');

  try {
    fs.copyFileSync(ps1Src, ps1Dst);
    outputChannel.appendLine(`Wrote ${ps1Dst}`);
    fs.copyFileSync(readmeSrc, readmeDst);
    outputChannel.appendLine(`Wrote ${readmeDst}`);
  } catch (err) {
    outputChannel.appendLine(`Failed to write script/README: ${(err as Error).message}`);
    vscode.window.showErrorMessage('Failed to generate install script — see output.');
    return;
  }

  const gitignorePath = path.join(devkitRoot, '.gitignore');
  try {
    let gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    const lines = gitignoreContent.split(/\r?\n/);
    const alreadyIgnored = lines.some((l) => {
      const t = l.trim().replace(/^\//, '').replace(/\/+$/, '');
      return t === 'dev-scripts';
    });
    if (!alreadyIgnored) {
      if (gitignoreContent.length > 0 && !/\r?\n$/.test(gitignoreContent)) {
        gitignoreContent += '\n';
      }
      gitignoreContent += 'dev-scripts/\n';
      fs.writeFileSync(gitignorePath, gitignoreContent, 'utf8');
      outputChannel.appendLine(`Added 'dev-scripts/' to ${gitignorePath}`);
    } else {
      outputChannel.appendLine(`'dev-scripts' already listed in ${gitignorePath}`);
    }
  } catch (err) {
    outputChannel.appendLine(`Failed to update .gitignore: ${(err as Error).message}`);
  }

  vscode.window.showInformationMessage(
    `Generated dev-scripts/Install-TargetNugets.ps1 (version ${version}). Run it from the terminal before testing DevKit changes.`
  );
}

export async function installTargetNugets(
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any,
  execFn: ExecFn = defaultExec as any
): Promise<void> {
  const devkitRoot = getDevkitBuildRoot();
  if (!devkitRoot) {
    vscode.window.showErrorMessage(`No workspace folder named "${DEVKIT_FOLDER_NAME}" is open.`);
    return;
  }

  outputChannel.show(true);
  outputChannel.appendLine(`=== Install targets Nugets (${devkitRoot}) ===`);

  const version = await readOrPromptVersion(devkitRoot, outputChannel);
  if (!version) { return; }

  const localFeed = await resolveLocalNugetFeed(outputChannel);
  if (!localFeed) {
    vscode.window.showErrorMessage('Failed to resolve or register a "Local" NuGet source. See output for details.');
    return;
  }
  if (!fs.existsSync(localFeed)) {
    try { fs.mkdirSync(localFeed, { recursive: true }); } catch (err) {
      outputChannel.appendLine(`Failed to create ${localFeed}: ${(err as Error).message}`);
      vscode.window.showErrorMessage(`Local feed path ${localFeed} is not accessible.`);
      return;
    }
  }

  const projects: string[] = [];
  const dataverseSrc = path.join(devkitRoot, 'src', 'Dataverse');
  if (fs.existsSync(dataverseSrc)) { collectCsprojs(dataverseSrc, projects); }
  const sdkProj = path.join(devkitRoot, 'src', 'Sdk', 'TALXIS.DevKit.Build.Sdk.csproj');
  if (fs.existsSync(sdkProj)) { projects.push(sdkProj); }

  if (projects.length === 0) {
    vscode.window.showWarningMessage('No .csproj files found under src\\Dataverse or src\\Sdk.');
    return;
  }

  const artifactsDir = path.join(devkitRoot, 'artifacts');
  if (!fs.existsSync(artifactsDir)) { fs.mkdirSync(artifactsDir, { recursive: true }); }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Install targets Nugets',
      cancellable: true
    },
    async (progress, token) => {
      outputChannel.appendLine(`\n=== Packing ${projects.length} project(s) with version ${version} ===`);
      let failed = 0;
      for (let i = 0; i < projects.length; i++) {
        if (token.isCancellationRequested) { break; }
        const proj = projects[i];
        const prefix = `(${i + 1}/${projects.length}) `;
        progress.report({ message: `${prefix}pack ${path.basename(proj)}` });
        outputChannel.appendLine(`\nPacking ${path.basename(proj)} ...`);
        const ok = await runStreamedDotnet(
          ['pack', proj, '--configuration', 'Release', `-p:PackageVersion=${version}`, `-p:Version=${version}`, '--output', artifactsDir],
          outputChannel,
          progress,
          token,
          prefix,
          spawnFn
        );
        if (!ok) { failed++; break; }
      }

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage('Install targets Nugets cancelled.');
        return;
      }
      if (failed > 0) {
        vscode.window.showErrorMessage('One or more projects failed to pack. See output for details.');
        return;
      }

      progress.report({ message: `Copying .nupkg files to ${localFeed}` });
      outputChannel.appendLine(`\n=== Copying packages to ${localFeed} ===`);
      const pkgs = fs.readdirSync(artifactsDir).filter(f => f.toLowerCase().endsWith('.nupkg'));
      for (const pkg of pkgs) {
        const src = path.join(artifactsDir, pkg);
        const dst = path.join(localFeed, pkg);
        try {
          fs.copyFileSync(src, dst);
          outputChannel.appendLine(`  Copied ${pkg}`);
        } catch (err) {
          outputChannel.appendLine(`  FAILED to copy ${pkg}: ${(err as Error).message}`);
        }
      }

      progress.report({ message: 'Killing dotnet processes' });
      outputChannel.appendLine('\n=== Killing dotnet processes ===');
      await new Promise<void>((resolve) => {
        execFn('taskkill /IM dotnet.exe /F', (_err, stdout, stderr) => {
          if (stdout) { outputChannel.appendLine(stdout.trimEnd()); }
          if (stderr) { outputChannel.appendLine(stderr.trimEnd()); }
          resolve();
        });
      });

      progress.report({ message: 'Clearing NuGet cache' });
      outputChannel.appendLine('\n=== Clearing NuGet cache ===');
      await runStreamedDotnet(['nuget', 'locals', 'all', '--clear'], outputChannel, progress, token, '', spawnFn);

      outputChannel.appendLine('\nAll done!');
      vscode.window.showInformationMessage('Install targets Nugets completed.');
    }
  );
}

export async function dataverseSolutionUnpack(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any
): Promise<void> {
  const zipPath = resourceUri.fsPath;
  if (!zipPath.toLowerCase().endsWith('.zip')) {
    vscode.window.showWarningMessage('Dataverse Solutions unpack requires a .zip file.');
    return;
  }

  const zipDir = path.dirname(zipPath);
  const zipBaseName = path.basename(zipPath, path.extname(zipPath));
  const folderPath = path.join(zipDir, zipBaseName);

  outputChannel.show(true);

  const runUnpack = (packageType?: 'managed'): Promise<{ ok: boolean; code: number | null }> => {
    return new Promise((resolve) => {
      const args = ['solution', 'unpack', '--zipfile', zipPath, '--localize', '--folder', folderPath];
      if (packageType) {
        args.push('--packagetype', packageType);
      }
      const quoted = args.map(quoteShellArg);
      const printable = `pac ${quoted.join(' ')}`;
      outputChannel.appendLine(`Running: ${printable}`);

      const child = spawnFn('pac', quoted, { shell: true });

      const stream = (chunk: Buffer | string) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) { outputChannel.appendLine(line); }
        }
      };

      child.stdout?.on('data', stream);
      child.stderr?.on('data', stream);
      child.on('error', (err) => {
        outputChannel.appendLine(`Error: ${err.message}`);
        resolve({ ok: false, code: null });
      });
      child.on('close', (code) => {
        resolve({ ok: code === 0, code });
      });
    });
  };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Unpacking ${path.basename(zipPath)}`,
      cancellable: false
    },
    async (progress) => {
      progress.report({ message: 'Running pac solution unpack ...' });
      const first = await runUnpack();
      if (first.ok) {
        outputChannel.appendLine(`Unpacked "${path.basename(zipPath)}" to "${folderPath}".`);
        vscode.window.showInformationMessage(`Dataverse solution unpacked to "${folderPath}".`);
        return;
      }

      outputChannel.appendLine(`Initial unpack failed (exit ${first.code}). Retrying with --packagetype managed ...`);
      progress.report({ message: 'Retrying with --packagetype managed ...' });
      const second = await runUnpack('managed');
      if (second.ok) {
        outputChannel.appendLine(`Unpacked "${path.basename(zipPath)}" (managed) to "${folderPath}".`);
        vscode.window.showInformationMessage(`Dataverse solution unpacked (managed) to "${folderPath}".`);
      } else {
        outputChannel.appendLine(`Unpack failed (exit ${second.code}).`);
        vscode.window.showErrorMessage('Dataverse solution unpack failed. See output for details.');
      }
    }
  );
}

export async function openInNewWindow(resourceUri: vscode.Uri): Promise<void> {
  if (!resourceUri) {
    vscode.window.showWarningMessage('Open in New Window: no file or folder selected.');
    return;
  }
  // vscode.openFolder handles both files and folders. For files it opens
  // a new VS Code window with the file's parent as workspace and the file
  // focused; for folders it opens the folder as workspace root.
  await vscode.commands.executeCommand('vscode.openFolder', resourceUri, {
    forceNewWindow: true,
    noRecentEntry: false
  });
}
