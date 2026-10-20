import { describe, it, expect, afterEach } from 'bun:test';
import { isDevRuntime, isDeveloperFeedbackEnabled, isMemWiseCliEnabled, isEmbeddedServerEnabled } from '../feature-flags.ts';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  MEMWISE_DEBUG: process.env.MEMWISE_DEBUG,
  MEMWISE_FEATURE_DEVELOPER_FEEDBACK: process.env.MEMWISE_FEATURE_DEVELOPER_FEEDBACK,
  MEMWISE_FEATURE_MEMWISE_CLI: process.env.MEMWISE_FEATURE_MEMWISE_CLI,
  MEMWISE_FEATURE_EMBEDDED_SERVER: process.env.MEMWISE_FEATURE_EMBEDDED_SERVER,
};

afterEach(() => {
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;

  if (ORIGINAL_ENV.MEMWISE_DEBUG === undefined) delete process.env.MEMWISE_DEBUG;
  else process.env.MEMWISE_DEBUG = ORIGINAL_ENV.MEMWISE_DEBUG;

  if (ORIGINAL_ENV.MEMWISE_FEATURE_DEVELOPER_FEEDBACK === undefined) delete process.env.MEMWISE_FEATURE_DEVELOPER_FEEDBACK;
  else process.env.MEMWISE_FEATURE_DEVELOPER_FEEDBACK = ORIGINAL_ENV.MEMWISE_FEATURE_DEVELOPER_FEEDBACK;

  if (ORIGINAL_ENV.MEMWISE_FEATURE_MEMWISE_CLI === undefined) delete process.env.MEMWISE_FEATURE_MEMWISE_CLI;
  else process.env.MEMWISE_FEATURE_MEMWISE_CLI = ORIGINAL_ENV.MEMWISE_FEATURE_MEMWISE_CLI;

  if (ORIGINAL_ENV.MEMWISE_FEATURE_EMBEDDED_SERVER === undefined) delete process.env.MEMWISE_FEATURE_EMBEDDED_SERVER;
  else process.env.MEMWISE_FEATURE_EMBEDDED_SERVER = ORIGINAL_ENV.MEMWISE_FEATURE_EMBEDDED_SERVER;
});

describe('feature-flags runtime helpers', () => {
  it('isDevRuntime returns true for explicit dev NODE_ENV', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.MEMWISE_DEBUG;

    expect(isDevRuntime()).toBe(true);
  });

  it('isDevRuntime returns true for MEMWISE_DEBUG override', () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMWISE_DEBUG = '1';

    expect(isDevRuntime()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled honors explicit override false', () => {
    process.env.NODE_ENV = 'development';
    process.env.MEMWISE_FEATURE_DEVELOPER_FEEDBACK = '0';

    expect(isDeveloperFeedbackEnabled()).toBe(false);
  });

  it('isDeveloperFeedbackEnabled honors explicit override true', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MEMWISE_DEBUG;
    process.env.MEMWISE_FEATURE_DEVELOPER_FEEDBACK = '1';

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled falls back to dev runtime when no override', () => {
    process.env.NODE_ENV = 'production';
    process.env.MEMWISE_DEBUG = '1';
    delete process.env.MEMWISE_FEATURE_DEVELOPER_FEEDBACK;

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isMemWiseCliEnabled defaults to false when no override is set', () => {
    delete process.env.MEMWISE_FEATURE_MEMWISE_CLI;

    expect(isMemWiseCliEnabled()).toBe(false);
  });

  it('isMemWiseCliEnabled honors explicit override true', () => {
    process.env.MEMWISE_FEATURE_MEMWISE_CLI = '1';

    expect(isMemWiseCliEnabled()).toBe(true);
  });

  it('isMemWiseCliEnabled honors explicit override false', () => {
    process.env.MEMWISE_FEATURE_MEMWISE_CLI = '0';

    expect(isMemWiseCliEnabled()).toBe(false);
  });

  it('isEmbeddedServerEnabled defaults to false when no override is set', () => {
    delete process.env.MEMWISE_FEATURE_EMBEDDED_SERVER;

    expect(isEmbeddedServerEnabled()).toBe(false);
  });

  it('isEmbeddedServerEnabled honors explicit override true', () => {
    process.env.MEMWISE_FEATURE_EMBEDDED_SERVER = '1';

    expect(isEmbeddedServerEnabled()).toBe(true);
  });

  it('isEmbeddedServerEnabled honors explicit override false', () => {
    process.env.MEMWISE_FEATURE_EMBEDDED_SERVER = '0';

    expect(isEmbeddedServerEnabled()).toBe(false);
  });
});
