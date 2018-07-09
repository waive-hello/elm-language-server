import * as cp from 'child_process';
import * as readline from 'readline';
import * as utils from './elmUtils';
import * as vscode from 'vscode-languageserver/lib/main';
import Uri from 'vscode-uri/lib/umd';
import { Diagnostic } from 'vscode-languageserver/lib/main';

export interface IElmIssueRegion {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface IElmIssue {
  tag: string;
  overview: string;
  subregion: string;
  details: string;
  region: IElmIssueRegion;
  type: string;
  file: string;
}

function severityStringToDiagnosticSeverity(
  severity: string,
): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function elmMakeIssueToDiagnostic(issue: IElmIssue): vscode.Diagnostic {
  let lineRange: vscode.Range = vscode.Range.create(
    issue.region.start.line - 1,
    issue.region.start.column - 1,
    issue.region.end.line - 1,
    issue.region.end.column - 1,
  );
  return vscode.Diagnostic.create(
    lineRange,
    issue.overview + ' - ' + issue.details.replace(/\[\d+m/g, ''),
    severityStringToDiagnosticSeverity(issue.type),
  );
}

function checkForErrors(connection: vscode.Connection, rootPath: string, filename: string): Promise<IElmIssue[]> {
  return new Promise((resolve, reject) => {
    const makeCommand: string = 'elm-make';
    const cwd: string =
      utils.detectProjectRoot(filename) || rootPath;
    let make: cp.ChildProcess;
    if (utils.isWindows) {
      filename = "\"" + filename + "\""
    }
    const args = [filename, '--report', 'json', '--output', '/dev/null'];
    if (utils.isWindows) {
      make = cp.exec(makeCommand + ' ' + args.join(' '), { cwd: cwd });
    } else {
      make = cp.spawn(makeCommand, args, { cwd: cwd });
    }
    // output is actually optional
    // (fixed in https://github.com/Microsoft/vscode/commit/b4917afe9bdee0e9e67f4094e764f6a72a997c70,
    // but unreleased at this time)
    const stdoutlines: readline.ReadLine = readline.createInterface({
      input: make.stdout,
      output: undefined,
    });
    const lines: IElmIssue[] = [];
    stdoutlines.on('line', (line: string) => {
      // Ignore compiler success.
      if (line.startsWith('Successfully generated')) {
        return;
      }
      // Elm writes out JSON arrays of diagnostics, with one array per line.
      // Multiple lines may be received.
      lines.push(...(<IElmIssue[]>JSON.parse(line)));
    });
    const stderr: Buffer[] = [];
    make.stderr.on('data', (data: Buffer) => {
      if (data) {
        stderr.push(data);
      }
    });
    make.on('error', (err: Error) => {
      stdoutlines.close();
      if (err && (<any>err).code === 'ENOENT') {
        connection.console.log(
          "The 'elm-make' compiler is not available.  Install Elm from http://elm-lang.org/.",
        );
        resolve([]);
      } else {
        reject(err);
      }
    });
    make.on('close', (code: number, signal: string) => {
      stdoutlines.close();
      if (stderr.length) {
        let errorResult: IElmIssue = {
          tag: 'error',
          overview: '',
          subregion: '',
          details: stderr.join(''),
          region: {
            start: {
              line: 1,
              column: 1,
            },
            end: {
              line: 1,
              column: 1,
            },
          },
          type: 'error',
          file: filename,
        };
        resolve([errorResult]);
      } else {
        resolve(lines);
      }
    });
  });
}

export function runLinter(
  connection: vscode.Connection,
  rootPath: string,
  document: vscode.TextDocument,
  // elmAnalyse: ElmAnalyse,
): void {
  let compileErrors: vscode.Diagnostic[] = [];
  let uri: Uri = Uri.parse(document.uri);

  checkForErrors(connection, rootPath, uri.fsPath)
    .then((compilerErrors: IElmIssue[]) => {
      const cwd: string =
        utils.detectProjectRoot(uri.fsPath) || rootPath;
      let splitCompilerErrors: Map<string, IElmIssue[]> = new Map();

      compilerErrors.forEach((issue: IElmIssue) => {
        // If provided path is relative, make it absolute
        if (issue.file.startsWith('.')) {
          issue.file = cwd + issue.file.slice(1);
        }
        if (splitCompilerErrors.has(issue.file)) {
          splitCompilerErrors.get(issue.file).push(issue);
        } else {
          splitCompilerErrors.set(issue.file, [issue]);
        }
      });
      // Turn split arrays into diagnostics and associate them with correct files in VS
      splitCompilerErrors.forEach((issue: IElmIssue[], path: string) => {
        connection.sendDiagnostics({
          uri: document.uri,
          diagnostics: issue.map(error => elmMakeIssueToDiagnostic(error)),
        });
      });
    })
    .catch(error => {
    });

  // if (elmAnalyse.elmAnalyseIssues.length > 0) {
  //   let splitCompilerErrors: Map<string, IElmIssue[]> = new Map();
  //   elmAnalyse.elmAnalyseIssues.forEach((issue: IElmIssue) => {
  //     if (splitCompilerErrors.has(issue.file)) {
  //       splitCompilerErrors.get(issue.file).push(issue);
  //     } else {
  //       splitCompilerErrors.set(issue.file, [issue]);
  //     }
  //     splitCompilerErrors.forEach(
  //       (analyserIssue: IElmIssue[], path: string) => {
  //         compileErrors.concat(
  //           analyserIssue.map(error => elmMakeIssueToDiagnostic(error)),
  //         );
  //       },
  //     );
  //   });
  // }
}
