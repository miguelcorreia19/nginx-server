// Tests the ENVIRONMENT resolution/validation logic in js/entrypoint.js.
// We mirror the exact switch-case there so a regression to the old
// "invalid value silently exits 0" behavior is caught.

const resolveEnvironment = (rawValue) => {
  let value = rawValue;
  if (!value) {
    value = 'production';
  }

  switch (value) {
    case 'dev':
    case 'development':
      return { mode: 'dev', exitCode: null };
    case 'prod':
    case 'production':
      return { mode: 'production', exitCode: null };
    default:
      return {
        mode: null,
        exitCode: 1,
        message: `Fatal: invalid ENVIRONMENT value "${value}" — must be 'development'/'dev' or 'production'/'prod'`,
      };
  }
};

describe('ENVIRONMENT resolution', () => {
  it('defaults missing/empty value to production', () => {
    expect(resolveEnvironment(undefined)).toEqual({ mode: 'production', exitCode: null });
    expect(resolveEnvironment('')).toEqual({ mode: 'production', exitCode: null });
  });

  it('accepts dev and development as dev mode', () => {
    expect(resolveEnvironment('dev')).toEqual({ mode: 'dev', exitCode: null });
    expect(resolveEnvironment('development')).toEqual({ mode: 'dev', exitCode: null });
  });

  it('accepts prod and production as production mode', () => {
    expect(resolveEnvironment('prod')).toEqual({ mode: 'production', exitCode: null });
    expect(resolveEnvironment('production')).toEqual({ mode: 'production', exitCode: null });
  });

  it('rejects an invalid value with a non-zero exit code', () => {
    const result = resolveEnvironment('staging');
    expect(result.mode).toBeNull();
    expect(result.exitCode).toBe(1);
  });

  it('rejects an invalid value with a message that names the actual value received', () => {
    const result = resolveEnvironment('staging');
    expect(result.message).toEqual(expect.stringContaining('"staging"'));
  });

  it('rejects values that differ only in case (no silent fallback/normalization)', () => {
    const result = resolveEnvironment('Production');
    expect(result.exitCode).toBe(1);
    expect(result.message).toEqual(expect.stringContaining('"Production"'));
  });
});

describe('js/entrypoint.js source — invalid ENVIRONMENT fails fast', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'entrypoint.js'), 'utf8');

  it('does not silently exit 0 on an invalid ENVIRONMENT', () => {
    expect(source).not.toMatch(/default:[^]*?process\.exit\(0\)/);
  });

  it('exits with a non-zero code in the default (invalid) case', () => {
    const defaultCase = source.slice(source.indexOf('default:'));
    expect(defaultCase).toMatch(/process\.exit\(1\)/);
  });

  it('logs a message that includes the actual invalid value received', () => {
    const defaultCase = source.slice(source.indexOf('default:'));
    expect(defaultCase).toMatch(/process\.env\.ENVIRONMENT/);
    expect(defaultCase).toMatch(/invalid ENVIRONMENT value/i);
  });
});
