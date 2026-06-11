import fs from 'node:fs';
import path from 'node:path';

import type {
  AcReported,
  Appliance,
  FanSpeed,
  FrigidaireClientOptions,
  Logger,
  OnOff,
  RegionalConfig,
  TempUnit,
} from './types.js';

// Public, app-embedded constants (identical to the official Frigidaire app).
const OCP_BASE = 'https://api.ocp.electrolux.one';
const GLOBAL_API_KEY = '3BAfxFtCTdGbJ74udWvSe6ZdPugP8GcKz3nSJVfg';
const OAUTH_CLIENT_ID = 'FrigidaireOneApp';
const OAUTH_CLIENT_SECRET =
  '26SGRupOJaxv4Y1npjBsScjJPuj7f8YTdGxJak3nhAnowCStsBAEzKtrEHsgbqUyh90KFsoty7xXwMNuLYiSEcLqhGQryBM26i435hncaLqj5AuSvWaGNRTACi7ba5yu';

const USER_AGENT = 'Ktor client';
/** Renew the access token this long before it actually expires. */
const TOKEN_RENEW_SKEW_MS = 10 * 60 * 1000;

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

/** Decode a JWT payload without verifying it (we only read the expiry). */
function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload, 'base64').toString('utf8');
    const exp = JSON.parse(json).exp as number | undefined;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * A self-contained client for the Frigidaire / Electrolux OCP cloud API.
 * Replaces the legacy @samthegeek/frigidaire library: native fetch, async/await,
 * automatic token refresh, and optional refresh-token caching.
 */
export class FrigidaireClient {
  private readonly username: string;
  private readonly password: string;
  private readonly countryCode: string;
  private readonly cacheDir: string | null;
  private readonly log: Logger;

  private region: RegionalConfig | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiry = 0;
  private refreshToken: string | null = null;

  /** De-dupes concurrent authentication so we only run the flow once at a time. */
  private authInFlight: Promise<void> | null = null;

