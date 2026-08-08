// sndVariables.ts
//
// Snd's dialogs, as data.
//
// Transform Options, the control panel, the View menu, Preferences: every
// one of them is a window over VARIABLES. "Blackman2" selected in that
// list is `(set! (fft-window) blackman2-window)`; the sonogram radio
// button is `(set! (transform-graph-type) graph-as-sonogram)`; the
// "normalize" checkbox is `transform-normalization`.
//
// So the way to have those dialogs in VS Code is not to mirror Snd's
// windows. It is to declare which variable each control stands for and
// render the controls from that declaration. One renderer
// (dialogPanel.ts), one table, four dialogs -- and adding a fifth is an
// entry here rather than a new webview.
//
// WHY ENUMS CARRY SYMBOLS AND NOT NUMBERS. `fourier-transform` is an
// integer in Snd, and the panel needs the integer to know which radio
// button is on. Writing those integers down here would work until Snd
// inserts a transform in the middle of its list, after which every panel
// would be one entry off, would still look perfectly correct, and would
// compute a spectrum with the wrong window -- a picture nobody can check
// by eye. So the symbols are declared and resolved once per session
// against the running build (the `constants` op).
//
// The names come from Snd's own documentation; anything absent from a
// given build is reported as unavailable by the bridge and rendered
// greyed out rather than omitted, because "this build cannot do it" is
// information and a missing row is not.

export type VariableKind = 'bool' | 'int' | 'float' | 'enum' | 'string' | 'readonly';

export interface VariableSpec {
  name: string;
  label: string;
  kind: VariableKind;
  /** For int/float: the range the slider spans. */
  min?: number;
  max?: number;
  step?: number;
  /** For enum: option labels and the SYMBOL each stands for. */
  options?: Array<{ label: string; symbol: string }>;
  /** Objects that travel as integers: transform-type, colormap. */
  via?: 'transform' | 'colormap';
  /** Belongs to a sound rather than the session. */
  perSound?: boolean;
  hint?: string;
}

export interface DialogGroup {
  title: string;
  variables: VariableSpec[];
}

export interface DialogSpec {
  id: string;
  title: string;
  groups: DialogGroup[];
  /** Buttons below the fields. */
  actions?: Array<{ id: string; label: string; hint?: string }>;
  note?: string;
}

const TRANSFORM_TYPES = [
  { label: 'Fourier', symbol: 'fourier-transform' },
  { label: 'Wavelet', symbol: 'wavelet-transform' },
  { label: 'Walsh', symbol: 'walsh-transform' },
  { label: 'Autocorrelate', symbol: 'autocorrelation' },
  { label: 'Cepstrum', symbol: 'cepstrum' },
  { label: 'Haar', symbol: 'haar-transform' },
];

// The order is Snd's own; the numbers are resolved at run time.
const FFT_WINDOWS = [
  'rectangular-window',
  'hann-window',
  'welch-window',
  'parzen-window',
  'bartlett-window',
  'hamming-window',
  'blackman2-window',
  'blackman3-window',
  'blackman4-window',
  'exponential-window',
  'riemann-window',
  'kaiser-window',
  'cauchy-window',
  'poisson-window',
  'gaussian-window',
  'tukey-window',
  'dolph-chebyshev-window',
  'hann-poisson-window',
  'connes-window',
  'samaraki-window',
  'ultraspherical-window',
  'bartlett-hann-window',
  'bohman-window',
  'flat-top-window',
  'blackman5-window',
  'blackman6-window',
  'blackman7-window',
  'blackman8-window',
  'blackman9-window',
  'blackman10-window',
  'rv2-window',
  'rv3-window',
  'rv4-window',
  'mlt-sine-window',
  'papoulis-window',
  'dpss-window',
  'sinc-window',
].map(symbol => ({
  label: symbol.replace('-window', '').replace(/-/g, ' '),
  symbol,
}));

const SIZES = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

