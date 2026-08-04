import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
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
    if (fsFns.existsSync(binPath)) { foldersToDelete.push(binPath); }
    if (fsFns.existsSync(objPath)) { foldersToDelete.push(objPath); }
  }

  if (foldersToDelete.length === 0) {
    outputChannel.appendLine('No bin/ or obj/ folders found. Nothing to delete.');
    vscode.window.showInformationMessage('No bin/ or obj/ folders to delete.');
    return;
  }

  // Build a temp .ps1 script with all the deletes. The previous implementation
  // crammed every Remove-Item into a single -ArgumentList string, which blew
  // past the ~8 191-char cmd.exe command-line limit when there were many
  // targets (e.g. 700+ projects) and the elevated process never launched —
  // the UAC prompt didn't even appear. With -File <script.ps1> the launcher
  // command stays constant-length regardless of how many folders we process.
  const tempScriptPath = path.join(os.tmpdir(), `zekelin-dotnet-wipe-${Date.now()}-${process.pid}.ps1`);
  const tempLogPath = path.join(os.tmpdir(), `zekelin-dotnet-wipe-${Date.now()}-${process.pid}.log`);

  const psSingleQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const scriptLines: string[] = [
    '$ErrorActionPreference = "Continue"',
    `Start-Transcript -Path ${psSingleQuote(tempLogPath)} -Force | Out-Null`,
    `Write-Host "Deleting ${foldersToDelete.length} folder(s)..."`,
    ...foldersToDelete.map((f) =>
      `Remove-Item -LiteralPath ${psSingleQuote(f)} -Recurse -Force -ErrorAction SilentlyContinue`
    ),
    'Write-Host "Done."',
    'Stop-Transcript | Out-Null'
  ];

  try {
    // Write UTF-8 with BOM so PowerShell 5.1 correctly interprets non-ASCII paths.
    fs.writeFileSync(tempScriptPath, '﻿' + scriptLines.join('\r\n') + '\r\n', 'utf8');
  } catch (err) {
    outputChannel.appendLine(`Failed to write temp script: ${(err as Error).message}`);
    vscode.window.showErrorMessage('Failed to prepare .NET Wipe script. See output for details.');
    return;
  }

  outputChannel.appendLine(`Deleting ${foldersToDelete.length} bin/obj folder(s) as admin ...`);
  outputChannel.appendLine(`  script:  ${tempScriptPath}`);
  outputChannel.appendLine(`  log:     ${tempLogPath}`);

  // Outer launcher: a tiny, constant-length command that asks Windows to
  // run the temp script elevated. -ArgumentList carries 5 short literal
  // tokens — no per-folder content in here.
  const escScript = tempScriptPath.replace(/'/g, "''");
  const launchCmd = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${escScript}'`;

  return new Promise((resolve) => {
    execFn(`powershell -NoProfile -Command "${launchCmd}"`, (error, stdout, stderr) => {
      // Surface whatever the elevated transcript captured.
      try {
        if (fs.existsSync(tempLogPath)) {
          const log = fs.readFileSync(tempLogPath, 'utf8').replace(/^﻿/, '').trimEnd();
          if (log.length > 0) { outputChannel.appendLine(log); }
        }
      } catch { /* ignore log read errors */ }

      // Clean up temp artefacts.
      try { fs.unlinkSync(tempScriptPath); } catch { /* ignore */ }
      try { fs.unlinkSync(tempLogPath); } catch { /* ignore */ }

      if (error) {
        outputChannel.appendLine(`Error: ${error.message}`);
        if (stderr) { outputChannel.appendLine(stderr); }
        vscode.window.showErrorMessage('Failed to delete bin/obj folders. See output for details.');
      } else {
        if (stdout) { outputChannel.appendLine(stdout); }
        outputChannel.appendLine(`bin/ and obj/ folders deletion completed (${foldersToDelete.length} target(s)).`);
        vscode.window.showInformationMessage(`.NET Wipe completed — ${foldersToDelete.length} folder(s) processed.`);
      }
      resolve();
    });
  });
}

// ─── Git Wipe ──────────────────────────────────────────────────────────────────
// Deletes everything .gitignore matches under the selected folder (recursively,
// nested .gitignore files included) via `git clean -Xdf`, then sweeps away any
// directories left empty. Dry-runs first so the confirmation shows real counts.

function removeEmptyDirs(root: string): number {
  let removed = 0;
  const walk = (dir: string): boolean => {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return false; }
    let empty = true;
    for (const entry of entries) {
      if (entry === '.git') { empty = false; continue; }
      const full = path.join(dir, entry);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { empty = false; continue; }
      if (!st.isDirectory()) { empty = false; continue; }
      if (walk(full)) {
        try { fs.rmdirSync(full); removed++; } catch { empty = false; }
      } else {
        empty = false;
      }
    }
    return empty;
  };
  walk(root);
  return removed;
}

