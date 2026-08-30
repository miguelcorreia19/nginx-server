// The nginx config-reload watcher contract (reload.sh).
//
// reload.sh used to watch `close_write` only, which sees a config written in
// place and nothing else. Every other way the effective configuration changes
// emits no CLOSE_WRITE at all: a rename into the directory emits MOVED_TO, a
// move out emits MOVED_FROM, a removal emits DELETE, and `ln -sf` emits CREATE
// (or DELETE then CREATE when it repoints an existing link). All of those were
// silently missed. With no filename filter it also reloaded on editor debris —
// `.site.conf.swp`, `site.conf~`, `site.tmp`, vim's numbered `4913` probe.
//
// These are *source* assertions, in the same style as
// build-startup-assertions.test.js and logging-improvements.test.js: they pin
// the invocation the script is supposed to make, so the flags cannot be
// silently dropped or reordered into something weaker. They deliberately do
// NOT claim to prove inotify's runtime semantics — a string match cannot
// establish which events the kernel delivers. That half was established by
// running this script against this image's runtime (observed with
// inotify-tools 4.23.9.0 on Alpine 3.24) with `nginx` stubbed by a counter;
// the observed sequences are recorded in the comments in reload.sh, and the
// per-event rationale below exists so a future edit has to argue with the
// evidence rather than guess.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const reloadSh = fs.readFileSync(path.join(root, 'reload.sh'), 'utf8');

// Strip comment lines before asserting on the command. reload.sh documents
// every watched event by name in the block above the invocation, so without
// this a comment mentioning `moved_to` would satisfy an assertion that the
// flag is actually passed.
const codeOnly = reloadSh
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

// The inotifywait command, line continuations folded away, from the line that
// starts with the binary through the line that pipes it into the read loop.
// Anchoring on `^inotifywait` skips the `pkill inotifywait` inside the trap.
const invocationMatch = codeOnly.match(/^inotifywait[\s\S]*?\|$/m);
const invocation = (invocationMatch ? invocationMatch[0] : '').replace(/\\\n\s*/g, ' ');

describe('reload.sh — watcher invocation', () => {
  it('pipes a single monitoring inotifywait into the reload loop', () => {
    expect(invocationMatch).not.toBeNull();
    expect(invocation).toMatch(/\binotifywait\b.*\s-m\b/);
  });
});

describe('reload.sh — watched event mask', () => {
  // Every event here earns its place from an observed sequence; see reload.sh.
  const CHILD_EVENTS = [
    // In-place write to an existing config — the only event it emits.
    'close_write',
    // `ln -sf` creating a link emits CREATE and no CLOSE_WRITE, so a symlink
    // swap is invisible without this.
    'create',
    // A config removed, and the first half of an `ln -sf` repoint.
    'delete',
    // A config renamed in; the atomic temp-file-then-rename deployment ends
    // here, and this is the only event carrying the final name.
    'moved_to',
    // A config moved out: the effective configuration changed even though
    // nothing was written.
    'moved_from',
  ];

  // These are about the watched directories themselves, not their contents.
  // inotify follows the inode, so `rm -rf <dir> && mkdir <dir>` leaves the
  // watch on the directory that is gone while an unwatched one takes its
  // place — and inotifywait does not exit, because the other directory still
  // has a live watch. Without these the watcher went on running with half its
  // coverage silently missing.
  const SELF_EVENTS = ['delete_self', 'move_self', 'unmount'];

  const REQUIRED_EVENTS = [...CHILD_EVENTS, ...SELF_EVENTS];

  it.each(REQUIRED_EVENTS)('subscribes to %s', (event) => {
    expect(invocation).toMatch(new RegExp(`-e\\s+${event}\\b`));
  });

  it('no longer watches close_write alone', () => {
    const subscribed = [...invocation.matchAll(/-e\s+(\w+)/g)].map(([, e]) => e);
    expect(subscribed).toEqual(expect.arrayContaining(REQUIRED_EVENTS));
    expect(subscribed.length).toBeGreaterThan(1);
  });

  it('subscribes to nothing beyond the required set', () => {
    // Not completeness for its own sake: `modify`, `open`, `access` and
    // `close_nowrite` all fire repeatedly during a single ordinary write and
    // would turn one save into a burst of reloads.
    const subscribed = [...invocation.matchAll(/-e\s+(\w+)/g)].map(([, e]) => e);
    expect([...new Set(subscribed)].sort()).toEqual([...REQUIRED_EVENTS].sort());
  });

  it('stays non-recursive', () => {
    expect(invocation).not.toMatch(/(^|\s)(-r|--recursive)(\s|$)/);
  });
});

