// Phase A (webroot-readiness) tests.
//
// These assert that the project-controlled port-80 nginx config can serve ACME
// http-01 challenge files from the shared webroot (/var/www/certbot) WITHOUT
// redirecting them, while leaving normal-request behavior (the HTTP→HTTPS
// redirect and the default-server 444) unchanged. Renewal still uses standalone
// mode — there are intentionally no renewal tests here.

const fs = require('fs');
const path = require('path');

const REDIRECT_TPL = path.join(__dirname, '../templates/http_redirect.conf');
const DEFAULT_VHOST = path.join(__dirname, '../../nginx/nginx.vh.default.80.conf');
const DOCKERFILE = path.join(__dirname, '../../Dockerfile');

const read = (p) => fs.readFileSync(p, 'utf8');

// Cheap structural validity proxy (no nginx binary available in unit tests):
// a well-formed config has balanced braces.
const bracesBalanced = (s) =>
  (s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length;

// Extract the body of the first matching `location <sel> { ... }` block.
const locationBody = (conf, selectorRe) => {
  const m = conf.match(new RegExp(`location\\s+${selectorRe}\\s*\\{([\\s\\S]*?)\\}`));
  return m ? m[1] : null;
};

const ACME_SELECTOR = '\\^~\\s*/\\.well-known/acme-challenge/';

describe('ACME webroot — generated HTTP redirect block', () => {
  const tpl = read(REDIRECT_TPL);

  it('serves the ACME challenge from the shared webroot', () => {
    const body = locationBody(tpl, ACME_SELECTOR);
    expect(body).not.toBeNull();
    expect(body).toContain('root /var/www/certbot;');
  });

  it('never redirects challenge requests (no return inside the ACME location)', () => {
    const body = locationBody(tpl, ACME_SELECTOR);
    expect(body).not.toMatch(/return\s+30[12]/);
  });

  it('still redirects normal requests to HTTPS (inside location /)', () => {
    const body = locationBody(tpl, '/');
    expect(body).not.toBeNull();
    expect(body).toMatch(/return 301 https:\/\//);
  });

  it('preserves the exact redirect target (no behavior change for normal requests)', () => {
    expect(tpl).toContain('return 301 https://$host$request_uri;');
  });

  it('does not escape the redirect target variables (no literal backslashes in the Location header)', () => {
    expect(tpl).not.toMatch(/\\\$host|\\\$request_uri/);
  });

  it('matches the ACME challenge before the catch-all redirect', () => {
    expect(tpl.indexOf('/.well-known/acme-challenge/')).toBeLessThan(tpl.indexOf('location / {'));
  });

  it('produces a balanced, placeholder-free block once a Let\'s Encrypt domain is substituted', () => {
    // Mirrors js/utils.js httpRedirect for an http_redirect=true LE domain.
    const generated = tpl.replace('${SERVER_NAMES}', 'example.com www.example.com');
    expect(generated).not.toMatch(/\$\{[A-Z_]+\}/);
    expect(generated).toContain('server_name example.com www.example.com;');
    expect(generated).toContain('location ^~ /.well-known/acme-challenge/');
    expect(generated).toMatch(/return 301 https:\/\//);
    expect(bracesBalanced(generated)).toBe(true);
  });
});

describe('ACME webroot — default port-80 vhost', () => {
  const vhost = read(DEFAULT_VHOST);

  it('serves the ACME challenge from the shared webroot (covers http_redirect=false domains)', () => {
    const body = locationBody(vhost, ACME_SELECTOR);
    expect(body).not.toBeNull();
    expect(body).toContain('root /var/www/certbot;');
  });

  it('still returns 444 for normal requests (behavior unchanged)', () => {
    const body = locationBody(vhost, '/');
    expect(body).not.toBeNull();
    expect(body).toMatch(/return 444;/);
  });

  it('remains the default_server on port 80', () => {
    expect(vhost).toMatch(/listen\s+80\s+default_server;/);
  });

  it('is structurally valid (balanced braces)', () => {
    expect(bracesBalanced(vhost)).toBe(true);
  });
});

describe('ACME webroot — image provisioning', () => {
  // Strip comment lines so the directory path in documentation comments does
  // not satisfy the check (same approach as build-startup-assertions.test.js).
  const dockerfileNoComments = read(DOCKERFILE)
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('creates the /var/www/certbot webroot in the image', () => {
    expect(dockerfileNoComments).toMatch(/mkdir -p[\s\S]*\/var\/www\/certbot/);
  });
});