/** Transform Options — Snd's Options → Transform options. */
export const TRANSFORM_DIALOG: DialogSpec = {
  id: 'transform',
  title: 'Snd: Transform Options',
  note:
    'The same variables Snd\'s own Transform Options dialog writes. With a ' +
    'Motif build both work, on the same state.',
  groups: [
    {
      title: 'transform',
      variables: [
        {
          name: 'transform-type',
          label: 'type',
          kind: 'enum',
          options: TRANSFORM_TYPES,
          via: 'transform',
        },
        {
          name: 'transform-size',
          label: 'size',
          kind: 'enum',
          options: SIZES.map(size => ({ label: String(size), symbol: String(size) })),
        },
        { name: 'fft-window', label: 'window', kind: 'enum', options: FFT_WINDOWS },
        {
          name: 'wavelet-type',
          label: 'wavelet',
          kind: 'int',
          min: 0,
          max: 19,
          step: 1,
          hint: 'daub4 … daub20, only used by the wavelet transform',
        },
        { name: 'zero-pad', label: 'zero pad', kind: 'int', min: 0, max: 8, step: 1 },
      ],
    },
    {
      title: 'window parameters',
      variables: [
        { name: 'fft-window-alpha', label: 'alpha', kind: 'float', min: 0, max: 10, step: 0.01 },
        { name: 'fft-window-beta', label: 'beta', kind: 'float', min: 0, max: 1, step: 0.001 },
      ],
    },
    {
      title: 'display',
      variables: [
        {
          name: 'transform-graph-type',
          label: 'graph',
          kind: 'enum',
          options: [
            { label: 'single transform', symbol: 'graph-once' },
            { label: 'sonogram', symbol: 'graph-as-sonogram' },
            { label: 'spectrogram', symbol: 'graph-as-spectrogram' },
          ],
        },
        { name: 'show-transform-peaks', label: 'peaks', kind: 'bool' },
        {
          name: 'max-transform-peaks',
          label: 'how many peaks',
          kind: 'int',
          min: 1,
          max: 1000,
          step: 1,
        },
        { name: 'fft-log-magnitude', label: 'dB', kind: 'bool' },
        { name: 'min-dB', label: 'floor in dB', kind: 'float', min: -120, max: -10, step: 1 },
        { name: 'fft-log-frequency', label: 'log freq', kind: 'bool' },
        {
          name: 'log-freq-start',
          label: 'log freq start',
          kind: 'float',
          min: 1,
          max: 500,
          step: 1,
        },
        {
          name: 'transform-normalization',
          label: 'normalize',
          kind: 'enum',
          options: [
            { label: 'none', symbol: 'dont-normalize' },
            { label: 'by channel', symbol: 'normalize-by-channel' },
            { label: 'by sound', symbol: 'normalize-by-sound' },
            { label: 'globally', symbol: 'normalize-globally' },
          ],
        },
        { name: 'show-selection-transform', label: 'selection only', kind: 'bool' },
        { name: 'fft-with-phases', label: 'with phases', kind: 'bool' },
      ],
    },
    {
      title: 'spectrum start / end',
      variables: [
        { name: 'spectrum-start', label: 'start', kind: 'float', min: 0, max: 1, step: 0.001 },
        { name: 'spectrum-end', label: 'end', kind: 'float', min: 0, max: 1, step: 0.001 },
      ],
    },
    {
      title: 'sonogram and spectrogram',
      variables: [
        { name: 'spectro-hop', label: 'hop', kind: 'int', min: 1, max: 400, step: 1 },
        { name: 'spectro-x-angle', label: 'x angle', kind: 'float', min: 0, max: 360, step: 1 },
        { name: 'spectro-y-angle', label: 'y angle', kind: 'float', min: 0, max: 360, step: 1 },
        { name: 'spectro-z-angle', label: 'z angle', kind: 'float', min: 0, max: 360, step: 1 },
        { name: 'spectro-x-scale', label: 'x scale', kind: 'float', min: 0, max: 4, step: 0.01 },
        { name: 'spectro-y-scale', label: 'y scale', kind: 'float', min: 0, max: 4, step: 0.01 },
        { name: 'spectro-z-scale', label: 'z scale', kind: 'float', min: 0, max: 4, step: 0.01 },
        { name: 'colormap', label: 'colormap', kind: 'int', min: 0, max: 20, step: 1, via: 'colormap' },
      ],
    },
  ],
};

/**
 * The control panel — Snd's View → Show controls, plus "More controls".
 *
 * Every one of these is per-sound, and every one of them affects PLAYBACK
 * only until Apply is pressed. That is the one thing about this panel
 * that is not visible in it, so the Apply button says so.
 */