export async function gitWipe(
  resourceUri: vscode.Uri | undefined,
  outputChannel: vscode.OutputChannel,
  runner: GitRunner = defaultGitRunner,
  confirm: (msg: string, modal: boolean, ...actions: string[]) => Thenable<string | undefined> =
    (msg, modal, ...actions) => vscode.window.showWarningMessage(msg, { modal }, ...actions)
): Promise<void> {
  const target = resourceUri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!target) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  let st: fs.Stats;
  try { st = fs.statSync(target); } catch {
    vscode.window.showErrorMessage(`Git Wipe: path not found: ${target}`);
    return;
  }
  if (!st.isDirectory()) {
    vscode.window.showWarningMessage('Git Wipe is only available for folders.');
    return;
  }

  const rootRes = await runner(['rev-parse', '--show-toplevel'], target);
  if (rootRes.error) {
    vscode.window.showErrorMessage('Git Wipe: this folder is not inside a git repository.');
    return;
  }

  const dryRes = await runner(['clean', '-Xdn', '--', '.'], target);
  if (dryRes.error) {
    outputChannel.show(true);
    outputChannel.appendLine(dryRes.stderr || dryRes.error.message);
    vscode.window.showErrorMessage('Git Wipe: git clean dry run failed. See output for details.');
    return;
  }
  const wouldRemove = dryRes.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (wouldRemove.length === 0) {
    const emptied = removeEmptyDirs(target);
    vscode.window.showInformationMessage(
      emptied > 0
        ? `Git Wipe: nothing gitignored to delete — removed ${emptied} empty folder(s).`
        : 'Git Wipe: nothing to delete.'
    );
    return;
  }

  const preview = wouldRemove.slice(0, 10).map((l) => l.replace(/^Would remove /, '  ')).join('\n');
  const more = wouldRemove.length > 10 ? `\n  … and ${wouldRemove.length - 10} more` : '';
  const choice = await confirm(
    `Git Wipe: delete ${wouldRemove.length} gitignored item(s) under\n${target}?\n\n` +
    `${preview}${more}\n\n` +
    `Empty folders left behind will be removed too. This cannot be undone.`,
    true,
    'Delete'
  );
  if (choice !== 'Delete') return;

  outputChannel.show(true);
  outputChannel.appendLine(`Git Wipe: ${target}`);

  await killVBCSCompiler(outputChannel);

  outputChannel.appendLine('Running: git clean -Xdf -- .');
  const cleanRes = await runner(['clean', '-Xdf', '--', '.'], target);
  if (cleanRes.stdout) { outputChannel.appendLine(cleanRes.stdout.trimEnd()); }
  if (cleanRes.stderr) { outputChannel.appendLine(cleanRes.stderr.trimEnd()); }
  if (cleanRes.error) {
    vscode.window.showErrorMessage('Git Wipe: git clean failed. See output for details.');
    return;
  }

  const emptied = removeEmptyDirs(target);
  if (emptied > 0) { outputChannel.appendLine(`Removed ${emptied} empty folder(s).`); }

  vscode.window.showInformationMessage(
    `Git Wipe completed — ${wouldRemove.length} gitignored item(s)` +
    (emptied > 0 ? ` and ${emptied} empty folder(s)` : '') + ' deleted.'
  );
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
export const PLATFORM_METADATA_FOLDER_NAME = 'platform-metadata';
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

export function getPlatformMetadataRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (path.basename(folder.uri.fsPath) === PLATFORM_METADATA_FOLDER_NAME) {
      return folder.uri.fsPath;
    }
  }
  return undefined;
}

export type DataverseEnvironment = { name: string; id: string; url: string };

export const dataverseEnvironmentsChanged = new vscode.EventEmitter<void>();

// Global config — shared across all workspaces, all VS Code variants on this
// machine. Lives under the user's home dir so it shows up next to .gitconfig,
// .aws, etc. instead of being buried under AppData\Roaming\Code\....
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.zekelin-dotnet-tools');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, DEVKIT_CONFIG_FILE);

export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_FILE;
}

function readGlobalConfig(): { [key: string]: any } {
  if (!fs.existsSync(GLOBAL_CONFIG_FILE)) { return {}; }
  try {
    const parsed = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function writeGlobalConfig(cfg: { [key: string]: any }): void {
  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) { fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true }); }
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// packLocalVersion stays project-local — it really is per-repo state.
// These two helpers still operate on <workspace>/.vscode/zekelin-dotnet-tools.json
// but only for that one key (and migration cleanup).
function getWorkspaceCacheRoot(): string | undefined {
  const devkit = getDevkitBuildRoot();
  if (devkit) { return devkit; }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) { return folders[0].uri.fsPath; }
  return undefined;
}

