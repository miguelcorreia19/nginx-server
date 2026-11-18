// The security-scan workflow's report and failure policy
// (.github/scripts/security-report.js, documented in docs/security-scanning.md).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', '..', '.github', 'scripts', 'security-report.js');
const {
  InputError, parseTrivyReport, parseNginxAdvisories, advisoryAffects, advisoryFixedVersion, evaluate,
} = require(script);

const vuln = (id, pkg, severity, installed, fixed, extra = {}) => ({
  VulnerabilityID: id, PkgName: pkg, Severity: severity, InstalledVersion: installed,
  FixedVersion: fixed, DataSource: { ID: 'alpine', Name: 'Alpine Secdb' }, Title: `${id} title`, ...extra,
});

function report({ osVulns = [], libVulns = [], packages = [] } = {}) {
  return {
    SchemaVersion: 2,
    ArtifactName: 'nginx-server:test',
    Metadata: { OS: { Family: 'alpine', Name: '3.24.4' }, RepoDigests: ['nginx-server@sha256:abc'] },
    Results: [
      {
        Target: 'nginx-server:test (alpine 3.24.4)', Class: 'os-pkgs', Type: 'alpine',
        Packages: [
          { Name: 'nginx', Version: '1.31.9-r1', InstalledFiles: ['usr/sbin/nginx'] },
          {
            Name: 'py3-cryptography', Version: '47.0.0-r0',
            InstalledFiles: ['usr/lib/python3.14/site-packages/cryptography-47.0.0.dist-info/METADATA'],
          },
          ...packages,
        ],
        Vulnerabilities: osVulns,
      },
      { Target: 'Python', Class: 'lang-pkgs', Type: 'python-pkg', Vulnerabilities: libVulns },
    ],
  };
}

const appliedCryptographyFinding = (severity) => vuln('CVE-2026-1', 'cryptography', severity, '47.0.0', '50.0.0', {
  PkgPath: 'usr/lib/python3.14/site-packages/cryptography-47.0.0.dist-info/METADATA',
  DataSource: { ID: 'ghsa', Name: 'GitHub Security Advisory pip' },
});

const advisoryItem = (title, severity, cve, notVulnerable, vulnerable) =>
  `<li><p>${title}<br>Severity: ${severity}<br><a href="#">Advisory</a><br><a href="#">${cve}</a><br>Not vulnerable: ${notVulnerable}<br>Vulnerable: ${vulnerable}</p></li>`;

const advisoriesHtml = [
  advisoryItem('Memory corruption in HTTP/2 flow control', '<b>major</b>', 'CVE-2026-123007', '1.31.9+, 1.30.7+', '1.9.5-1.31.8'),
  advisoryItem('Use-after-free in HTTP/3', 'medium', 'CVE-CVE-2026-121810', '1.31.9+, 1.30.7+', '1.25.0-1.31.8'),
  advisoryItem('Future issue', '<b>major</b>', 'CVE-2027-1', '1.31.10+', '1.31.0-1.31.9'),
  advisoryItem('Windows only', 'low', 'CVE-2010-1', '0.8.33+', 'nginx/Windows 0.7.52-0.8.32'),
  advisoryItem('Old issue', 'medium', 'CVE-2009-1', 'none', 'all'),
  ...Array.from({ length: 6 }, (_, i) => advisoryItem(`Filler ${i}`, 'low', `CVE-2000-${i}`, '1.0.0+', '0.1.0-0.9.9')),
].map((li) => `${li}\n`).join('');

