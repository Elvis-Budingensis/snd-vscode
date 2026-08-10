// spectrogram.test.js -- the 3D spectrogram is a surface, and all of it shows.
//
// WHY THIS EXISTS. The spectrogram and the wavogram are the same picture drawn
// from different data: slices stacked into depth, each filled with the
// background before it is stroked so that it hides what lies behind. The
// wavogram got that wrong -- it closed every mask on the CANVAS FLOOR and
// painted front-to-back, so the hindmost slice's mask covered the whole frame
// and 120 correctly computed traces were erased after being drawn.
//
// This file is that lesson pointed at the other display. It exists because the
// two were suspected of sharing the fault and only measurement settled it:
// the spectrogram closes each mask on `slice.base`, the slice's own baseline,
// so a mask can never reach past its own strip and the cumulative erasure
// cannot happen. That is the difference between the two, it is one expression,
// and nothing in tsc or the s7 tests would notice it changing.
//
// So the property under test is not "the order is right" -- it is "no slice is
// hidden by what was painted after it", measured with the alpha in force, on
// the panel's own script text with the real projection interpolated in.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('./vscode-stub.js').install();

const { rotationMatrix, place } = require('../out/spectrumView.js');

const WIDTH = 800;
const HEIGHT = 300;

function panelScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'spectrumView.ts'),
    'utf8'
  );
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(source);
  assert.ok(script, 'the spectrum panel has no script');
  const code = script[1]
    .replace('${rotationMatrix.toString()}', rotationMatrix.toString())
    .replace('${place.toString()}', place.toString());
  assert.ok(
    !code.includes('${'),
    'the spectrum script has an interpolation this gate does not know about'
  );
  return code;
}

/**
 * A sonogram matrix as the bridge sends it: one byte of level per bin per
 * column. `atob` is the identity here, so the fixture is the decoded string.
 */
function sonogram(slices = 40, bins = 64) {
  let cells = '';
  for (let column = 0; column < slices; column++) {
    for (let bin = 0; bin < bins; bin++) {
      const level = 120 + 100 * Math.sin(bin / 4) * Math.cos(column / 6);
      cells += String.fromCharCode(Math.round(level));
    }
  }
  return {
    columns: slices,
    bins,
    cells,
    srate: 44100,
    size: 4096,
    fileName: 'gate.snd',
    chn: 0,
    spectro: {
      xAngle: 90, yAngle: 0, zAngle: 358,
      xScale: 1, yScale: 1, zScale: 0.1, hop: 4,
    },
  };
}

const settings = {
  mode: 'spectrogram',
  size: 4096,
  sizes: [4096],
  window: 'blackman2-window',
  windows: ['blackman2-window'],
  linear: false,
  followCursor: true,
};

/** Run the panel and return the paint log: fills and strokes, with alpha. */
function paint(data, spectrumEnd = 1) {
  const operations = [];
  let current = [];
  const context = {
    globalAlpha: 1,
    setTransform() {}, clearRect() {}, save() {}, restore() {},
    beginPath() { current = []; },
    closePath() {},
    moveTo(x, y) { current.push({ x, y }); },
    lineTo(x, y) { current.push({ x, y }); },
    fill() { operations.push({ kind: 'fill', path: current.slice(), alpha: context.globalAlpha }); },
    stroke() { operations.push({ kind: 'stroke', path: current.slice(), alpha: context.globalAlpha }); },
    fillRect() {}, fillText() {}, drawImage() {}, putImageData() {},
    createImageData: () => ({ data: new Uint8Array(WIDTH * HEIGHT * 4) }),
  };

  const element = () => ({
    value: '', textContent: '', style: {}, options: [],
    checked: false, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, setAttribute() {},
    getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT }),
    getContext: () => context,
    clientWidth: WIDTH, clientHeight: HEIGHT, width: WIDTH, height: HEIGHT,
  });
  const elements = new Map();
  const listeners = {};

  const scope = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: () => element(),
      body: {},
    },
    window: {
      devicePixelRatio: 1,
      addEventListener(name, listener) { listeners[name] = listener; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    acquireVsCodeApi: () => ({ postMessage() {} }),
    // The bridge base64-encodes the matrix; the fixture is already decoded.
    atob: value => value,
    console, Math, JSON, Number, String, Array, Object,
    isFinite, Infinity, NaN, Uint8Array, setTimeout,
  };

  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(scope), panelScript())(...Object.values(scope));
  assert.ok(listeners.message, 'the spectrum panel never listens for its data');
  listeners.message({
    data: { type: 'axes', axes: { spectrumStart: 0, spectrumEnd, logFrequency: false } },
  });
  listeners.message({ data: { type: 'sonogram', sonogram: data, settings } });
  return operations;
}