function readWorkspaceCacheConfig(root: string): { [key: string]: any } {
  const configPath = path.join(root, '.vscode', DEVKIT_CONFIG_FILE);
  if (!fs.existsSync(configPath)) { return {}; }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function writeWorkspaceCacheConfig(root: string, cfg: { [key: string]: any }): void {
  const configDir = path.join(root, '.vscode');
  const configPath = path.join(configDir, DEVKIT_CONFIG_FILE);
  if (!fs.existsSync(configDir)) { fs.mkdirSync(configDir, { recursive: true }); }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// Back-compat shims for callers that still operate on the workspace cache
// (currently only the packLocalVersion path).
function readCacheConfig(root: string): { [key: string]: any } {
  return readWorkspaceCacheConfig(root);
}
function writeCacheConfig(root: string, cfg: { [key: string]: any }): void {
  writeWorkspaceCacheConfig(root, cfg);
}

// Best-effort one-time migration: if the global config has no environments
// but the currently-open workspace's cache does, move them up and clear the
// workspace copy. Runs idempotently — subsequent calls see the global file
// already populated and do nothing.
let migrationAttempted = false;
export function migrateEnvironmentsToGlobalIfNeeded(outputChannel?: vscode.OutputChannel): void {
  if (migrationAttempted) { return; }
  migrationAttempted = true;

  const global = readGlobalConfig();
  if (Array.isArray(global.environments) && global.environments.length > 0) { return; }

  const wsRoot = getWorkspaceCacheRoot();
  if (!wsRoot) { return; }
  const wsCfg = readWorkspaceCacheConfig(wsRoot);
  const wsEnvs = wsCfg.environments;
  if (!Array.isArray(wsEnvs) || wsEnvs.length === 0) { return; }

  global.environments = wsEnvs;
  writeGlobalConfig(global);

  delete wsCfg.environments;
  writeWorkspaceCacheConfig(wsRoot, wsCfg);

  const msg = `Migrated ${wsEnvs.length} Dataverse environment(s) from ${path.join(wsRoot, '.vscode', DEVKIT_CONFIG_FILE)} → ${GLOBAL_CONFIG_FILE}.`;
  if (outputChannel) { outputChannel.appendLine(msg); }
  vscode.window.showInformationMessage(
    `Dataverse environments now live in ${GLOBAL_CONFIG_FILE}. Migrated ${wsEnvs.length} from the current workspace.`
  );
}

export function getDataverseEnvironments(): DataverseEnvironment[] {
  migrateEnvironmentsToGlobalIfNeeded();
  const cfg = readGlobalConfig();
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
  migrateEnvironmentsToGlobalIfNeeded(outputChannel);

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

  const cfg = readGlobalConfig();
  const list: DataverseEnvironment[] = Array.isArray(cfg.environments) ? cfg.environments : [];
  list.push(env);
  cfg.environments = list;
  writeGlobalConfig(cfg);

  outputChannel.appendLine(`Added environment "${env.name}" to ${GLOBAL_CONFIG_FILE}`);
  vscode.window.showInformationMessage(`Added Dataverse environment "${env.name}".`);
  dataverseEnvironmentsChanged.fire();
  return env;
}

export async function revealDataverseEnvironmentsConfig(outputChannel: vscode.OutputChannel): Promise<void> {
  migrateEnvironmentsToGlobalIfNeeded(outputChannel);

  if (!fs.existsSync(GLOBAL_CONFIG_FILE)) {
    if (!fs.existsSync(GLOBAL_CONFIG_DIR)) { fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true }); }
    fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify({ environments: [] }, null, 2) + '\n', 'utf8');
  }

  const doc = await vscode.workspace.openTextDocument(GLOBAL_CONFIG_FILE);
  await vscode.window.showTextDocument(doc, { preview: false });
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
  migrateEnvironmentsToGlobalIfNeeded(outputChannel);

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

  const cfg = readGlobalConfig();
  const list: DataverseEnvironment[] = Array.isArray(cfg.environments) ? cfg.environments : [];
  list.push(env);
  cfg.environments = list;
  writeGlobalConfig(cfg);

  outputChannel.appendLine(`Created environment "${env.name}" (id=${env.id}, url=${env.url}) and saved to ${GLOBAL_CONFIG_FILE}`);
  vscode.window.showInformationMessage(`Created Dataverse environment "${env.name}".`);
  dataverseEnvironmentsChanged.fire();
  return env;
}

function removeEnvironmentFromGlobal(target: DataverseEnvironment): boolean {
  const cfg = readGlobalConfig();
  const list: DataverseEnvironment[] = Array.isArray(cfg.environments) ? cfg.environments : [];
  const before = list.length;
  const filtered = list.filter((e) => !(e.id === target.id && e.url === target.url && e.name === target.name));
  if (filtered.length === before) { return false; }
  cfg.environments = filtered;
  writeGlobalConfig(cfg);
  return true;
}

export async function deleteDataverseEnvironment(
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any
): Promise<void> {
  migrateEnvironmentsToGlobalIfNeeded(outputChannel);

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
    const removed = removeEnvironmentFromGlobal(env);
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
    const removed = removeEnvironmentFromGlobal(env);
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
  return generateInstallScriptCore(devkitRoot, [], context, outputChannel);
}

export async function platformMetadataGenerateScript(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const root = getPlatformMetadataRoot();
  if (!root) {
    vscode.window.showErrorMessage(`No workspace folder named "${PLATFORM_METADATA_FOLDER_NAME}" is open.`);
    return;
  }
  return generateInstallScriptCore(root, [PLATFORM_METADATA_FOLDER_NAME], context, outputChannel);
}

