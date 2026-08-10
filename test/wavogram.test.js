// wavogram.test.js -- the wavogram is a landscape, and all of it is visible.
//
// WHY THIS EXISTS. The wavogram hides what is behind: each trace is filled
// with the background colour down to the floor before it is stroked, so a
// nearer trace covers the ground and the traces beyond it. That is the whole
// of hidden-line removal, and it is an ORDER, not an effect.
//
// The order was wrong. `projected.forEach` runs trace 0 first, and trace 0 is
// the FRONT of the landscape -- so the hindmost trace was painted last and
// its mask, reaching from its own curve down to the floor, covered the entire
// picture. At `globalAlpha = .72` a hundred and twenty such masks leave
// nothing at all: 120 traces were computed, projected correctly, stroked, and
// then erased, and the panel showed a thin band of lines along the top edge
// with grey underneath.
//
// Nothing else could see it. The projection was right, so a matrix test
// passes. The traces were right, so the bridge tests pass. Every id exists,
// so the panel gate passes. tsc has no opinion about painter's algorithms.
// The evidence was a screenshot.
//
// So this gate runs the panel's OWN script text -- the same string the webview
// gets, with the same interpolated matrix -- against a recording canvas, and
// asks the only question that matters: after everything is painted, is each
// trace still there? Coverage is computed with the alpha the panel actually
// used, so a mask that hides by ordering and a mask that hides by washing out
// both fail here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('./vscode-stub.js').install();

// The real projection, from the module the panel interpolates it from. A copy
// here would be a second implementation and the first thing to drift.
const { rotationMatrix, place } = require('../out/spectrumView.js');

const WIDTH = 800;
const HEIGHT = 300;

/**
 * The panel's script, as the webview receives it.
 */
function panelScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'wavogramView.ts'),
    'utf8'
  );
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(source);
  assert.ok(script, 'the wavogram panel has no script');
  const code = script[1]
    .replace('${rotationMatrix.toString()}', rotationMatrix.toString())
    .replace('${place.toString()}', place.toString());
  // An interpolation left as literal text would be a syntax error inside the
  // Function below, reported as "unexpected token" with no hint of where from.
  assert.ok(
    !code.includes('${'),
    'the wavogram script has an interpolation this gate does not know about'
  );
  return code;
}

/**
 * Run the script against a recording 2D context and return the paint log:
 * one entry per fill and per stroke, with the path as it was submitted and
 * the alpha in force at the time.
 */
function paint(payload) {
  const operations = [];
  let current = [];
  const state = { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1 };
  const context = {
    ...state,
    setTransform() {},
    clearRect() {},
    beginPath() { current = []; },
    closePath() {},
    moveTo(x, y) { current.push({ x, y }); },
    lineTo(x, y) { current.push({ x, y }); },
    fill() { operations.push({ kind: 'fill', path: current.slice(), alpha: context.globalAlpha }); },
    stroke() { operations.push({ kind: 'stroke', path: current.slice(), alpha: context.globalAlpha }); },
    fillText() {},
    save() {},
    restore() {},
  };

  const element = () => ({
    value: '',
    textContent: '',
    style: {},
    addEventListener() {},
    getContext: () => context,
    clientWidth: WIDTH,
    clientHeight: HEIGHT,
    width: WIDTH,
    height: HEIGHT,
  });
  const elements = new Map();
  const listeners = {};

  const scope = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      body: {},
    },
    window: {
      devicePixelRatio: 1,
      addEventListener(name, listener) { listeners[name] = listener; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    acquireVsCodeApi: () => ({ postMessage() {} }),
    console,
    Math, JSON, Number, String, Array, Object, isFinite, Infinity, NaN,
  };

  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(scope), panelScript())(...Object.values(scope));
  assert.ok(listeners.message, 'the wavogram panel never listens for its data');
  listeners.message({ data: { type: 'wavogram', data: payload } });
  return operations;
}

/** A wavogram of `traces` lines, each a sine of its own amplitude. */
function wavogram(traces = 24, points = 32) {
  return {
    snd: 0,
    chn: 0,
    fileName: 'gate.snd',
    srate: 44100,
    frames: traces * 64,
    start: 0,
    traceLength: 64,
    hop: 3,
    points,
    traces: Array.from({ length: traces }, (_, row) =>
      Array.from({ length: points }, (_, i) =>
        0.8 * Math.sin((2 * Math.PI * i) / points) * (0.3 + (0.7 * row) / traces)
      )
    ),
    orientation: { xAngle: 90, yAngle: 0, zAngle: 358, xScale: 1, yScale: 1, zScale: 0.1 },
  };
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

/**
 * How much of a stroke survives everything painted after it: for each vertex,
 * the product of (1 - alpha) over the later fills that cover it. The best
 * vertex counts -- a trace is visible if any part of it is.
 */
function survival(operations) {
  const strokes = operations
    .map((operation, index) => ({ ...operation, index }))
    .filter(operation => operation.kind === 'stroke');
  return strokes.map(stroke => {
    let best = 0;
    for (const vertex of stroke.path) {
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

test('the wavogram strokes every trace it is given', () => {
  const data = wavogram();
  const strokes = paint(data).filter(operation => operation.kind === 'stroke');
  assert.equal(strokes.length, data.traces.length);
});

test('the wavogram fills the ground under every trace it strokes', () => {
  // Hiding is what the fill is for. A picture without it is a wire mesh, and
  // one fill missing is one trace showing through the one in front of it.
  const operations = paint(wavogram());
  const fills = operations.filter(operation => operation.kind === 'fill');
  const strokes = operations.filter(operation => operation.kind === 'stroke');
  assert.equal(fills.length, strokes.length);
});

test('every trace of the wavogram is still visible once the masks are down', () => {
  // THE GATE. Anything painted later may hide a trace: the wrong order, a
  // mask reaching past its own curve, a translucent fill applied often
  // enough. All of them arrive here as a trace whose survival is zero.
  const visible = survival(paint(wavogram()));
  const lost = visible
    .map((value, row) => ({ row, value }))
    .filter(entry => entry.value < 0.5);
  assert.deepEqual(
    lost,
    [],
    `traces hidden by what was painted over them: ` +
      lost.map(entry => `${entry.row} (${entry.value.toFixed(3)})`).join(', ')
  );
});

test('the wavogram paints from the back of the landscape forward', () => {
  // The same fault named directly, so a failure says which way round it went
  // rather than only that something is hidden. Trace 0 is the front, which
  // is the LOWEST on the screen, so the first fill belongs to the last trace
  // and the fills descend from there.
  const fills = paint(wavogram()).filter(operation => operation.kind === 'fill');
  const depth = fills.map(fill => Math.min(...fill.path.map(point => point.y)));
  const descending = depth.every((value, i) => i === 0 || value >= depth[i - 1] - 1e-9);
  assert.ok(
    descending,
    'the fills run front-to-back: the hindmost trace is painted last and its ' +
      'mask covers the whole picture'
  );
});

test('the wavogram survives a trace count the panel height cannot show', () => {
  // 256 traces into 300 pixels: the projection squeezes, the masks overlap
  // heavily, and the ordering has to hold anyway.
  const visible = survival(paint(wavogram(256, 16)));
  assert.equal(visible.filter(value => value < 0.5).length, 0);
});