export const CONTROLS_DIALOG: DialogSpec = {
  id: 'controls',
  title: 'Snd: Control Panel',
  note:
    'Per sound. These change playback; "Apply" writes the result into the ' +
    'edit history, which is what makes it undoable and savable.',
  actions: [
    {
      id: 'applycontrols',
      label: 'Apply to the sound',
      hint: 'apply-controls: one entry in the edit history',
    },
    { id: 'resetcontrols', label: 'Reset', hint: 'back to the neutral values' },
  ],
  groups: [
    {
      title: 'amplitude and speed',
      variables: [
        { name: 'amp-control', label: 'amp', kind: 'float', min: 0, max: 8, step: 0.001, perSound: true },
        { name: 'speed-control', label: 'speed', kind: 'float', min: -4, max: 4, step: 0.001, perSound: true },
        {
          name: 'speed-control-style',
          label: 'speed shown as',
          kind: 'enum',
          options: [
            { label: 'float', symbol: 'speed-control-as-float' },
            { label: 'ratio', symbol: 'speed-control-as-ratio' },
            { label: 'semitones', symbol: 'speed-control-as-semitone' },
          ],
        },
        { name: 'speed-control-tones', label: 'semitone division', kind: 'int', min: 1, max: 96, step: 1 },
      ],
    },
    {
      title: 'expand',
      variables: [
        { name: 'expand-control?', label: 'on', kind: 'bool', perSound: true },
        { name: 'expand-control', label: 'expand', kind: 'float', min: 0.001, max: 20, step: 0.001, perSound: true },
        { name: 'expand-control-hop', label: 'hop', kind: 'float', min: 0.001, max: 0.5, step: 0.001, perSound: true },
        { name: 'expand-control-length', label: 'length', kind: 'float', min: 0.01, max: 0.5, step: 0.001, perSound: true },
        { name: 'expand-control-ramp', label: 'ramp', kind: 'float', min: 0, max: 0.5, step: 0.001, perSound: true },
        { name: 'expand-control-jitter', label: 'jitter', kind: 'float', min: 0, max: 2, step: 0.001, perSound: true },
      ],
    },
    {
      title: 'contrast',
      variables: [
        { name: 'contrast-control?', label: 'on', kind: 'bool', perSound: true },
        { name: 'contrast-control', label: 'contrast', kind: 'float', min: -10, max: 10, step: 0.01, perSound: true },
        { name: 'contrast-control-amp', label: 'contrast amp', kind: 'float', min: 0, max: 2, step: 0.001, perSound: true },
      ],
    },
    {
      title: 'reverb',
      variables: [
        { name: 'reverb-control?', label: 'on', kind: 'bool', perSound: true },
        { name: 'reverb-control-scale', label: 'scale', kind: 'float', min: 0, max: 4, step: 0.001, perSound: true },
        { name: 'reverb-control-length', label: 'length', kind: 'float', min: 0, max: 5, step: 0.01, perSound: true },
        { name: 'reverb-control-feedback', label: 'feedback', kind: 'float', min: 0, max: 1.25, step: 0.001, perSound: true },
        { name: 'reverb-control-lowpass', label: 'lowpass', kind: 'float', min: 0, max: 1, step: 0.001, perSound: true },
        { name: 'reverb-control-decay', label: 'decay', kind: 'float', min: 0, max: 10, step: 0.01 },
      ],
    },
    {
      title: 'filter',
      variables: [
        { name: 'filter-control?', label: 'on', kind: 'bool', perSound: true },
        { name: 'filter-control-order', label: 'order', kind: 'int', min: 2, max: 512, step: 2, perSound: true },
        { name: 'filter-control-in-hz', label: 'frequencies in Hz', kind: 'bool', perSound: true },
        {
          name: 'filter-control-envelope',
          label: 'envelope',
          kind: 'readonly',
          // Read-only HERE on purpose, not for want of a way to write it.
          // A list of breakpoints is not a control: typing one into a text
          // field is how a curve gets a vertical segment and Snd's env
          // generator divides by zero. "Snd: Envelope Editor" draws it, with
          // the neighbours constrained so that cannot happen.
          hint: 'draw it in "Snd: Envelope Editor" — target: the filter response',
          perSound: true,
        },
      ],
    },
  ],
};