async function generateInstallScriptCore(
  repoRoot: string,
  resourceSubdirs: string[],
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine('=== Generate Install Script ===');

  const version = await readOrPromptVersion(repoRoot, outputChannel);
  if (!version) { return; }

  const scriptsDir = path.join(repoRoot, 'dev-scripts');
  try {
    if (!fs.existsSync(scriptsDir)) { fs.mkdirSync(scriptsDir, { recursive: true }); }
  } catch (err) {
    outputChannel.appendLine(`Failed to create ${scriptsDir}: ${(err as Error).message}`);
    vscode.window.showErrorMessage('Failed to create dev-scripts/ folder.');
    return;
  }

  const resourceDir = path.join(context.extensionPath, 'resources', 'dev-scripts', ...resourceSubdirs);
  const ps1Src = path.join(resourceDir, 'Install-TargetNugets.ps1');
  const readmeSrc = path.join(resourceDir, 'README.md');
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

  const gitignorePath = path.join(repoRoot, '.gitignore');
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

  const projects: string[] = [];
  const dataverseSrc = path.join(devkitRoot, 'src', 'Dataverse');
  if (fs.existsSync(dataverseSrc)) { collectCsprojs(dataverseSrc, projects); }
  const sdkProj = path.join(devkitRoot, 'src', 'Sdk', 'TALXIS.DevKit.Build.Sdk.csproj');
  if (fs.existsSync(sdkProj)) { projects.push(sdkProj); }

  if (projects.length === 0) {
    vscode.window.showWarningMessage('No .csproj files found under src\\Dataverse or src\\Sdk.');
    return;
  }

  return packProjectsIntoLocalFeed(devkitRoot, projects, outputChannel, spawnFn, execFn);
}

export async function platformMetadataInstallNugets(
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn = defaultSpawn as any,
  execFn: ExecFn = defaultExec as any
): Promise<void> {
  const root = getPlatformMetadataRoot();
  if (!root) {
    vscode.window.showErrorMessage(`No workspace folder named "${PLATFORM_METADATA_FOLDER_NAME}" is open.`);
    return;
  }

  const projects: string[] = [];
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) { collectCsprojs(srcDir, projects); }

  if (projects.length === 0) {
    vscode.window.showWarningMessage('No .csproj files found under src\\.');
    return;
  }

  return packProjectsIntoLocalFeed(root, projects, outputChannel, spawnFn, execFn);
}

async function packProjectsIntoLocalFeed(
  repoRoot: string,
  projects: string[],
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn,
  execFn: ExecFn
): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine(`=== Install targets Nugets (${repoRoot}) ===`);

  const version = await readOrPromptVersion(repoRoot, outputChannel);
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

  const artifactsDir = path.join(repoRoot, 'artifacts');
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

// ─── Send to Local NuGet Feed ─────────────────────────────────────────────────
// Stores the chosen feed path in the global config so it works across
// every workspace on this machine, and only asks once.

function getLocalNugetFeedPath(): string | undefined {
  const cfg = readGlobalConfig();
  const raw = cfg.localNugetFeed;
  return (typeof raw === 'string' && raw.trim().length > 0) ? raw.trim() : undefined;
}

function setLocalNugetFeedPath(feedPath: string): void {
  const cfg = readGlobalConfig();
  cfg.localNugetFeed = feedPath;
  writeGlobalConfig(cfg);
}

function clearLocalNugetFeedPath(): void {
  const cfg = readGlobalConfig();
  if ('localNugetFeed' in cfg) {
    delete cfg.localNugetFeed;
    writeGlobalConfig(cfg);
  }
}

