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
  const REQUIRED_EVENTS = [
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
    expect(invocation).toMatch(/--include\s+'\\\.conf\$'/);
  });

  it('matches only entries whose final name ends in .conf', () => {
    const pattern = (invocation.match(/--include\s+'([^']+)'/) || [])[1];
    expect(pattern).toBe('\\.conf$');

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
    expect(codeOnly).toMatch(/mkdir -p "\$CUSTOM_NGINX_CONFIG_FILES_PATH"/);
    expect(codeOnly).not.toMatch(/\$CUSTOM_NGINX_CONFIG_FILES_PATH(?!")/);
  });
});

describe('reload.sh — duplicate-event coalescing', () => {
  // One logical update can emit two events for the same name: creating a
  // config emits CREATE then CLOSE_WRITE, and an `ln -sf` repoint emits
  // DELETE then CREATE. The settle sleep does not discard those — they stay
  // queued in the pipe and would each drive their own reload on a later pass.
  it('drains queued events between the settle sleep and the reload', () => {
    expect(codeOnly).toMatch(
      /sleep 1\s*\n\s*while read -r -t 0\.1 _ _ _; do :; done\s*\n\s*nginx -s reload/
    );
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
