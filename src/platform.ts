import path from 'node:path';

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { FrigidaireClient } from './frigidaire/index.js';
import { FrigidaireACAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class FrigidaireACPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Cached accessories restored from disk. */
  public readonly accessories: PlatformAccessory[] = [];

  public readonly client: FrigidaireClient;
  public readonly pollingInterval: number;

  private readonly hasCredentials: boolean;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pollingInterval = Math.max(5000, (this.config.pollingInterval as number) || 10000);

    this.hasCredentials = Boolean(this.config.username && this.config.password);
    if (!this.hasCredentials) {
      this.log.error('Frigidaire account "username" and "password" are required — the plugin will not start.');
    }

    let cacheDir: string | null = null;
    if (this.config.cacheRefreshToken) {
      cacheDir = path.dirname(api.user.configPath());
    }

    this.client = new FrigidaireClient({
      username: (this.config.username as string) ?? '',
      password: (this.config.password as string) ?? '',
      countryCode: (this.config.countryCode as string) || 'US',
      cacheDir,
      logger: this.log,
    });

    this.api.on('didFinishLaunching', () => {
      if (this.hasCredentials) {
        void this.discoverDevices();
      }
    });
  }

  /** Called by Homebridge for each accessory restored from disk at startup. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /** Discover Frigidaire devices and (re)register them as HomeKit accessories. */
  private async discoverDevices(): Promise<void> {
    try {
      await this.client.connect();
      this.log.debug('Authenticated with Frigidaire; discovering appliances…');

      const appliances = await this.client.getAppliances();
      const validUuids: string[] = [];

      for (const appliance of appliances) {
        if (appliance.reported.applianceInfo?.applianceType !== 'AC') {
          this.log.info('Skipping non-AC appliance:', appliance.name, appliance.reported.applianceInfo?.applianceType);
          continue;
        }

        const uuid = this.api.hap.uuid.generate(appliance.applianceId);
        validUuids.push(uuid);

        const existing = this.accessories.find((accessory) => accessory.UUID === uuid);
        if (existing) {
          this.log.info('Restoring existing accessory from cache:', existing.displayName);
          existing.context.appliance = appliance;
          this.api.updatePlatformAccessories([existing]);
          new FrigidaireACAccessory(this, existing);
        } else {
          this.log.info('Adding new accessory:', appliance.name);
          const accessory = new this.api.platformAccessory(appliance.name, uuid);
          accessory.context.appliance = appliance;
          new FrigidaireACAccessory(this, accessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }

      for (const stale of this.accessories.filter((accessory) => !validUuids.includes(accessory.UUID))) {
        this.log.info('Removing accessory no longer in your Frigidaire account:', stale.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [stale]);
      }
    } catch (err) {
      this.log.error('Failed to discover Frigidaire devices:', String(err));
    }
  }
}