function inside(point, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      hit = !hit;
    }
  }
  return hit;
}

/** For each stroke, the best vertex's survival against every later fill. */
function survival(operations) {
  const strokes = operations
    .map((operation, index) => ({ ...operation, index }))
    .filter(operation => operation.kind === 'stroke');
  return strokes.map(stroke => {
    let best = 0;
    const step = Math.max(1, Math.ceil(stroke.path.length / 12));
    for (let i = 0; i < stroke.path.length; i += step) {
      const vertex = stroke.path[i];
      let visible = 1;
      for (const later of operations.slice(stroke.index + 1)) {
        if (later.kind === 'fill' && inside(vertex, later.path)) {
          visible *= 1 - later.alpha;
        }
      }
      best = Math.max(best, visible);
    }
    return best;
  });
}

test('the spectrogram strokes and fills one slice each', () => {
  const operations = paint(sonogram());
  const fills = operations.filter(operation => operation.kind === 'fill');
  const strokes = operations.filter(operation => operation.kind === 'stroke');
  assert.equal(strokes.length, fills.length);
  assert.ok(strokes.length >= 8, `only ${strokes.length} slices drawn`);
});

test('every slice of the spectrogram survives what is painted over it', () => {
  // THE GATE, and the reason the file exists. A mask closed on the canvas
  // floor instead of the slice's own base turns this into a row of zeros --
  // which is precisely what the wavogram did.
  const visible = survival(paint(sonogram()));
  const lost = visible
    .map((value, slice) => ({ slice, value }))
    .filter(entry => entry.value < 0.5);
  assert.deepEqual(
    lost,
    [],
    'slices hidden by later paint: ' +
      lost.map(entry => `${entry.slice} (${entry.value.toFixed(3)})`).join(', ')
  );
});

test('each spectrogram mask stays inside its own slice', () => {
  // The property BEHIND the one above, named so a failure says which of the
  // two went wrong. A mask reaching the bottom of the frame is the fault; a
  // mask no deeper than the next slice's stack step is correct.
  const operations = paint(sonogram());
  const fills = operations.filter(operation => operation.kind === 'fill');
  const depths = fills.map(fill => {
    const ys = fill.path.map(point => point.y);
    return Math.max(...ys) - Math.min(...ys);
  });
  const frame = Math.max(...fills.flatMap(fill => fill.path.map(point => point.y)));
  const tallest = Math.max(...depths);
  assert.ok(
    tallest < frame * 0.75,
    `a mask spans ${tallest.toFixed(0)} of ${frame.toFixed(0)} px — it is ` +
      'reaching past its own slice and will erase the ones behind it'
  );
});

test('the spectrogram restricts itself to the bins it was asked for', () => {
  // spectrum-end is what makes the picture readable: a 330 Hz note at 4096
  // points puts everything of interest in the first few percent of the width.
  // If the setting is ignored, both of these draw the same number of points.
  const full = paint(sonogram());
  const quarter = paint(sonogram(), 0.25);
  const width = operations =>
    operations.find(operation => operation.kind === 'stroke').path.length;
  assert.ok(
    width(quarter) < width(full),
    'spectrum-end does not reach the spectrogram: the full range and a ' +
      'quarter of it drew the same number of bins'
  );
});
