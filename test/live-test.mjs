/**
 * Read-only live test for the native FrigidaireClient.
 *
 * Validates the full auth flow (client-credentials -> identity-providers ->
 * Gigya login -> token exchange), device discovery, and telemetry parsing
 * against the real Frigidaire cloud. It does NOT send any commands.
 *
 * Usage (keeps credentials out of the shell history if you prefer env vars):
 *   FRIGIDAIRE_USER='you@example.com' FRIGIDAIRE_PASS='secret' \
 *     node test/live-test.mjs
 *
 *   # or positional:
 *   node test/live-test.mjs you@example.com secret
 *
 * Build first: `npm run build`.
 */
import { FrigidaireClient } from '../dist/frigidaire/index.js';

const username = process.env.FRIGIDAIRE_USER || process.argv[2];
const password = process.env.FRIGIDAIRE_PASS || process.argv[3];

if (!username || !password) {
  console.error('Usage: FRIGIDAIRE_USER=… FRIGIDAIRE_PASS=… node test/live-test.mjs  (or pass as args)');
  process.exit(1);
}

const log = {
  debug: (...a) => console.log('  ·', ...a),
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

const client = new FrigidaireClient({ username, password, logger: log });

try {
  console.log('→ Authenticating…');
  await client.connect();
  console.log('✓ Authenticated.\n→ Listing appliances…');

  const appliances = await client.getAppliances();
  console.log(`✓ Found ${appliances.length} appliance(s).\n`);

  for (const a of appliances) {
    const r = a.reported;
    console.log(`• ${a.name}`);
    console.log(`    id:        ${a.applianceId}`);
    console.log(`    type:      ${r.applianceInfo?.applianceType}   firmware: ${a.firmware}`);
    console.log('    state:     ' + JSON.stringify({
      mode: r.mode,
      applianceState: r.applianceState,
      ambientTemperatureC: r.ambientTemperatureC,
      targetTemperatureC: r.targetTemperatureC,
      temperatureRepresentation: r.temperatureRepresentation,
      fanSpeedSetting: r.fanSpeedSetting,
      verticalSwing: r.verticalSwing,
      filterState: r.filterState,
    }));
  }
  process.exit(0);
} catch (err) {
  console.error('\n✗ FAILED:', err?.message || err);
  process.exit(1);
}
