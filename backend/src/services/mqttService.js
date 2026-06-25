const mqtt = require('mqtt');
const { query } = require('../config/database');
const logger = require('./logger');

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
      const meterResult = await query(
        'SELECT id FROM meters WHERE device_eui = $1',
        [deviceEui]
      );

      if (!meterResult.rows.length) {
        logger.warn(`⚠️  Device ${deviceEui} not found in database`);
        return;
      }

      const meterId = meterResult.rows[0].id;
      
      // Extract payload data
      const fPort = data.fPort || 0;
      const fCnt = data.fCnt || 0;
      const rxInfo = data.rxInfo?.[0] || {};
      const txInfo = data.txInfo || {};
      
      // Decode payload (assumes ChirpStack application server decoding)
      const objectData = data.objectJSON || data.data || {};
      const totalConsumption = objectData.consumption || objectData.total || null;
      const currentFlow = objectData.flow || objectData.current || null;
      const batteryVoltage = objectData.battery || objectData.voltage || null;

      // Store meter reading
      await query(
        `INSERT INTO meter_readings (
          meter_id, device_eui, timestamp, total_consumption, current_flow, 
          battery_voltage, rssi, snr, f_port, f_cnt, raw_payload, alarm_flags, created_at
        ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
        [
          meterId,
          deviceEui,
          totalConsumption,
          currentFlow,
          batteryVoltage,
          rxInfo.rssi || null,
          rxInfo.snr || null,
          fPort,
          fCnt,
          JSON.stringify(data),
          JSON.stringify(objectData.alarms || {})
        ]
      );

      // Update meter with latest values
      await query(
        `UPDATE meters SET 
          total_consumption = COALESCE($2, total_consumption),
          current_flow = COALESCE($3, current_flow),
          battery_voltage = COALESCE($4, battery_voltage),
          rssi = $5,
          snr = $6,
          is_online = true,
          last_seen = NOW(),
          updated_at = NOW()
        WHERE id = $1`,
        [
          meterId,
          totalConsumption,
          currentFlow,
          batteryVoltage,
          rxInfo.rssi || null,
          rxInfo.snr || null
        ]
      );

      logger.info(`📊 Meter ${deviceEui}: consumption=${totalConsumption}m³, flow=${currentFlow}L/h`);

      // Check for alarms/anomalies
      await this.checkAlarms(meterId, deviceEui, objectData);

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

  async checkAlarms(meterId, deviceEui, data) {
    try {
      const alarms = [];

      // Low battery alarm
      if (data.battery && data.battery < 2.5) {
        alarms.push({
          type: 'low_battery',
          severity: 'warning',
          message: `Battery voltage low: ${data.battery}V`
        });
      }

      // High flow alarm
      if (data.flow && data.flow > 100) {
        alarms.push({
          type: 'high_flow',
          severity: 'warning',
          message: `High flow detected: ${data.flow}L/h`
        });
      }

      // Meter tamper alarm
      if (data.tamper) {
        alarms.push({
          type: 'meter_tamper',
          severity: 'critical',
          message: 'Meter tampering detected'
        });
      }

      // Insert alarms into database
      for (const alarm of alarms) {
        await query(
          `INSERT INTO alarms (meter_id, device_eui, alarm_type, severity, message, status, triggered_at)
           VALUES ($1, $2, $3, $4, $5, 'active', NOW())`,
          [meterId, deviceEui, alarm.type, alarm.severity, alarm.message]
        );
      }

      if (alarms.length > 0) {
        logger.warn(`⚠️  New alarms for ${deviceEui}: ${alarms.map(a => a.type).join(', ')}`);
      }
    } catch (err) {
      logger.error('Error checking alarms:', err);
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
  }
};

module.exports = mqttService;
