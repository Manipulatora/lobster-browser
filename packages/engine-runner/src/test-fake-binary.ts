import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Test-only fixture builder: produce a file this platform's process loader can actually EXECUTE.
 *
 * Several suites need a stand-in for the native Lobium binary — something the product can hand to
 * `spawn()`/`execFile()` so that the capability probe, the proxy fail-closed ordering, and the
 * DevToolsActivePort handshake are exercised against a real child process rather than a mock. On
 * POSIX that is a one-line shebang script, which is why the fixtures were written that way.
 *
 * Windows has no equivalent. `CreateProcess` loads a PE image and nothing else, so an extension-less
 * shebang file fails with EFTYPE; and since the CVE-2024-27980 fix Node additionally refuses to spawn
 * `.bat`/`.cmd` unless `shell: true` — which the product must never use for a browser binary, so
 * relaxing that is not an option either. The fixture therefore has to be a genuine compiled `.exe`.
 *
 * To keep the fixture LOGIC in one language, the Windows `.exe` is a ~20-line shim whose only job is
 * to re-launch `node <same-name>.cjs` with the arguments it was handed. Each caller's JavaScript body
 * is then byte-identical on both platforms, so the two paths cannot drift.
 */

const execFileAsync = promisify(execFile);

/**
 * The C# source of the Windows shim. `node` is baked in at compile time (as a verbatim `@"..."`
 * string, so the backslashes in the path stay literal), and the script is derived from the shim's own
 * location, which makes the compiled image identical for every fixture — so it is built once per test
 * process and copied.
 */
function windowsShimSource(nodePath: string): string {
  return `using System;
using System.Diagnostics;
using System.IO;

static class LobsterFakeBinaryShim {
  // Forward the RAW command-line tail rather than re-quoting args[]. Chromium-style flags carry
  // Windows paths ("--user-data-dir=C:\\Users\\...\\profile"), and round-tripping those through
  // args[] and back would need a full CommandLineToArgvW-compatible re-quote to be lossless.
  static string ArgumentTail(string commandLine) {
    if (commandLine.Length > 0 && commandLine[0] == '"') {
      int end = commandLine.IndexOf('"', 1);
      return end < 0 ? "" : commandLine.Substring(end + 1);
    }
    int space = commandLine.IndexOf(' ');
    return space < 0 ? "" : commandLine.Substring(space);
  }

  static int Main() {
    string exe = Process.GetCurrentProcess().MainModule.FileName;
    string script = Path.ChangeExtension(exe, ".cjs");
    var start = new ProcessStartInfo(@"${nodePath}");
    start.Arguments = "\\"" + script + "\\"" + ArgumentTail(Environment.CommandLine);
    start.UseShellExecute = false;
    using (var child = Process.Start(start)) {
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
`;
}

/**
 * The .NET Framework compiler. It is a component of Windows itself (present on every desktop/server
 * SKU since Windows 8), which is the only reason a test suite can rely on compiling at all here — no
 * SDK, toolchain, or npm dependency is involved.
 */
function resolveWindowsCsc(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const csc = candidates.find((candidate) => existsSync(candidate));
  if (!csc) {
    throw new Error(
      `cannot build an executable test fixture: no .NET Framework compiler at ${candidates.join(
        ' or ',
      )}. Windows can only spawn a PE image, so these tests need one compiled locally.`,
    );
  }
  return csc;
}

let windowsShim: Promise<string> | undefined;

function buildWindowsShim(): Promise<string> {
  windowsShim ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lobster-fake-bin-shim-'));
    // The shim outlives individual fixtures (it is copied per fixture), so it is torn down with the
    // test process instead of by any one test's cleanup.
    process.once('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir must never fail a test run */
      }
    });
    const source = join(dir, 'shim.cs');
    const exe = join(dir, 'shim.exe');
    await writeFile(source, windowsShimSource(process.execPath), 'utf8');
    await execFileAsync(
      resolveWindowsCsc(),
      ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, source],
      { windowsHide: true },
    );
    return exe;
  })();
  return windowsShim;
}

/**
 * Write `script` (a CommonJS body) as an executable named `name` in `dir` and return the path the
 * product should be pointed at: `<dir>/<name>` on POSIX, `<dir>/<name>.exe` on Windows.
 *
 * Callers must use the RETURNED path — the Windows name differs, and `resolveLobiumBinary` only
 * discovers platform-correct names anyway.
 */
export async function writeFakeBinary(dir: string, name: string, script: string): Promise<string> {
  if (process.platform !== 'win32') {
    const path = join(dir, name);
    await writeFile(path, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
    // writeFile's `mode` applies only when it creates the file; chmod covers a fixture rewrite.
    await chmod(path, 0o755);
    return path;
  }
  // The shim resolves its script as <own path with .cjs>, so the two names must stay in lockstep.
  await writeFile(join(dir, `${name}.cjs`), script, 'utf8');
  const exe = join(dir, `${name}.exe`);
  await copyFile(await buildWindowsShim(), exe);
  return exe;
}

/**
 * The file name a Chromium build output actually carries on this platform, mirroring
 * `platformBinaryNames()`. A fixture named `chrome` is invisible to discovery on Windows — and
 * unspawnable there — so name-based discovery tests must build the platform-correct name.
 */
export const CHROMIUM_BINARY_NAME = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
