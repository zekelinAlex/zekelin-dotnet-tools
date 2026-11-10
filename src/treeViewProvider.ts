import * as vscode from 'vscode';
import { dataverseEnvironmentKey, dataverseEnvironmentsChanged, getActiveDataverseEnvironmentKey, getDataverseEnvironments, getInstalledTxcVersions, toolsCliVersionsChanged } from './commands';

export class CleanupActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.command = {
      command: commandId,
      title: label
    };
  }
}

export class CleanupActionsProvider implements vscode.TreeDataProvider<CleanupActionItem> {
  private actions: CleanupActionItem[] = [
    new CleanupActionItem('Clear NuGet Cache', 'dotnet-cleanup.clearNugetCache', 'dotnet nuget locals all --clear: wipes every local NuGet cache'),
    new CleanupActionItem('Kill .NET Processes', 'dotnet-cleanup.killDotnetProcesses', 'taskkill /IM dotnet.exe /F: ends every running dotnet.exe'),
    new CleanupActionItem('Kill VBCSCompiler', 'dotnet-cleanup.killVBCSCompiler', 'taskkill /IM VBCSCompiler.exe /F: ends the Roslyn compiler that often locks files in bin/obj')
  ];

  getTreeItem(element: CleanupActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CleanupActionItem[] {
    return this.actions;
  }
}

export class GitActionsProvider implements vscode.TreeDataProvider<CleanupActionItem> {
  private actions: CleanupActionItem[] = [
    new CleanupActionItem('Undo last commit', 'dotnet-cleanup.undoLastCommit', 'git reset --soft HEAD~1: removes the last commit, its changes stay staged'),
    new CleanupActionItem('Resend last commit', 'dotnet-cleanup.resendLastCommit', 'git commit --amend --date=now: asks for a new message (empty keeps the current one) and refreshes the timestamp. Needs git push --force if already pushed'),
    new CleanupActionItem('Combine commits', 'dotnet-cleanup.combineCommits', 'Squashes all commits of the current branch into one (git reset --soft + git commit), keeping the first commit message'),
    new CleanupActionItem('Git Wipe', 'dotnet-cleanup.gitWipe', 'git clean -Xdf: deletes gitignored files (bin, obj, node_modules, ...) and empty folders, after a preview')
  ];

  getTreeItem(element: CleanupActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CleanupActionItem[] {
    return this.actions;
  }
}

export class DevkitBuildActionsProvider implements vscode.TreeDataProvider<CleanupActionItem> {
  private actions: CleanupActionItem[] = [
    new CleanupActionItem('Install targets Nugets', 'dotnet-cleanup.installTargetNugets', 'Packs src/Dataverse/*.csproj and the Sdk project at the configured version and copies the .nupkg files into the local NuGet feed'),
    new CleanupActionItem('Generate Install Script', 'dotnet-cleanup.generateInstallScript', 'Writes dev-scripts/Install-TargetNugets.ps1, a standalone copy of Install targets Nugets for terminals and agents')
  ];

  getTreeItem(element: CleanupActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CleanupActionItem[] {
    return this.actions;
  }
}

export class PlatformMetadataActionsProvider implements vscode.TreeDataProvider<CleanupActionItem> {
  private actions: CleanupActionItem[] = [
    new CleanupActionItem('Install targets Nugets', 'dotnet-cleanup.platformMetadataInstallNugets', 'Packs every .csproj under src/ at the configured version and copies the .nupkg files into the local NuGet feed'),
    new CleanupActionItem('Generate Install Script', 'dotnet-cleanup.platformMetadataGenerateScript', 'Writes dev-scripts/Install-TargetNugets.ps1, a standalone copy of Install targets Nugets for terminals and agents')
  ];

  getTreeItem(element: CleanupActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CleanupActionItem[] {
    return this.actions;
  }
}

export class ToolsDevkitTemplatesActionsProvider implements vscode.TreeDataProvider<CleanupActionItem> {
  private actions: CleanupActionItem[] = [
    new CleanupActionItem('Install targets Nugets', 'dotnet-cleanup.toolsDevkitTemplatesInstallNugets', 'Packs every packable .csproj under src/ (templates/ excluded) at the configured version and copies the .nupkg files into the local NuGet feed'),
    new CleanupActionItem('Generate Install Script', 'dotnet-cleanup.toolsDevkitTemplatesGenerateScript', 'Writes dev-scripts/Install-TargetNugets.ps1, a standalone copy of Install targets Nugets for terminals and agents')
  ];

