import type { API } from 'homebridge';

import { FrigidaireACPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Register the platform with Homebridge.
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, FrigidaireACPlatform);
};
