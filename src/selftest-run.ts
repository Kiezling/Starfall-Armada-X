/** Node entry point for the headless logic self-tests. Bundled by scripts/selftest.mjs. */

import { runSelfTest } from './selftest';

const results = runSelfTest();

let failed = 0;
console.log('\n================ SELF TEST ================');
for (const r of results) {
  if (!r.ok) failed++;
  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${r.name}${r.detail ? `\n         ${r.detail}` : ''}`);
}
console.log('-------------------------------------------');
console.log(`${results.length - failed}/${results.length} passed`);
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'}`);
console.log('===========================================\n');

process.exit(failed === 0 ? 0 : 1);