describe('reload.sh — .conf filename filter', () => {
  it('filters at inotifywait rather than in the shell loop', () => {
    expect(invocation).toMatch(/--include\s+'\(\\\.conf\|\/\)\$'/);
  });

  it('matches config files and the watched directories, and nothing else', () => {
    const pattern = (invocation.match(/--include\s+'([^']+)'/) || [])[1];
    expect(pattern).toBe('(\\.conf|/)$');

    // inotifywait's --include is an extended regular expression matched
    // against the event's full path, so exercising it with a JS RegExp on
    // full paths is a faithful check of what it accepts and rejects.
    const re = new RegExp(pattern);
    for (const dir of ['/home/nginx/sites/', '/home/nginx/configs/']) {
      expect(re.test(`${dir}site.conf`)).toBe(true);
      expect(re.test(`${dir}default.conf`)).toBe(true);
      expect(re.test(`${dir}.site.conf.swp`)).toBe(false);
      expect(re.test(`${dir}site.conf~`)).toBe(false);
      expect(re.test(`${dir}.site.conf.tmp`)).toBe(false);
      expect(re.test(`${dir}site.tmp`)).toBe(false);
      expect(re.test(`${dir}4913`)).toBe(false);
      expect(re.test(`${dir}notes.txt`)).toBe(false);

      // The `/$` half. A self-event names the watched directory itself, which
      // inotifywait prints with its trailing slash — `\.conf$` alone rejected
      // those, so delete_self would have been filtered out before the loop
      // ever saw it. A child path never ends in a slash, so this admits the
      // directory events and nothing more.
      expect(re.test(dir)).toBe(true);
    }
  });

  it('is one global pattern, not anchored to either watched directory', () => {
    // --include is matched against the full path, so a pattern carrying a
    // directory prefix would silently filter events from the *other* watched
    // directory out of existence. It must match on the suffix alone.
    const includes = [...invocation.matchAll(/--include[i]?\s+'([^']+)'/g)];
    expect(includes).toHaveLength(1);
    const [, pattern] = includes[0];
    expect(pattern).not.toMatch(/\/home\/nginx/);
    expect(pattern).not.toMatch(/CUSTOM_NGINX_CONFIG_FILES_PATH/);
  });
});

