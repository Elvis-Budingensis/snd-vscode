// loadpath.test.js -- what goes on s7's *load-path* when a session starts.
//
// WHY THIS EXISTS. `(load "examples/vscode-ui.scm")` is the line the example's
// own header tells the reader to type, and it failed: Snd's cwd is the
// workspace, not the extension, and only Snd's source tree was being added to
// the load path. The file was installed, documented, and unreachable by the
// name given for it. The user pasted an absolute path instead, which works and
// is not what the documentation says.
//
// The decision is now one exported function instead of an await inside a
// closure in activate(), for the reason this file exists at all: nothing would
// have gone red if that await were dropped in a refactor.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

require('./vscode-stub.js').install();

const { loadPathsFor } = require('../out/extension.js');

const EXT = '/ext/snd-vscode';
const never = () => false;
const always = () => true;

test('the extension directory is on the load path', () => {
  // The whole point: (load "examples/vscode-ui.scm") resolves through this.
  const paths = loadPathsFor({ configured: '', extensionPath: EXT, exists: never });
  assert.ok(paths.includes(EXT), `extension path missing from ${JSON.stringify(paths)}`);
});

test('the extension directory comes first', () => {
  // Order decides which wins when both directories hold a file of the same
  // name. The extension's own examples should not be shadowed by whatever a
  // Snd tarball happens to carry.
  const paths = loadPathsFor({
    configured: '/opt/snd-26.5',
    extensionPath: EXT,
    exists: always,
  });
  assert.equal(paths[0], EXT);
});

test('a configured source path is added as well', () => {
  // Both, not either: the examples and the fm-violin are different needs.
  const paths = loadPathsFor({
    configured: '/opt/snd-26.5',
    extensionPath: EXT,
    exists: never,
  });
  assert.deepEqual(paths, [EXT, '/opt/snd-26.5']);
});

test('a configured source path wins over the bundled tree', () => {
  // Someone who set the setting means it, even with a .build present.
  const paths = loadPathsFor({
    configured: '/opt/snd-26.5',
    extensionPath: EXT,
    exists: always,
  });
  assert.deepEqual(paths, [EXT, '/opt/snd-26.5']);
});

test('the bundled Snd tree is used when nothing is configured', () => {
  const bundled = path.join(EXT, '.build', 'snd-26.5');
  const paths = loadPathsFor({
    configured: '',
    extensionPath: EXT,
    exists: candidate => candidate === bundled,
  });
  assert.deepEqual(paths, [EXT, bundled]);
});

test('a bundled tree that is not there is not offered', () => {
  // A path that does not exist would be a request whose only outcome is a
  // no-op, and the caller cannot tell that from success.
  const paths = loadPathsFor({ configured: '', extensionPath: EXT, exists: never });
  assert.deepEqual(paths, [EXT]);
});

test('whitespace in the setting is not a path', () => {
  const paths = loadPathsFor({ configured: '   ', extensionPath: EXT, exists: never });
  assert.deepEqual(paths, [EXT]);
});

test('the same directory is never sent twice', () => {
  // Configuring the extension directory as the source path is odd but legal,
  // and the bridge prepends to *load-path* -- a duplicate that shadows nothing
  // is exactly the kind of thing that looks harmless for a hundred restarts.
  const paths = loadPathsFor({ configured: EXT, extensionPath: EXT, exists: always });
  assert.deepEqual(paths, [EXT]);
});