/** The View menu, which in Snd is a menu and here is a panel. */
export const VIEW_DIALOG: DialogSpec = {
  id: 'view',
  title: 'Snd: View Options',
  note: 'Snd\'s View menu. Affects Snd\'s own graphs; the VS Code panels draw their own.',
  groups: [
    {
      title: 'what is shown',
      variables: [
        { name: 'show-listener', label: 'listener', kind: 'bool' },
        { name: 'show-controls', label: 'control panel', kind: 'bool' },
        { name: 'show-marks', label: 'marks', kind: 'bool' },
        { name: 'show-selection', label: 'selection', kind: 'bool' },
        { name: 'show-mix-waveforms', label: 'mix waveforms', kind: 'bool' },
        { name: 'show-y-zero', label: 'y = 0', kind: 'bool' },
        { name: 'show-grid', label: 'grid', kind: 'bool' },
        { name: 'grid-density', label: 'grid density', kind: 'float', min: 0, max: 4, step: 0.05 },
        { name: 'show-indices', label: 'sound index', kind: 'bool' },
        // Named `verbose-cursor` up to Snd 15 or so, and it is still
        // called that in the View menu. The variable is
        // with-verbose-cursor.
        { name: 'with-verbose-cursor', label: 'verbose cursor', kind: 'bool' },
        { name: 'show-full-duration', label: 'full duration', kind: 'bool' },
        { name: 'show-full-range', label: 'full range', kind: 'bool' },
      ],
    },
    {
      title: 'how it is drawn',
      variables: [
        {
          name: 'time-graph-style',
          label: 'graph style',
          kind: 'enum',
          options: [
            { label: 'lines', symbol: 'graph-lines' },
            { label: 'dots', symbol: 'graph-dots' },
            { label: 'filled', symbol: 'graph-filled' },
            { label: 'dots and lines', symbol: 'graph-dots-and-lines' },
            { label: 'lollipops', symbol: 'graph-lollipops' },
          ],
        },
        { name: 'dot-size', label: 'dot size', kind: 'int', min: 1, max: 20, step: 1 },
        {
          name: 'x-axis-style',
          label: 'x axis',
          kind: 'enum',
          options: [
            { label: 'seconds', symbol: 'x-axis-in-seconds' },
            { label: 'samples', symbol: 'x-axis-in-samples' },
            { label: 'percentage', symbol: 'x-axis-as-percentage' },
            { label: 'beats', symbol: 'x-axis-in-beats' },
            { label: 'measures', symbol: 'x-axis-in-measures' },
            { label: 'clock', symbol: 'x-axis-as-clock' },
          ],
        },
        {
          name: 'show-axes',
          label: 'axes',
          kind: 'enum',
          options: [
            { label: 'none', symbol: 'show-no-axes' },
            { label: 'all', symbol: 'show-all-axes' },
            { label: 'x only', symbol: 'show-x-axis' },
            { label: 'all, unlabelled', symbol: 'show-all-axes-unlabelled' },
            { label: 'x only, unlabelled', symbol: 'show-x-axis-unlabelled' },
            { label: 'bare x', symbol: 'show-bare-x-axis' },
          ],
        },
        {
          name: 'channel-style',
          label: 'channel layout',
          kind: 'enum',
          options: [
            { label: 'separate', symbol: 'channels-separate' },
            { label: 'combined', symbol: 'channels-combined' },
            { label: 'superimposed', symbol: 'channels-superimposed' },
          ],
        },
        {
          name: 'zoom-focus-style',
          label: 'zoom centres on',
          kind: 'enum',
          options: [
            { label: 'left', symbol: 'zoom-focus-left' },
            { label: 'right', symbol: 'zoom-focus-right' },
            { label: 'middle', symbol: 'zoom-focus-middle' },
            { label: 'active', symbol: 'zoom-focus-active' },
          ],
        },
        { name: 'beats-per-minute', label: 'beats per minute', kind: 'float', min: 1, max: 400, step: 1 },
        { name: 'beats-per-measure', label: 'beats per measure', kind: 'int', min: 1, max: 16, step: 1 },
      ],
    },
  ],
};

/**
 * Preferences.
 *
 * Snd's own Preferences dialog has a Save button that writes ~/.snd. This
 * panel deliberately does NOT: it sets the variables in the session, and
 * `Snd: Save Session State` is the separate, explicit act. Silently
 * rewriting a file a Snd user has been keeping by hand for years is not a
 * convenience.
 */
