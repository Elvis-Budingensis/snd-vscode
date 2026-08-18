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
  /** process.platform when omitted. Only Windows changes how -l is written. */
  platform?: string;
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
  // NO DEFAULT TO process.platform -- same reason as executableFor. With one,
  // commandLine answered differently for identical arguments depending on the
  // machine: full paths on macOS, basenames on Windows. start() passes the
  // real platform; callers that don't pass one get the paths through unchanged.
  const name = options.platform ? loadArgument(options.platform) : (file: string) => file;
  const args: string[] = [];
  if (options.uiBridgePath) {
    if (!userNoInit) args.push('-noinit');
    args.push('-l', name(options.uiBridgePath));
    if (!userNoInit) {
      for (const file of options.initFiles ?? []) args.push('-l', name(file));
    }
  }
  args.push(...options.args);
  for (const file of options.files ?? []) args.push(file);
  args.push('-l', name(options.bridgePath));
  return { command: options.command, args };
}

/**
 * How a file is named to -l.
 *
 * WINDOWS CANNOT BE GIVEN AN ABSOLUTE PATH HERE. Snd splits the -l argument
 * on ':' as a path-list separator, and every absolute Windows path carries a
 * drive colon, so `C:/tmp/t.scm` is torn into "C" and "/tmp/t.scm" and the
 * answer is
 *
 *   can't load C:/tmp/t.scm: Invalid argument
 *
 * -- which is also, exactly, what a missing file says, because the failure
 * happens before the file is ever opened. Verified against Snd 26 under
 * MSYS2/UCRT64: `-l t.scm` loads, `-l "$PWD/t.scm"` does not, same file.
 *
 * So on Windows the BASENAME goes on the command line and the directory goes
 * into SND_PATH, which -l does search (also verified: PING from a different
 * cwd with SND_PATH pointing at the file's directory). cwd is deliberately
 * NOT used for this -- it belongs to the user as Snd's notion of "current
 * file", and the -l files span two directories anyway, the extension's own
 * and the user's home.
 *
 * path.win32.basename rather than path.basename so the rule is the same
 * whichever platform runs the test.
 */
export function loadArgument(platform: string): (file: string) => string {
  if (platform !== 'win32') return file => file;
  return file => path.win32.basename(file);
}

/**
 * SND_PATH: every directory that -l has to find something in.
 *
 * JOINED, not concatenated. Written as `dir + delimiter + (env ?? '')` this
 * puts a trailing separator on the value whenever SND_PATH is unset, which is
 * the normal case. Snd then takes the whole string as ONE directory named
 * "…/scheme:", and load reports "No such file or directory" for a file that is
 * sitting right there -- which is how the parity overlay came to be silently
 * absent from every session. See test/sndpath.test.js.
 *
 * On Windows the directories of the -l files must be here, because the command
 * line carries only their basenames (see loadArgument). Elsewhere only the
 * bridge's own directory is needed, for (require ...).
 */
