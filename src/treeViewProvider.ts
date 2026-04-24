import * as vscode from 'vscode';

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