export const PREFERENCES_DIALOG: DialogSpec = {
  id: 'preferences',
  title: 'Snd: Preferences',
  note:
    'Sets these in the running session only. This panel does not write ~/.snd — ' +
    'that file is yours.',
  groups: [
    {
      title: 'behaviour',
      variables: [
        { name: 'ask-before-overwrite', label: 'ask before overwriting', kind: 'bool' },
        { name: 'ask-about-unsaved-edits', label: 'ask about unsaved edits', kind: 'bool' },
        { name: 'auto-resize', label: 'resize as sounds open', kind: 'bool' },
        { name: 'auto-update', label: 'reread changed files', kind: 'bool' },
        { name: 'auto-update-interval', label: 'reread interval (s)', kind: 'float', min: 0, max: 300, step: 1 },
        { name: 'remember-sound-state', label: 'restore a sound\'s state', kind: 'bool' },
        { name: 'with-inset-graph', label: 'thumbnail graph', kind: 'bool' },
        { name: 'max-regions', label: 'max regions', kind: 'int', min: 0, max: 128, step: 1 },
        { name: 'selection-creates-region', label: 'selection creates a region', kind: 'bool' },
        { name: 'with-tracking-cursor', label: 'cursor follows playback', kind: 'bool' },
        { name: 'cursor-update-interval', label: 'cursor update (s)', kind: 'float', min: 0, max: 1, step: 0.01 },
        { name: 'sync-style', label: 'sync style', kind: 'int', min: 0, max: 2, step: 1 },
      ],
    },
    {
      title: 'files',
      variables: [
        { name: 'save-dir', label: 'save-state directory', kind: 'string' },
        { name: 'temp-dir', label: 'temporary directory', kind: 'string' },
        { name: 'save-state-file', label: 'default save-state file', kind: 'string' },
        { name: 'html-program', label: 'HTML reader for snd-help', kind: 'string' },
        { name: 'peak-env-dir', label: 'peak env directory', kind: 'string' },
        { name: 'just-sounds', label: 'sound files only in lists', kind: 'bool' },
      ],
    },
    {
      title: 'new sounds',
      variables: [
        { name: 'default-output-chans', label: 'channels', kind: 'int', min: 1, max: 8, step: 1 },
        {
          name: 'default-output-srate',
          label: 'sample rate',
          kind: 'enum',
          options: [8000, 22050, 44100, 48000, 96000].map(rate => ({
            label: String(rate),
            symbol: String(rate),
          })),
        },
        {
          name: 'default-output-header-type',
          label: 'header',
          kind: 'enum',
          options: [
            { label: 'aifc', symbol: 'mus-aifc' },
            { label: 'wave', symbol: 'mus-riff' },
            { label: 'au', symbol: 'mus-next' },
            { label: 'rf64', symbol: 'mus-rf64' },
            { label: 'aiff', symbol: 'mus-aiff' },
          ],
        },
        {
          name: 'default-output-sample-type',
          label: 'samples',
          kind: 'enum',
          options: [
            { label: 'short', symbol: 'mus-lshort' },
            { label: 'int', symbol: 'mus-lint' },
            { label: 'float', symbol: 'mus-lfloat' },
            { label: 'double', symbol: 'mus-ldouble' },
          ],
        },
      ],
    },
    {
      title: 'listener',
      variables: [
        { name: 'listener-prompt', label: 'prompt', kind: 'string' },
        { name: 'listener-colorized', label: 'colourised', kind: 'bool' },
        { name: 'print-length', label: 'print length', kind: 'int', min: 1, max: 1000, step: 1 },
      ],
    },
  ],
};

export const DIALOGS: DialogSpec[] = [
  TRANSFORM_DIALOG,
  CONTROLS_DIALOG,
  VIEW_DIALOG,
  PREFERENCES_DIALOG,
];

/** Every variable a dialog needs, for one getvars request. */
export function variableNames(spec: DialogSpec): string[] {
  return spec.groups.flatMap(group => group.variables.map(variable => variable.name));
}

/** Every symbol whose numeric value has to be resolved against the build. */
export function symbolNames(spec: DialogSpec): string[] {
  const out: string[] = [];
  for (const group of spec.groups) {
    for (const variable of group.variables) {
      if (variable.kind !== 'enum' || !variable.options) continue;
      for (const option of variable.options) {
        // Numeric options (sizes, sample rates) are literals, not symbols.
        if (!/^-?\d+(\.\d+)?$/.test(option.symbol)) out.push(option.symbol);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * The Scheme literal for a value from a form field.
 *
 * The one place a panel value becomes Scheme, so the one place where the
 * difference between #f and "false" and 0 has to be got right. Strings go
 * through the caller's quoting; everything else is a literal here.
 */
export function schemeLiteral(spec: VariableSpec, value: unknown): string | undefined {
  switch (spec.kind) {
    case 'bool':
      return value ? '#t' : '#f';
    case 'int': {
      const number = Math.round(Number(value));
      return Number.isFinite(number) ? String(number) : undefined;
    }
    case 'float': {
      const number = Number(value);
      if (!Number.isFinite(number)) return undefined;
      // A float variable set from an integer-looking slider position must
      // still arrive as a float: (set! (amp-control) 1) gives an exact 1
      // in s7, and an exact amp where Snd expects a real is a type error
      // on some of these accessors.
      return Number.isInteger(number) ? `${number}.0` : String(number);
    }
    case 'enum': {
      const text = String(value);
      if (/^-?\d+(\.\d+)?$/.test(text)) return text;
      const known = spec.options?.some(option => option.symbol === text);
      return known ? text : undefined;
    }
    case 'readonly':
      return undefined;
    default:
      return undefined;
  }
}