describe('security report — failure policy', () => {
  it('fails on a HIGH OS-package finding that Alpine has fixed', () => {
    const result = evaluate({ report: report({ osVulns: [vuln('CVE-2026-2', 'curl', 'HIGH', '8.19.0-r0', '8.23.0-r0')] }) });
    expect(result.violations.map((f) => f.id)).toEqual(['CVE-2026-2']);
    expect(result.violations[0].evidence).toMatch(/Alpine secdb/);
  });

  it('fails on every CRITICAL finding, fixed or not', () => {
    const result = evaluate({ report: report({ osVulns: [vuln('CVE-2026-3', 'zlib', 'CRITICAL', '1.0-r0', '')] }) });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].remediation.text).toBe('no fix published');
  });

  it('reports, but does not fail on, a HIGH finding with no fix published', () => {
    const result = evaluate({ report: report({ osVulns: [vuln('CVE-2026-4', 'musl', 'HIGH', '1.2.6-r3', '')] }) });
    expect(result.violations).toEqual([]);
    expect(result.findings).toHaveLength(1);
  });

  it('does not fail on a HIGH finding in a package only Alpine can rebuild, and says so', () => {
    const result = evaluate({ report: report({ libVulns: [appliedCryptographyFinding('HIGH')] }) });
    expect(result.violations).toEqual([]);
    const [finding] = result.findings;
    expect(finding.apkPackage).toBe('py3-cryptography-47.0.0-r0');
    expect(finding.remediation).toEqual({ actionable: false, text: expect.stringMatching(/no Alpine build yet/) });
    expect(finding.evidence).toMatch(/^triage:/);
  });

  it('still fails on a CRITICAL finding in an Alpine-managed language package', () => {
    const result = evaluate({ report: report({ libVulns: [appliedCryptographyFinding('CRITICAL')] }) });
    expect(result.violations).toHaveLength(1);
  });

  it('fails on a HIGH finding in a project-managed dependency that has a fix', () => {
    const npm = vuln('CVE-2026-5', 'luxon', 'HIGH', '3.7.2', '3.7.3', {
      PkgPath: 'home/scripts/js/node_modules/luxon/package.json', DataSource: { ID: 'ghsa', Name: 'GitHub Security Advisory npm' },
    });
    const result = evaluate({ report: report({ libVulns: [npm] }) });
    expect(result.violations.map((f) => f.remediation.text)).toEqual(['update the dependency to 3.7.3']);
  });

  it('never fails on MEDIUM or LOW findings', () => {
    const result = evaluate({ report: report({ osVulns: [
      vuln('CVE-2026-6', 'busybox', 'MEDIUM', '1.37.0-r30', '1.37.0-r31'),
      vuln('CVE-2026-7', 'busybox', 'LOW', '1.37.0-r30', '1.37.0-r31'),
    ] }) });
    expect(result.violations).toEqual([]);
  });
});

describe('security report — upstream base and published-image comparison', () => {
  const inherited = vuln('CVE-2026-10', 'musl', 'HIGH', '1.2.6-r3', '');
  const added = vuln('CVE-2026-11', 'certbot', 'HIGH', '5.6.0-r0', '');
  const clearedByBuild = vuln('CVE-2026-12', 'libcurl', 'HIGH', '8.19.0-r0', '8.23.0-r0');

  it('separates findings inherited from the base image from those this image adds', () => {
    const result = evaluate({
      report: report({ osVulns: [inherited, added] }),
      base: report({ osVulns: [inherited, clearedByBuild] }),
    });
    const origin = Object.fromEntries(result.findings.map((f) => [f.id, f.origin]));
    expect(origin).toEqual({ 'CVE-2026-10': 'upstream base image', 'CVE-2026-11': 'added by nginx-server' });
    expect(result.baseOnly.map((f) => f.id)).toEqual(['CVE-2026-12']);
  });

  it('marks the origin unknown when no base scan is available', () => {
    const result = evaluate({ report: report({ osVulns: [inherited] }) });
    expect(result.findings[0].origin).toBe('unknown');
    expect(result.baseOnly).toBeNull();
  });

  it('lists what a fresh rebuild clears and what it introduces', () => {
    const result = evaluate({
      report: report({ osVulns: [added] }),
      published: report({ osVulns: [clearedByBuild] }),
    });
    expect(result.comparison.clearedByRebuild.map((f) => f.id)).toEqual(['CVE-2026-12']);
    expect(result.comparison.newInRebuild.map((f) => f.id)).toEqual(['CVE-2026-11']);
    expect(result.comparison.publishedViolations).toBe(1);
    expect(result.rebuildRequired).toBe(true);
    expect(result.failed).toBe(true);
  });

  // Alpine fixing py3-cryptography is invisible to the daily policy (the
  // finding stays "fixed upstream only" in the published image), but a fresh
  // build no longer has it.
  it('fails the rebuild check when a fresh build clears a finding the daily policy only reports', () => {
    const result = evaluate({ report: report(), published: report({ libVulns: [appliedCryptographyFinding('HIGH')] }) });
    expect(result.violations).toEqual([]);
    expect(result.comparison.publishedViolations).toBe(0);
    expect(result.rebuildRequired).toBe(true);
  });

  it('passes when the fresh build clears nothing severe', () => {
    const same = report({ libVulns: [appliedCryptographyFinding('HIGH')] });
    const result = evaluate({ report: same, published: same });
    expect(result.rebuildRequired).toBe(false);
    expect(result.failed).toBe(false);
  });
});

