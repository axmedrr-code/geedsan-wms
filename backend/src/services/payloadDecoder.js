const shengda = require('./shengdaProtocol');

// Decodes a Shengda HAC-MLW uplink frame (base64-encoded over LoRaWAN) into
// the normalized shape consumed by telemetryService/alarmService. Pure
// protocol decode only — no DB access, no meter-specific defaults (e.g. the
// pulse constant fallback is applied downstream where the meter row is known).
const decodeMeterPayload = (base64Data) => {
  const empty = {
    totalConsumption: null, currentFlow: null, batteryVoltage: null, pressure: null,
    alarmFlags: {}, valveStatus: null, pulseCount: null, pulseConstantLiters: null,
    statusWord1: null, statusWord2: null, triggerSource: null, meterSerial: null,
    historicalFlow: null, checksumValid: null
  };

  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 3) return empty;

    const { fields, checksumValid } = shengda.decodeFrame(buf);
    const result = { ...empty, checksumValid };

    if (fields.pulseCount !== undefined) result.pulseCount = fields.pulseCount;
    if (fields.pulseConstant !== undefined) result.pulseConstantLiters = fields.pulseConstant;
    if (fields.instantaneousFlow !== undefined) result.currentFlow = fields.instantaneousFlow;
    if (fields.batteryVoltage !== undefined) result.batteryVoltage = Number(fields.batteryVoltage.toFixed(3));
    if (fields.pressure !== undefined) result.pressure = fields.pressure; // kPa, per spec T=0x40
    if (fields.deviceSerial !== undefined) result.meterSerial = String(fields.deviceSerial);
    if (fields.triggerSource !== undefined) result.triggerSource = fields.triggerSource;
    if (fields.historicalFlow !== undefined) result.historicalFlow = fields.historicalFlow;

    if (fields.statusWord !== undefined) {
      const { word1, word2 } = shengda.splitStatusWord(fields.statusWord);
      result.statusWord1 = word1;
      result.statusWord2 = word2;

      const w1 = shengda.decodeStatusWord1(word1);
      const w2 = shengda.decodeStatusWord2(word2);
      result.valveStatus = w1.valve_closed ? 'closed' : 'open';

      result.alarmFlags = {
        valve_fault: w1.valve_fault,
        low_battery: w1.low_battery,
        magnetic_attack: w1.magnetic_attack,
        battery_removed: w1.battery_removed,
        metering_fault: w1.metering_fault,
        water_inlet_alarm: w2.water_inlet_alarm,
        water_return_alarm: w2.water_return_alarm,
        flow_alarm: w2.flow_alarm,
        water_leakage: w2.leakage,
        pipe_burst: w2.tube_burst,
        reverse_flow: w2.historical_magnetic_attack
      };
    }

    // Consumption requires the pulse constant; only computable here if the
    // device included it in this same frame (T=0x14 is usually configured
    // once, not sent on every report) — otherwise left null for the caller
    // to compute using the meter's stored pulse_constant_liters.
    if (result.pulseCount !== null && result.pulseConstantLiters !== null) {
      result.totalConsumption = (result.pulseCount * result.pulseConstantLiters) / 1000; // m³
    }

    return result;
  } catch {
    return empty;
  }
};

module.exports = { decodeMeterPayload };
