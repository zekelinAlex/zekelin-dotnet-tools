import * as assert from 'assert';
import { CleanupActionsProvider } from '../../treeViewProvider';

suite('TreeView Provider Test Suite', () => {
  let provider: CleanupActionsProvider;

  setup(() => {
    provider = new CleanupActionsProvider();
  });

  test('should return exactly 3 items', () => {
    const items = provider.getChildren();
    assert.strictEqual(items.length, 3);
  });

  test('first item should be "Clear NuGet Cache"', () => {
    const items = provider.getChildren();
    assert.strictEqual(items[0].label, 'Clear NuGet Cache');
  });

  test('second item should be "Kill .NET Processes"', () => {
    const items = provider.getChildren();
    assert.strictEqual(items[1].label, 'Kill .NET Processes');
  });

  test('first item should have clearNugetCache command', () => {
    const items = provider.getChildren();
    assert.strictEqual(items[0].command?.command, 'dotnet-cleanup.clearNugetCache');
  });

  test('second item should have killDotnetProcesses command', () => {
    const items = provider.getChildren();
    assert.strictEqual(items[1].command?.command, 'dotnet-cleanup.killDotnetProcesses');
  });

  test('third item should be "Kill VBCSCompiler"', () => {
    const items = provider.getChildren();
    assert.strictEqual(items[2].label, 'Kill VBCSCompiler');
  });

  test('third item should have killVBCSCompiler command', () => {
    const items = provider.getChildren();
    assert.strictEqual(items[2].command?.command, 'dotnet-cleanup.killVBCSCompiler');
  });

  test('getTreeItem should return the item itself', () => {
    const items = provider.getChildren();
    const treeItem = provider.getTreeItem(items[0]);
    assert.strictEqual(treeItem, items[0]);
  });
});
