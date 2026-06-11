// Regression tests: ensure that runtime package installation was removed from
// entrypoint.sh (it bloats startup time and is non-deterministic) and that the
// Dockerfile installs dependencies at build time using the lockfile.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const entrypoint = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
const dockerfile  = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

// Split the Dockerfile at the runtime stage boundary (second FROM, no AS).
// The builder stage is used only to produce node_modules; the runtime stage
// is what actually runs in production.
const runtimeStageMatch = dockerfile.search(/^FROM nginx:alpine\s*$/m);
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

  it('copies package files in a separate layer before the full source copy', () => {
    const pkgCopyIdx  = dockerfile.indexOf('COPY js/package');
    const npmCiIdx    = dockerfile.indexOf('npm ci');
    const srcCopyIdx  = dockerfile.indexOf('COPY . /home/scripts/');
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
    expect(dockerfile).toMatch(/FROM nginx:alpine AS node-builder/);
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
