import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { resendLastCommit } from '../../commands';

suite('resendLastCommit', () => {
  const output = { appendLine: () => {}, show: () => {} } as unknown as vscode.OutputChannel;
  let calls: string[][];
  const runner = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { stdout: 'C:/repo\n', stderr: '', error: null };
    if (args[0] === 'log') return { stdout: 'abc123 feat: old title\nMe <me@x>\n2026-11-10', stderr: '', error: null };
    return { stdout: '', stderr: '', error: null };
  };

  setup(() => {
    calls = [];
    sinon.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file('C:/repo'), name: 'repo', index: 0 }]);
  });
  teardown(() => sinon.restore());

  const commitCall = () => calls.find((c) => c[0] === 'commit');

  test('empty input keeps the message and refreshes the date', async () => {
    await resendLastCommit(output, runner as any, async () => '  ');
    assert.deepStrictEqual(commitCall(), ['commit', '--amend', '--no-edit', '--date=now']);
  });

  test('typed input becomes the new message', async () => {
    await resendLastCommit(output, runner as any, async () => 'fix: new "title"');
    assert.deepStrictEqual(commitCall(), ['commit', '--amend', '-m', 'fix: new "title"', '--date=now']);
  });

  test('escape cancels without committing', async () => {
    await resendLastCommit(output, runner as any, async () => undefined);
    assert.strictEqual(commitCall(), undefined);
  });
});
