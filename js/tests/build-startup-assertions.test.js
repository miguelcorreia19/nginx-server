// Regression tests: ensure that runtime package installation was removed from
// entrypoint.sh (it bloats startup time and is non-deterministic) and that the
// Dockerfile installs dependencies at build time using the lockfile.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const entrypoint = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
const entrypointJs = fs.readFileSync(path.join(root, 'js', 'entrypoint.js'), 'utf8');
const dockerfile  = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

// Split the Dockerfile at the runtime stage boundary (second FROM, no AS).
// The builder stage is used only to produce node_modules; the runtime stage
// is what actually runs in production.
const runtimeStageMatch = dockerfile.search(/^FROM nginx:1\.31\.4-alpine3\.24\s*$/m);
const runtimeStage = runtimeStageMatch >= 0 ? dockerfile.slice(runtimeStageMatch) : dockerfile;

// Strip comment lines so assertions on package names are not tripped by
// documentation comments that mention removed packages (e.g. "git: not needed").
// Word-boundary patterns (\b) still ensure filename prefixes like
// "certbot_renew.sh" don't satisfy a \bcertbot\b check.
const runtimeNoComments = runtimeStage.split('\n')
  .filter(line => !line.trim().startsWith('#'))
  .join('\n');

describe('entrypoint.sh — no runtime package installation', () => {
  it('does not call npm install at startup', () => {
    expect(entrypoint).not.toMatch(/\bnpm\s+install\b/);
  });

  it('does not call npm i (shorthand) at startup', () => {
    expect(entrypoint).not.toMatch(/\bnpm\s+i\b/);
  });

  it('does not call npm ci at startup', () => {
    expect(entrypoint).not.toMatch(/\bnpm\s+ci\b/);
  });
});

describe('Dockerfile — build-time dependency install', () => {
  it('installs Node dependencies with npm ci at build time', () => {
    expect(dockerfile).toMatch(/RUN.*npm ci/);
  });

  it('uses --omit=dev to keep dev dependencies out of the production image', () => {
    expect(dockerfile).toMatch(/npm ci.*--omit=dev/);
  });

  it('copies package files in a separate layer before the application source', () => {
    const pkgCopyIdx  = dockerfile.indexOf('COPY js/package');
    const npmCiIdx    = dockerfile.indexOf('npm ci');
    const srcCopyIdx  = dockerfile.indexOf('COPY js/ /home/scripts/js/');
    expect(pkgCopyIdx).toBeGreaterThan(-1);
    expect(npmCiIdx).toBeGreaterThan(pkgCopyIdx);
    expect(srcCopyIdx).toBeGreaterThan(npmCiIdx);
  });

  it('uses the package-lock.json (package*.json glob) for deterministic installs', () => {
    expect(dockerfile).toMatch(/COPY js\/package\*\.json/);
  });
});

describe('Dockerfile — multi-stage build isolates build tools from runtime', () => {
  it('has a builder stage (node-builder) for npm ci', () => {
    expect(dockerfile).toMatch(/FROM nginx:1\.31\.4-alpine3\.24 AS node-builder/);
  });

  it('copies pre-built node_modules from the builder stage', () => {
    expect(runtimeStage).toMatch(/COPY --from=node-builder.*node_modules/);
  });

  it('does not install npm in the runtime stage (build-only tool)', () => {
    // npm may appear in the builder stage — check only the runtime stage
    expect(runtimeStage).not.toMatch(/apk add[^\n]*\bnpm\b/);
  });
});

describe('Dockerfile — required runtime packages are installed', () => {
  // apk add uses multi-line backslash continuations; packages land on their
  // own lines. runtimeNoComments has comment lines stripped so package names
  // in documentation comments don't satisfy these checks.
  it('installs certbot (Let\'s Encrypt certificate management)', () => {
    expect(runtimeNoComments).toMatch(/\bcertbot\b/);
  });

  it('installs openssl (self-signed cert generation in dev/fallback modes)', () => {
    expect(runtimeNoComments).toMatch(/\bopenssl\b/);
  });

  it('installs nodejs (runs entrypoint.js and all mode-handler scripts)', () => {
    expect(runtimeNoComments).toMatch(/\bnodejs\b/);
  });

  it('installs inotify-tools (inotifywait used by reload.sh)', () => {
    expect(runtimeNoComments).toMatch(/\binotify-tools\b/);
  });

  it('installs bash (all shell scripts require bash for pushd/trap/etc.)', () => {
    expect(runtimeNoComments).toMatch(/\bbash\b/);
  });
});

