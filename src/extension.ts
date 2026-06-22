import * as vscode from 'vscode';
import * as path from 'path';
import { CleanupActionsProvider, DevkitBuildActionsProvider, DataverseActionsProvider, ToolsCliActionsProvider } from './treeViewProvider';
import { clearNugetCache, killDotnetProcesses, killVBCSCompiler, dotnetWipe, dotnetPublish, generateSnippetPrefixes, gitPush, gitDiscard, installTargetNugets, generateInstallScript, dataverseSolutionUnpack, dataverseSolutionImport, dataversePackageDeploy, addDataverseEnvironment, createDataverseEnvironment, deleteDataverseEnvironment, revealDataverseEnvironmentsConfig, migrateEnvironmentsToGlobalIfNeeded, openInNewWindow, sendToLocalNugetFeed, sortExplorerByModified, sortExplorerByDefault, updateExplorerSortContextKey, toolsCliReinstallLocal, toolsCliGenerateScript, DEVKIT_FOLDER_NAME, TOOLS_CLI_FOLDER_NAME } from './commands';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Zekelin .NET Tools');

  const provider = new CleanupActionsProvider();
  vscode.window.registerTreeDataProvider('dotnetCleanupActions', provider);

  const devkitProvider = new DevkitBuildActionsProvider();
  vscode.window.registerTreeDataProvider('zekelinDevkitBuildActions', devkitProvider);

  const dataverseProvider = new DataverseActionsProvider();
  vscode.window.registerTreeDataProvider('zekelinDataverseActions', dataverseProvider);

  const toolsCliProvider = new ToolsCliActionsProvider();
  vscode.window.registerTreeDataProvider('zekelinToolsCliActions', toolsCliProvider);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.dataverseSolutionUnpack', (uri: vscode.Uri) => {
      return dataverseSolutionUnpack(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.dataverseSolutionImport', (uri: vscode.Uri) => {
      return dataverseSolutionImport(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.dataversePackageDeploy', (uri: vscode.Uri) => {
      return dataversePackageDeploy(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.addDataverseEnvironment', () => {
      return addDataverseEnvironment(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.createDataverseEnvironment', () => {
      return createDataverseEnvironment(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.deleteDataverseEnvironment', () => {
      return deleteDataverseEnvironment(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.openInNewWindow', (uri: vscode.Uri) => {
      return openInNewWindow(uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.revealDataverseEnvironmentsConfig', () => {
      return revealDataverseEnvironmentsConfig(outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.sendToLocalNugetFeed', (uri: vscode.Uri) => {
      return sendToLocalNugetFeed(uri, outputChannel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.sortExplorerByModified', () => sortExplorerByModified())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.sortExplorerByDefault', () => sortExplorerByDefault())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.toolsCliReinstallLocal', () => {
      return toolsCliReinstallLocal(outputChannel, false);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.toolsCliReinstallLocalWithMcp', () => {
      return toolsCliReinstallLocal(outputChannel, true);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('dotnet-cleanup.toolsCliGenerateScript', () => {
      return toolsCliGenerateScript(outputChannel);
    })
  );

  // Seed the context key right now, and keep it in sync if the user (or
  // another extension, or settings sync) changes explorer.sortOrder later.
  updateExplorerSortContextKey();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('explorer.sortOrder')) {
        updateExplorerSortContextKey();
      }
    })
  );

  // Run migration once at activation so users see the info message even
  // before they open the Dataverse section. Safe to call repeatedly — it
  // short-circuits after the first invocation.
  migrateEnvironmentsToGlobalIfNeeded(outputChannel);

  // One-time apply of preferred window.title so the folder name shows up
  // in the OS taskbar instead of the active file. Only fires when the user
  // hasn't set their own global value, so we never clobber a custom setting.
  applyPreferredWindowTitle(outputChannel);

  setupDevkitBuildContext(context);
  setupToolsCliContext(context);
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

function setupToolsCliContext(context: vscode.ExtensionContext) {
  const update = () => {
    const folders = vscode.workspace.workspaceFolders || [];
    const isToolsCli = folders.some((f) => path.basename(f.uri.fsPath) === TOOLS_CLI_FOLDER_NAME);
    vscode.commands.executeCommand('setContext', 'zekelin.isToolsCli', isToolsCli);
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

const PREFERRED_WINDOW_TITLE = '${dirty}${rootName}${separator}${appName}';

async function applyPreferredWindowTitle(outputChannel: vscode.OutputChannel): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration();
    const inspect = cfg.inspect<string>('window.title');
    // Inspect tells us where the value came from:
    //   globalValue   — explicit user setting in settings.json (we don't touch)
    //   workspaceValue / workspaceFolderValue — workspace overrides (we don't touch either)
    //   defaultValue  — VS Code built-in fallback (we may replace at the user level)
    if (inspect?.globalValue !== undefined) { return; }
    if (inspect?.workspaceValue !== undefined) { return; }
    if (inspect?.workspaceFolderValue !== undefined) { return; }

    await cfg.update('window.title', PREFERRED_WINDOW_TITLE, vscode.ConfigurationTarget.Global);
    outputChannel.appendLine(`Set window.title = "${PREFERRED_WINDOW_TITLE}" (global) so the workspace folder name shows in the taskbar.`);
    vscode.window.showInformationMessage(
      'Zekelin .NET Tools: window.title now shows the workspace folder name in the taskbar. Edit window.title in settings.json to revert.'
    );
  } catch (err) {
    outputChannel.appendLine(`Failed to apply preferred window.title: ${(err as Error).message}`);
  }
}

export function deactivate() {}
