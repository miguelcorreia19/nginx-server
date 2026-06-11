// Regression tests: ensure that runtime package installation was removed from
// entrypoint.sh (it bloats startup time and is non-deterministic) and that the
// Dockerfile installs dependencies at build time using the lockfile.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const entrypoint = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
const dockerfile  = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

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
