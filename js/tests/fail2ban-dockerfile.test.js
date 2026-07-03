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
    expect(dockerfile).toMatch(/chmod \+x[^\n]*\/usr\/local\/bin\/fail2ban\.sh/);
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

describe('entrypoint.sh — Fail2ban launched as a background helper', () => {
  it('launches fail2ban.sh in the background (like reload.sh)', () => {
    expect(entrypoint).toMatch(/\/usr\/local\/bin\/fail2ban\.sh &/);
  });
  it('launches it before exec-ing nginx, so nginx stays the foreground process', () => {
    const f2bIdx = entrypoint.indexOf('fail2ban.sh &');
    const execIdx = entrypoint.indexOf('exec "$@"');
    expect(f2bIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(f2bIdx);
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
