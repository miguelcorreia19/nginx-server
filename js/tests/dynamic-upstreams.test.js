// The examples proxy to other Compose services by name. With a literal
// `proxy_pass http://service:port`, nginx resolves that name once, when it
// loads the configuration, and keeps the IP — so a backend recreated with a new
// address keeps getting the old one until nginx is reloaded. The documented
// fix (docs/configuration.md -> Proxying to other Docker containers) is a named
// upstream with `server <name>:<port> resolve`, a shared-memory `zone`, and
// Docker's embedded resolver declared inside that upstream block.
//
// Two more things the pattern depends on. The validity is one second because
// Docker can hand a freed address to another container, and nginx keeps
// sending to the old address until the cached answer expires — a longer value
// widens that window (measured: ~1s at 1s, ~10s at 10s). And upstream/zone
// names are global to the whole http context, into which every site file is
// loaded, so a name derived from the service alone (`service1_upstream`)
// collides as soon as two sites proxy the same service; names are scoped to
// the site as well (`someid_service1_upstream`).
//
// The runtime behaviour itself is proven against the real image by
// tests/integration/dynamic-upstream-dns.sh. What this suite protects is the
// shipped configuration: every example stays on the pattern, and the resolver
// stays out of the http-level base files an operator may replace.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const examplesDir = path.join(root, 'examples');

const stripComments = (text) => text.replace(/#[^\n]*/g, '');

const read = (file) => stripComments(fs.readFileSync(file, 'utf8'));

// examples/<name>/nginx/sites/*.conf, for every example that has a sites dir.
const siteConfigs = fs.readdirSync(examplesDir)
  .map((name) => path.join(examplesDir, name, 'nginx', 'sites'))
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) => fs.readdirSync(dir)
    .filter((f) => f.endsWith('.conf'))
    .map((f) => path.join(dir, f)))
  .sort();

const proxyingConfigs = siteConfigs.filter((file) => /\bproxy_pass\b/.test(read(file)));

// upstream name -> block body.
const upstreamBlocks = (text) => {
  const blocks = {};
  for (const m of text.matchAll(/\bupstream\s+(\S+)\s*\{([^}]*)\}/g)) blocks[m[1]] = m[2];
  return blocks;
};

// The host part of every proxy_pass target: `http://name/` and `http://name`
// both yield `name`.
const proxyTargets = (text) =>
  [...text.matchAll(/\bproxy_pass\s+https?:\/\/([^\s;/]+)/g)].map((m) => m[1]);

describe('examples — Docker backends are proxied through dynamically resolved upstreams', () => {
  it('finds site configs that proxy', () => {
    expect(proxyingConfigs.length).toBeGreaterThan(0);
  });

  describe.each(proxyingConfigs.map((f) => [path.relative(root, f), f]))('%s', (_label, file) => {
    const text = read(file);
    const upstreams = upstreamBlocks(text);
    const targets = proxyTargets(text);
    // The site id: the file name is the config.json key by contract.
    const site = path.basename(file, '.conf');

    it('proxies only to named upstreams defined in the same file', () => {
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        // A literal `service:port` target, or one nginx would have to resolve
        // itself, is exactly the stale-IP configuration.
        expect(Object.keys(upstreams)).toContain(target);
      }
    });

    it('does not use a variable in proxy_pass to force re-resolution', () => {
      // Variable-based proxy_pass has different URI semantics and is not the
      // pattern this project documents.
      expect(text).not.toMatch(/\bproxy_pass\s+\S*\$/);
    });

    // Guarded: describe.each rejects an empty list outright, and the check
    // above already reports a file with no upstream block readably.
    const names = Object.keys(upstreams);
    if (names.length === 0) return;

    describe.each(names)('upstream %s', (name) => {
      const body = upstreams[name];

      it('re-resolves its server through `resolve`', () => {
        expect(body).toMatch(/\bserver\s+[\w.-]+:\d+\s+resolve\s*;/);
      });

      it('resides in shared memory, which `resolve` requires', () => {
        expect(body).toMatch(/\bzone\s+\S+\s+\d+[kKmM]?\s*;/);
      });

      it("uses Docker's embedded DNS, inside the block, with a one-second validity", () => {
        expect(body).toMatch(/\bresolver\s+127\.0\.0\.11\b[^;]*\bvalid=1s\b[^;]*;/);
      });

      it('is named after the site as well as the backend', () => {
        expect(name.startsWith(`${site}_`)).toBe(true);
        expect(name.length).toBeGreaterThan(site.length + 1);
      });

      it('names its zone after itself', () => {
        expect(body).toMatch(new RegExp(`\\bzone\\s+${name}\\s`));
      });

      it('leaves IPv6 resolution enabled', () => {
        expect(body).not.toMatch(/ipv6=off/);
      });
    });
  });
});

// Within one example every site file lands in the same http context, so a
// name repeated across two of its files would be refused as a duplicate.
describe('examples — upstream and zone names are unique across each example', () => {
  const byExample = {};
  for (const file of proxyingConfigs) {
    const example = path.relative(examplesDir, file).split(path.sep)[0];
    (byExample[example] = byExample[example] || []).push(file);
  }

  it.each(Object.keys(byExample).sort())('%s', (example) => {
    const upstreamNames = [];
    const zoneNames = [];
    for (const file of byExample[example]) {
      const text = read(file);
      upstreamNames.push(...Object.keys(upstreamBlocks(text)));
      zoneNames.push(...[...text.matchAll(/\bzone\s+(\S+)\s/g)].map((m) => m[1]));
    }
    expect(new Set(upstreamNames).size).toBe(upstreamNames.length);
    expect(new Set(zoneNames).size).toBe(zoneNames.length);
  });
});

// The resolver is scoped to each upstream block on purpose: a `resolver` in
// nginx.conf, http-common.conf or proxy.conf would be new global state that
// collides with any resolver an operator already ships in their override of
// those files, and would force overriders to adopt a new include to keep the
// feature. The bundled files, and the override example, must stay free of it.
describe('base nginx configuration declares no global resolver', () => {
  const baseFiles = [
    'nginx/nginx.conf',
    'nginx/http-common.conf',
    'nginx/proxy.conf',
    'examples/custom-configs/nginx/configs/http-common.conf',
    'examples/custom-configs/nginx/configs/proxy.conf',
  ];

  it.each(baseFiles)('%s', (rel) => {
    expect(read(path.join(root, rel))).not.toMatch(/^\s*resolver\b/m);
  });
});