// The project supports one explicit runtime stack rather than an undefined
// range of nginx/Alpine/Certbot versions. The Certbot pin in particular is
// load-bearing: js/letsencrypt/utils.js parses `certbot certificates` output
// and targets the 5.6 format, so an unnoticed Certbot bump is a startup risk,
// not merely a dependency change.
describe('Dockerfile — pinned runtime version contract', () => {
  it('pins the base image to an exact nginx and Alpine version', () => {
    expect(dockerfile).toMatch(/FROM nginx:1\.31\.4-alpine3\.24/);
  });

  it('leaves no floating base tag', () => {
    // nginx:alpine, nginx:1.31-alpine and nginx:alpine3.24 all still let the
    // nginx patch/minor selection drift between rebuilds.
    expect(dockerfile).not.toMatch(/FROM nginx:alpine/);
    expect(dockerfile).not.toMatch(/FROM nginx:[0-9]+\.[0-9]+-alpine/);
    expect(dockerfile).not.toMatch(/FROM nginx:alpine3/);
  });

  it('pins certbot to the exact Alpine package revision the parser targets', () => {
    expect(runtimeNoComments).toMatch(/\bcertbot=5\.6\.0-r0\b/);
  });

  it('does not install certbot unpinned', () => {
    expect(runtimeNoComments).not.toMatch(/^\s*certbot\s*\\?\s*$/m);
  });
});

// What reaches /home/scripts is named explicitly rather than swept in with
// `COPY . /home/scripts/`. The blanket copy shipped the documentation tree,
// .github/, the changelog and any untracked working-tree file the maintainer
// happened to have, plus a second copy of all four helper scripts that missed
// the 0755 normalisation applied to the /usr/local/bin copies.
describe('Dockerfile — the runtime image copies only what it runs', () => {
  it('does not sweep the whole build context into the image', () => {
    expect(runtimeNoComments).not.toMatch(/^COPY \.\s+\/home\/scripts\/?\s*$/m);
  });

  it('copies the Node layer, which entrypoint.sh and certbot_renew.sh both run', () => {
    expect(runtimeNoComments).toMatch(/^COPY js\/ \/home\/scripts\/js\/\s*$/m);
  });

  // js/reconcile.js copies these two back into conf.d/{80,443} on every
  // production startup, so they are the one part of nginx/ the runtime reads.
  it('copies the two default-vhost sources js/reconcile.js restores from', () => {
    expect(runtimeNoComments).toMatch(
      /^COPY nginx\/nginx\.vh\.default\.80\.conf nginx\/nginx\.vh\.default\.443\.conf \/home\/scripts\/nginx\/\s*$/m,
    );
  });

  // The helpers are installed once, in /usr/local/bin, where the chmod below
  // pins their mode. A second copy under /home/scripts would not be executed
  // and would not be mode-normalised.
  it.each(['entrypoint.sh', 'reload.sh', 'certbot_renew.sh', 'fail2ban.sh'])(
    'does not also copy %s into /home/scripts',
    (script) => {
      expect(runtimeNoComments).not.toMatch(new RegExp(`^COPY ${script} /home/scripts`, 'm'));
    },
  );
});

// The bundled nginx files were copied into /etc/nginx/conf/ as well as their
// real locations. nginx.conf globs only conf.d/{80,443}/*.conf, so those copies
// had no reader — while sharing a directory with the per-site fragments the
// mode handlers generate there.
describe('Dockerfile — /etc/nginx/conf holds generated fragments only', () => {
  it('no longer copies the bundled nginx directory into it', () => {
    expect(runtimeNoComments).not.toMatch(/^COPY \.\/nginx\/ \/etc\/nginx\/conf\/\s*$/m);
  });

  it('still creates the directory the mode handlers write their fragments into', () => {
    expect(runtimeNoComments).toMatch(/mkdir -p[\s\S]{0,200}\/etc\/nginx\/conf\b/);
  });

  it('keeps the three base config files at the paths nginx.conf loads', () => {
    expect(runtimeNoComments).toMatch(/^COPY \.\/nginx\/nginx\.conf \/etc\/nginx\/nginx\.conf\s*$/m);
    expect(runtimeNoComments).toMatch(/^COPY \.\/nginx\/proxy\.conf \/etc\/nginx\/proxy\.conf\s*$/m);
    expect(runtimeNoComments).toMatch(/^COPY \.\/nginx\/http-common\.conf \/etc\/nginx\/http-common\.conf\s*$/m);
  });
});

