// Mocks must be declared before any require of the module under test.
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
}));
jest.mock('../utils.js', () => ({
  command: jest.fn(),
}));
jest.mock('luxon', () => ({ DateTime: { fromJSDate: jest.fn(() => 'mock-validity') } }));

const fs = require('fs');
const { command } = require('../utils.js');
const { parseCerts } = require('../letsencrypt/utils.js');

const NO_CERTS_OUTPUT = 'No certificates found.';

const ENV_KEYS = ['CERTBOT_BACKUP', 'CERTBOT_BACKUP_PATH'];
const savedEnv = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('parseCerts — certbot query failure propagation', () => {
  it('throws (does not return a {error, msg} sentinel) when "certbot certificates" fails', async () => {
    command.mockRejectedValueOnce({ error: 'certbot: command not found' });

    await expect(parseCerts()).rejects.toThrow(/Failed to query certbot certificates/);
  });

  it('includes the underlying command error in the thrown message', async () => {
    command.mockRejectedValueOnce({ error: 'connection refused' });

    await expect(parseCerts()).rejects.toThrow(/connection refused/);
  });
});

describe('parseCerts — backup restore logic (live dir contents)', () => {
  const setupBackupEnv = () => {
    process.env.CERTBOT_BACKUP = 'true';
    process.env.CERTBOT_BACKUP_PATH = '/backup';
  };

  it('does not inspect backups when CERTBOT_BACKUP is not set', async () => {
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('discards the backup when the live directory contains only README', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README']);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    expect(result).toEqual({});
  });

  it('restores the backup when it contains exactly one certificate lineage alongside README (regression for dir.length > 1 bug)', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README', 'example.com']);
    command.mockImplementation((cmd) => {
      if (cmd === 'certbot certificates') return Promise.resolve(NO_CERTS_OUTPUT);
      return Promise.resolve();
    });

    const result = await parseCerts(true);

    expect(command).toHaveBeenCalledWith(expect.stringContaining('cp -rf /backup/* /etc/letsencrypt'));
    expect(result).toEqual({});
  });

  it('restores the backup when it contains multiple certificate lineages', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['README', 'example.com', 'other.com']);
    command.mockImplementation((cmd) => {
      if (cmd === 'certbot certificates') return Promise.resolve(NO_CERTS_OUTPUT);
      return Promise.resolve();
    });

    const result = await parseCerts(true);

    expect(command).toHaveBeenCalledWith(expect.stringContaining('cp -rf /backup/* /etc/letsencrypt'));
    expect(result).toEqual({});
  });

  it('restores the backup even when README is absent and exactly one lineage dir exists', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['example.com']);
    command.mockImplementation((cmd) => {
      if (cmd === 'certbot certificates') return Promise.resolve(NO_CERTS_OUTPUT);
      return Promise.resolve();
    });

    const result = await parseCerts(true);

    expect(command).toHaveBeenCalledWith(expect.stringContaining('cp -rf /backup/* /etc/letsencrypt'));
    expect(result).toEqual({});
  });

  it('discards the backup when the live directory is completely empty', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([]);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    expect(result).toEqual({});
  });

  it('discards the backup when the backup path does not exist on disk', async () => {
    setupBackupEnv();
    fs.existsSync.mockReturnValue(false);
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(true);

    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(expect.stringContaining('cp -rf'));
    expect(result).toEqual({});
  });

  it('does not inspect backups when copy_files is false, even with CERTBOT_BACKUP set', async () => {
    setupBackupEnv();
    command.mockResolvedValueOnce(NO_CERTS_OUTPUT);

    const result = await parseCerts(false);

    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});
