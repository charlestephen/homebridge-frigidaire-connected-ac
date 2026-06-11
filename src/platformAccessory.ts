import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { FrigidaireACPlatform } from './platform.js';
import type { AcReported, Appliance, FanSpeed, TempUnit } from './frigidaire/index.js';

/** Cached HomeKit-facing state. `onGet` returns from here (fast); `refresh()` keeps it fresh. */
interface AcState {
  active: CharacteristicValue;
  currentState: CharacteristicValue;
  currentTemp: number;
  targetTemp: number;
  units: CharacteristicValue;
  fanActive: CharacteristicValue;
  currentFanState: CharacteristicValue;
  targetFanState: CharacteristicValue;
  fanSpeed: number;
  swing: CharacteristicValue;
  eco: boolean;
  filter: CharacteristicValue;
}

/** Debounce so rapid HomeKit slider drags collapse into a single API call. */
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Fan speed <-> setting mapping (HomeKit 0-100 in thirds <-> LOW/MIDDLE/HIGH).
function fanFromSpeed(speed: number): FanSpeed {
  if (speed <= 33.33) {
    return 'LOW';
  }
  if (speed <= 66.66) {
    return 'MIDDLE';
  }
  return 'HIGH';
}

function speedFromFan(setting?: FanSpeed): number {
  switch (setting) {
    case 'LOW': return 33.33;
    case 'MIDDLE': return 66.66;
    case 'HIGH':
    case 'AUTO': return 99.99;
    default: return 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * One instance per Frigidaire AC: a HeaterCooler (cooling only), a Fanv2 (speed
 * + vertical swing), an Eco-mode switch, and a FilterMaintenance sensor.
 */
export class FrigidaireACAccessory {
  private readonly heaterCooler: Service;
  private readonly fan: Service;
  private readonly ecoSwitch: Service;
  private readonly filterMaintenance: Service;

  private readonly C: FrigidaireACPlatform['Characteristic'];
  private readonly id: string;

  private readonly state: AcState;
  private readonly setFanSpeedDebounced: (value: number) => void;

  constructor(
    private readonly platform: FrigidaireACPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.C = platform.Characteristic;

    const appliance = accessory.context.appliance as Appliance;
    this.id = appliance.applianceId;

    this.state = {
      active: this.C.Active.INACTIVE,
      currentState: this.C.CurrentHeaterCoolerState.INACTIVE,
      currentTemp: 20,
      targetTemp: 22,
      units: this.C.TemperatureDisplayUnits.FAHRENHEIT,
      fanActive: this.C.Active.INACTIVE,
      currentFanState: this.C.CurrentFanState.INACTIVE,
      targetFanState: this.C.TargetFanState.AUTO,
      fanSpeed: 0,
      swing: this.C.SwingMode.SWING_DISABLED,
      eco: false,
      filter: this.C.FilterChangeIndication.FILTER_OK,
    };

    this.setFanSpeedDebounced = debounce((value: number) => {
      void this.setFanSpeed(value);
    }, 500);

    accessory.category = platform.api.hap.Categories.AIR_CONDITIONER;

    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, 'Frigidaire')
      .setCharacteristic(this.C.Model, appliance.modelType)
      .setCharacteristic(this.C.SerialNumber, appliance.serialNumber)
      .setCharacteristic(this.C.FirmwareRevision, appliance.firmware);

    this.heaterCooler = accessory.getService(platform.Service.HeaterCooler)
      || accessory.addService(platform.Service.HeaterCooler);
    this.fan = accessory.getService(platform.Service.Fanv2)
      || accessory.addService(platform.Service.Fanv2);
    this.ecoSwitch = accessory.getService('eco-mode')
      || accessory.addService(platform.Service.Switch, `${appliance.name} Eco Mode`, 'eco-mode');
    this.filterMaintenance = accessory.getService(platform.Service.FilterMaintenance)
      || accessory.addService(platform.Service.FilterMaintenance);

    this.heaterCooler.setPrimaryService(true);
    this.heaterCooler.addLinkedService(this.ecoSwitch);
    this.heaterCooler.addLinkedService(this.filterMaintenance);

    this.heaterCooler.setCharacteristic(this.C.Name, appliance.name);
    this.fan.setCharacteristic(this.C.Name, `${appliance.name} Fan`);
    this.ecoSwitch.setCharacteristic(this.C.Name, `${appliance.name} Eco Mode`);

    // --- HeaterCooler (cooling only) ---
    this.heaterCooler.getCharacteristic(this.C.Active)
      .onGet(() => this.state.active)
      .onSet(this.setActive.bind(this));

    this.heaterCooler.getCharacteristic(this.C.CurrentHeaterCoolerState)
      .onGet(() => this.state.currentState);

    this.heaterCooler.getCharacteristic(this.C.TargetHeaterCoolerState)
      .setProps({ validValues: [this.C.TargetHeaterCoolerState.COOL] })
      .onGet(() => this.C.TargetHeaterCoolerState.COOL)
      .onSet(() => { /* cooling-only device */ });

    this.heaterCooler.getCharacteristic(this.C.CurrentTemperature)
      .onGet(() => this.state.currentTemp);

    this.heaterCooler.getCharacteristic(this.C.CoolingThresholdTemperature)
      .setProps({ minValue: 15.56, maxValue: 32.22, minStep: 0.1 })
      .onGet(() => this.state.targetTemp)
      .onSet(this.setTargetTemp.bind(this));

    this.heaterCooler.getCharacteristic(this.C.TemperatureDisplayUnits)
      .onGet(() => this.state.units)
      .onSet(this.setUnits.bind(this));

    // --- Fan (speed + vertical swing) ---
    this.fan.getCharacteristic(this.C.Active)
      .onGet(() => this.state.fanActive)
      .onSet(this.setFanActive.bind(this));

    this.fan.getCharacteristic(this.C.CurrentFanState)
      .onGet(() => this.state.currentFanState);

    this.fan.getCharacteristic(this.C.TargetFanState)
      .onGet(() => this.state.targetFanState)
      .onSet(this.setTargetFanState.bind(this));

    this.fan.getCharacteristic(this.C.RotationSpeed)
      .setProps({ minStep: 33.33 })
      .onGet(() => this.state.fanSpeed)
      .onSet((value) => this.setFanSpeedDebounced(value as number));

    this.fan.getCharacteristic(this.C.SwingMode)
      .onGet(() => this.state.swing)
      .onSet(this.setSwing.bind(this));

    // --- Eco mode switch ---
    this.ecoSwitch.getCharacteristic(this.C.On)
      .onGet(() => this.state.eco)
      .onSet(this.setEco.bind(this));

    // --- Filter ---
    this.filterMaintenance.getCharacteristic(this.C.FilterChangeIndication)
      .onGet(() => this.state.filter);

    // Seed from the discovery snapshot, then poll.
    this.applyReported(appliance.reported);
    void this.refresh();
    setInterval(() => void this.refresh(), this.platform.pollingInterval);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    try {
      const reported = await this.platform.client.getReported(this.id);
      this.applyReported(reported);
      this.pushAll();
    } catch (err) {
      this.platform.log.debug(`[${this.accessory.displayName}] refresh failed:`, String(err));
    }
  }

  /** Map a reported telemetry snapshot into the cached HomeKit state. */
  private applyReported(r: AcReported): void {
    const mode = r.mode ?? 'OFF';
    const cooling = mode !== 'OFF' && mode !== 'FANONLY';
    const fanRunning = mode !== 'OFF';

    this.state.active = cooling ? this.C.Active.ACTIVE : this.C.Active.INACTIVE;
    this.state.eco = mode === 'ECO';
    this.state.currentState = r.applianceState === 'RUNNING'
      ? this.C.CurrentHeaterCoolerState.COOLING
      : this.C.CurrentHeaterCoolerState.INACTIVE;

    if (typeof r.ambientTemperatureC === 'number') {
      this.state.currentTemp = r.ambientTemperatureC;
    }
    if (typeof r.targetTemperatureC === 'number') {
      this.state.targetTemp = clamp(r.targetTemperatureC, 15.56, 32.22);
    }
    this.state.units = r.temperatureRepresentation === 'FAHRENHEIT'
      ? this.C.TemperatureDisplayUnits.FAHRENHEIT
      : this.C.TemperatureDisplayUnits.CELSIUS;

    this.state.fanActive = fanRunning ? this.C.Active.ACTIVE : this.C.Active.INACTIVE;
    this.state.currentFanState = fanRunning
      ? this.C.CurrentFanState.BLOWING_AIR
      : this.C.CurrentFanState.INACTIVE;
    this.state.targetFanState = r.fanSpeedSetting === 'AUTO'
      ? this.C.TargetFanState.AUTO
      : this.C.TargetFanState.MANUAL;
    this.state.fanSpeed = fanRunning ? speedFromFan(r.fanSpeedSetting) : 0;
    this.state.swing = r.verticalSwing === 'ON'
      ? this.C.SwingMode.SWING_ENABLED
      : this.C.SwingMode.SWING_DISABLED;
    this.state.filter = (r.filterState ?? 'GOOD') === 'GOOD'
      ? this.C.FilterChangeIndication.FILTER_OK
      : this.C.FilterChangeIndication.CHANGE_FILTER;
  }

  private pushAll(): void {
    this.heaterCooler.updateCharacteristic(this.C.Active, this.state.active);
    this.heaterCooler.updateCharacteristic(this.C.CurrentHeaterCoolerState, this.state.currentState);
    this.heaterCooler.updateCharacteristic(this.C.CurrentTemperature, this.state.currentTemp);
    this.heaterCooler.updateCharacteristic(this.C.CoolingThresholdTemperature, this.state.targetTemp);
    this.heaterCooler.updateCharacteristic(this.C.TemperatureDisplayUnits, this.state.units);

    this.fan.updateCharacteristic(this.C.Active, this.state.fanActive);
    this.fan.updateCharacteristic(this.C.CurrentFanState, this.state.currentFanState);
    this.fan.updateCharacteristic(this.C.TargetFanState, this.state.targetFanState);
    this.fan.updateCharacteristic(this.C.RotationSpeed, this.state.fanSpeed);
    this.fan.updateCharacteristic(this.C.SwingMode, this.state.swing);

    this.ecoSwitch.updateCharacteristic(this.C.On, this.state.eco);
    this.filterMaintenance.updateCharacteristic(this.C.FilterChangeIndication, this.state.filter);
  }

  // ---------------------------------------------------------------------------
  // SET handlers
  // ---------------------------------------------------------------------------

  private async setActive(value: CharacteristicValue): Promise<void> {
    if (value === this.state.active) {
      return;
    }
    const mode = value === this.C.Active.ACTIVE ? (this.state.eco ? 'ECO' : 'COOL') : 'OFF';
    await this.platform.client.setMode(this.id, mode);
    this.state.active = value;
    this.heaterCooler.updateCharacteristic(this.C.Active, value);
  }

  private async setTargetTemp(value: CharacteristicValue): Promise<void> {
    if (value === this.state.targetTemp) {
      return;
    }
    // HomeKit always sends Celsius; command in whatever unit the AC reports
    // (these units natively run in whole degrees Fahrenheit).
    const unit: TempUnit = this.state.units === this.C.TemperatureDisplayUnits.FAHRENHEIT ? 'FAHRENHEIT' : 'CELSIUS';
    await this.platform.client.setTargetTemperature(this.id, value as number, unit);
    this.state.targetTemp = value as number;
    this.heaterCooler.updateCharacteristic(this.C.CoolingThresholdTemperature, value);
  }

  private async setUnits(value: CharacteristicValue): Promise<void> {
    if (value === this.state.units) {
      return;
    }
    await this.platform.client.setUnits(this.id, value === this.C.TemperatureDisplayUnits.FAHRENHEIT ? 'FAHRENHEIT' : 'CELSIUS');
    this.state.units = value;
    this.heaterCooler.updateCharacteristic(this.C.TemperatureDisplayUnits, value);
  }

  private async setFanActive(value: CharacteristicValue): Promise<void> {
    if (value === this.state.fanActive) {
      return;
    }
    await this.platform.client.setMode(this.id, value === this.C.Active.ACTIVE ? 'FANONLY' : 'OFF');
    this.state.fanActive = value;
    this.fan.updateCharacteristic(this.C.Active, value);
  }

  private async setTargetFanState(value: CharacteristicValue): Promise<void> {
    if (value === this.state.targetFanState) {
      return;
    }
    const speed: FanSpeed = value === this.C.TargetFanState.AUTO ? 'AUTO' : fanFromSpeed(this.state.fanSpeed);
    await this.platform.client.setFanSpeed(this.id, speed);
    this.state.targetFanState = value;
    this.fan.updateCharacteristic(this.C.TargetFanState, value);
  }

  private async setFanSpeed(value: number): Promise<void> {
    if (value === this.state.fanSpeed) {
      return;
    }
    const speed = fanFromSpeed(value);
    await this.platform.client.setFanSpeed(this.id, speed);
    this.state.fanSpeed = speedFromFan(speed);
    this.fan.updateCharacteristic(this.C.RotationSpeed, this.state.fanSpeed);
  }

  private async setSwing(value: CharacteristicValue): Promise<void> {
    if (value === this.state.swing) {
      return;
    }
    await this.platform.client.setVerticalSwing(this.id, value === this.C.SwingMode.SWING_ENABLED);
    this.state.swing = value;
    this.fan.updateCharacteristic(this.C.SwingMode, value);
  }

  private async setEco(value: CharacteristicValue): Promise<void> {
    const on = Boolean(value);
    if (!on && this.state.active === this.C.Active.INACTIVE) {
      this.state.eco = false;
      return;
    }
    await this.platform.client.setMode(this.id, on ? 'ECO' : 'COOL');
    this.state.eco = on;
    this.ecoSwitch.updateCharacteristic(this.C.On, on);
  }
}
