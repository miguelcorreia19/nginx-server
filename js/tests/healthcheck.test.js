// The container health policy (healthcheck.sh).
//
// These are behaviour tests, not source assertions: each case runs the real
// script and reads its exit status and output. The script's documented
// test-override variables (HEALTHCHECK_NGINX_PID_FILE, ..._WATCHER_PID_FILE,
// ..._CRONTAB, ..._PROC) point it at a temp tree, so every state — including a
// zombie watcher, which is otherwise awkward to produce on demand — is built
// as fixture data rather than simulated by stubbing the checks away. Only
// `nginx` itself is a PATH stub, since the suite has no nginx to run.
//
// The policy under test:
//   nginx           alive and holding a valid configuration -> required
//   reload watcher  alive                                   -> required
//   crond           alive                                   -> required ONLY when
//                                                              renewal is registered
//   Fail2ban        never consulted

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const HEALTHCHECK = path.join(root, 'healthcheck.sh');

// Far above any real PID, so `kill -0` can never find a process for it.
const UNREACHABLE_PID = 2147483647;
const RENEWAL_LINE =
  '0 5 * * * /bin/bash /usr/local/bin/certbot_renew.sh >> /var/log/certbot/certbot_renew.log\n';
const PERIODIC_ONLY = '*/15\t*\t*\t*\t*\trun-parts /etc/periodic/15min\n';

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'healthcheck-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// One entry in a fake /proc. `state` is the single letter Linux reports in
// /proc/<pid>/status ('S' sleeping, 'R' running, 'Z' zombie). The kernel stores
// argv NUL-separated in /proc/<pid>/cmdline and leaves it *empty* for a zombie,
// which is what makes a zombie distinguishable from a live process.
const procEntry = (procRoot, pid, { state = 'S', comm = 'sh', argv = ['sh'] } = {}) => {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status'), `Name:\t${comm}\nState:\t${state} (state)\n`);
  fs.writeFileSync(path.join(dir, 'comm'), `${comm}\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), state === 'Z' ? '' : `${argv.join('\0')}\0`);
};

const WATCHER_ARGV = ['/bin/bash', '/usr/local/bin/reload.sh'];

// The nginx stub reports on stderr the way the real binary does — including
// its success message — so a check that read stdout, or treated any stderr
// output as failure, would not pass here either.
const nginxStub = (valid) => {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const body = valid
    ? 'echo "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok" >&2\n' +
      'echo "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2\nexit 0\n'
    : 'echo "nginx: [emerg] unknown directive \\"bogus\\" in /etc/nginx/conf.d/80/broken.conf:1" >&2\n' +
      'echo "nginx: configuration file /etc/nginx/nginx.conf test failed" >&2\nexit 1\n';
  fs.writeFileSync(path.join(bin, 'nginx'), `#!/bin/sh\n${body}`);
  fs.chmodSync(path.join(bin, 'nginx'), 0o755);
  return bin;
};

// Assembles a whole container state and runs the real script against it.
// Defaults describe a healthy http-mode deployment: nginx up and valid, watcher
// alive, no renewal registered and therefore no crond.
const run = ({
  nginxPid = process.pid,
  nginxValid = true,
  watcherPid = 4242,
  watcher = { state: 'S', comm: 'reload.sh', argv: WATCHER_ARGV },
  crontab = PERIODIC_ONLY,
  processes = [],
} = {}) => {
  const procRoot = path.join(tmp, 'proc');
  fs.mkdirSync(procRoot, { recursive: true });

  if (watcher) procEntry(procRoot, watcherPid, watcher);
  for (const p of processes) procEntry(procRoot, p.pid, p);

  const nginxPidFile = path.join(tmp, 'nginx.pid');
  if (nginxPid !== null) fs.writeFileSync(nginxPidFile, `${nginxPid}\n`);

  const watcherPidFile = path.join(tmp, 'reload.pid');
  if (watcherPid !== null) fs.writeFileSync(watcherPidFile, `${watcherPid}\n`);

  const crontabFile = path.join(tmp, 'crontab');
  if (crontab !== null) fs.writeFileSync(crontabFile, crontab);

  const result = spawnSync('bash', [HEALTHCHECK], {
    encoding: 'utf8',
    env: {
      PATH: `${nginxStub(nginxValid)}:${process.env.PATH}`,
      HEALTHCHECK_NGINX_PID_FILE: nginxPidFile,
      HEALTHCHECK_WATCHER_PID_FILE: watcherPidFile,
      HEALTHCHECK_CRONTAB: crontabFile,
      HEALTHCHECK_PROC: procRoot,
    },
  });

  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe('healthcheck — nginx', () => {
  it('passes when nginx is alive and its configuration is valid', () => {
    expect(run().status).toBe(0);
  });

  it('says nothing at all when everything is healthy', () => {
    // A check that printed on every pass would fill the health log with
    // identical lines and bury the one result an operator needs to read.
    expect(run().output).toBe('');
  });

  it('fails when the nginx master process is gone', () => {
    const { status, output } = run({ nginxPid: UNREACHABLE_PID });
    expect(status).not.toBe(0);
    expect(output).toMatch(/nginx is not running/);
  });

  it('fails when the pidfile is empty rather than reporting healthy', () => {
    // `kill -0 ""` exits 0 in a shell, so a naive check would call an empty
    // pidfile healthy — the exact state nginx leaves behind when it is killed
    // before it finishes writing one.
    const { status, output } = run({ nginxPid: '' });
    expect(status).not.toBe(0);
    expect(output).toMatch(/nginx is not running/);
  });

  it('fails when the pidfile is missing entirely', () => {
    const { status, output } = run({ nginxPid: null });
    expect(status).not.toBe(0);
    expect(output).toMatch(/nginx is not running/);
  });

  it('fails when the configuration is invalid', () => {
    expect(run({ nginxValid: false }).status).not.toBe(0);
  });

  it('preserves the nginx -t diagnostic instead of discarding it', () => {
    // This is the regression the runtime audit found: the old command ran
    // `nginx -t >/dev/null 2>&1`, so `docker inspect`'s recorded health Output
    // was an empty string for the one failure that most needs explaining.
    const { output } = run({ nginxValid: false });
    expect(output).toMatch(/nginx configuration is invalid/);
    expect(output).toMatch(/unknown directive "bogus"/);
    expect(output).toMatch(/conf\.d\/80\/broken\.conf:1/);
  });

  it('makes no network request', () => {
    const source = fs.readFileSync(HEALTHCHECK, 'utf8');
    expect(source).not.toMatch(/\b(curl|wget|nc|netcat)\b/);
  });
});

describe('healthcheck — reload watcher', () => {
  it('passes when the watcher process is alive', () => {
    expect(run().status).toBe(0);
  });

  it('fails when the watcher PID no longer exists', () => {
    const { status, output } = run({ watcher: null });
    expect(status).not.toBe(0);
    expect(output).toMatch(/reload watcher is not running/);
  });

  it('fails when the pidfile is missing', () => {
    const { status, output } = run({ watcherPid: null });
    expect(status).not.toBe(0);
    expect(output).toMatch(/reload watcher is not running/);
  });

  it('fails on a zombie watcher, which still answers kill -0', () => {
    // The reachable failure: reload.sh exiting early leaves `Z [reload.sh]`
    // parented to nginx, and a liveness test built on `kill -0` alone reports
    // that as healthy. Observed in the runtime audit with an option-like
    // CUSTOM_NGINX_CONFIG_FILES_PATH.
    const { status, output } = run({
      watcher: { state: 'Z', comm: 'reload.sh', argv: WATCHER_ARGV },
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/reload watcher is not running/);
  });

  it('fails when an unrelated process has taken over the recorded PID', () => {
    // Container PIDs are small and restart from 1, so a recycled PID is not a
    // theoretical concern. argv still identifies the real watcher.
    const { status, output } = run({
      watcher: { state: 'S', comm: 'nginx', argv: ['nginx: worker process'] },
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/reload watcher is not running/);
  });

  it('does not accept any other reload.sh — only the recorded PID', () => {
    // A different live watcher elsewhere in the process table must not cover
    // for the one this container actually launched.
    const { status } = run({
      watcher: null,
      processes: [{ pid: 999, state: 'S', comm: 'reload.sh', argv: WATCHER_ARGV }],
    });
    expect(status).not.toBe(0);
  });
});

describe('healthcheck — certificate renewal and crond', () => {
  const CROND = { pid: 77, state: 'S', comm: 'crond', argv: ['crond', '-bS', '-c', '/var/spool/cron/crontabs'] };

  it('passes with no renewal registered and no crond running', () => {
    // http-mode, custom-certificate-only and development deployments never
    // register renewal and must not be asked to run cron.
    const { status, output } = run({ crontab: PERIODIC_ONLY, processes: [] });
    expect(status).toBe(0);
    expect(output).toBe('');
  });

  it('passes with no crontab file at all', () => {
    expect(run({ crontab: null, processes: [] }).status).toBe(0);
  });

  it('passes when renewal is registered and crond is running', () => {
    const { status, output } = run({
      crontab: PERIODIC_ONLY + RENEWAL_LINE,
      processes: [CROND],
    });
    expect(status).toBe(0);
    expect(output).toBe('');
  });

  it('fails when renewal is registered but crond is gone', () => {
    const { status, output } = run({
      crontab: PERIODIC_ONLY + RENEWAL_LINE,
      processes: [],
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/certificate renewal is configured but crond is not running/);
  });

  it('fails when renewal is registered and crond is a zombie', () => {
    const { status, output } = run({
      crontab: PERIODIC_ONLY + RENEWAL_LINE,
      processes: [{ ...CROND, state: 'Z' }],
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/crond is not running/);
  });

  it('is not satisfied by an unrelated process that merely mentions crond', () => {
    // The check matches the process name exactly rather than searching command
    // lines, so a renewal script or a shell naming crond cannot stand in for it.
    const { status } = run({
      crontab: PERIODIC_ONLY + RENEWAL_LINE,
      processes: [{ pid: 88, state: 'S', comm: 'bash', argv: ['/bin/bash', '-c', 'crond -bS'] }],
    });
    expect(status).not.toBe(0);
  });

  it('does not require crond just because certbot_renew.sh exists in the image', () => {
    // The trigger is the registered crontab entry, not the script's presence:
    // the file ships in every image, renewal does not run in every deployment.
    expect(fs.existsSync(path.join(root, 'certbot_renew.sh'))).toBe(true);
    expect(run({ crontab: PERIODIC_ONLY, processes: [] }).status).toBe(0);
  });
});

describe('healthcheck — Fail2ban stays outside health', () => {
  const withRenewal = { crontab: PERIODIC_ONLY + RENEWAL_LINE };
  const CROND = { pid: 77, state: 'S', comm: 'crond', argv: ['crond'] };

  it('is healthy with Fail2ban absent', () => {
    expect(run({ ...withRenewal, processes: [CROND] }).status).toBe(0);
  });

  it('is healthy with Fail2ban running', () => {
    const { status } = run({
      ...withRenewal,
      processes: [CROND, { pid: 90, state: 'S', comm: 'fail2ban-server', argv: ['fail2ban-server', '-xf', 'start'] }],
    });
    expect(status).toBe(0);
  });

  it('is healthy with a dead (zombie) Fail2ban', () => {
    const { status } = run({
      ...withRenewal,
      processes: [CROND, { pid: 90, state: 'Z', comm: 'fail2ban.sh', argv: [] }],
    });
    expect(status).toBe(0);
  });

  it('never consults Fail2ban state at all', () => {
    const source = fs.readFileSync(HEALTHCHECK, 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/fail2ban/i);
  });
});

describe('healthcheck — wiring and process model', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const entrypoint = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
  const source = fs.readFileSync(HEALTHCHECK, 'utf8');

  it('is the command the Dockerfile actually runs', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[^\n]*\\\n\s*CMD \["healthcheck\.sh"\]/);
  });

  it('is installed and made executable by the image', () => {
    expect(dockerfile).toMatch(/COPY healthcheck\.sh \/usr\/local\/bin\//);
    expect(dockerfile).toMatch(/chmod 0755 [^\n]*\/usr\/local\/bin\/healthcheck\.sh/);
  });

  it('reads the watcher PID that entrypoint.sh records', () => {
    // The two halves of the mechanism have to agree on one path.
    expect(entrypoint).toMatch(/echo \$! > \/run\/nginx-server\/reload\.pid/);
    expect(source).toMatch(/\/run\/nginx-server\/reload\.pid/);
  });

  it('observes only — it never restarts a helper or signals nginx', () => {
    // The health model deliberately has no recovery behaviour: nginx stays
    // PID 1, nothing is supervised, and an unhealthy container keeps running.
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\bkill\s+-(?!0\b)/);
    expect(code).not.toMatch(/\bpkill\b|\bnginx -s\b|\breload\.sh\s*&|\bcrond\s+-/);
  });
});