export function loadSearchPath(args: {
  bridgePath: string;
  uiBridgePath?: string;
  initFiles?: string[];
  platform: string;
  inherited?: string;
}): string {
  const p = args.platform === 'win32' ? path.win32 : path.posix;
  const directories = [p.dirname(args.bridgePath)];
  if (args.platform === 'win32') {
    for (const file of [args.uiBridgePath, ...(args.initFiles ?? [])]) {
      if (file) directories.push(p.dirname(file));
    }
  }
  const seen = new Set<string>();
  const unique = directories.filter(directory => {
    if (seen.has(directory)) return false;
    seen.add(directory);
    return true;
  });
  return [...unique, args.inherited].filter(Boolean).join(p.delimiter);
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

  // This is where it started, as the note that used to stand here said it
  // would. Snd 26.7 builds under MSYS2/UCRT64 and runs; a bundle is snd.exe
  // plus three DLLs (libdl, libfftw3-3, libwinpthread-1).
  const candidates = [
    withExeSuffix(path.join(bundleRoot, `${platform}-${arch}`, 'snd'), platform),
    withExeSuffix(path.join(bundleRoot, platform, 'snd'), platform),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return { command: candidate, source: 'bundled' };
  }

  return { command: executableFor(mode, configured, platform), source: 'path' };
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
/**
 * NO DEFAULT FOR platform. Falling back to process.platform here would make a
 * pure function answer differently depending on the machine the test runs on:
 * executableFor('nogui', 'snd') returned 'snd-nogui' on macOS and
 * 'snd-nogui.exe' on Windows, for the same arguments. The platform is a
 * PARAMETER everywhere else in this file (see resolveExecutable), and callers
 * that have one pass it; the PATH lookup is the only caller that does.
 */
export function executableFor(mode: SndMode, configured: string, platform?: string): string {
  if (configured && configured !== 'snd') return configured;
  const suffix = (name: string) => (platform ? withExeSuffix(name, platform) : name);
  if (mode === 'nogui') return suffix('snd-nogui');
  if (mode === 'gui') return suffix('snd-motif');
  return suffix('snd');
}

/**
 * '.exe' where the platform needs it.
 *
 * MSYS2 makes this genuinely hard to see: its shell resolves a name without
 * the suffix to the .exe transparently, so `which snd` answers
 * /ucrt64/bin/snd and `ls bin/win32-x64/snd` succeeds -- while node, which
 * does no such translation, reports existsSync('bin/win32-x64/snd') === false
 * and spawn() fails with ENOENT. Checked both ways on Windows 11: the .exe
 * name exists and runs, the bare name does neither.
 */
export function withExeSuffix(name: string, platform: string): string {
  if (platform !== 'win32' || name.endsWith('.exe')) return name;
  return `${name}.exe`;
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

    const platform = options.platform ?? process.platform;
    const { command, args } = commandLine({ ...options, uiBridgePath, initFiles, platform });
    const searchPath = loadSearchPath({
      bridgePath: options.bridgePath,
      uiBridgePath,
      initFiles,
      platform,
      inherited: process.env.SND_PATH,
    });
    this.setStatus('starting', `${command} ${args.join(' ')}`);

    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn(command, args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // See loadSearchPath: shape of the value, and why Windows needs
          // more than one directory in it.
          SND_PATH: searchPath,
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
   * Ends the session and RESOLVES WHEN THE PROCESS IS ACTUALLY GONE.
   *
   * Closing stdin first, and only then a signal: the headless bridge reads
   * until EOF and shuts Snd down itself, which gives Snd the chance to release
   * the audio device and to ask about unsaved edits in the GUI case. SIGKILL
   * leaves a locked sound card behind often enough to be worth the wait.
   *
   * But EOF only reaches a Snd that is reading stdin, and there is one state
   * where it is not: playing. In a no-GUI build play does not return until the
   * sound is over, and snd-dac.c's loop there is
   *
   *   while (dac_in_background(NULL) == BACKGROUND_CONTINUE) check_for_event();
   *
   * A pause set from the play hook stops the DAC without ending that loop, so
   * the process spins at 100% and nothing on stdin will ever be read again.
   * Six of those were found in Activity Monitor after a day's work, one with
   * 8:44 hours of CPU time.
   *
   * SIGINT is what gets out of it -- Bill's own note beside that loop is "need
   * to be able to C-g out of this" -- so it comes before SIGTERM rather than
   * after. And this returns a promise because deactivate() has to be able to
   * await it: a timer chain does not run once the extension host is tearing
   * down, which is exactly when this matters most.
   */
  stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        for (const timer of timers) clearTimeout(timer);
        resolve();
      };
      child.once('exit', finish);
      const signal = (name: NodeJS.Signals) => {
        if (child.exitCode === null) {
          try { child.kill(name); } catch { /* gone */ }
        }
      };
      try {
        child.stdin.end();
      } catch {
        // already gone
      }
      // WINDOWS HAS NO SIGNALS, and Node does not pretend otherwise for long:
      // child.kill(name) there calls TerminateProcess whatever the name says,
      // so the "polite" step at 200 ms is a HARD kill -- the audio device stays claimed and
      // unsaved edits are never asked about, which is the opposite of what the
      // escalation is for. EOF, on the other hand, works everywhere.
      //
      // So on Windows: EOF and then WAIT, long enough for a Snd that is
      // reading stdin to shut itself down (node's own startup under x64
      // emulation on ARM already costs a quarter second, so 200 ms is not a
      // measurement of anything). Only after that, taskkill -- with /T,
      // because a Windows process tree is not reparented and killing the
      // parent alone can leave children holding the device.
      const windows = process.platform === 'win32';
      const killTree = () => {
        if (child.exitCode !== null || !child.pid) return;
        try {
          cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch { /* gone */ }
      };
      const timers = windows ? [
        setTimeout(killTree, 1500),
        setTimeout(finish, 2500),
      ] : [
        setTimeout(() => signal('SIGINT'), 200),
        setTimeout(() => signal('SIGTERM'), 700),
        // Last resort, and it does happen: a Snd in that spin loop with the
        // audio device open does not always answer the polite signals.
        setTimeout(() => signal('SIGKILL'), 1700),
        // Resolved on the exit event whenever possible, and only given up on
        // here. Resolving the instant SIGKILL is SENT is not the same as the
        // process being gone: restart() awaits this, and a second Snd starting
        // while the first still holds the audio device is the failure that
        // produces two of them at 100% CPU.
        setTimeout(finish, 2000),
      ];
    });
  }
}