function normalizeForCompare(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

async function ensureRegisteredAsNugetSource(
  feedPath: string,
  outputChannel: vscode.OutputChannel
): Promise<boolean> {
  outputChannel.appendLine('Listing NuGet sources ...');
  const list = await runDotnet(['nuget', 'list', 'source']);
  if (list.error) {
    outputChannel.appendLine(list.stderr || list.error.message);
    return false;
  }
  if (list.stdout) { outputChannel.appendLine(list.stdout.trimEnd()); }

  const sources = parseNugetSources(list.stdout);
  const target = normalizeForCompare(feedPath);
  const already = sources.find((s) => {
    try { return normalizeForCompare(s.url) === target; } catch { return false; }
  });
  if (already) {
    outputChannel.appendLine(`Feed already registered as NuGet source "${already.name}".`);
    return true;
  }

  // Pick a name that doesn't collide with an existing source.
  const taken = new Set(sources.map((s) => s.name.toLowerCase()));
  const base = path.basename(feedPath) || 'Local';
  let name = taken.has(base.toLowerCase()) ? `${base}_zekelin` : base;
  let suffix = 2;
  while (taken.has(name.toLowerCase())) { name = `${base}_zekelin${suffix++}`; }

  outputChannel.appendLine(`Registering "${feedPath}" as NuGet source "${name}" ...`);
  const add = await runDotnet(['nuget', 'add', 'source', feedPath, '--name', name]);
  if (add.stdout) { outputChannel.appendLine(add.stdout.trimEnd()); }
  if (add.stderr) { outputChannel.appendLine(add.stderr.trimEnd()); }
  if (add.error) {
    outputChannel.appendLine(`Failed to register source: ${add.error.message}`);
    return false;
  }
  return true;
}

export async function sendToLocalNugetFeed(
  resourceUri: vscode.Uri,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const pkgPath = resourceUri?.fsPath;
  if (!pkgPath || !pkgPath.toLowerCase().endsWith('.nupkg')) {
    vscode.window.showWarningMessage('Send to Local NuGet Feed requires a .nupkg file.');
    return;
  }
  if (!fs.existsSync(pkgPath)) {
    vscode.window.showErrorMessage(`Package file not found: ${pkgPath}`);
    return;
  }

  outputChannel.show(true);

  let feedPath = getLocalNugetFeedPath();
  let prompted = false;

  // If the previously-saved path no longer exists, treat as unset and re-prompt.
  if (feedPath && !fs.existsSync(feedPath)) {
    outputChannel.appendLine(`Saved local NuGet feed "${feedPath}" no longer exists — asking for a new path.`);
    clearLocalNugetFeedPath();
    feedPath = undefined;
  }

  if (!feedPath) {
    const entered = await vscode.window.showInputBox({
      prompt: 'Path to local NuGet feed folder (saved globally, asked only once)',
      placeHolder: 'e.g. C:\\NuGetLocal',
      validateInput: (v) => v.trim().length === 0 ? 'Path is required' : null
    });
    if (entered === undefined) { return; }
    feedPath = entered.trim();
    if (!feedPath) { return; }
    prompted = true;
  }

  // Validate folder.
  if (!fs.existsSync(feedPath)) {
    vscode.window.showErrorMessage(`Folder does not exist: ${feedPath}`);
    return;
  }
  let st: fs.Stats;
  try { st = fs.statSync(feedPath); } catch (err) {
    vscode.window.showErrorMessage(`Cannot stat ${feedPath}: ${(err as Error).message}`);
    return;
  }
  if (!st.isDirectory()) {
    vscode.window.showErrorMessage(`Path is not a directory: ${feedPath}`);
    return;
  }

  // Make sure the folder is a registered NuGet source.
  const registered = await ensureRegisteredAsNugetSource(feedPath, outputChannel);
  if (!registered) {
    vscode.window.showErrorMessage('Failed to register local NuGet feed. See output for details.');
    return;
  }

  // Copy the package into the feed folder.
  const dst = path.join(feedPath, path.basename(pkgPath));
  try {
    fs.copyFileSync(pkgPath, dst);
    outputChannel.appendLine(`Copied "${path.basename(pkgPath)}" → ${dst}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to copy package: ${(err as Error).message}`);
    return;
  }

  // Save the path globally only after the whole thing succeeded.
  if (prompted || getLocalNugetFeedPath() !== feedPath) {
    setLocalNugetFeedPath(feedPath);
    outputChannel.appendLine(`Saved local NuGet feed path to ${GLOBAL_CONFIG_FILE}`);
  }

  vscode.window.showInformationMessage(`Sent "${path.basename(pkgPath)}" to ${feedPath}.`);
}

// ─── tools-cli workspace actions ──────────────────────────────────────────────
//
// The extension is the source of truth for this script — embedded below. The
// run buttons write a fresh copy to a temp .ps1 every time they're clicked, so
// they work regardless of whether <repo>/scripts/reinstall-local.ps1 exists.
// "Generate Script" writes the same content to that canonical path for users
// who want a standalone copy in their repo.

export const TOOLS_CLI_FOLDER_NAME = 'tools-cli';
const TOOLS_CLI_REINSTALL_SCRIPT_REL = path.join('scripts', 'reinstall-local.ps1');

// The script accepts an optional -RepoRoot parameter — the extension passes
// the actual workspace path when running from a temp file (where $PSScriptRoot
// would otherwise resolve to the OS temp dir). Standalone runs leave -RepoRoot
// blank and fall back to $PSScriptRoot's parent.
const TOOLS_CLI_REINSTALL_SCRIPT_CONTENT = `#Requires -Version 7
<#
.SYNOPSIS
    Removes the globally installed TALXIS CLI and installs the local build
    from this repository instead.

.DESCRIPTION
    Packs src/TALXIS.CLI under a unique dev version (so NuGet can't serve a
    stale cached copy), uninstalls any existing global 'txc', then installs the
    freshly packed nupkg. Pass -IncludeMcp to do the same for 'txc-mcp'.

.EXAMPLE
    ./scripts/reinstall-local.ps1
    ./scripts/reinstall-local.ps1 -IncludeMcp -Configuration Debug
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [switch]$IncludeMcp,
    # When invoked by the Zekelin .NET Tools VS Code extension via a temp .ps1,
    # the extension passes the actual tools-cli workspace path here.
    # Standalone runs (from scripts/) leave this blank and the script falls
    # back to its own location's parent.
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$repoRoot  = $RepoRoot
$nupkgDir  = 'C:\\NuGetLocal'
$cliProj   = Join-Path $repoRoot 'src/TALXIS.CLI/TALXIS.CLI.csproj'
$mcpProj   = Join-Path $repoRoot 'src/TALXIS.CLI.MCP/TALXIS.CLI.MCP.csproj'

# Unique prerelease version per run -> bypasses the NuGet global-packages cache.
$version = '0.0.0-local.{0}' -f (Get-Date -Format 'yyyyMMddHHmmss')

function Invoke-Reinstall {
    param(
        [string]$PackageId,
        [string]$ProjectPath,
        [string]$CommandName
    )

    Write-Host "==> $PackageId ($CommandName)" -ForegroundColor Cyan

    # 1. Uninstall the current global tool (ignore 'not installed').
    Write-Host "    uninstalling existing global tool..."
    try { dotnet tool uninstall --global $PackageId 2>&1 | Out-Null }
    catch { Write-Host "    (was not installed)" -ForegroundColor DarkGray }

    # 2. Pack the local project under the unique dev version.
    Write-Host "    packing $version ..."
    # PackageVersion (not Version) drives the nupkg name and is hard-set in
    # src/Directory.Build.props, so it must be overridden explicitly here.
    dotnet pack $ProjectPath -c $Configuration -o $nupkgDir "-p:PackageVersion=$version" "-p:Version=$version" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "dotnet pack failed for $PackageId" }

    # 3. Install the freshly packed nupkg from the local folder.
    Write-Host "    installing from $nupkgDir ..."
    dotnet tool install --global --add-source $nupkgDir --version $version $PackageId
    if ($LASTEXITCODE -ne 0) { throw "dotnet tool install failed for $PackageId" }

    Write-Host "    done -> $CommandName $version" -ForegroundColor Green
}

# Drop only our previous local builds; leave any other packages in the shared
# C:\\NuGetLocal feed untouched.
New-Item -ItemType Directory -Force -Path $nupkgDir | Out-Null
Remove-Item (Join-Path $nupkgDir 'TALXIS.CLI.*.nupkg') -Force -ErrorAction SilentlyContinue

Invoke-Reinstall -PackageId 'TALXIS.CLI' -ProjectPath $cliProj -CommandName 'txc'
if ($IncludeMcp) {
    Invoke-Reinstall -PackageId 'TALXIS.CLI.MCP' -ProjectPath $mcpProj -CommandName 'txc-mcp'
}

Write-Host ""
Write-Host "Installed tools:" -ForegroundColor Cyan
dotnet tool list --global | Select-String -Pattern 'talxis'
`;

export function getToolsCliRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    if (path.basename(folder.uri.fsPath) === TOOLS_CLI_FOLDER_NAME) {
      return folder.uri.fsPath;
    }
  }
  return undefined;
}