describe('reload.sh — watched directories', () => {
  it('watches the mounted sites directory', () => {
    expect(invocation).toMatch(/"\/home\/nginx\/sites\/"/);
  });

  it('watches the operator-configurable custom config directory', () => {
    expect(invocation).toMatch(/"\$CUSTOM_NGINX_CONFIG_FILES_PATH"/);
  });

  it('quotes the custom path everywhere it is used', () => {
    // An operator-supplied path may contain spaces or glob characters;
    // unquoted it would word-split into several bogus watch targets (or
    // silently expand) instead of one directory.
    expect(codeOnly).toMatch(/mkdir -p -- "\$CUSTOM_NGINX_CONFIG_FILES_PATH"/);
    expect(codeOnly).not.toMatch(/\$CUSTOM_NGINX_CONFIG_FILES_PATH(?!")/);
  });
});

// Quoting and end-of-options guarding solve two different halves of the same
// problem, and only the first was ever in place here. Quoting stops the *shell*
// from word-splitting the value; it does nothing about the command's own option
// parser, so a CUSTOM_NGINX_CONFIG_FILES_PATH beginning with `-` was still read
// as flags by both commands this script hands it to. Observed against this
// image with `CUSTOM_NGINX_CONFIG_FILES_PATH=-badcfg`: `mkdir` dumped its usage,
// `inotifywait` answered `unrecognized option: b`, reload.sh exited, and the
// container went on serving traffic and reporting healthy with automatic reload
// permanently gone.
//
// The same guard the Node layer already applies to every operator-supplied path
// that reaches a command (mapCustomNginxConf in js/utils.js; the backup mkdir
// and copies in js/letsencrypt/).
describe('reload.sh — end-of-options guarding for the operator path', () => {
  it('ends mkdir option parsing before the directory operand', () => {
    expect(codeOnly).toMatch(/mkdir\s+-p\s+--\s+"\$CUSTOM_NGINX_CONFIG_FILES_PATH"/);
  });

  it('ends inotifywait option parsing before the watched directories', () => {
    // Pins `--` immediately ahead of both operands: dropping it, or letting a
    // path drift back in front of it, fails here.
    expect(invocation).toMatch(
      /(^|\s)--\s+"\/home\/nginx\/sites\/"\s+"\$CUSTOM_NGINX_CONFIG_FILES_PATH"\s*\|?$/
    );
  });

  it('places the separator after the option list, not inside it', () => {
    // `--` before `--include` would turn the pattern into a watch target and
    // drop the filter entirely, which is a worse failure than the one being
    // fixed. `--include` itself starts with two dashes, so the separator is
    // matched as a standalone token rather than by substring.
    const include = invocation.indexOf("--include");
    const separator = invocation.search(/(^|\s)--(\s|$)/);
    expect(include).toBeGreaterThan(-1);
    expect(separator).toBeGreaterThan(include);
  });

  it('guards every command the operator path is passed to', () => {
    // Both call sites, so a future one cannot be added without the guard.
    const uses = [...codeOnly.matchAll(/^.*\$CUSTOM_NGINX_CONFIG_FILES_PATH.*$/gm)]
      .map(([line]) => line);
    expect(uses).toHaveLength(2);
    for (const line of uses) {
      expect(line).toMatch(/(^|\s)--\s/);
    }
  });
});

// The block above pins what the script asks for; this one checks that the ask
// is the right one against the binaries actually present. It is a narrow claim —
// option parsing only — and deliberately not a claim about which inotify events
// the kernel delivers, which no test here establishes (see the file header).
describe('reload.sh — the guarded invocations against the real binaries', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');

  const available = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
  const OPTION_ERROR = /unrecognized option|invalid option|unknown option|illegal option/i;

  let workdir;
  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-guard-'));
  });
  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('mkdir needs the separator to treat an option-like path as a directory', () => {
    const bare = spawnSync('mkdir', ['-p', '-badcfg'], { cwd: workdir, encoding: 'utf8' });
    expect(bare.status).not.toBe(0);
    expect(`${bare.stderr}`).toMatch(OPTION_ERROR);

    const guarded = spawnSync('mkdir', ['-p', '--', '-badcfg'], { cwd: workdir, encoding: 'utf8' });
    expect(guarded.status).toBe(0);
    expect(fs.statSync(path.join(workdir, '-badcfg')).isDirectory()).toBe(true);
  });

  // inotify-tools is present in the runtime image but not on every machine the
  // suite runs on (it is absent from the GitHub runner and from macOS), so this
  // reports as skipped rather than failing where the binary does not exist.
  const withInotify = available('inotifywait') ? it : it.skip;

  withInotify('inotifywait needs the separator to treat an option-like path as a watch target', () => {
    fs.mkdirSync(path.join(workdir, '-badcfg'));
    const args = ['-t', '1', '-e', 'close_write', '--include', '\\.conf$'];

    const bare = spawnSync('inotifywait', [...args, '-badcfg'], { cwd: workdir, encoding: 'utf8' });
    expect(`${bare.stderr}`).toMatch(OPTION_ERROR);

    const guarded = spawnSync('inotifywait', [...args, '--', '-badcfg'], { cwd: workdir, encoding: 'utf8' });
    expect(`${guarded.stderr}`).not.toMatch(OPTION_ERROR);
    expect(`${guarded.stderr}`).toMatch(/Watches established/);
  });
});

describe('reload.sh — duplicate-event coalescing', () => {
  // One logical update can emit two events for the same name: creating a
  // config emits CREATE then CLOSE_WRITE, and an `ln -sf` repoint emits
  // DELETE then CREATE. The settle sleep does not discard those — they stay
  // queued in the pipe and would each drive their own reload on a later pass.
  it('drains queued events between the settle sleep and the reload', () => {
    expect(codeOnly).toMatch(
      /sleep 1\s*\n\s*while read -r -t 0\.1 [\s\S]*?\n\s*done\s*\n\s*nginx -s reload/
    );
  });

  it('inspects what it drains instead of discarding it blind', () => {
    // The drain used to be `while read ... do :; done`. `rm -rf <watched-dir>`
    // unlinks the configs first, so the DELETE of the last `.conf` arrives
    // before the directory's own DELETE_SELF — the child event starts the
    // reload cycle and the blind drain swallowed the event that says the watch
    // is gone. Every empty-directory test passed while runtime did not.
    const drain = codeOnly.match(/while read -r -t 0\.1[\s\S]*?\n\t\tdone/);
    expect(drain).not.toBeNull();
    expect(drain[0]).toMatch(/DELETE_SELF/);
    expect(drain[0]).toMatch(/watch_lost/);
  });

  it('drains strictly before the reload, never after it', () => {
    // Ordering is the whole safety argument: nginx re-reads the directory
    // after the drain, so every drained event is still accounted for by the
    // config it then loads. Draining *after* the reload would discard changes
    // made since nginx read the config, and they would never be applied.
    const drain = codeOnly.indexOf('while read -r -t 0.1');
    const reload = codeOnly.indexOf('nginx -s reload');
    expect(drain).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(-1);
    expect(drain).toBeLessThan(reload);
  });
});

