// sndProcess.ts
//
// Life cycle of the Snd child process.
//
// ONE DEPARTURE FROM clamps-vscode WORTH STATING.  There, SBCL is started
// DETACHED and survives a restart of the extension host, because the
// channel is a socket: a fresh extension can simply reconnect to the port
// noted in session.json.  Here the channel IS the pipe.  A detached Snd
// would keep running with its stdin bound to a dead parent, and nothing
// could ever speak to it again -- an orphan holding the audio device.  So
// this process is a child, and it dies with the window.
//
// The consequence is honest rather than pleasant: reloading the window
// loses the session.  What survives instead is the FILE, because Snd's
// edit history can be written out (save-state), and that is offered as a
// command rather than pretended to be automatic.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SndMode = 'auto' | 'nogui' | 'gui';
export type SndStatus = 'stopped' | 'starting' | 'ready' | 'error';

export interface SndOptions {
  /** Executable: snd, snd-nogui, snd-motif, an absolute path. */
  command: string;
  /** Extra arguments, from the user's settings. */
  args: string[];
  /** Directory Snd starts in -- its notion of "current file". */
  cwd: string;
  /** Absolute path of scheme/snd-vscode.scm. */
  bridgePath: string;
  /** UI compatibility loaded before the user's init files. */
  uiBridgePath?: string;
  /** Local init files, in Snd's own order. Filled by start when omitted. */
  initFiles?: string[];
  mode: SndMode;
  /** Sound files to open at startup. */
  files?: string[];
}

/**
 * The command line for Snd.
 *
 * A pure function, and deliberately so: the argument order is the one
 * thing here that cannot be checked by looking at a running process.
 * The UI vocabulary comes first, then the user's init files, while the main
 * -l bridge still comes LAST, after the user's own arguments
 * and after any file to open -- Snd processes startup arguments in order,
 * so a bridge loaded first would announce itself ready before the files
 * it is supposed to report even exist.
 *
 * Why -noinit appears when the UI bridge is used: Snd normally reads ~/.snd
 * before it processes -l. A GUI call in ~/.snd would therefore run before
 * the compatibility vocabulary existed. We suppress that automatic read,
 * load the vocabulary, then explicitly load the same files in the same
 * order. The user's -noinit still wins and loads none of them.
 */
export function commandLine(options: SndOptions): { command: string; args: string[] } {
  const userNoInit = options.args.some(arg => arg === '-noinit' || arg === '--noinit');
  const args: string[] = [];
  if (options.uiBridgePath) {
    if (!userNoInit) args.push('-noinit');
    args.push('-l', options.uiBridgePath);
    if (!userNoInit) {
      for (const file of options.initFiles ?? []) args.push('-l', file);
    }
  }
  args.push(...options.args);
  for (const file of options.files ?? []) args.push(file);
  args.push('-l', options.bridgePath);
  return { command: options.command, args };
}