async function runPowerShellScript(
  scriptPath: string,
  extraArgs: string[],
  title: string,
  outputChannel: vscode.OutputChannel,
  spawnFn: SpawnFn
): Promise<boolean> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    },
    () =>
      new Promise<boolean>((resolve) => {
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs];
        const printable = `pwsh ${args.map(quoteShellArg).join(' ')}`;
        outputChannel.appendLine(`Running: ${printable}`);

        const child = spawnFn('pwsh', args.map(quoteShellArg), { shell: true });
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
          resolve(false);
        });
        child.on('close', (code) => {
          if (code === 0) {
            outputChannel.appendLine(`Done.`);
            resolve(true);
          } else {
            outputChannel.appendLine(`Script exited with code ${code}.`);
            resolve(false);
          }
        });
      })
  );
}

export async function toolsCliReinstallLocal(
  outputChannel: vscode.OutputChannel,
  includeMcp: boolean,
  spawnFn: SpawnFn = defaultSpawn as any
): Promise<void> {
  const root = getToolsCliRoot();
  if (!root) {
    vscode.window.showErrorMessage(`No workspace folder named "${TOOLS_CLI_FOLDER_NAME}" is open.`);
    return;
  }

  outputChannel.show(true);

  // Write the embedded script to a temp .ps1 — this means the buttons work
  // even if <repo>/scripts/reinstall-local.ps1 has been deleted or never
  // existed in this branch. -RepoRoot is passed explicitly so $PSScriptRoot
  // (which would resolve to %TEMP%) doesn't matter.
  const tempScript = path.join(os.tmpdir(), `zekelin-tools-cli-reinstall-${Date.now()}-${process.pid}.ps1`);
  try {
    fs.writeFileSync(tempScript, '﻿' + TOOLS_CLI_REINSTALL_SCRIPT_CONTENT, 'utf8');
  } catch (err) {
    outputChannel.appendLine(`Failed to write temp script: ${(err as Error).message}`);
    vscode.window.showErrorMessage('Failed to prepare Reinstall Local script.');
    return;
  }

  const extraArgs = ['-RepoRoot', root];
  if (includeMcp) { extraArgs.push('-IncludeMcp'); }
  const title = includeMcp ? `Reinstall Local (with MCP)` : `Reinstall Local`;

  try {
    const ok = await runPowerShellScript(tempScript, extraArgs, title, outputChannel, spawnFn);
    if (ok) {
      vscode.window.showInformationMessage(`${title} completed.`);
    } else {
      vscode.window.showErrorMessage(`${title} failed. See output for details.`);
    }
  } finally {
    try { fs.unlinkSync(tempScript); } catch { /* ignore cleanup error */ }
  }
}