// The image default, the Node fallback and the shell startup line must all name
// the same environment. They disagreed once: the image shipped
// ENV ENVIRONMENT=development while js/entrypoint.js fell back to production and
// every document recorded production as the default. An ENV set in the image is
// never "unset", so the Node fallback could not correct it — a container started
// without an explicit ENVIRONMENT ran in development mode and failed on the
// missing dev.conf instead of serving the configured production sites.
describe('ENVIRONMENT default — image, Node fallback and shell agree on production', () => {
  it('the image defaults ENVIRONMENT to production', () => {
    expect(runtimeNoComments).toMatch(/^ENV ENVIRONMENT=production\s*$/m);
  });

  it('never ships development as the image default', () => {
    expect(runtimeNoComments).not.toMatch(/^ENV ENVIRONMENT=(development|dev)\s*$/m);
  });

  it('js/entrypoint.js still falls back to production when the variable is unset', () => {
    expect(entrypointJs).toMatch(/process\.env\.ENVIRONMENT\s*=\s*'production'/);
  });

  it('entrypoint.sh reports the same default in its startup line', () => {
    expect(entrypoint).toMatch(/ENVIRONMENT=\$\{ENVIRONMENT:-production\}/);
  });
});

// DOMAIN, ORGANIZATION and COUNTRY were image ENV defaults with no consumer
// anywhere in the repository — no script, template, nginx config or JS source
// ever read them, in any commit. Both openssl invocations hardcode their
// subject (-subj '/C=UA'), so nothing was left unparameterised by removing them.
describe('Dockerfile — no unused environment defaults', () => {
  it.each(['DOMAIN', 'ORGANIZATION', 'COUNTRY'])('does not declare %s', (name) => {
    expect(runtimeNoComments).not.toMatch(new RegExp(`^ENV ${name}=`, 'm'));
  });
});

describe('Dockerfile — unused packages removed', () => {
  // runtimeNoComments strips comment lines that document WHY a package is
  // absent, so only an actual apk add call would trigger these matches.
  it('does not install git (no usage in any script or JS source)', () => {
    expect(runtimeNoComments).not.toMatch(/\bgit\b/);
  });

  it('does not install ip6tables (no usage in any script or JS source)', () => {
    expect(runtimeNoComments).not.toMatch(/\bip6tables\b/);
  });

  it('does not install rsync (only referenced in a commented-out line; not called at runtime)', () => {
    expect(runtimeNoComments).not.toMatch(/\brsync\b/);
  });
});