describe('reload.sh — existing reload behaviour preserved', () => {
  it('still reloads with the same nginx command', () => {
    expect(codeOnly).toMatch(/\bnginx -s reload\b/);
  });

  it('still reports success and failure from the reload exit status', () => {
    expect(codeOnly).toMatch(/nginx -s reload\s*\n\s*RELOAD_RC=\$\?/);
    expect(codeOnly).toMatch(/if \[ "\$RELOAD_RC" -eq 0 \]/);
    expect(codeOnly).toMatch(/Nginx reloaded successfully/);
    expect(codeOnly).toMatch(/ERROR: nginx reload failed/);
  });

  it('adds no rollback or restoration of its own', () => {
    // A delete or move-out can leave the on-disk config invalid. The contract
    // is nginx's own: it refuses the bad config, the failure is logged, and
    // the running config stays active. The watcher never repairs anything.
    expect(codeOnly).not.toMatch(/\bnginx -s reload\b.*\|\|/);
    expect(codeOnly).not.toMatch(/\b(cp|mv|rm|ln)\b/);
  });

  it('keeps the trap that stops the watcher cleanly on a signal', () => {
    expect(codeOnly).toMatch(/trap '.*pkill inotifywait.*' TERM INT/);
  });
});

// ──────────────────────────────────────────────
//  Losing a watch is fatal to the watcher
// ──────────────────────────────────────────────
//
// inotify follows the inode, so `rm -rf <dir> && mkdir <dir>` leaves the watch
// on the directory that is gone while an unwatched one stands in its place.
// inotifywait does not exit — the other watched directory still has a live
// watch — so the container went on running with half its coverage missing:
// changes in the replaced directory produced no reload, no error, and a
// healthy container.
//
// These drive the real reload.sh against the real inotify-tools, because the
// thing under test is what the kernel delivers and how the script reacts to
// it — a source assertion could not establish either. They skip where the
// binary or the image's own watched directory is genuinely absent (the GitHub
// runner has neither); the source assertions above stay portable.