export async function toolsCliGenerateScript(
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const root = getToolsCliRoot();
  if (!root) {
    vscode.window.showErrorMessage(`No workspace folder named "${TOOLS_CLI_FOLDER_NAME}" is open.`);
    return;
  }

  const targetPath = path.join(root, TOOLS_CLI_REINSTALL_SCRIPT_REL);
  const targetDir = path.dirname(targetPath);

  try {
    if (!fs.existsSync(targetDir)) { fs.mkdirSync(targetDir, { recursive: true }); }
    // UTF-8 BOM so PowerShell 5.1 reads non-ASCII chars correctly if anyone
    // runs the standalone copy on a Windows PowerShell that defaults to ANSI.
    fs.writeFileSync(targetPath, '﻿' + TOOLS_CLI_REINSTALL_SCRIPT_CONTENT, 'utf8');
  } catch (err) {
    outputChannel.appendLine(`Failed to write ${targetPath}: ${(err as Error).message}`);
    vscode.window.showErrorMessage('Failed to generate reinstall-local.ps1.');
    return;
  }

  outputChannel.show(true);
  outputChannel.appendLine(`Wrote ${targetPath}`);
  vscode.window.showInformationMessage(`Generated ${TOOLS_CLI_REINSTALL_SCRIPT_REL}.`);
}

// ─── Explorer sort toggle (alphabetical ↔ modified date) ──────────────────────
// Both commands write to user-global explorer.sortOrder; the context key
// zekelin.explorerSortByModified is what swaps which of the two title-bar
// buttons is currently visible.

export async function sortExplorerByModified(): Promise<void> {
  await vscode.workspace.getConfiguration('explorer').update(
    'sortOrder',
    'modified',
    vscode.ConfigurationTarget.Global
  );
}

export async function sortExplorerByDefault(): Promise<void> {
  await vscode.workspace.getConfiguration('explorer').update(
    'sortOrder',
    'default',
    vscode.ConfigurationTarget.Global
  );
}

export function updateExplorerSortContextKey(): void {
  const cur = vscode.workspace.getConfiguration('explorer').get<string>('sortOrder');
  vscode.commands.executeCommand('setContext', 'zekelin.explorerSortByModified', cur === 'modified');
}

// ─── Resend last commit (refresh timestamp) ────────────────────────────────────
// Runs `git commit --amend --no-edit --date=now` in the first workspace's repo.
// Designed for not-yet-pushed commits where the user wants the timestamp to be
// "now" without changing the message. Since amend rewrites the commit SHA, this
// is safe locally but would require --force on push if already published.

export async function resendLastCommit(
  outputChannel: vscode.OutputChannel,
  runner: GitRunner = defaultGitRunner,
  confirm: (msg: string, modal: boolean, ...actions: string[]) => Thenable<string | undefined> =
    (msg, modal, ...actions) => vscode.window.showWarningMessage(msg, { modal }, ...actions)
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Open a workspace folder with a git repository first.');
    return;
  }

  const seed = folders[0].uri.fsPath;
  const rootRes = await runner(['rev-parse', '--show-toplevel'], seed);
  if (rootRes.error) {
    vscode.window.showErrorMessage('Not a git repository (or no commits yet).');
    return;
  }
  const repoRoot = rootRes.stdout.trim();

  // Grab last commit info to show in the confirmation prompt.
  const info = await runner(['log', '-1', '--format=%h %s%n%an <%ae>%n%ad', '--date=iso'], repoRoot);
  if (info.error) {
    outputChannel.show(true);
    outputChannel.appendLine(info.stderr || info.error.message);
    vscode.window.showErrorMessage('No commits to amend in this repository.');
    return;
  }
  const lines = info.stdout.split(/\r?\n/);
  const [shaAndSubject = '', authorLine = '', dateLine = ''] = lines;

  const choice = await confirm(
    `Replace last commit with a new one (same message, fresh timestamp)?\n\n` +
    `${shaAndSubject}\n${authorLine}\n${dateLine}\n\n` +
    `Runs: git commit --amend --no-edit --date=now\n` +
    `If you've already pushed this commit, you'll need git push --force afterwards.`,
    true,
    'Replace'
  );
  if (choice !== 'Replace') { return; }

  outputChannel.show(true);
  outputChannel.appendLine(`Repo: ${repoRoot}`);
  outputChannel.appendLine(`Running: git commit --amend --no-edit --date=now`);
  const res = await runner(['commit', '--amend', '--no-edit', '--date=now'], repoRoot);
  if (res.stdout) { outputChannel.appendLine(res.stdout.trimEnd()); }
  if (res.stderr) { outputChannel.appendLine(res.stderr.trimEnd()); }
  if (res.error) {
    vscode.window.showErrorMessage('git commit --amend failed. See output for details.');
    return;
  }

  // Show new SHA so the user can see the commit was rewritten.
  const after = await runner(['log', '-1', '--format=%h %s'], repoRoot);
  if (after.stdout) { outputChannel.appendLine(`New commit: ${after.stdout.trim()}`); }
  vscode.window.showInformationMessage('Last commit replaced — timestamp refreshed.');
}

// ─── Combine commits (squash into first) ───────────────────────────────────────
// Squashes every commit ahead of main/master/upstream, plus any uncommitted
// changes, into a single commit that reuses the FIRST squashed commit's message.
// Implemented as: git reset --soft <base> && git add -A && git commit -m <msg>.
// Rewrites history, so already-pushed commits need git push --force afterwards.

const COMBINE_BASE_REFS = ['origin/main', 'origin/master', 'main', 'master', '@{upstream}'];

