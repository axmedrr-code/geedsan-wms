const mqtt = require('mqtt');
const { query } = require('../config/database');
const logger = require('./logger');
const { decodeMeterPayload } = require('./payloadDecoder');
const { ingestTelemetry } = require('./telemetryService');

let client = null;

const mqttService = {
  async connect() {
    try {
      const brokerUrl = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
      const clientId = process.env.MQTT_CLIENT_ID || `geedsan-backend-${Date.now()}`;
      
      client = mqtt.connect(brokerUrl, {
        clientId,
        username: process.env.MQTT_USERNAME || undefined,
        password: process.env.MQTT_PASSWORD || undefined,
        reconnectPeriod: 5000,
        clean: true
      });

      client.on('connect', () => {
        logger.info(`✅ MQTT connected to ${brokerUrl}`);
        
        // Subscribe to ChirpStack uplink messages
        const topics = [
          'application/+/device/+/event/up',      // Uplink data
          'application/+/device/+/event/join',    // Join events
          'application/+/device/+/event/status'   // Status events
        ];
        
        client.subscribe(topics, (err) => {
          if (err) {
            logger.error('MQTT subscription error:', err);
          } else {
            logger.info(`📡 Subscribed to LoRaWAN topics: ${topics.join(', ')}`);
          }
        });
      });

      client.on('message', async (topic, payload) => {
        try {
          await this.handleMessage(topic, payload);
        } catch (err) {
          logger.error('Error handling MQTT message:', err);
        }
      });

      client.on('error', (err) => {
        logger.error('MQTT error:', err.message);
      });

      client.on('disconnect', () => {
        logger.warn('⚠️  MQTT disconnected');
      });

    } catch (err) {
      logger.error('MQTT connection error:', err);
      setTimeout(() => this.connect(), 5000);
    }
  },

  async handleMessage(topic, payload) {
    try {
      const data = JSON.parse(payload.toString());
      
      // Parse topic: application/{application_id}/device/{device_eui}/event/{event_type}
      const parts = topic.split('/');
      const deviceEui = parts[3];
      const eventType = parts[5];

      if (eventType === 'up') {
        await this.handleUplinkMessage(deviceEui, data);
      } else if (eventType === 'join') {
        await this.handleJoinEvent(deviceEui, data);
      } else if (eventType === 'status') {
        await this.handleStatusEvent(deviceEui, data);
      }
    } catch (err) {
      logger.error('Message parse error:', err);
    }
  },

  async handleUplinkMessage(deviceEui, data) {
    try {
      // Find meter by device EUI
      const meterResult = await query('SELECT * FROM meters WHERE device_eui = $1', [deviceEui]);

      if (!meterResult.rows.length) {
        logger.warn(`⚠️  Device ${deviceEui} not found in database`);
        return;
      }

      const meter = meterResult.rows[0];
      const fPort = data.fPort || 0;
      const fCnt = data.fCnt || 0;
      const rxInfo = data.rxInfo?.[0] || {};

      // Prefer decoding the raw payload ourselves (consistent with the webhook path).
      // Fall back to ChirpStack's codec-decoded object if raw data isn't present.
      const rawData = data.data || '';
      let decoded = rawData ? decodeMeterPayload(rawData) : null;
      if (!decoded || decoded.totalConsumption === null) {
        const objectData = data.objectJSON || data.object || {};
        decoded = {
          totalConsumption: objectData.consumption ?? objectData.total ?? null,
          currentFlow: objectData.flow ?? objectData.current ?? null,
          batteryVoltage: objectData.battery ?? objectData.voltage ?? null,
          pressure: objectData.pressure ?? null,
          valveStatus: objectData.valveStatus ?? null,
          alarmFlags: objectData.alarms || objectData.alarmFlags || {}
        };
      }

      await ingestTelemetry(meter, decoded, {
        rssi: rxInfo.rssi ?? null,
        snr: rxInfo.snr ?? null,
        fPort,
        fCnt,
        rawPayload: rawData || JSON.stringify(data),
        gatewayEui: (rxInfo.gatewayId || '').toUpperCase() || null
      });

      logger.info(`📊 Meter ${deviceEui}: consumption=${decoded.totalConsumption}m³, flow=${decoded.currentFlow}L/h`);
    } catch (err) {
      logger.error(`Error handling uplink from ${deviceEui}:`, err);
    }
  },

  async handleJoinEvent(deviceEui, data) {
    try {
      // Update meter as online when it joins
      await query(
        'UPDATE meters SET is_online = true, last_seen = NOW(), updated_at = NOW() WHERE device_eui = $1',
        [deviceEui]
      );
      
      logger.info(`🔗 Device ${deviceEui} joined LoRaWAN network`);
      
      // Create info-level alarm for join event
      const meterResult = await query('SELECT id FROM meters WHERE device_eui = $1', [deviceEui]);
      if (meterResult.rows.length) {
        await query(
          `INSERT INTO alarms (meter_id, device_eui, alarm_type, severity, message, status, triggered_at)
           VALUES ($1, $2, 'device_join', 'info', 'Device reconnected to network', 'active', NOW())`,
          [meterResult.rows[0].id, deviceEui]
        );
      }
    } catch (err) {
      logger.error(`Error handling join event for ${deviceEui}:`, err);
    }
  },

  async handleStatusEvent(deviceEui, data) {
    try {
      // Handle device status updates
      const battery = data.battery || null;
      const rssi = data.rssi || null;
      
      await query(
        `UPDATE meters SET 
          battery_voltage = COALESCE($2, battery_voltage),
          rssi = COALESCE($3, rssi),
          is_online = true,
          last_seen = NOW(),
          updated_at = NOW()
        WHERE device_eui = $1`,
        [deviceEui, battery, rssi]
      );
      
      logger.debug(`📡 Status update for ${deviceEui}: battery=${battery}, rssi=${rssi}`);
    } catch (err) {
      logger.error(`Error handling status event for ${deviceEui}:`, err);
    }
  },

  async publish(topic, message) {
    if (client && client.connected) {
      return new Promise((resolve, reject) => {
        client.publish(topic, JSON.stringify(message), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  },

  disconnect() {
    if (client) {
      client.end();
      logger.info('MQTT disconnected');
    }
  },

  isConnected() {
    return !!(client && client.connected);
  }
};

module.exports = mqttService;