describe('reload.sh — a lost watch stops the watcher', () => {
  const os = require('os');
  const { spawn, spawnSync } = require('child_process');

  const hasInotify = spawnSync('sh', ['-c', 'command -v inotifywait']).status === 0;
  const hasSitesDir = fs.existsSync('/home/nginx/sites');
  const runnable = hasInotify && hasSitesDir;
  const withWatcher = runnable ? it : it.skip;

  const WATCH_LOST_RC = 3;
  let tmp;
  let watcher;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-lost-'));
    // `nginx -s reload` must not actually run, or fail loudly, during a test.
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.writeFileSync(path.join(tmp, 'bin', 'nginx'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(tmp, 'bin', 'nginx'), 0o755);
  });

  afterEach(async () => {
    if (watcher) {
      if (watcher.exitCode === null && watcher.signalCode === null) {
        // SIGTERM, not SIGKILL: reload.sh traps it and reaps its own
        // inotifywait. A hard kill skips the trap and leaves that child
        // orphaned, and once its parent is gone nothing in the container reaps
        // it — it lingers as a zombie into the next test.
        watcher.kill('SIGTERM');
        if (!(await closed(watcher, 1500))) {
          watcher.kill('SIGKILL');
          await closed(watcher, 1000);
        }
      }
      // Wait for 'close', not just 'exit': the stdio pipes outlive the process
      // and are what keeps the Jest worker from shutting down cleanly.
      await closed(watcher, 1000);
      watcher.stdout.destroy();
      watcher.stderr.destroy();
      watcher.unref();
    }
    watcher = undefined;
    spawnSync('pkill', ['inotifywait']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Races a promise against a deadline, clearing the timer whichever side wins.
  // Promise.race leaves the losing timer pending, and a still-armed multi-second
  // timeout holds the event loop open long after the test has finished — which
  // is what makes Jest force-exit the worker at the end of the run.
  const within = (promise, ms, onTimeout) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout);
    }, ms);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });

  // Resolves true once the child's stdio has closed, false on timeout.
  const closed = (child, ms) => {
    if (child.stdout.destroyed && child.exitCode !== null) return Promise.resolve(true);
    return within(new Promise((resolve) => child.once('close', () => resolve(true))), ms, false);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Running inotifywait processes. Deliberately not `pgrep -x`: a zombie keeps
  // its /proc entry and pgrep still matches it, so an already-dead process
  // would read as an orphan. Same live-vs-zombie distinction healthcheck.sh
  // makes, and here it is the difference between "still watching" and "gone".
  const liveInotifywaits = () => {
    if (!fs.existsSync('/proc')) return [];
    return fs.readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .filter((pid) => {
        try {
          if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'inotifywait') return false;
          const state = (fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^State:\s*(\S+)/m) || [])[1];
          return state !== 'Z';
        } catch (_) {
          return false;
        }
      });
  };

  // Starts the real script with its operator-configurable directory pointed at
  // a temp path. /home/nginx/sites/ is hard-coded in the script and is the
  // *other* watch — the one that must not save a half-working watcher.
  const startWatcher = async () => {
    const configs = path.join(tmp, 'configs');
    fs.mkdirSync(configs);

    const output = [];
    watcher = spawn('bash', [path.join(root, 'reload.sh')], {
      env: {
        PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
        CUSTOM_NGINX_CONFIG_FILES_PATH: configs,
      },
    });
    watcher.stdout.on('data', (d) => output.push(String(d)));
    watcher.stderr.on('data', (d) => output.push(String(d)));

    const exited = new Promise((resolve) => watcher.on('exit', (code) => resolve(code)));
    // Long enough for inotifywait to report "Watches established".
    await sleep(1500);
    return { configs, output, exited, log: () => output.join('') };
  };

  const alive = () => watcher.exitCode === null && watcher.signalCode === null;

  const exitedWithin = (exited, ms) => within(exited, ms, 'timeout');

  withWatcher('keeps running when a .conf inside a watched directory is deleted', async () => {
    const { configs, exited, log } = await startWatcher();

    fs.writeFileSync(path.join(configs, 'site.conf'), 'x');
    await sleep(4000);
    fs.rmSync(path.join(configs, 'site.conf'));
    await sleep(4000);

    expect(alive()).toBe(true);
    expect(await exitedWithin(exited, 100)).toBe('timeout');
    // and it did treat both as ordinary reload events
    expect(log()).toMatch(/File 'site\.conf' was changed/);
    expect(log()).not.toMatch(/watch for .* was lost/);
  }, 30000);

  withWatcher('exits when a watched directory is deleted', async () => {
    const { configs, exited, log } = await startWatcher();

    fs.rmSync(configs, { recursive: true, force: true });

    expect(await exitedWithin(exited, 8000)).toBe(WATCH_LOST_RC);
    expect(log()).toMatch(/watch for .* was lost/);
  }, 30000);

  withWatcher('exits when a watched directory holding configs is deleted', async () => {
    // The realistic shape, and the one an empty-directory test misses:
    // `rm -rf` unlinks the configs first, so the DELETE of the last `.conf`
    // arrives before the directory's own DELETE_SELF. That child event starts
    // a reload cycle, and the cycle's drain would swallow the DELETE_SELF
    // behind it — which is exactly what happened at runtime while every
    // empty-directory test passed.
    const { configs, exited, log } = await startWatcher();
    fs.writeFileSync(path.join(configs, 'proxy.conf'), 'x');
    await sleep(4000);

    fs.rmSync(configs, { recursive: true, force: true });

    expect(await exitedWithin(exited, 10000)).toBe(WATCH_LOST_RC);
    expect(log()).toMatch(/watch for .* was lost/);
  }, 40000);

  withWatcher('exits when a watched directory is moved away', async () => {
    const { configs, exited, log } = await startWatcher();

    fs.renameSync(configs, path.join(tmp, 'moved-aside'));

    expect(await exitedWithin(exited, 8000)).toBe(WATCH_LOST_RC);
    expect(log()).toMatch(/watch for .* was lost/);
  }, 30000);

  withWatcher('exits when a watched directory is replaced by a new one', async () => {
    // The reported reproduction: the path still exists afterwards, and looks
    // fine, but the watch is on the inode that went away.
    const { configs, exited, log } = await startWatcher();

    fs.rmSync(configs, { recursive: true, force: true });
    fs.mkdirSync(configs);
    fs.writeFileSync(path.join(configs, 'new.conf'), 'x');

    expect(await exitedWithin(exited, 8000)).toBe(WATCH_LOST_RC);
    expect(log()).toMatch(/watch for .* was lost/);
  }, 30000);

  withWatcher('exits even though the other watched directory is still fine', async () => {
    // The whole point: partial coverage is not a working watcher. The script's
    // other watch, /home/nginx/sites/, is untouched here.
    const { configs, exited } = await startWatcher();
    expect(fs.existsSync('/home/nginx/sites')).toBe(true);

    fs.rmSync(configs, { recursive: true, force: true });

    expect(await exitedWithin(exited, 8000)).toBe(WATCH_LOST_RC);
    expect(fs.existsSync('/home/nginx/sites')).toBe(true);
  }, 30000);

  withWatcher('names the directory and the reason in the diagnostic', async () => {
    const { configs, exited, log } = await startWatcher();

    fs.rmSync(configs, { recursive: true, force: true });
    await exitedWithin(exited, 8000);

    expect(log()).toMatch(new RegExp(configs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(log()).toMatch(/DELETE_SELF/);
    expect(log()).toMatch(/automatic nginx reload is no longer reliable/);
    expect(log()).toMatch(/restart the container/i);
  }, 30000);

  withWatcher('leaves no running inotifywait behind', async () => {
    // The reader kills it before exiting; otherwise `wait` would hang and the
    // process would outlive the script.
    const before = liveInotifywaits();
    const { configs, exited } = await startWatcher();
    expect(liveInotifywaits().length).toBe(before.length + 1);

    fs.rmSync(configs, { recursive: true, force: true });
    await exitedWithin(exited, 8000);
    await sleep(500);

    expect(liveInotifywaits()).toEqual(before);
  }, 30000);

  withWatcher('does not restart itself after a lost watch', async () => {
    const { configs, exited, log } = await startWatcher();

    fs.rmSync(configs, { recursive: true, force: true });
    await exitedWithin(exited, 8000);
    fs.mkdirSync(configs);
    await sleep(2000);
    fs.writeFileSync(path.join(configs, 'after.conf'), 'x');
    await sleep(3000);

    expect(alive()).toBe(false);
    expect(log()).not.toMatch(/File 'after\.conf' was changed/);
  }, 30000);
});

