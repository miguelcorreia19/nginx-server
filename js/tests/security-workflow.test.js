// Invariants of the CI workflows that a YAML linter cannot check: how actions
// and the scanner are sourced, what the security scan is allowed to do, and
// that its schedules actually select its jobs.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const workflowFiles = fs.readdirSync(path.join(root, '.github', 'workflows'))
  .filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
const actionFiles = ['.github/actions/install-trivy/action.yml'];
const security = read('.github/workflows/security.yml');
const installTrivy = read('.github/actions/install-trivy/action.yml');

describe('GitHub Actions are pinned to reviewed commits', () => {
  const uses = [...workflowFiles, ...actionFiles].flatMap((file) =>
    [...read(file).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)].map(([, ref, rest]) => ({ file, ref, rest })));

  it('finds the action references it checks', () => {
    expect(uses.length).toBeGreaterThan(5);
  });

  it('references every third-party action by full commit SHA, annotated with its release', () => {
    const offenders = uses
      .filter(({ ref }) => !ref.startsWith('./'))
      .filter(({ ref, rest }) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref) || !/^\s+# v\d+\.\d+\.\d+\s*$/.test(rest));
    expect(offenders).toEqual([]);
  });
});

describe('security scan workflow — triggers', () => {
  const crons = [...security.matchAll(/^\s+- cron: '([^']+)'/gm)].map(([, c]) => c);

  it('runs on a daily and a weekly schedule and on manual dispatch', () => {
    expect(crons).toHaveLength(2);
    for (const cron of crons) expect(cron.split(' ')).toHaveLength(5);
    expect(crons[0]).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(crons[1]).toMatch(/^\d+ \d+ \* \* [0-6]$/);
    expect(security).toMatch(/^ {2}workflow_dispatch:/m);
  });

  // github.event.schedule is the literal cron string, so a schedule edited in
  // one place but not the other would silently run no job at all.
  it('selects each job by the exact cron string it is scheduled with', () => {
    expect(security).toContain(`github.event.schedule == '${crons[0]}'`);
    expect(security).toContain(`github.event.schedule == '${crons[1]}'`);
  });

  it('never runs for pull requests or pushes, so untrusted code never runs here', () => {
    expect(security).not.toMatch(/^ {2}(pull_request|pull_request_target|push|workflow_run):/m);
  });
});

describe('security scan workflow — least privilege, read-only', () => {
  it('defaults the token to read-only repository access', () => {
    expect(security).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it('grants security-events: write once, to the job that uploads SARIF', () => {
    expect(security.match(/security-events: write/g)).toHaveLength(1);
    expect(security.match(/upload-sarif@/g)).toHaveLength(1);
  });

  it('uses no repository secrets and does not log in to any registry', () => {
    expect(security).not.toMatch(/\$\{\{\s*secrets\./);
    expect(security).not.toMatch(/docker login|login-action/);
  });

  it('never publishes, tags or pushes an image', () => {
    expect(security).not.toMatch(/docker (image )?push|--push\b|docker tag\b|imagetools create/);
  });

  it('does not leave the checkout token in the workspace', () => {
    const checkouts = security.match(/uses: actions\/checkout@/g);
    expect(security.match(/persist-credentials: false/g)).toHaveLength(checkouts.length);
  });
});

describe('security scan workflow — coverage and failure visibility', () => {
  it('scans both architectures in both jobs', () => {
    expect(security).toMatch(/arch: \[amd64, arm64\]/);
    expect(security).toMatch(/- arch: amd64\n\s+runner: ubuntu-24\.04\n/);
    expect(security).toMatch(/- arch: arm64\n\s+runner: ubuntu-24\.04-arm\n/);
  });

  // Each architecture is its own job, so one failing (or missing) cannot cancel
  // or hide the other's result.
  it('runs every architecture as an independent job', () => {
    expect(security.match(/strategy:\n\s+fail-fast: false\n/g)).toHaveLength(2);
    expect(security).toMatch(/name: Published image \(linux\/\$\{\{ matrix\.arch \}\}\)/);
    expect(security).toMatch(/name: Fresh rebuild \(linux\/\$\{\{ matrix\.arch \}\}\)/);
  });

  // The published image is resolved to one per-architecture digest, and that
  // digest is what gets scanned, so a scan cannot describe the other platform.
  it('scans the published image by its per-architecture digest in both jobs', () => {
    expect(security.match(/\.Platform\.Architecture|\.platform\.architecture/g)).toHaveLength(2);
    expect(security).toMatch(/--output "scan-results\/published-\$ARCH\.json" "\$REF"/);
    expect(security).toMatch(/--output "scan-results\/published-\$ARCH\.json" "\$PUBLISHED"/);
    expect(security.match(/Missing architecture/g)).toHaveLength(2);
  });

  // Docker's containerd image store can hold several platforms of one tag, so a
  // scan without --platform may silently cover the host's architecture instead.
  it('pins every image scan to the job architecture', () => {
    const scans = [...security.matchAll(/trivy image --skip-db-update[^\n]*/g)].map(([line]) => line);
    expect(scans.length).toBeGreaterThanOrEqual(3);
    for (const line of scans) expect(line).toContain('--platform "linux/$ARCH"');
  });

  it('suppresses nothing: no ignore file and no ignore-unfixed', () => {
    expect(security).toMatch(/TRIVY_IGNOREFILE: \/dev\/null/);
    expect(security).not.toMatch(/ignore-unfixed|IGNORE_UNFIXED|ignore-status|continue-on-error/);
  });

  it('applies the documented policy script to every scanned target', () => {
    expect(security.match(/node \.github\/scripts\/security-report\.js/g)).toHaveLength(2);
  });
});

describe('Trivy is a pinned, checksum-verified release outside the compromised set', () => {
  const version = installTrivy.match(/TRIVY_VERSION: (\d+\.\d+\.\d+)/)[1];
  const atLeast = (v, min) => {
    const [a, b] = [v, min].map((x) => x.split('.').map(Number));
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
  };

  it('pins an exact version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // GHSA-69fq-xp46-6x23 (malicious 0.69.4 binaries, 0.69.5/0.69.6 images), and
  // GHSA-mcj4-mphf-j9ff / GHSA-8rc5-4fr6-64pw fixed in 0.71.1 / 0.72.0.
  it('is not a compromised release and includes the later scanner security fixes', () => {
    expect(['0.69.4', '0.69.5', '0.69.6']).not.toContain(version);
    expect(atLeast(version, '0.72.0')).toBe(true);
  });

  it('verifies a pinned SHA-256 for each runner architecture before extracting', () => {
    expect(installTrivy).toMatch(/TRIVY_SHA256_X64: [0-9a-f]{64}\n/);
    expect(installTrivy).toMatch(/TRIVY_SHA256_ARM64: [0-9a-f]{64}\n/);
    expect(installTrivy.indexOf('sha256sum --check --strict')).toBeLessThan(installTrivy.indexOf('tar -xzf'));
  });

  it('downloads only from the official release page', () => {
    const urls = installTrivy.match(/https:\/\/[^\s"]+/g);
    expect(urls).toEqual(['https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_${asset}.tar.gz']);
  });
});