export async function combineCommits(
  outputChannel: vscode.OutputChannel,
  runner: GitRunner = defaultGitRunner,
  confirm: (msg: string, modal: boolean, ...actions: string[]) => Thenable<string | undefined> =
    (msg, modal, ...actions) => vscode.window.showWarningMessage(msg, { modal }, ...actions)
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Open a workspace folder with a git repository first.');
    return;
  }

  const seed = folders[0].uri.fsPath;
  const rootRes = await runner(['rev-parse', '--show-toplevel'], seed);
  if (rootRes.error) {
    vscode.window.showErrorMessage('Not a git repository (or no commits yet).');
    return;
  }
  const repoRoot = rootRes.stdout.trim();

  const headRes = await runner(['rev-parse', 'HEAD'], repoRoot);
  if (headRes.error) {
    vscode.window.showErrorMessage('No commits in this repository yet.');
    return;
  }
  const head = headRes.stdout.trim();

  const branchRes = await runner(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const branch = branchRes.stdout.trim();

  // Prefer the branch's creation point from its reflog so only commits made on
  // THIS branch get squashed, even when it was cut from another feature branch.
  let base = '';
  let baseRef = '';
  if (branch && branch !== 'HEAD') {
    const reflog = await runner(['reflog', 'show', '--format=%H %gs', branch], repoRoot);
    if (!reflog.error && reflog.stdout.trim()) {
      const entries = reflog.stdout.trim().split(/\r?\n/);
      const created = (entries[entries.length - 1] ?? '').match(/^([0-9a-f]{40}) branch: Created from /);
      if (created && created[1] !== head) { base = created[1]; baseRef = 'branch creation point'; }
    }
  }
  for (const ref of COMBINE_BASE_REFS) {
    if (base) break;
    const mb = await runner(['merge-base', 'HEAD', ref], repoRoot);
    if (mb.error) continue;
    const sha = mb.stdout.trim();
    if (sha && sha !== head) { base = sha; baseRef = ref; }
  }
  if (!base) {
    vscode.window.showErrorMessage('Combine commits: no commits ahead of main/master/upstream — nothing to squash.');
    return;
  }

  const countRes = await runner(['rev-list', '--count', `${base}..HEAD`], repoRoot);
  const count = parseInt(countRes.stdout.trim(), 10) || 0;
  const statusRes = await runner(['status', '--porcelain'], repoRoot);
  const dirty = statusRes.stdout.trim().length > 0;
  if (count <= 1 && !dirty) {
    vscode.window.showInformationMessage('Only one commit ahead and no uncommitted changes — nothing to combine.');
    return;
  }

  const firstRes = await runner(['rev-list', '--reverse', `${base}..HEAD`], repoRoot);
  const firstSha = (firstRes.stdout.split(/\r?\n/)[0] ?? '').trim();
  const msgRes = await runner(['log', '-1', '--format=%B', firstSha], repoRoot);
  if (msgRes.error || !msgRes.stdout.trim()) {
    vscode.window.showErrorMessage('Combine commits: could not read the first commit message.');
    return;
  }
  const message = msgRes.stdout.replace(/\r\n/g, '\n').trimEnd();
  const subject = message.split('\n')[0];

  const choice = await confirm(
    `Squash ${count} commit(s) on "${branch}"${dirty ? ' plus uncommitted changes' : ''} into one commit?\n\n` +
    `Message (from first commit): ${subject}\n` +
    `Base: ${baseRef} (${base.slice(0, 7)})\n\n` +
    `If any of these commits are already pushed, you'll need git push --force afterwards.`,
    true,
    'Combine'
  );
  if (choice !== 'Combine') return;

  outputChannel.show(true);
  outputChannel.appendLine(`Repo: ${repoRoot}`);
  outputChannel.appendLine(`Old HEAD: ${head} (recover with: git reset ${head.slice(0, 7)})`);

  outputChannel.appendLine(`Running: git reset --soft ${base.slice(0, 7)}`);
  const resetRes = await runner(['reset', '--soft', base], repoRoot);
  if (resetRes.stderr) { outputChannel.appendLine(resetRes.stderr.trimEnd()); }
  if (resetRes.error) {
    vscode.window.showErrorMessage('git reset --soft failed. See output for details.');
    return;
  }

  outputChannel.appendLine('Running: git add -A');
  const addRes = await runner(['add', '-A'], repoRoot);
  if (addRes.stderr) { outputChannel.appendLine(addRes.stderr.trimEnd()); }
  if (addRes.error) {
    vscode.window.showErrorMessage(`git add -A failed. Recover with: git reset ${head.slice(0, 7)}`);
    return;
  }

  outputChannel.appendLine(`Running: git commit -m "${subject}"`);
  const commitRes = await runner(['commit', '-m', message], repoRoot);
  if (commitRes.stdout) { outputChannel.appendLine(commitRes.stdout.trimEnd()); }
  if (commitRes.stderr) { outputChannel.appendLine(commitRes.stderr.trimEnd()); }
  if (commitRes.error) {
    vscode.window.showErrorMessage(`git commit failed. Recover with: git reset ${head.slice(0, 7)}`);
    return;
  }

  const after = await runner(['log', '-1', '--format=%h %s'], repoRoot);
  if (after.stdout) { outputChannel.appendLine(`New commit: ${after.stdout.trim()}`); }
  vscode.window.showInformationMessage(`Combined ${count} commit(s) into: ${subject}`);
}
