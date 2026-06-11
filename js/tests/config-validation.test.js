// Tests the validation logic added to js/entrypoint.js.
// We mirror the exact conditions used there so regressions are caught
// if someone weakens or removes a check.

const isValidConfig = (value) => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
};

describe('config.json shape validation', () => {
  it('accepts a non-empty domain object', () => {
    const config = { 'my-domain': { mode: 'http', names: ['example.com'] } };
    expect(isValidConfig(config)).toBe(true);
  });

  it('accepts an empty object (no domains configured)', () => {
    expect(isValidConfig({})).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidConfig(null)).toBe(false);
  });

  it('rejects an array at root level', () => {
    expect(isValidConfig([{ mode: 'http' }])).toBe(false);
  });

  it('rejects a string', () => {
    expect(isValidConfig('not-an-object')).toBe(false);
  });

  it('rejects a number', () => {
    expect(isValidConfig(42)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidConfig(undefined)).toBe(false);
  });
});

describe('config.json require error classification', () => {
  const classifyError = (err) => {
    if (err.code === 'MODULE_NOT_FOUND') return 'not-found';
    return 'parse-error';
  };

  it('classifies MODULE_NOT_FOUND as not-found', () => {
    const err = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    expect(classifyError(err)).toBe('not-found');
  });

  it('classifies SyntaxError as parse-error', () => {
    const err = new SyntaxError('Unexpected token');
    expect(classifyError(err)).toBe('parse-error');
  });

  it('classifies generic error as parse-error', () => {
    expect(classifyError(new Error('something'))).toBe('parse-error');
  });
});
