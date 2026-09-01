// Repository contracts for the runnable examples under examples/.
//
// Compose parsing is already covered by CI (`docker compose config -q`) and
// needs Docker, so it is not repeated here. What this adds is what Compose
// cannot check: that every example's config.json is something the image would
// actually accept, that no example ever commits credential or key material, and
// that the Cloudflare example's certificate filenames agree across the three
// places that have to spell them identically.

const fs = require('fs');
const path = require('path');

const { validateConfigEntry } = require('../validate.js');

const root = path.join(__dirname, '..', '..');
const examplesDir = path.join(root, 'examples');

const examples = fs.readdirSync(examplesDir)
  .filter((name) => fs.statSync(path.join(examplesDir, name)).isDirectory())
  .sort();

const readConfig = (name) => {
  const p = path.join(examplesDir, name, 'nginx', 'config.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

// Every file an example actually ships, so the secret scan below cannot be
// satisfied by a directory it forgot to walk.
const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(full) : [full];
});

describe('examples — config.json validates against the real schema', () => {
  it('finds the examples directory', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)('%s', (name) => {
    const config = readConfig(name);
    if (config === null) return; // an example without config.json is not a failure

    expect(typeof config).toBe('object');
    expect(Array.isArray(config)).toBe(false);

    for (const [id, entry] of Object.entries(config)) {
      // The email argument stands in for CERTBOT_EMAIL, which a letsencrypt
      // entry may rely on instead of carrying its own.
      expect(() => validateConfigEntry(id, entry, 'ops@example.com')).not.toThrow();
    }
  });
});

describe('examples — no example ships a secret', () => {
  // A committed token or key is the one mistake in an example that cannot be
  // walked back once it is public.
  const SECRET_CONTENT = [
    [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, 'a private key'],
    [/-----BEGIN CERTIFICATE-----/, 'a certificate'],
    // A real Cloudflare API token is 40 chars of [A-Za-z0-9_-]; the committed
    // template must keep its obvious placeholder instead.
    [/dns_cloudflare_api_token\s*=\s*(?!replace-with-)\S{20,}/, 'a Cloudflare API token'],
    [/dns_cloudflare_api_key\s*=\s*(?!replace-with-)\S{20,}/, 'a Cloudflare API key'],
  ];

  const tracked = filesUnder(examplesDir)
    // Demo material an example's README tells the reader to generate locally is
    // gitignored, never committed — skip it if a previous run left it behind.
    .filter((f) => !/custom-certificates\/.*\.(pem|key)$/.test(f))
    .filter((f) => !/cloudflare\.ini$/.test(f));

  it.each(tracked.map((f) => [path.relative(root, f), f]))('%s', (_label, file) => {
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch (_) { return; } // binary
    for (const [pattern, what] of SECRET_CONTENT) {
      if (pattern.test(body)) throw new Error(`${path.relative(root, file)} appears to contain ${what}`);
    }
  });

  it('keeps the real Cloudflare credentials file out of the repository', () => {
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/examples\/cloudflare-custom-certs\/cloudflare\.ini\s*$/m);
    // Only the template is committed.
    expect(fs.existsSync(path.join(examplesDir, 'cloudflare-custom-certs', 'cloudflare.ini.example'))).toBe(true);
  });
});

// The Cloudflare example spells the two exported filenames in three places, and
// nothing at runtime reconciles them: the sidecar writes them, the sidecar's
// healthcheck tests for them, and nginx-server's config.json names them. A
// mismatch means either a container that never becomes healthy or one whose
// certificate preflight fails — both after issuance has already happened.
describe('examples/cloudflare-custom-certs — exported filenames agree', () => {
  const dir = path.join(examplesDir, 'cloudflare-custom-certs');
  const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const config = readConfig('cloudflare-custom-certs');

  const envValue = (key) => (compose.match(new RegExp(`${key}=(\\S+)`)) || [])[1];

  it('config.json names the files the sidecar is told to export', () => {
    expect(config.lan.cert_file).toBe(envValue('FULLCHAIN_NAME'));
    expect(config.lan.privkey_file).toBe(envValue('PRIVKEY_NAME'));
  });

  it('the readiness healthcheck tests for those same files', () => {
    const healthcheck = (compose.match(/test:\n\s*- CMD-SHELL\n\s*- (.+)/) || [])[1] || '';
    expect(healthcheck).toContain(config.lan.cert_file);
    expect(healthcheck).toContain(config.lan.privkey_file);
  });

  it('holds nginx-server back until the certificate exists', () => {
    // Without this gate the first start races initial issuance and fails the
    // custom-certificate preflight.
    //
    // Matched as a block rather than as adjacent lines, so an explanatory
    // comment between them does not read as a missing dependency.
    const block = (compose.match(/depends_on:\n((?:\s+.*\n)+?)\s*ports:/) || [])[1] || '';
    expect(block).toMatch(/certbot-cloudflare:/);
    expect(block).toMatch(/condition: service_healthy/);
  });

  it('consumes the export as a custom certificate, not via the built-in ACME flow', () => {
    expect(config.lan.mode).toBe('custom');
    expect(compose).not.toMatch(/^\s*-\s*CERTBOT_EMAIL=/m);
    expect(compose).not.toMatch(/^\s*-\s*CERTBOT_BACKUP/m);
    // Fail2ban is the only feature needing NET_ADMIN, and it is not part of this example.
    expect(compose).not.toMatch(/NET_ADMIN/);
  });

  it('mounts the export read-only at the default CUSTOM_CERTS_PATH', () => {
    expect(compose).toMatch(/certs:\/home\/custom-certificates:ro/);
  });
});