  getTreeItem(element: CleanupActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CleanupActionItem[] {
    return this.actions;
  }
}

export class ToolsCliActionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private actions: CleanupActionItem[] = [
    new CleanupActionItem('Reinstall Local', 'dotnet-cleanup.toolsCliReinstallLocal', 'Builds txc from this repo and installs it as the global tool, wiping cached dotnet new templates'),
    new CleanupActionItem('Reinstall Local (with MCP)', 'dotnet-cleanup.toolsCliReinstallLocalWithMcp', 'Same as Reinstall Local, plus the txc-mcp server'),
    new CleanupActionItem('Reinstall from NuGet', 'dotnet-cleanup.toolsCliReinstallNuget', 'Replaces the installed txc (and txc-mcp if present) with the latest release from nuget.org, templates too'),
    new CleanupActionItem('Generate Script', 'dotnet-cleanup.toolsCliGenerateScript', 'Writes scripts/reinstall-local.ps1 so you can run Reinstall Local outside VS Code')
  ];

  constructor() {
    toolsCliVersionsChanged.event(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const versions = await getInstalledTxcVersions();
    const versionItem = new vscode.TreeItem(
      versions.cli ? `txc ${versions.cli}` : 'txc not installed',
      vscode.TreeItemCollapsibleState.None
    );
    versionItem.description = versions.mcp ? `txc-mcp ${versions.mcp}` : '';
    versionItem.iconPath = new vscode.ThemeIcon('tag');
    versionItem.tooltip = 'Installed global dotnet tools (dotnet tool list --global). Refreshes after each reinstall; click to refresh now.';
    versionItem.contextValue = 'toolsCliVersion';
    versionItem.command = { command: 'dotnet-cleanup.toolsCliRefreshVersions', title: 'Refresh txc version' };
    return [versionItem, ...this.actions];
  }
}

export class DataverseActionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor() {
    dataverseEnvironmentsChanged.event(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    const addBtn = new vscode.TreeItem('Add environment', vscode.TreeItemCollapsibleState.None);
    addBtn.command = { command: 'dotnet-cleanup.addDataverseEnvironment', title: 'Add environment' };
    addBtn.iconPath = new vscode.ThemeIcon('add');
    addBtn.tooltip = 'Adds an existing environment to the list by hand: name, optional id, url';
    addBtn.contextValue = 'dataverseAddEnvironment';
    items.push(addBtn);

    const createBtn = new vscode.TreeItem('Create environment', vscode.TreeItemCollapsibleState.None);
    createBtn.command = { command: 'dotnet-cleanup.createDataverseEnvironment', title: 'Create environment' };
    createBtn.iconPath = new vscode.ThemeIcon('cloud-upload');
    createBtn.tooltip = 'txc env create --currency EUR --region europe --type Developer --wait';
    createBtn.contextValue = 'dataverseCreateEnvironment';
    items.push(createBtn);

    const deleteBtn = new vscode.TreeItem('Delete environment', vscode.TreeItemCollapsibleState.None);
    deleteBtn.command = { command: 'dotnet-cleanup.deleteDataverseEnvironment', title: 'Delete environment' };
    deleteBtn.iconPath = new vscode.ThemeIcon('trash');
    deleteBtn.tooltip = 'txc env delete <id> --yes';
    deleteBtn.contextValue = 'dataverseDeleteEnvironment';
    items.push(deleteBtn);

    const syncBtn = new vscode.TreeItem('Sync environments', vscode.TreeItemCollapsibleState.None);
    syncBtn.command = { command: 'dotnet-cleanup.syncDataverseEnvironments', title: 'Sync environments' };
    syncBtn.iconPath = new vscode.ThemeIcon('sync');
    syncBtn.tooltip = 'txc env list: add new environments, drop ones that no longer exist';
    syncBtn.contextValue = 'dataverseSyncEnvironments';
    items.push(syncBtn);

    const revealBtn = new vscode.TreeItem('Reveal config', vscode.TreeItemCollapsibleState.None);
    revealBtn.command = { command: 'dotnet-cleanup.revealDataverseEnvironmentsConfig', title: 'Reveal config' };
    revealBtn.iconPath = new vscode.ThemeIcon('go-to-file');
    revealBtn.tooltip = 'Open ~/.zekelin-dotnet-tools/zekelin-dotnet-tools.json (global, shared across workspaces)';
    revealBtn.contextValue = 'dataverseRevealConfig';
    items.push(revealBtn);

    const activeKey = getActiveDataverseEnvironmentKey();
    for (const env of getDataverseEnvironments()) {
      const label = env.name || '(unnamed)';
      const isActive = dataverseEnvironmentKey(env) === activeKey;
      const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      it.description = (isActive ? 'active · ' : '') + (env.url || env.id || '');
      it.tooltip = `name: ${env.name}\nid: ${env.id}\nurl: ${env.url}\n\nClick to make it the active txc profile`;
      it.iconPath = new vscode.ThemeIcon(isActive ? 'pass-filled' : 'cloud');
      it.command = { command: 'dotnet-cleanup.selectDataverseEnvironmentProfile', title: 'Select txc profile', arguments: [env] };
      it.contextValue = 'dataverseEnvironment';
      items.push(it);
    }

    return items;
  }
}