/** Snd's s7-specific local init sequence (snd-xen.c:snd_load_init_file). */
export function localInitFiles(args: {
  home: string;
  environmentInit?: string;
  exists(path: string): boolean;
}): string[] {
  const candidates = [
    path.join(args.home, '.snd_prefs_s7'),
    path.join(args.home, '.snd_s7'),
    args.environmentInit || path.join(args.home, '.snd'),
  ];
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    if (!candidate || seen.has(candidate) || !args.exists(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

/**
 * Where the Snd binary is.
 *
 * THE INSTALL PROBLEM, AND WHICH HALF OF IT THIS SOLVES.
 *
 * What makes Snd painful to install on macOS is not Snd. It is Motif:
 * XQuartz, libXm, libXt, libXpm, headers in places Homebrew moved last year.
 * Snd's own configure defaults to NO GUI -- Motif is only used with
 * --with-motif -- and a headless build has no X dependency at all. sndlib and
 * s7 are in the tarball; the audio backend on macOS is CoreAudio, which is
 * part of the system.
 *
 * macOS IS THE TARGET, and that is the project rather than a limit of it.
 * Linux packages Snd itself -- Planet CCRMA and most distributions carry it --
 * so a Linux user's own Snd on PATH is the right answer there, and the bundle
 * is for the platform where installing it is the problem.
 *
 * So: `./configure && make`. That is the whole build, and it is a build we
 * WANT rather than tolerate, because the GUI is exactly the part this
 * extension replaces.
 *
 * The second half -- not having to run even that -- is solved by shipping
 * the binary. Snd's licence permits it in as many words: permission to use,
 * copy, modify, distribute and license, no agreement or fee required. So
 * a bundled binary under bin/<platform>-<arch>/ is preferred over PATH, and
 * a user who has their own Snd keeps it by setting snd.path.
 *
 * The order is deliberate: an explicitly configured path wins over
 * everything, because someone who set it means it. The bundle comes next,
 * so that the common case needs no decision. PATH comes last -- a Snd on
 * PATH may well be the Motif one, and if it is, it works too.
 */
export function resolveExecutable(args: {
  configured: string;
  mode: SndMode;
  /** bin/ inside the extension. */
  bundleRoot: string;
  platform: string;
  arch: string;
  exists: (path: string) => boolean;
}): { command: string; source: 'configured' | 'bundled' | 'path' } {
  const { configured, mode, bundleRoot, platform, arch, exists } = args;

  // Anything but the default means the user chose. Absolute or not.
  if (configured && configured !== 'snd') {
    return { command: configured, source: 'configured' };
  }

  // No .exe branch: Windows is not a target. Snd's Windows paths are MSVC and
  // MinGW, both old, audio goes through waveOut, and none of it has been stood
  // up -- a suffix here would be the only line in the project pretending
  // otherwise. If it is ever built, this is where it starts.
  const candidates = [
    path.join(bundleRoot, `${platform}-${arch}`, 'snd'),
    path.join(bundleRoot, platform, 'snd'),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return { command: candidate, source: 'bundled' };
  }

  return { command: executableFor(mode, configured), source: 'path' };
}

/**
 * Guess a Snd executable from what the mode asks for.
 *
 * The Snd build decides whether there is a GUI: a Motif build always has
 * one, a build without --with-motif never has one, and there is no flag
 * that turns one into the other.  So "mode" cannot switch anything at
 * run time; it can only pick a different binary, and only if the user
 * built both.  Which is why the setting is a command name and this is a
 * guess with a fallback, not a promise.
 */
export function executableFor(mode: SndMode, configured: string): string {
  if (configured && configured !== 'snd') return configured;
  if (mode === 'nogui') return 'snd-nogui';
  if (mode === 'gui') return 'snd-motif';
  return 'snd';
}

export interface SndEvents {
  onStdout(text: string): void;
  onStderr(text: string): void;
  onExit(code: number | null, signal: string | null): void;
  onStatus(status: SndStatus, detail: string): void;
}

export class SndProcess {
  private child: cp.ChildProcessWithoutNullStreams | undefined;
  private currentStatus: SndStatus = 'stopped';

  /** Mode Snd reported about itself, not the one that was asked for. */
  reportedMode: 'gui' | 'nogui' | undefined;

  constructor(private readonly events: SndEvents) {}

  get status(): SndStatus {
    return this.currentStatus;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private setStatus(status: SndStatus, detail = ''): void {
    this.currentStatus = status;
    this.events.onStatus(status, detail);
  }

  start(options: SndOptions): void {
    if (this.running) return;

    if (!fs.existsSync(options.bridgePath)) {
      this.setStatus('error', `bridge not found: ${options.bridgePath}`);
      return;
    }

    const uiBridgePath =
      options.uiBridgePath ?? path.join(path.dirname(options.bridgePath), 'snd-vscode-ui.scm');
    if (!fs.existsSync(uiBridgePath)) {
      this.setStatus('error', `UI bridge not found: ${uiBridgePath}`);
      return;
    }

    const initFiles =
      options.initFiles ??
      localInitFiles({
        home: process.env.HOME || os.homedir(),
        environmentInit: process.env.SND_INIT_FILE,
        exists: candidate => fs.existsSync(candidate),
      });

    const { command, args } = commandLine({ ...options, uiBridgePath, initFiles });
    this.setStatus('starting', `${command} ${args.join(' ')}`);

    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn(command, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Snd looks for its .scm files here. Without it, a bridge that
          // wants (require ...) finds nothing -- and the error says only
          // "can't load", not where it looked.
          //
          // JOINED, not concatenated. Written as `dir + path.delimiter + (env ??
          // '')` this puts a trailing colon on the value whenever SND_PATH is
          // unset, which is the normal case. Snd then takes the whole string as
          // ONE directory named "…/scheme:", and load reports "No such file or
          // directory" for a file that is sitting right there -- which is how
          // the parity overlay came to be silently absent from every session.
          SND_PATH: [path.dirname(options.bridgePath), process.env.SND_PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
      }) as cp.ChildProcessWithoutNullStreams;
    } catch (error) {
      this.setStatus('error', String(error));
      return;
    }

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => this.events.onStdout(text));
    child.stderr.on('data', (text: string) => this.events.onStderr(text));

    child.on('error', error => {
      // The usual case: the binary is not on PATH. Saying so is more use
      // than the ENOENT, because the fix is a setting.
      this.setStatus(
        'error',
        `${command} could not be started (${String(error)}). ` +
          'Check "snd.path" in the settings.'
      );
    });

    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.reportedMode = undefined;
      this.setStatus('stopped', signal ? `signal ${signal}` : `exit code ${code}`);
      this.events.onExit(code, signal);
    });
  }

  /** One line down Snd's stdin. Returns false if nothing is listening. */
  send(line: string): boolean {
    if (!this.child || !this.running) return false;
    return this.child.stdin.write(line);
  }

  markReady(mode: 'gui' | 'nogui'): void {
    this.reportedMode = mode;
    this.setStatus('ready', `Snd is listening (${mode})`);
  }

  /**
   * Ends the session.
   *
   * Closing stdin first, and only then a signal: the headless bridge
   * reads until EOF and shuts Snd down itself, which gives Snd the chance
   * to release the audio device and to ask about unsaved edits in the GUI
   * case.  SIGKILL leaves a locked sound card behind often enough to be
   * worth the two hundred milliseconds.
   */
  stop(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // already gone
    }
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
      }
      setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
      }, 2000);
    }, 200);
  }
}
