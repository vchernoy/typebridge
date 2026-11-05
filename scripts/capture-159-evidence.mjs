/**
 * Historical #159 S6 layout screenshot helper.
 * The in-page split UI was removed in #175 step 10; keep this script as a record of how
 * the PNGs under docs/evidence/159/ were produced. Do not re-run against current main.
 */
import process from 'node:process';

process.stderr.write(
  'capture-159-evidence.mjs is historical: in-page split was removed in #175 step 10.\n'
  + 'Existing PNGs under docs/evidence/159/ remain the S6 record.\n',
);
process.exit(1);