describe('reload.sh — the lost-watch exit path', () => {
  it('reports the failure through the exit status, not just the log', () => {
    // `exit` inside the event loop ends only its subshell — the loop is the
    // reader of a backgrounded pipeline — so the status has to be carried out
    // through the join before it can end this script.
    expect(codeOnly).toMatch(/WATCH_LOST_RC=3/);
    expect(codeOnly).toMatch(/exit "\$WATCH_LOST_RC"/);
    expect(codeOnly).toMatch(/wait "\$WATCH_PID"\s*\n\s*WATCH_RC=\$\?/);
    expect(codeOnly).toMatch(/if \[ "\$WATCH_RC" -eq "\$WATCH_LOST_RC" \]/);
  });

  it('reaps inotifywait before exiting, not after', () => {
    // After would be unreachable: the join waits for the whole pipeline, so a
    // surviving inotifywait hangs the script instead of ending it.
    const handler = codeOnly.match(/watch_lost\(\) \{[\s\S]*?\n\}/);
    expect(handler).not.toBeNull();
    const kill = handler[0].indexOf('pkill inotifywait');
    const exit = handler[0].indexOf('exit "$WATCH_LOST_RC"');
    expect(kill).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(kill);
  });

  it('reaches the failure path from both the arriving event and the drain', () => {
    // Two call sites, one handler — so a future edit cannot fix one and leave
    // the other silently discarding the event.
    const calls = (codeOnly.match(/watch_lost "\$\w+" "\$\w+"/g) || []);
    expect(calls).toHaveLength(2);
  });

  it('adds no polling, re-watching or respawn loop', () => {
    // The lifecycle policy is unchanged: nothing here supervises anything.
    expect(codeOnly).not.toMatch(/\bwhile\s+true\b/);
    expect(codeOnly).not.toMatch(/\bmkdir\b[^\n]*\$path/);
    // exactly one inotifywait invocation, still not recursive
    expect((codeOnly.match(/^inotifywait /gm) || []).length).toBe(1);
    expect(invocation).not.toMatch(/(^|\s)(-r|--recursive)(\s|$)/);
  });
});
