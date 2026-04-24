import * as assert from 'assert';
import * as vscode from 'vscode';
import { clearNugetCache, killDotnetProcesses, killVBCSCompiler, dotnetWipe } from '../../commands';

suite('Commands Test Suite', () => {
  let outputLines: string[];
  let fakeOutputChannel: { appendLine: (msg: string) => void; show: () => void };

  setup(() => {
    outputLines = [];
    fakeOutputChannel = {
      appendLine: (msg: string) => { outputLines.push(msg); },
      show: () => {}
    };
  });

  suite('clearNugetCache', () => {
    test('should execute "dotnet nuget locals all --clear"', async () => {
      let calledCmd = '';
      const fakeExec = (cmd: string, callback: Function) => {
        calledCmd = cmd;
        callback(null, 'Clearing NuGet HTTP cache...', '');
      };

      await clearNugetCache(fakeOutputChannel as any, fakeExec as any);

      assert.strictEqual(calledCmd, 'dotnet nuget locals all --clear');
    });

    test('should write stdout to output channel on success', async () => {
      const fakeExec = (cmd: string, callback: Function) => {
        callback(null, 'Cache cleared successfully', '');
      };

      await clearNugetCache(fakeOutputChannel as any, fakeExec as any);

      assert.ok(outputLines.some(line => line.includes('Cache cleared successfully')));
    });

    test('should write error to output channel on failure', async () => {
      const fakeExec = (cmd: string, callback: Function) => {
        callback(new Error('dotnet not found'), '', 'dotnet not found');
      };

      await clearNugetCache(fakeOutputChannel as any, fakeExec as any);

      assert.ok(outputLines.some(line => line.toLowerCase().includes('error')));
    });
  });

  suite('killDotnetProcesses', () => {
    test('should execute "taskkill /IM dotnet.exe /F"', async () => {
      let calledCmd = '';
      const fakeExec = (cmd: string, callback: Function) => {
        calledCmd = cmd;
        callback(null, 'SUCCESS: Sent termination signal', '');
      };

      await killDotnetProcesses(fakeOutputChannel as any, fakeExec as any);

      assert.strictEqual(calledCmd, 'taskkill /IM dotnet.exe /F');
    });

    test('should write stdout to output channel on success', async () => {
      const fakeExec = (cmd: string, callback: Function) => {
        callback(null, 'SUCCESS: Sent termination signal to process', '');
      };

      await killDotnetProcesses(fakeOutputChannel as any, fakeExec as any);

      assert.ok(outputLines.some(line => line.includes('SUCCESS')));
    });

    test('should handle case when no dotnet processes are running', async () => {
      const fakeExec = (cmd: string, callback: Function) => {
        callback(new Error('not found'), '', 'ERROR: The process "dotnet.exe" not found.');
      };

      await killDotnetProcesses(fakeOutputChannel as any, fakeExec as any);

      assert.ok(outputLines.some(line => line.includes('No .NET processes') || line.includes('not found')));
    });
  });

  suite('killVBCSCompiler', () => {
    test('should execute "taskkill /IM VBCSCompiler.exe /F"', async () => {
      let calledCmd = '';
      const fakeExec = (cmd: string, callback: Function) => {
        calledCmd = cmd;
        callback(null, 'SUCCESS: Sent termination signal', '');
      };

      await killVBCSCompiler(fakeOutputChannel as any, fakeExec as any);

      assert.strictEqual(calledCmd, 'taskkill /IM VBCSCompiler.exe /F');
    });

    test('should write stdout to output channel on success', async () => {
      const fakeExec = (cmd: string, callback: Function) => {
        callback(null, 'SUCCESS: Terminated process VBCSCompiler.exe', '');
      };

      await killVBCSCompiler(fakeOutputChannel as any, fakeExec as any);

      assert.ok(outputLines.some(line => line.includes('SUCCESS')));
    });

    test('should handle case when no VBCSCompiler processes are running', async () => {
      const fakeExec = (cmd: string, callback: Function) => {
        callback(new Error('not found'), '', 'ERROR: The process "VBCSCompiler.exe" not found.');
      };

      await killVBCSCompiler(fakeOutputChannel as any, fakeExec as any);

      assert.ok(outputLines.some(line => line.includes('No VBCSCompiler') || line.includes('not found')));
    });
  });

  suite('dotnetWipe', () => {
    function makeFakeUri(fsPath: string): vscode.Uri {
      return { fsPath } as any;
    }

    function fakeStat(isDir: boolean): any {
      return { isDirectory: () => isDir };
    }

    test('should warn if no .csproj in folder or subfolders', async () => {
      const fakeFsFns = {
        existsSync: () => false,
        readdirSync: ((_: any) => ['readme.md', 'file.txt']) as any,
        statSync: ((p: any) => fakeStat(p === 'C:\\fake\\folder')) as any
      };
      const fakeExec = (_cmd: string, callback: Function) => {
        callback(null, '', '');
      };

      await dotnetWipe(makeFakeUri('C:\\fake\\folder'), fakeOutputChannel as any, fakeExec as any, fakeFsFns);

      assert.ok(!outputLines.some(line => line.includes('Deleting')));
    });

    test('should kill VBCSCompiler first, then delete bin/obj', async () => {
      const calledCmds: string[] = [];
      const fakeExec = (cmd: string, callback: Function) => {
        calledCmds.push(cmd);
        callback(null, 'SUCCESS', '');
      };
      const fakeFsFns = {
        existsSync: () => true,
        readdirSync: ((_: any) => ['MyProject.csproj', 'Program.cs']) as any,
        statSync: ((p: any) => fakeStat(p === 'C:\\fake\\project')) as any
      };

      await dotnetWipe(makeFakeUri('C:\\fake\\project'), fakeOutputChannel as any, fakeExec as any, fakeFsFns);

      assert.ok(calledCmds[0].includes('VBCSCompiler'), 'First command should kill VBCSCompiler');
      assert.ok(calledCmds[1].includes('Remove-Item'), 'Second command should delete folders');
    });

    test('should report nothing to delete if bin/obj do not exist', async () => {
      const fakeExec = (cmd: string, callback: Function) => {
        callback(null, '', '');
      };
      const fakeFsFns = {
        existsSync: () => false,
        readdirSync: ((_: any) => ['App.csproj']) as any,
        statSync: ((p: any) => fakeStat(p === 'C:\\fake\\project')) as any
      };

      await dotnetWipe(makeFakeUri('C:\\fake\\project'), fakeOutputChannel as any, fakeExec as any, fakeFsFns);

      assert.ok(outputLines.some(line => line.includes('No bin/ or obj/')));
    });

    test('should wipe a .csproj file by targeting its parent folder', async () => {
      const calledCmds: string[] = [];
      const fakeExec = (cmd: string, callback: Function) => {
        calledCmds.push(cmd);
        callback(null, 'SUCCESS', '');
      };
      const fakeFsFns = {
        existsSync: () => true,
        readdirSync: ((_: any) => []) as any,
        statSync: ((_p: any) => fakeStat(false)) as any
      };

      await dotnetWipe(
        makeFakeUri('C:\\fake\\project\\App.csproj'),
        fakeOutputChannel as any,
        fakeExec as any,
        fakeFsFns
      );

      const psCmd = calledCmds.find(c => c.includes('Remove-Item'));
      assert.ok(psCmd, 'should have issued a Remove-Item command');
      assert.ok(psCmd!.includes('C:\\\\fake\\\\project\\\\bin') || psCmd!.includes('C:\\fake\\project\\bin'));
    });

    test('should recursively wipe every subfolder containing a .csproj', async () => {
      const calledCmds: string[] = [];
      const fakeExec = (cmd: string, callback: Function) => {
        calledCmds.push(cmd);
        callback(null, 'SUCCESS', '');
      };

      const tree: { [dir: string]: string[] } = {
        'C:\\sln': ['ProjectA', 'ProjectB', 'README.md'],
        'C:\\sln\\ProjectA': ['A.csproj', 'Program.cs'],
        'C:\\sln\\ProjectB': ['B.csproj']
      };
      const dirs = new Set(['C:\\sln', 'C:\\sln\\ProjectA', 'C:\\sln\\ProjectB']);

      const fakeFsFns = {
        existsSync: () => true,
        readdirSync: ((dir: any) => (tree[dir as string] || [])) as any,
        statSync: ((p: any) => fakeStat(dirs.has(p as string))) as any
      };

      await dotnetWipe(makeFakeUri('C:\\sln'), fakeOutputChannel as any, fakeExec as any, fakeFsFns);

      assert.ok(outputLines.some(l => l.includes('C:\\sln\\ProjectA')), 'should list ProjectA');
      assert.ok(outputLines.some(l => l.includes('C:\\sln\\ProjectB')), 'should list ProjectB');
      const psCmd = calledCmds.find(c => c.includes('Remove-Item'));
      assert.ok(psCmd && psCmd.includes('ProjectA'));
      assert.ok(psCmd && psCmd.includes('ProjectB'));
    });
  });
});
