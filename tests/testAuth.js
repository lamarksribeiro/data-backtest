import { createAuthService } from '../src/auth/authService.js';

export function createTestAuthService(db, config = {}) {
  return createAuthService({
    db,
    config: {
      SESSION_SECRET: 'test-session-secret',
      SESSION_MAX_AGE_SEC: 3600,
      NODE_ENV: 'test',
      INITIAL_ADMIN_USERNAME: 'admin',
      INITIAL_ADMIN_PASSWORD: 'test-pass',
      TEST_MODE: true,
      ...config,
    },
  });
}

export function testServerConfig(overrides = {}) {
  return {
    lakeRoot: overrides.lakeRoot,
    stateDbPath: overrides.stateDbPath,
    backtestDataMode: 'strict',
    backtestBookDepth: overrides.backtestBookDepth ?? 25,
    prepareRunner: 'inline',
    SESSION_SECRET: 'test-session-secret',
    SESSION_MAX_AGE_SEC: 3600,
    NODE_ENV: 'test',
    TEST_MODE: true,
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PASSWORD: 'test-pass',
    ...overrides,
  };
}
