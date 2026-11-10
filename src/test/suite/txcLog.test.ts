import * as assert from 'assert';
import { createLineBuffer, createTxcOutputWriter, formatTxcLogLine, formatTxcLogLineDetailed, humanizeEmbeddedJson } from '../../txcLog';

const dataverseError = JSON.stringify({ Code: '', Message: 'Nullable object must have a value.', Target: null, Details: [], Innererror: null });
const apiHubsError = JSON.stringify({
  error: {
    code: 'ApiHubsRequestFailed',
    message: `The request failed with client error: '${dataverseError}'. The correlation Id is '3ee5c009-a3ac-4d9d-93b9-2502890d35a5'.`,
    details: [{ code: 'FullNonLocalizedError', message: dataverseError }]
  }
});
const solutionImportErrorLine = JSON.stringify({
  ts: '2026-09-21T15:14:16.9801816Z',
  level: 'Error',
  cat: 'SolutionImportCliCommand',
  msg: `Command failed: Solution import failed: Connector import: FAILURE: ${apiHubsError} System.InvalidOperationException: Solution import failed: Connector import: FAILURE: ${apiHubsError}\r\n` +
    '   at TALXIS.CLI.Platform.Dataverse.Application.Sdk.SolutionImporter.PollAsyncOperationAsync(Guid asyncOperationId, CancellationToken cancellationToken) in /_/src/TALXIS.CLI.Platform.Dataverse.Application/Sdk/SolutionImporter.cs:line 275\r\n' +
    '   at TALXIS.CLI.Core.TxcLeafCommand.RunAsync() in /_/src/TALXIS.CLI.Core/Shared/TxcLeafCommand.cs:line 105',
  data: { Error: 'Solution import failed' }
});

const supportInfoLine = String.raw`{"ts":"2026-09-21T15:14:16.9813192Z","level":"Information","cat":"SolutionImportCliCommand","msg":"If this is unexpected, report at https://github.com/TALXIS/tools-cli/issues\r\n  Session: ae65408d-2786-41e3-a1a8-548d7c648173\r\n  Operation: 44997db111070170ee2858654e88257b\r\n  Logs: ~\\AppData\\Local\\Temp\\txc\\logs\\session-ae65408d-2786-41e3-a1a8-548d7c648173.jsonl"}`;

suite('txcLog Test Suite', () => {
  suite('formatTxcLogLine', () => {
    test('should render an error line without escapes, stack trace or nested JSON', () => {
      assert.deepStrictEqual(formatTxcLogLine(solutionImportErrorLine), [
        "[ERROR] Command failed: Solution import failed: Connector import: FAILURE: ApiHubsRequestFailed: The request failed with client error: 'Nullable object must have a value.'. The correlation Id is '3ee5c009-a3ac-4d9d-93b9-2502890d35a5'."
      ]);
    });

    test('should indent the continuation lines of a multi-line message', () => {
      assert.deepStrictEqual(formatTxcLogLine(supportInfoLine), [
        '[INFO] If this is unexpected, report at https://github.com/TALXIS/tools-cli/issues',
        '       Session: ae65408d-2786-41e3-a1a8-548d7c648173',
        '       Operation: 44997db111070170ee2858654e88257b',
        '       Logs: ~\\AppData\\Local\\Temp\\txc\\logs\\session-ae65408d-2786-41e3-a1a8-548d7c648173.jsonl'
      ]);
    });

    test('should pass non-log lines through unchanged', () => {
      assert.deepStrictEqual(formatTxcLogLine('Environment URL: https://x.crm4.dynamics.com/'), ['Environment URL: https://x.crm4.dynamics.com/']);
      assert.deepStrictEqual(formatTxcLogLine('{'), ['{']);
      assert.deepStrictEqual(formatTxcLogLine('  "id": "zz"'), ['  "id": "zz"']);
    });

    test('should drop blank lines', () => {
      assert.deepStrictEqual(formatTxcLogLine('   '), []);
    });
  });

  suite('formatTxcLogLineDetailed', () => {
    test('should lay out the error JSON as a tree and keep the stack trace', () => {
      assert.deepStrictEqual(formatTxcLogLineDetailed(solutionImportErrorLine), [
        '[ERROR] Command failed: Solution import failed: Connector import: FAILURE:',
        '          error:',
        '            code: ApiHubsRequestFailed',
        `            message: The request failed with client error: '${dataverseError}'. The correlation Id is '3ee5c009-a3ac-4d9d-93b9-2502890d35a5'.`,
        '            details:',
        '              [0]:',
        '                code: FullNonLocalizedError',
        '                message:',
        '                  Code: ""',
        '                  Message: Nullable object must have a value.',
        '                  Target: null',
        '                  Details: []',
        '                  Innererror: null',
        "        System.InvalidOperationException: Solution import failed: Connector import: FAILURE: ApiHubsRequestFailed: The request failed with client error: 'Nullable object must have a value.'. The correlation Id is '3ee5c009-a3ac-4d9d-93b9-2502890d35a5'.",
        '           at TALXIS.CLI.Platform.Dataverse.Application.Sdk.SolutionImporter.PollAsyncOperationAsync(Guid asyncOperationId, CancellationToken cancellationToken) in /_/src/TALXIS.CLI.Platform.Dataverse.Application/Sdk/SolutionImporter.cs:line 275',
        '           at TALXIS.CLI.Core.TxcLeafCommand.RunAsync() in /_/src/TALXIS.CLI.Core/Shared/TxcLeafCommand.cs:line 105'
      ]);
    });

    test('should return undefined when the short form hides nothing', () => {
      assert.strictEqual(formatTxcLogLineDetailed(supportInfoLine), undefined);
      assert.strictEqual(formatTxcLogLineDetailed('plain text'), undefined);
    });
  });

  suite('createTxcOutputWriter', () => {
    const feed = (failed: boolean): string[] => {
      const lines: string[] = [];
      const writer = createTxcOutputWriter((line) => lines.push(line));
      const text = `${solutionImportErrorLine}\r\n${supportInfoLine}\r\n`;
      for (let i = 0; i < text.length; i += 50) writer.stderr(text.slice(i, i + 50));
      writer.finish(failed);
      return lines;
    };

    test('should print only the short form when the command succeeds', () => {
      const lines = feed(false);
      assert.strictEqual(lines.length, 5);
      assert.ok(!lines.includes('--- Full txc error details ---'));
    });

    test('should append the full details after the output when the command fails', () => {
      const lines = feed(true);
      assert.strictEqual(lines[5], '--- Full txc error details ---');
      assert.deepStrictEqual(lines.slice(6), formatTxcLogLineDetailed(solutionImportErrorLine));
    });
  });

  suite('humanizeEmbeddedJson', () => {
    test('should leave braces that are not error JSON untouched', () => {
      assert.strictEqual(humanizeEmbeddedJson('value {not json} and {"a":1}'), 'value {not json} and {"a":1}');
    });
  });

  suite('createLineBuffer', () => {
    test('should join a line split across chunks', () => {
      const lines: string[] = [];
      const buffer = createLineBuffer((line) => lines.push(line));
      buffer.push('{"ts":"1","le');
      buffer.push('vel":"Error"}\r');
      buffer.push('\nnext');
      buffer.flush();
      assert.deepStrictEqual(lines, ['{"ts":"1","level":"Error"}', 'next']);
    });
  });
});
