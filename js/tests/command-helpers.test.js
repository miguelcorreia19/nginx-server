// Real-process regression tests for command() and commandSafe() in js/utils.js.
//
// Every other suite in this repo replaces these two helpers with jest.fn()
// mocks — or, in backup-protection.test.js, with its own separate
// exec/execFile wrapper that never exercised the actual resolve/reject logic
// below. That is exactly why the stderr-on-success defect these tests pin
// survived: every existing mock supplied empty stderr, so the buggy
// `if (stderr) reject(...)` branch this file used to have was never reached
// by any test in the suite.
//
// child_process is intentionally left unmocked here — these run real,
// deterministic local processes end to end, matching the exit-code-is-truth
// contract validateNginxConfig() already uses and already has real-process-
// style coverage for (nginx-validation.test.js, via a controlled EventEmitter
// standing in for spawn's real event surface).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { command, commandSafe } = require('../utils.js');

// Small standalone scripts rather than an inline `node -e ...`, so shell-
// quoting of an inline script string can't leak into what these tests are
// actually pinning: the resolve/reject contract, not string escaping.
let scriptDir;
const scriptPath = (name) => path.join(scriptDir, name);

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-helpers-test-'));
  fs.writeFileSync(scriptPath('stdout-only.js'), "process.stdout.write('stdout-only-output');\n");
  fs.writeFileSync(scriptPath('stderr-only.js'), "process.stderr.write('stderr-only-output');\n");
  fs.writeFileSync(scriptPath('both-streams.js'), "process.stdout.write('both-stdout'); process.stderr.write('both-stderr');\n");
  fs.writeFileSync(scriptPath('no-output.js'), "// exits 0, writes nothing to either stream\n");
  fs.writeFileSync(scriptPath('fail.js'), "process.stderr.write('failure-diagnostic'); process.exit(3);\n");
});

afterAll(() => {
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

// Asserts the shape every production caller relies on: a rejection is a
// plain { error: string } object, not a rejected Error instance (manage_certs.js,
// certbot_renew.js and friends all read `err.error`, never `err.message`).
const expectRejectionShape = (caught) => {
  expect(caught).toBeDefined();
  expect(caught).not.toBeInstanceOf(Error);
  expect(typeof caught.error).toBe('string');
};

describe('command() — real-process success/failure contract', () => {
  // Runs through a real shell (exec), built as one shell-string — the same
  // shape every production command() call site uses.
  const runScript = (name) => command(`"${process.execPath}" "${scriptPath(name)}"`);

  it('resolves with stdout when the process writes only to stdout', async () => {
    await expect(runScript('stdout-only.js')).resolves.toBe('stdout-only-output');
  });

  // The defect this suite exists to pin: a process that exits 0 and writes
  // only to stderr — openssl's progress dots, certbot's "Saving debug log to
  // ..." banner — is a successful execution. The old contract rejected it
  // solely because stderr was non-empty, even though nothing failed.
  it('resolves (not rejects) when the process exits 0 and writes only to stderr', async () => {
    await expect(runScript('stderr-only.js')).resolves.toBeUndefined();
  });

  it('resolves with stdout, ignoring stderr, when the process writes to both streams', async () => {
    await expect(runScript('both-streams.js')).resolves.toBe('both-stdout');
  });

  // Empty success must stay `undefined`, not become `''` — callers like
  // js/letsencrypt/certbot_renew.js branch on `if (renewOutput)`, and other
  // sites resolve() this call without ever reading the value.
  it('resolves undefined when the process writes to neither stream', async () => {
    await expect(runScript('no-output.js')).resolves.toBeUndefined();
  });

  it('rejects on a non-zero exit, preserving the existing shape and diagnostic', async () => {
    let caught;
    try {
      await runScript('fail.js');
    } catch (err) {
      caught = err;
    }
    expectRejectionShape(caught);
    expect(caught.error).toContain('failure-diagnostic');
  });
});

describe('commandSafe() — real-process success/failure contract', () => {
  const runFile = (name) => commandSafe(process.execPath, [scriptPath(name)]);

  it('resolves with stdout when the process writes only to stdout', async () => {
    await expect(runFile('stdout-only.js')).resolves.toBe('stdout-only-output');
  });

  it('resolves (not rejects) when the process exits 0 and writes only to stderr', async () => {
    await expect(runFile('stderr-only.js')).resolves.toBeUndefined();
  });

  it('resolves with stdout, ignoring stderr, when the process writes to both streams', async () => {
    await expect(runFile('both-streams.js')).resolves.toBe('both-stdout');
  });

  it('resolves undefined when the process writes to neither stream', async () => {
    await expect(runFile('no-output.js')).resolves.toBeUndefined();
  });

  it('rejects on a non-zero exit, preserving the existing shape and diagnostic', async () => {
    let caught;
    try {
      await runFile('fail.js');
    } catch (err) {
      caught = err;
    }
    expectRejectionShape(caught);
    expect(caught.error).toContain('failure-diagnostic');
  });

  // execFile-specific failure mode: the binary itself cannot be found. Not
  // wording-pinned — ENOENT text is platform/Node-version-sensitive — only
  // the project's own contract: an execution error still rejects, in the
  // existing { error: string } shape.
  it('rejects when the executable does not exist', async () => {
    let caught;
    try {
      await commandSafe('this-binary-definitely-does-not-exist-xyz123', []);
    } catch (err) {
      caught = err;
    }
    expectRejectionShape(caught);
  });
});
