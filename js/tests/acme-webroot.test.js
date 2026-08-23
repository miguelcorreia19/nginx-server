// ACME webroot tests.
//
// These assert that the project-controlled port-80 nginx config serves ACME
// http-01 challenge files from the shared webroot (/var/www/certbot) WITHOUT
// redirecting them, while leaving normal-request behavior (the HTTP→HTTPS
// redirect and the default-server 444) unchanged.
//
// This is what renewal depends on: `certbot renew --webroot -w /var/www/certbot`
// writes its challenge tokens there and nginx keeps port 80 throughout, so these
// two blocks are live renewal infrastructure rather than preparation for it.
// (Initial issuance still uses --standalone, before nginx is listening.) The
// renewal flow itself is covered by certbot-renew.test.js and partial-renewal.test.js.

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

  // The block used to carry `ssl_ciphers aNULL`, `ssl_certificate data:$empty`
  // and `ssl_certificate_key data:$empty`, plus the `map` that fed them —
  // copied from the :443 default vhost, where they are load-bearing. This
  // listener has no `ssl` parameter, so nginx never enters the TLS path for it
  // and none of them had any effect. Verified with a real `nginx -t` in the
  // built image, before and after removal.
  it('carries no TLS directives, which a plain :80 listener never uses', () => {
    expect(vhost).not.toMatch(/ssl_certificate/);
    expect(vhost).not.toMatch(/ssl_certificate_key/);
    expect(vhost).not.toMatch(/ssl_ciphers/);
  });

  it('declares no map, since nothing in it consumes one', () => {
    expect(vhost).not.toMatch(/^\s*map\s/m);
    expect(vhost).not.toMatch(/\$empty/);
  });

  it('does not turn the listener into an SSL one', () => {
    expect(vhost).not.toMatch(/listen\s+80\s+ssl/);
  });
});

// The :443 default vhost is the one that genuinely needs the certificate-less
// trick: nginx requires a certificate on an SSL listener, so it synthesises an
// empty inline one. Pinned here so cleaning the :80 block above can never be
// mirrored onto this one by mistake.
describe('default HTTPS vhost — keeps its certificate-less mechanism', () => {
  const vhost443 = read(path.join(__dirname, '../../nginx/nginx.vh.default.443.conf'));

  it('still synthesises an empty inline certificate', () => {
    expect(vhost443).toMatch(/^\s*map\s+""\s+\$empty\s*\{/m);
    expect(vhost443).toContain('ssl_certificate data:$empty;');
    expect(vhost443).toContain('ssl_certificate_key data:$empty;');
    expect(vhost443).toContain('ssl_ciphers aNULL;');
  });

  it('remains the default_server on port 443 and still returns 444', () => {
    expect(vhost443).toMatch(/listen\s+443\s+ssl\s+default_server;/);
    expect(vhost443).toMatch(/return 444;/);
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
