'use strict';
// Menjalankan seluruh tes (git/store/services + provider + alur rilis). UI diuji terpisah: npm run test:ui
const { spawnSync } = require('node:child_process');
const files = ['core.test.cjs', 'providers.test.cjs', 'accounts.test.cjs'].map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
