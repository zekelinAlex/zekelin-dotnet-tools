import * as vscode from 'vscode';
import * as path from 'path';
import { CleanupActionsProvider, DevkitBuildActionsProvider } from './treeViewProvider';
import { clearNugetCache, killDotnetProcesses, killVBCSCompiler, dotnetWipe, dotnetPublish, generateSnippetPrefixes, gitPush, gitDiscard, installTargetNugets, generateInstallScript, DEVKIT_FOLDER_NAME } from './commands';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Zekelin .NET Tools');

  const provider = new CleanupActionsProvider();
  vscode.window.registerTreeDataProvider('dotnetCleanupActions', provider);

  const devkitProvider = new DevkitBuildActionsProvider();
  vscode.window.registerTreeDataProvider('zekelinDevkitBuildActions', devkitProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.clearNugetCache', () => {
      return clearNugetCache(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.killDotnetProcesses', () => {
      return killDotnetProcesses(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.killVBCSCompiler', () => {
      return killVBCSCompiler(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.dotnetWipe', (uri: vscode.Uri) => {
      return dotnetWipe(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.dotnetPublish', (uri: vscode.Uri) => {
      return dotnetPublish(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.generateSnippetPrefixes', (uri: vscode.Uri) => {
      return generateSnippetPrefixes(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.gitPush', (uri: vscode.Uri) => {
      return gitPush(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.gitDiscard', (uri: vscode.Uri) => {
      return gitDiscard(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.installTargetNugets', () => {
      return installTargetNugets(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.generateInstallScript', () => {
      return generateInstallScript(context, outputChannel);
    })
  );

  setupDevkitBuildContext(context);
  setupGitChangedPathsContext(context);
  setupWipeTargetsContext(context);
  setupPublishTargetsContext(context);

  context.subscriptions.push(outputChannel);
}

function setupDevkitBuildContext(context: vscode.ExtensionContext) {
  const update = () => {
    const folders = vscode.workspace.workspaceFolders || [];
    const isDevkit = folders.some((f) => path.basename(f.uri.fsPath) === DEVKIT_FOLDER_NAME);
    vscode.commands.executeCommand('setContext', 'zekelin.isDevkitBuild', isDevkit);
  };
  update();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(update));
}

function setupPublishTargetsContext(context: vscode.ExtensionContext) {
  const glob = '**/*.{csproj,sln,slnx}';
  const refresh = async () => {
    const targets: { [key: string]: boolean } = {};
    try {
      const files = await vscode.workspace.findFiles(glob, '**/node_modules/**');
      for (const uri of files) {
        const filePath = uri.fsPath;
        targets[filePath] = true;
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        const wsRoot = wsFolder ? wsFolder.uri.fsPath : undefined;
        let p = path.dirname(filePath);
        while (true) {
          targets[p] = true;
          if (wsRoot && p === wsRoot) { break; }
          const parent = path.dirname(p);
          if (parent === p) { break; }
          p = parent;
        }
      }
    } catch (err) {
      console.error('dotnet-cleanup: failed to index publish targets', err);
    }
    vscode.commands.executeCommand('setContext', 'dotnetCleanup.publishTargets', targets);
  };

  refresh();

  const watcher = vscode.workspace.createFileSystemWatcher(glob);
  context.subscriptions.push(watcher);
  context.subscriptions.push(watcher.onDidCreate(() => refresh()));
  context.subscriptions.push(watcher.onDidDelete(() => refresh()));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()));
}

function setupWipeTargetsContext(context: vscode.ExtensionContext) {
  const refresh = async () => {
    const targets: { [key: string]: boolean } = {};
    try {
      const csprojs = await vscode.workspace.findFiles('**/*.csproj', '**/node_modules/**');
      for (const uri of csprojs) {
        const csprojPath = uri.fsPath;
        targets[csprojPath] = true;

        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        const wsRoot = wsFolder ? wsFolder.uri.fsPath : undefined;

        let p = path.dirname(csprojPath);
        while (true) {
          targets[p] = true;
          if (wsRoot && p === wsRoot) { break; }
          const parent = path.dirname(p);
          if (parent === p) { break; }
          p = parent;
        }
      }
    } catch (err) {
      console.error('dotnet-cleanup: failed to index .csproj files', err);
    }
    vscode.commands.executeCommand('setContext', 'dotnetCleanup.wipeTargets', targets);
  };

  refresh();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
  context.subscriptions.push(watcher);
  context.subscriptions.push(watcher.onDidCreate(() => refresh()));
  context.subscriptions.push(watcher.onDidDelete(() => refresh()));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()));
}

function setupGitChangedPathsContext(context: vscode.ExtensionContext) {
  const gitExt = vscode.extensions.getExtension<any>('vscode.git');
  if (!gitExt) { return; }

  const init = async () => {
    try {
      if (!gitExt.isActive) { await gitExt.activate(); }
      const api = gitExt.exports.getAPI(1);

      const refresh = () => {
        const changed: { [key: string]: boolean } = {};
        for (const repo of api.repositories) {
          const repoRoot: string = repo.rootUri.fsPath;
          const changes: { uri: vscode.Uri }[] = [
            ...repo.state.workingTreeChanges,
            ...repo.state.indexChanges,
            ...(repo.state.untrackedChanges || [])
          ];
          if (changes.length === 0) { continue; }
          for (const c of changes) {
            let p = c.uri.fsPath;
            changed[p] = true;
            while (p.length > repoRoot.length) {
              const parent = path.dirname(p);
              if (parent === p) { break; }
              p = parent;
              changed[p] = true;
              if (p === repoRoot) { break; }
            }
            changed[repoRoot] = true;
          }
        }
        vscode.commands.executeCommand('setContext', 'dotnetGit.changedPaths', changed);
      };

      const watchRepo = (repo: any) => {
        context.subscriptions.push(repo.state.onDidChange(refresh));
      };

      for (const repo of api.repositories) { watchRepo(repo); }
      context.subscriptions.push(api.onDidOpenRepository((repo: any) => { watchRepo(repo); refresh(); }));
      context.subscriptions.push(api.onDidCloseRepository(() => refresh()));

      refresh();
    } catch (err) {
      console.error('dotnet-cleanup: failed to initialize git change tracking', err);
    }
  };

  init();
}

export function deactivate() {}
