// Dockerfile + shell-script assertions for the optional Fail2ban feature.
// These pin the build-time wiring (package install, file copies, Alpine
// startup fixes) and the runtime gate/non-fatal behaviour of fail2ban.sh,
// without requiring Docker — they read the source files and assert on them,
// the same approach used by build-startup-assertions.test.js / healthcheck.test.js.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const entrypoint = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
const fail2banSh = fs.readFileSync(path.join(root, 'fail2ban.sh'), 'utf8');

// Strip comment lines so package-name assertions are not satisfied by prose in
// documentation comments (consistent with build-startup-assertions.test.js).
const dockerfileNoComments = dockerfile.split('\n')
  .filter(line => !line.trim().startsWith('#'))
  .join('\n');

describe('Dockerfile — Fail2ban packages installed', () => {
  it('installs fail2ban', () => {
    expect(dockerfileNoComments).toMatch(/\bfail2ban\b/);
  });
  it('installs iptables (ban backend)', () => {
    expect(dockerfileNoComments).toMatch(/\biptables\b/);
  });
  it('still does NOT add ip6tables explicitly (it ships with the iptables package)', () => {
    expect(dockerfileNoComments).not.toMatch(/\bip6tables\b/);
  });
});

describe('Dockerfile — Fail2ban files and Alpine startup fixes', () => {
  it('copies fail2ban.sh into the image', () => {
    expect(dockerfile).toMatch(/COPY fail2ban\.sh \/usr\/local\/bin\//);
  });
  it('makes fail2ban.sh executable', () => {
    // An explicit mode rather than `chmod +x`: symbolic `+x` adds the execute
    // bits and keeps whatever read/write bits COPY was handed, so the result
    // would be the checkout's to decide (git tracks only the executable bit,
    // and a umask-002 clone supplies 0664 -> 0775). The full permission model
    // for all four helpers lives in build-startup-assertions.test.js.
    expect(dockerfile).toMatch(/chmod 0?755[^\n]*\/usr\/local\/bin\/fail2ban\.sh/);
  });
  it('installs the static fail2ban.local server config', () => {
    expect(dockerfile).toMatch(/COPY \.\/fail2ban\/fail2ban\.local \/etc\/fail2ban\/fail2ban\.local/);
  });
  it('removes the Alpine ssh jail drop-in that would abort startup', () => {
    expect(dockerfile).toMatch(/rm -f \/etc\/fail2ban\/jail\.d\/alpine-ssh\.conf/);
  });
  it('pre-creates the Fail2ban runtime directories', () => {
    expect(dockerfile).toMatch(/mkdir -p \/var\/run\/fail2ban \/var\/lib\/fail2ban/);
  });
});

// This whole script used to be backgrounded here. Fail2ban is disabled by
// default, so the common case exited while entrypoint.sh was still on its way
// to `exec nginx`, leaving a child that shell never got to reap — nginx
// inherited it as a zombie (`Z [fail2ban.sh]`) and cleared it only
// incidentally, on the next reload that made nginx sweep its children.
//
// The gate now runs synchronously and only the daemon is backgrounded, so no
// path that skips Fail2ban creates a background child at all.
describe('entrypoint.sh — Fail2ban launched without leaving a child behind', () => {
  it('runs fail2ban.sh in the foreground, not backgrounded', () => {
    expect(entrypoint).toMatch(/^\/usr\/local\/bin\/fail2ban\.sh$/m);
    expect(entrypoint).not.toMatch(/\/usr\/local\/bin\/fail2ban\.sh\s*&/);
  });

  it('runs it before exec-ing nginx, so nginx stays the foreground process', () => {
    const f2bIdx = entrypoint.indexOf('/usr/local/bin/fail2ban.sh');
    const execIdx = entrypoint.indexOf('exec "$@"');
    expect(f2bIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(f2bIdx);
  });

  it('still backgrounds the reload watcher, which is long-lived', () => {
    // The distinction the fix rests on: a helper that outlives `exec` is
    // re-parented to nginx and reaped when it eventually exits. Only one that
    // exits *before* `exec` was ever the problem.
    expect(entrypoint).toMatch(/\/usr\/local\/bin\/reload\.sh &/);
  });

  it('never waits on the Fail2ban daemon', () => {
    // A blanket `wait` would hang here forever whenever Fail2ban is enabled.
    expect(entrypoint).not.toMatch(/^\s*wait\b/m);
  });
});

describe('fail2ban.sh — gate and non-fatal startup', () => {
  it('is a no-op unless FAIL2BAN_ENABLED is exactly "true"', () => {
    expect(fail2banSh).toMatch(/\[ "\$\{FAIL2BAN_ENABLED\}" != "true" \]/);
    // Guard exits cleanly (0) so a disabled feature changes nothing.
    expect(fail2banSh).toMatch(/!= "true" \][^\n]*\n\s*exit 0/);
  });
  it('removes the Alpine ssh drop-in defensively at runtime', () => {
    expect(fail2banSh).toMatch(/rm -f \/etc\/fail2ban\/jail\.d\/alpine-ssh\.conf/);
  });
  it('ensures the required runtime directories exist', () => {
    expect(fail2banSh).toMatch(/mkdir -p \/var\/run\/fail2ban \/var\/lib\/fail2ban/);
  });
  it('checks for NET_ADMIN (iptables usable) and skips gracefully if missing', () => {
    expect(fail2banSh).toMatch(/iptables -L/);
    expect(fail2banSh).toMatch(/NET_ADMIN/);
  });
  it('starts the server in the foreground (no daemon double-fork, Docker-visible logs)', () => {
    expect(fail2banSh).toMatch(/fail2ban-server -xf start/);
  });
  it('exits 0 on every path so a Fail2ban failure never breaks nginx', () => {
    // No bare `exit 1` anywhere — all exits are clean.
    expect(fail2banSh).not.toMatch(/exit 1\b/);
  });
});

// ──────────────────────────────────────────────
//  Startup process lifecycle
// ──────────────────────────────────────────────
//
// Behaviour tests for the property that makes the zombie impossible: on every
// path that does not start the daemon, fail2ban.sh returns without having
// created a background child at all. Nothing is left for a caller to reap,
// whatever that caller then does.
//
// The zombie itself is deliberately NOT asserted here. It only ever appeared
// through entrypoint.sh — background a child, let it exit, then `exec` before
// the shell reaps it — and whether it is observable at any instant depends on
// bash's reaping timing, which is exactly why the original report called it
// incidental. A test built on that would be measuring a race, and a global
// zombie census also collides with other suites running in parallel. Its
// absence is established by the runtime container census instead.
//
// Needs a Linux /proc; skips where the test environment has none (macOS), while
// the source assertions above stay portable.
describe('fail2ban.sh — creates no background child on any skip path', () => {
  const os = require('os');
  const { spawnSync } = require('child_process');

  const withProc = fs.existsSync('/proc/self/status') ? it : it.skip;

  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f2b-life-'));
    fs.mkdirSync(path.join(tmp, 'bin'));
  });
  afterEach(() => {
    spawnSync('pkill', ['-f', 'sleep 3117']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const stub = (name, body) => {
    const p = path.join(tmp, 'bin', name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  };

  const alive = (pattern) => spawnSync('pgrep', ['-f', pattern]).status === 0;

  // stdout goes to a file rather than a pipe: the backgrounded daemon inherits
  // whatever the script had, and spawnSync waits for the *pipe* to close, not
  // just for the process to exit — so a piped run would block for as long as
  // the daemon lives and prove nothing about how quickly the script returned.
  const run = (env) => {
    const out = path.join(tmp, 'out.log');
    const started = Date.now();
    const result = spawnSync('bash', ['-c', `bash "${path.join(root, 'fail2ban.sh')}" > "${out}" 2>&1`], {
      encoding: 'utf8',
      env: { PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, ...env },
    });
    const elapsedMs = Date.now() - started;
    return {
      status: result.status,
      elapsedMs,
      output: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '',
    };
  };

  const jailFile = () => {
    const jail = path.join(tmp, 'jail.local');
    fs.writeFileSync(jail, '[DEFAULT]\n');
    return jail;
  };

  withProc('disabled — the default — returns at once and starts nothing', () => {
    const { status, elapsedMs } = run({ FAIL2BAN_ENABLED: '' });

    expect(status).toBe(0);
    expect(elapsedMs).toBeLessThan(10000);
    expect(alive('fail2ban-server')).toBe(false);
  });

  withProc('disabled explicitly with "false"', () => {
    const { status } = run({ FAIL2BAN_ENABLED: 'false' });

    expect(status).toBe(0);
    expect(alive('fail2ban-server')).toBe(false);
  });

  withProc('enabled but no generated jail config — skips, leaving no zombie', () => {
    const { status, output, elapsedMs } = run({
      FAIL2BAN_ENABLED: 'true',
      FAIL2BAN_JAIL_PATH: path.join(tmp, 'absent.local'),
    });

    expect(status).toBe(0);
    expect(output).toMatch(/skipping Fail2ban startup/i);
    expect(elapsedMs).toBeLessThan(10000);
    expect(alive('fail2ban-server')).toBe(false);
  });

  withProc('enabled without usable iptables — warns, skips, leaving no zombie', () => {
    // The missing-NET_ADMIN contract, and the reason this is not only about the
    // disabled default: it is a second short-lived path.
    stub('iptables', 'exit 1');

    const { status, output, elapsedMs } = run({
      FAIL2BAN_ENABLED: 'true',
      FAIL2BAN_JAIL_PATH: jailFile(),
    });

    expect(status).toBe(0);
    expect(output).toMatch(/NET_ADMIN/);
    expect(output).toMatch(/nginx continues/);
    expect(elapsedMs).toBeLessThan(10000);
    expect(alive('fail2ban-server')).toBe(false);
  });

  withProc('enabled and starting — returns at once, daemon keeps running', async () => {
    // The one path that must still background something. It has to return
    // promptly or entrypoint.sh would never reach `exec nginx`.
    stub('iptables', 'exit 0');
    // Touches a marker then sleeps: the marker is unambiguous evidence the
    // daemon was actually started, and the odd sleep length keeps the process
    // identifiable without matching anything else in the container.
    const marker = path.join(tmp, 'daemon-started');
    stub('fail2ban-server', `: > "${marker}"\nexec sleep 3117`);

    const { status, elapsedMs } = run({
      FAIL2BAN_ENABLED: 'true',
      FAIL2BAN_JAIL_PATH: jailFile(),
    });

    expect(status).toBe(0);
    // Returned without waiting on a 30s daemon. The bound is far below that
    // lifetime rather than tuned to how fast the script is, so this fails on
    // "it blocked" and not on a slow machine.
    expect(elapsedMs).toBeLessThan(10000);

    // The daemon starts in a subshell that outlives the script, so its arrival
    // is asynchronous by construction — polled for, with a generous bound,
    // rather than assumed to have happened by the time the script returned.
    // (Its "Starting Fail2ban" log line is written by that same subshell and is
    // asynchronous for the same reason, so it is not asserted here.)
    let started = false;
    for (let i = 0; i < 50 && !started; i++) {
      started = fs.existsSync(marker);
      if (!started) await new Promise((r) => setTimeout(r, 100));
    }
    expect(started).toBe(true);
    expect(alive('sleep 3117')).toBe(true);
  }, 20000);

  withProc('a skipped Fail2ban is never fatal', () => {
    stub('iptables', 'exit 1');
    const cases = [
      { FAIL2BAN_ENABLED: '' },
      { FAIL2BAN_ENABLED: 'true' },
      { FAIL2BAN_ENABLED: 'true', FAIL2BAN_JAIL_PATH: jailFile() },
    ];
    for (const env of cases) {
      expect(run(env).status).toBe(0);
    }
  });
});