describe('security report — nginx.org advisories', () => {
  const advisories = parseNginxAdvisories(advisoriesHtml);

  it('parses severity, CVE ids and version ranges from the advisory page', () => {
    expect(advisories[0]).toMatchObject({
      severity: 'major', ids: ['CVE-2026-123007'], notVulnerable: ['1.31.9+', '1.30.7+'], vulnerable: ['1.9.5-1.31.8'],
    });
    expect(advisories[1].ids).toEqual(['CVE-2026-121810']);
  });

  it('matches inclusive ranges, "all", "none" and ignores nginx/Windows-only entries', () => {
    expect(advisoryAffects(advisories[0], '1.31.8')).toBe(true);
    expect(advisoryAffects(advisories[0], '1.31.9')).toBe(false);
    expect(advisoryAffects(advisories[3], '0.8.0')).toBe(false);
    expect(advisoryAffects(advisories[4], '1.31.9')).toBe(true);
    expect(advisoryAffects({ ...advisories[4], vulnerable: ['none'] }, '1.31.9')).toBe(false);
  });

  it('picks the fixed release on the installed branch', () => {
    expect(advisoryFixedVersion(advisories[0], '1.31.4')).toBe('1.31.9');
    expect(advisoryFixedVersion(advisories[0], '1.30.5')).toBe('1.30.7');
    expect(advisoryFixedVersion(advisories[4], '1.31.9')).toBe('');
  });

  it('fails the policy on a major nginx advisory affecting the installed nginx', () => {
    const result = evaluate({ report: report(), nginxAdvisories: advisories });
    expect(result.violations.map((f) => f.id)).toEqual(['CVE-2027-1']);
    expect(result.violations[0]).toMatchObject({ severity: 'HIGH', fixed: '1.31.10', evidence: 'vendor advisory (nginx.org)' });
  });

  it('refuses a page it cannot parse instead of reporting no advisories', () => {
    expect(() => parseNginxAdvisories('<html>moved</html>')).toThrow(InputError);
  });

  it('refuses a version range it does not understand', () => {
    expect(() => advisoryAffects({ title: 't', vulnerable: ['1.2.x'] }, '1.31.9')).toThrow(/unrecognised version range/);
  });
});

describe('security report — input validation and exit status', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-report-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const run = (...args) => spawnSync(process.execPath, [script, '--arch', 'amd64', '--title', 'test', ...args], { encoding: 'utf8' });

  it('rejects a report in which Trivy detected no operating system', () => {
    const noOs = { SchemaVersion: 2, ArtifactName: 'x', Metadata: {}, Results: [] };
    expect(() => parseTrivyReport(JSON.stringify(noOs), 'x.json')).toThrow(/detected no operating system/);
  });

  it('exits 0 and writes the summary when the image is within policy', () => {
    const summary = path.join(dir, 'summary.md');
    const res = run('--report', write('clean.json', report()), '--summary', summary);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/\*\*Policy: pass\*\*/);
  });

  it('exits 1 with an error annotation on a policy violation', () => {
    const res = run('--report', write('bad.json', report({ osVulns: [vuln('CVE-2026-2', 'curl', 'HIGH', '8.19.0-r0', '8.23.0-r0')] })));
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^::error title=HIGH CVE-2026-2 \(linux\/amd64\)::/m);
  });

  it('exits 1 and asks for a rebuild when a fresh build clears a published HIGH finding', () => {
    const published = write('published.json', report({ libVulns: [appliedCryptographyFinding('HIGH')] }));
    const res = run('--report', write('candidate.json', report()), '--published', published);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/^::error title=Published image needs a rebuild \(linux\/amd64\)::CVE-2026-1 cryptography 47\.0\.0$/m);
    expect(res.stdout).toMatch(/\*\*Rebuild needed\*\*/);
  });

  it('exits 2, never 0, on a missing or malformed report', () => {
    expect(run('--report', path.join(dir, 'missing.json')).status).toBe(2);
    expect(run('--report', write('broken.json', '{"Results":')).status).toBe(2);
  });

  it('names the scanner and vulnerability-database snapshot in the summary', () => {
    const summary = path.join(dir, 'with-version.md');
    const version = write('version.json', { Version: '0.76.2', VulnerabilityDB: { UpdatedAt: '2026-11-18T13:03:23Z' } });
    const res = run('--report', write('v.json', report()), '--trivy-version', version, '--summary', summary);
    expect(res.status).toBe(0);
    expect(fs.readFileSync(summary, 'utf8')).toMatch('Scanner: Trivy 0.76.2, vulnerability DB updated 2026-11-18T13:03:23Z.');
  });

  it('exits 2 when the scanner metadata has no vulnerability database', () => {
    const res = run('--report', write('v2.json', report()), '--trivy-version', write('noversion.json', { Version: '0.76.2' }));
    expect(res.status).toBe(2);
  });

  it('exits 2 when the nginx advisory page cannot be parsed', () => {
    const res = run('--report', write('ok.json', report()), '--nginx-advisories', write('page.html', '<html></html>'));
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/Security report input unusable/);
  });
});
