/**
 * Typed models for the Frigidaire / Electrolux OCP (One Connected Platform)
 * cloud API used by Frigidaire WiFi air conditioners.
 */

export type AcMode = 'OFF' | 'COOL' | 'FANONLY' | 'ECO';
export type FanSpeed = 'LOW' | 'MIDDLE' | 'HIGH' | 'AUTO';
export type TempUnit = 'CELSIUS' | 'FAHRENHEIT';
export type OnOff = 'ON' | 'OFF';
export type FilterState = 'GOOD' | 'BUY' | 'CHANGE' | 'CLEAN';

/** The `properties.reported` blob for an air conditioner (subset we use). */
export interface AcReported {
  applianceInfo?: { applianceType?: string };
  networkInterface?: { swVersion?: string };
  mode?: AcMode;
  /** 'RUNNING' when the compressor is actively cooling. */
  applianceState?: string;
  temperatureRepresentation?: TempUnit;
  targetTemperatureC?: number;
  targetTemperatureF?: number;
  ambientTemperatureC?: number;
  fanSpeedSetting?: FanSpeed;
  verticalSwing?: OnOff;
  filterState?: FilterState;
  [key: string]: unknown;
}

/** A discovered appliance, parsed from the appliances list. */
export interface Appliance {
  /** Full id, e.g. "PNC_ELC:SERIAL-MAC" — used as the command target. */
  applianceId: string;
  serialNumber: string;
  name: string;
  modelType: string;
  firmware: string;
  reported: AcReported;
}

/** Regional connection details returned by the identity-providers endpoint. */
export interface RegionalConfig {
  domain: string;
  apiKey: string;
  httpRegionalBaseUrl: string;
  dataCenter: string;
}

export interface FrigidaireClientOptions {
  username: string;
  password: string;
  /** ISO country code for the account region (required by the OCP API). Default 'US'. */
  countryCode?: string;
  /** Directory to cache the refresh token + regional config (optional). */
  cacheDir?: string | null;
  logger?: Logger;
}

/** Minimal logger interface (Homebridge's Logging satisfies this). */
export interface Logger {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}