  constructor(options: FrigidaireClientOptions) {
    this.username = options.username;
    this.password = options.password;
    this.countryCode = options.countryCode || 'US';
    this.cacheDir = options.cacheDir ?? null;
    this.log = options.logger ?? noopLogger;

    if (this.cacheDir) {
      try {
        const saved = fs.readFileSync(this.refreshTokenPath(), 'utf8').trim();
        if (saved) {
          this.refreshToken = saved;
          this.log.debug('Loaded cached Frigidaire refresh token.');
        }
      } catch {
        // no cached token yet — fine
      }
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP helper
  // ---------------------------------------------------------------------------

  private async http<T>(url: string, init: RequestInit & { json?: unknown }): Promise<T> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    const res = await fetch(url, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /** Bootstrap the regional endpoint (apiKey, regional base URL, data center). */
  private async loadRegion(): Promise<RegionalConfig> {
    if (this.region) {
      return this.region;
    }

    if (this.cacheDir) {
      try {
        this.region = JSON.parse(fs.readFileSync(this.connectionInfoPath(), 'utf8')) as RegionalConfig;
        return this.region;
      } catch {
        // not cached
      }
    }

    // 1) App bearer token via client credentials.
    const appToken = await this.http<{ accessToken: string }>(
      `${OCP_BASE}/one-account-authorization/api/v1/token`,
      {
        method: 'POST',
        json: {
          grantType: 'client_credentials',
          clientId: OAUTH_CLIENT_ID,
          clientSecret: OAUTH_CLIENT_SECRET,
          scope: '',
        },
      },
    );

    // 2) Regional identity provider details for this account.
    const providers = await this.http<RegionalConfig[]>(
      `${OCP_BASE}/one-account-user/api/v1/identity-providers`
        + `?brand=frigidaire&countryCode=${encodeURIComponent(this.countryCode)}&email=${encodeURIComponent(this.username)}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': GLOBAL_API_KEY,
          Authorization: `Bearer ${appToken.accessToken}`,
        },
      },
    );

    const region = providers?.[0];
    if (!region?.httpRegionalBaseUrl) {
      throw new Error('Could not determine the Frigidaire regional endpoint for this account.');
    }
    this.region = region;

    if (this.cacheDir) {
      try {
        fs.writeFileSync(this.connectionInfoPath(), JSON.stringify(region));
      } catch (err) {
        this.log.debug('Could not cache connection info:', String(err));
      }
    }
    return region;
  }

  /** Full Gigya login + OAuth token exchange. */
  private async fullLogin(region: RegionalConfig): Promise<void> {
    const gigyaUrl = `https://accounts.${region.domain}/accounts.login?format=json&httpStatusCodes=false`
      + `&include=id_token&apikey=${encodeURIComponent(region.apiKey)}`
      + `&loginID=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;

    const gigya = await this.http<{ id_token?: string; statusCode?: number; errorMessage?: string }>(gigyaUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'frigidaireApp/5855 CFNetwork/1335.0.3.1 Darwin/21.6.0' },
    });
    if (!gigya.id_token) {
      throw new Error(`Frigidaire login failed${gigya.errorMessage ? `: ${gigya.errorMessage}` : ''} (check your email/password).`);
    }

    const tokens = await this.http<{ accessToken: string; refreshToken: string }>(
      `${region.httpRegionalBaseUrl}/one-account-authorization/api/v1/token`,
      {
        method: 'POST',
        headers: { 'x-api-key': GLOBAL_API_KEY, 'Origin-Country-Code': region.dataCenter },
        json: {
          grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
          clientId: OAUTH_CLIENT_ID,
          idToken: gigya.id_token,
          scope: '',
        },
      },
    );
    this.storeTokens(tokens.accessToken, tokens.refreshToken);
  }

  /** Exchange the cached refresh token for a fresh access token. */
  private async refreshAccessToken(region: RegionalConfig): Promise<void> {
    const tokens = await this.http<{ accessToken: string; refreshToken: string }>(
      `${region.httpRegionalBaseUrl}/one-account-authorization/api/v1/token`,
      {
        method: 'POST',
        headers: { 'x-api-key': GLOBAL_API_KEY, 'Origin-Country-Code': region.dataCenter },
        json: {
          grantType: 'refresh_token',
          clientId: OAUTH_CLIENT_ID,
          refreshToken: this.refreshToken,
        },
      },
    );
    this.storeTokens(tokens.accessToken, tokens.refreshToken);
  }

  private storeTokens(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accessTokenExpiry = jwtExpiryMs(accessToken) ?? Date.now() + 30 * 60 * 1000;
    if (this.cacheDir) {
      try {
        fs.writeFileSync(this.refreshTokenPath(), refreshToken);
      } catch (err) {
        this.log.debug('Could not cache refresh token:', String(err));
      }
    }
  }

  /** Ensure we hold a valid access token, (re)authenticating as needed. */
  private async ensureAuth(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - TOKEN_RENEW_SKEW_MS) {
      return this.accessToken;
    }
    if (!this.authInFlight) {
      this.authInFlight = this.authenticate().finally(() => {
        this.authInFlight = null;
      });
    }
    await this.authInFlight;
    if (!this.accessToken) {
      throw new Error('Frigidaire authentication failed.');
    }
    return this.accessToken;
  }

  private async authenticate(): Promise<void> {
    const region = await this.loadRegion();
    if (this.refreshToken) {
      try {
        await this.refreshAccessToken(region);
        return;
      } catch (err) {
        this.log.debug('Refresh token rejected, falling back to full login:', String(err));
        this.refreshToken = null;
      }
    }
    await this.fullLogin(region);
  }

  /** Authenticate up-front; surfaces credential errors at startup. */
  async connect(): Promise<void> {
    await this.ensureAuth();
  }

  // ---------------------------------------------------------------------------
  // Appliances
  // ---------------------------------------------------------------------------

  private async authedGet<T>(uriPath: string): Promise<T> {
    const region = await this.loadRegion();
    const token = await this.ensureAuth();
    return this.http<T>(`${region.httpRegionalBaseUrl}${uriPath}`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, 'x-api-key': GLOBAL_API_KEY, Authorization: `Bearer ${token}` },
    });
  }

  /** List all appliances on the account, parsed into a typed shape. */
  async getAppliances(): Promise<Appliance[]> {
    const raw = await this.authedGet<RawAppliance[]>('/appliance/api/v2/appliances?includeMetadata=true');
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => {
      const reported = (item.properties?.reported ?? {}) as AcReported;
      return {
        applianceId: item.applianceId,
        serialNumber: item.applianceId.split(':')[1]?.split('-')[0] ?? item.applianceId,
        name: item.applianceData?.applianceName ?? 'Frigidaire AC',
        modelType: item.applianceId.split(':')[0] ?? 'AC',
        firmware: reported.networkInterface?.swVersion?.replace(/[^\d.-]/g, '') || '1.0.0',
        reported,
      };
    });
  }

  /** Fetch just the reported state for one appliance. */
  async getReported(applianceId: string): Promise<AcReported> {
    const appliances = await this.getAppliances();
    const found = appliances.find((a) => a.applianceId === applianceId);
    if (!found) {
      throw new Error(`Appliance ${applianceId} not found.`);
    }
    return found.reported;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  private async command(applianceId: string, attribute: string, value: unknown): Promise<void> {
    const region = await this.loadRegion();
    const token = await this.ensureAuth();
    await this.http(`${region.httpRegionalBaseUrl}/appliance/api/v2/appliances/${applianceId}/command`, {
      method: 'PUT',
      headers: { 'User-Agent': USER_AGENT, 'x-api-key': GLOBAL_API_KEY, Authorization: `Bearer ${token}` },
      json: { [attribute]: value },
    });
  }

  setMode(applianceId: string, mode: AcReported['mode']): Promise<void> {
    return this.command(applianceId, 'mode', mode);
  }

  setFanSpeed(applianceId: string, speed: FanSpeed): Promise<void> {
    return this.command(applianceId, 'fanSpeedSetting', speed);
  }

  setVerticalSwing(applianceId: string, on: boolean): Promise<void> {
    return this.command(applianceId, 'verticalSwing', (on ? 'ON' : 'OFF') as OnOff);
  }

  setUnits(applianceId: string, unit: TempUnit): Promise<void> {
    return this.command(applianceId, 'temperatureRepresentation', unit);
  }

  /** Set the target temperature in Celsius. */
  setTargetTemperatureC(applianceId: string, celsius: number): Promise<void> {
    return this.command(applianceId, 'targetTemperatureC', Number(celsius.toFixed(1)));
  }

  /** Set the target temperature in whole degrees Fahrenheit. */
  setTargetTemperatureF(applianceId: string, fahrenheit: number): Promise<void> {
    return this.command(applianceId, 'targetTemperatureF', Math.round(fahrenheit));
  }

  /**
   * Set the target temperature for a HomeKit request (always Celsius), sending
   * it in whichever unit the appliance is currently configured for.
   */
  setTargetTemperature(applianceId: string, celsius: number, unit: TempUnit): Promise<void> {
    return unit === 'FAHRENHEIT'
      ? this.setTargetTemperatureF(applianceId, celsius * 9 / 5 + 32)
      : this.setTargetTemperatureC(applianceId, celsius);
  }

  // ---------------------------------------------------------------------------
  // Cache paths
  // ---------------------------------------------------------------------------

  private refreshTokenPath(): string {
    return path.join(this.cacheDir as string, `.frigidaireRefreshToken_${this.username}`);
  }

  private connectionInfoPath(): string {
    return path.join(this.cacheDir as string, `.frigidaireConnectionInfo_${this.username}`);
  }
}

/** Raw appliance entry as returned by /appliance/api/v2/appliances. */
interface RawAppliance {
  applianceId: string;
  applianceData?: { applianceName?: string };
  properties?: { reported?: Record<string, unknown> };
}
