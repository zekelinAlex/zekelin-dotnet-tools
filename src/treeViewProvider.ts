import * as vscode from 'vscode';
import { dataverseEnvironmentsChanged, getDataverseEnvironments } from './commands';

export class CleanupActionItem extends vscode.TreeItem {
  constructor(label: string, commandId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: commandId,
      title: label
    };
  }
}

export class CleanupActionsProvider implements vscode.TreeDataProvider<CleanupActionItem> {
  private actions: CleanupActionItem[] = [
    new CleanupActionItem('Clear NuGet Cache', 'dotnet-cleanup.clearNugetCache'),
    new CleanupActionItem('Kill .NET Processes', 'dotnet-cleanup.killDotnetProcesses'),
    new CleanupActionItem('Kill VBCSCompiler', 'dotnet-cleanup.killVBCSCompiler')
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
    new CleanupActionItem('Install targets Nugets', 'dotnet-cleanup.installTargetNugets'),
    new CleanupActionItem('Generate Install Script', 'dotnet-cleanup.generateInstallScript')
  ];

  getTreeItem(element: CleanupActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CleanupActionItem[] {
    return this.actions;
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
    addBtn.contextValue = 'dataverseAddEnvironment';
    items.push(addBtn);

    const createBtn = new vscode.TreeItem('Create environment', vscode.TreeItemCollapsibleState.None);
    createBtn.command = { command: 'dotnet-cleanup.createDataverseEnvironment', title: 'Create environment' };
    createBtn.iconPath = new vscode.ThemeIcon('cloud-upload');
    createBtn.tooltip = 'pac admin create --currency EUR --region europe --type Developer';
    createBtn.contextValue = 'dataverseCreateEnvironment';
    items.push(createBtn);

    const deleteBtn = new vscode.TreeItem('Delete environment', vscode.TreeItemCollapsibleState.None);
    deleteBtn.command = { command: 'dotnet-cleanup.deleteDataverseEnvironment', title: 'Delete environment' };
    deleteBtn.iconPath = new vscode.ThemeIcon('trash');
    deleteBtn.tooltip = 'pac admin delete --environment <id> --async';
    deleteBtn.contextValue = 'dataverseDeleteEnvironment';
    items.push(deleteBtn);

    const revealBtn = new vscode.TreeItem('Reveal config', vscode.TreeItemCollapsibleState.None);
    revealBtn.command = { command: 'dotnet-cleanup.revealDataverseEnvironmentsConfig', title: 'Reveal config' };
    revealBtn.iconPath = new vscode.ThemeIcon('go-to-file');
    revealBtn.tooltip = 'Open ~/.zekelin-dotnet-tools/zekelin-dotnet-tools.json (global, shared across workspaces)';
    revealBtn.contextValue = 'dataverseRevealConfig';
    items.push(revealBtn);

    for (const env of getDataverseEnvironments()) {
      const label = env.name || '(unnamed)';
      const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      it.description = env.url || env.id || '';
      it.tooltip = `name: ${env.name}\nid: ${env.id}\nurl: ${env.url}`;
      it.iconPath = new vscode.ThemeIcon('cloud');
      it.contextValue = 'dataverseEnvironment';
      items.push(it);
    }

    return items;
  }
}
