// Tests the Docker HEALTHCHECK command defined in the Dockerfile.
// The command is extracted directly from the Dockerfile (not retyped here)
// so this test fails if the two ever drift apart, and is executed against
// stub `cat`/`kill`/`nginx` binaries that simulate each edge case described
// in the Phase 3B spec: process alive/dead, config valid/invalid.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

const healthcheckMatch = dockerfile.match(/HEALTHCHECK[^\n]*\\\n\s*CMD (.+)/);
if (!healthcheckMatch) {
  throw new Error('Could not find a HEALTHCHECK CMD in the Dockerfile — has it been removed/reformatted?');
}
const HEALTHCHECK_CMD = healthcheckMatch[1].trim();

let stubDir;

beforeEach(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-stubs-'));
});

afterEach(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

const writeStub = (name, script) => {
  const stubPath = path.join(stubDir, name);
  fs.writeFileSync(stubPath, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(stubPath, 0o755);
};

// `kill` is a shell builtin in both bash and busybox ash (the Dockerfile's
// HEALTHCHECK runs under /bin/sh), so it cannot be intercepted via a PATH
// stub — the builtin always wins. Instead we point the stubbed `cat` at a
// real PID (this test process's own, which is guaranteed alive for the
// "alive" case) or an out-of-range PID that can never exist (for "dead"),
// and let the real `kill -0` evaluate it. This is more faithful to
// production than stubbing `kill` would be, since it exercises the exact
// liveness check the container relies on.
const UNREACHABLE_PID = '2147483647';

const setupStubs = ({ pidAlive, configValid }) => {
  writeStub('cat', `echo ${pidAlive ? process.pid : UNREACHABLE_PID}`);
  writeStub('nginx', `[ "$1" = "-t" ] && [ "${configValid ? '1' : '0'}" = "1" ] && exit 0 || exit 1`);
};

const runHealthcheck = () => {
  try {
    execSync(HEALTHCHECK_CMD, {
      shell: '/bin/sh',
      env: { PATH: `${stubDir}:${process.env.PATH}` },
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    return err.status;
  }
};

describe('Docker HEALTHCHECK command', () => {
  it('reports healthy (exit 0) when nginx is alive and the config is valid', () => {
    setupStubs({ pidAlive: true, configValid: true });
    expect(runHealthcheck()).toBe(0);
  });

  it('reports unhealthy (non-zero) when the nginx master process is missing/dead', () => {
    setupStubs({ pidAlive: false, configValid: true });
    expect(runHealthcheck()).not.toBe(0);
  });

  it('reports unhealthy (non-zero) when nginx is alive but the config is invalid', () => {
    setupStubs({ pidAlive: true, configValid: false });
    expect(runHealthcheck()).not.toBe(0);
  });

  it('reports unhealthy (non-zero) when both the process is dead and the config is invalid', () => {
    setupStubs({ pidAlive: false, configValid: false });
    expect(runHealthcheck()).not.toBe(0);
  });

  // Regression test: in this image's /bin/sh, `kill -0 ""` (an empty PID
  // argument) returns exit 0. A naive `kill -0 "$(cat pidfile)"` would
  // therefore report "healthy" for an empty or missing pidfile — exactly
  // the state nginx leaves behind when it crashes mid-write or is killed
  // before it finishes starting. The command must explicitly reject an
  // empty PID rather than relying on `kill -0` to do it.
  it('reports unhealthy (non-zero) when the pidfile is empty (false-positive guard)', () => {
    writeStub('cat', 'echo -n ""');
    writeStub('nginx', `[ "$1" = "-t" ] && exit 0 || exit 1`);
    expect(runHealthcheck()).not.toBe(0);
  });

  it('reports unhealthy (non-zero) when the pidfile is missing (cat fails)', () => {
    writeStub('cat', 'exit 1');
    writeStub('nginx', `[ "$1" = "-t" ] && exit 0 || exit 1`);
    expect(runHealthcheck()).not.toBe(0);
  });

  it('does not perform a network request (no curl/wget/nc in the command)', () => {
    expect(HEALTHCHECK_CMD).not.toMatch(/\b(curl|wget|nc|netcat)\b/);
  });
});