// Permissions on the Certbot renewal runtime.
//
// Both the renewal script and its log are written and executed by root only:
// cron runs the renewal line out of root's crontab (js/letsencrypt/index.js
// appends it to /etc/crontabs/root), and that same cron shell's `>>`
// redirection is the log's only writer. Neither needs to be group- or
// world-writable.
//
// A world-writable, root-executed script is a privilege-escalation path: nginx
// workers run as the unprivileged `nginx` user (nginx/nginx.conf), so anything
// able to write code into that file would have it run as root at the next
// renewal.
//
// These assert the *resulting* mode, not merely the absence of a bad one. A
// symbolic `chmod +x` would pass "no numeric mode grants group write" while
// still producing 0775, because `+x` adds the execute bits and keeps whatever
// read/write bits the build context handed COPY — and git tracks only the
// executable bit, so a clone made under umask 002 supplies 0664 files. The
// mode has to be stated in the Dockerfile for the image to be reproducible.
//
// runtimeNoComments has comment lines stripped, so the rationale comments in
// the Dockerfile cannot satisfy or trip any of this.
describe('Dockerfile — Certbot renewal runtime permissions', () => {
  // All four are runtime helpers executed by root (cron for certbot_renew.sh,
  // the ENTRYPOINT and its children for the rest), so they share one mode.
  const HELPER_SCRIPTS = ['entrypoint.sh', 'reload.sh', 'fail2ban.sh', 'certbot_renew.sh'];
  const LOG = '/var/log/certbot/certbot_renew.log';

  // Every numeric `chmod <mode> <targets>` in the runtime stage.
  const numericChmods = [...runtimeNoComments.matchAll(/chmod\s+([0-7]{3,4})\s+([^\n\\]+)/g)]
    .map(([, mode, targets]) => ({ mode, targets: targets.trim().split(/\s+/) }));

  // Every symbolic one (`+x`, `a+w`, `go-w`, `u=rwx`, ...).
  const symbolicChmods = [...runtimeNoComments.matchAll(/chmod\s+([ugoa]*[-+=][rwxXst]+)\s+([^\n\\]+)/g)]
    .map(([, op, targets]) => ({ op, targets: targets.trim().split(/\s+/) }));

  // Octal mode -> the three permission digits, as numbers.
  const digits = (mode) => mode.padStart(4, '0').slice(-3).split('').map(Number);
  const grantsNonOwnerWrite = (mode) => {
    const [, group, other] = digits(mode);
    return (group & 2) !== 0 || (other & 2) !== 0;
  };

  // The numeric modes applied to one path, newest-wins order preserved.
  const modesFor = (suffix) => numericChmods
    .filter(({ targets }) => targets.some((t) => t.endsWith(suffix)))
    .map(({ mode }) => mode);

  it.each(HELPER_SCRIPTS)('gives /usr/local/bin/%s an explicit 0755', (script) => {
    const modes = modesFor(`/usr/local/bin/${script}`);
    expect(modes).not.toHaveLength(0);
    for (const mode of modes) {
      const [owner, group, other] = digits(mode);
      expect(owner).toBe(7);  // rwx — root writes and runs it
      expect(group).toBe(5);  // r-x — readable and runnable, never writable
      expect(other).toBe(5);  // r-x
    }
  });

  it('sets all four helpers in the same chmod, so their modes cannot drift apart', () => {
    const covering = numericChmods.filter(({ targets }) =>
      HELPER_SCRIPTS.every((script) => targets.includes(`/usr/local/bin/${script}`)));
    expect(covering).toHaveLength(1);
    expect(covering[0].mode).toMatch(/^0?755$/);
  });

  it('never decides a helper permission symbolically', () => {
    // `chmod +x` preserves the incoming read/write bits, so the mode would be
    // the build context's to choose — 0664 in, 0775 out.
    const onHelpers = symbolicChmods.filter(({ targets }) =>
      targets.some((t) => HELPER_SCRIPTS.some((script) => t.endsWith(script))));
    expect(onHelpers).toEqual([]);
  });

  it('gives the renewal log an explicit 0644', () => {
    // `touch` alone would leave the log at the builder's umask, so the mode is
    // stated here too.
    const modes = modesFor(LOG);
    expect(modes).not.toHaveLength(0);
    for (const mode of modes) {
      const [owner, group, other] = digits(mode);
      expect(owner).toBe(6);  // rw- — the cron shell's `>>` is the only writer
      expect(group).toBe(4);  // r--
      expect(other).toBe(4);  // r--
    }
  });

  it('keeps the renewal log readable, since it is read back out of the container', () => {
    // docs/troubleshooting.md and docs/letsencrypt.md both document
    // `docker exec <container> cat /var/log/certbot/certbot_renew.log`, and the
    // Dockerfile suggests bind-mounting /var/log/certbot for host-side rotation.
    for (const mode of modesFor(LOG)) {
      const [owner, , other] = digits(mode);
      expect(owner & 4).not.toBe(0);
      expect(other & 4).not.toBe(0);
    }
  });

  it('never makes the renewal script group- or world-writable', () => {
    for (const mode of modesFor('/certbot_renew.sh')) {
      expect(grantsNonOwnerWrite(mode)).toBe(false);
    }
    expect(runtimeNoComments).not.toMatch(/chmod[^\n]*[ago]?\+w[^\n]*certbot_renew\.sh/);
  });

  it('never makes the renewal log group- or world-writable', () => {
    const modes = modesFor(LOG);
    expect(modes).not.toHaveLength(0);
    for (const mode of modes) {
      expect(grantsNonOwnerWrite(mode)).toBe(false);
    }
  });

  it('still creates the log file cron appends to', () => {
    expect(runtimeNoComments).toMatch(/mkdir\s+\/var\/log\/certbot/);
    expect(runtimeNoComments).toMatch(/touch\s+\/var\/log\/certbot\/certbot_renew\.log/);
  });

  it('uses no group- or world-writable mode anywhere in the runtime stage', () => {
    expect(runtimeNoComments).not.toMatch(/chmod\s+0?777/);
    // Listed rather than counted, so a regression names the offending mode
    // and path instead of just failing.
    const offenders = numericChmods.filter(({ mode }) => grantsNonOwnerWrite(mode));
    expect(offenders).toEqual([]);
  });
});
