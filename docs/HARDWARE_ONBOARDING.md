# Hardware Onboarding Checklist

Step-by-step for bringing a real gateway and a real Shengda HAC-MLW meter
online, with the exact verification command for each step. Do these in
order — each step's verification is the precondition for the next.

## 1. Gateway registration

Gateways in NUWACO **self-register from traffic** — there's no manual
"add gateway" step required. Your job here is just getting the physical
gateway talking to ChirpStack.

- [ ] Physical gateway has internet/LAN connectivity and the correct
      ChirpStack server address configured (Semtech UDP packet forwarder or
      Basic Station, pointed at `<your-host>:1700` or the Basic Station
      WebSocket port, depending on gateway model).
- [ ] In ChirpStack (`http://localhost:8080`), go to **Gateways** and
      confirm the gateway appears (ChirpStack-side registration — the
      gateway's EUI shows up once it first connects).
- [ ] Verify NUWACO sees it once a device uplink routes through it:
      ```bash
      curl -s http://localhost:5000/api/gateways -H "Authorization: Bearer $TOKEN"
      ```
      It will only appear here **after** step 3 (a real uplink), not before
      — gateways are discovered from telemetry, not provisioned ahead of time.

## 2. Meter registration (ChirpStack side)

- [ ] In ChirpStack, create an **Application** (e.g. "NUWACO Meters") if
      you haven't already.
- [ ] Create a **Device Profile**: Region = **EU868** (pre-configured —
      `docker/chirpstack/region_eu868.toml`), MAC version per the meter's
      datasheet (typically LoRaWAN 1.0.3), OTAA.
- [ ] Add the **Device**: enter the real **DevEUI** and **AppKey** printed
      on the meter's label/datasheet.
- [ ] Power on the meter and confirm it joins:
      ChirpStack → Applications → your app → Devices → the device should
      show "last seen" update within a few minutes of power-on.

## 3. DevEUI/AppKey setup verification

- [ ] Confirm the join succeeded server-side:
      ```bash
      docker exec geedsan-postgres psql -U geedsan -d chirpstack -c \
        "SELECT dev_eui, name, last_seen_at FROM device WHERE dev_eui = '<DEVEUI_UPPERCASE_HEX>';"
      ```
      `last_seen_at` should be recent.

## 4. Create the matching NUWACO meter record

- [ ] `POST /api/meters` with the **same** `device_eui` (uppercase hex, no
      separators) used in ChirpStack:
      ```bash
      curl -X POST http://localhost:5000/api/meters \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d '{"device_eui":"<DEVEUI>","meter_number":"MTR-001"}'
      ```
      This is the only manual provisioning step in the whole pipeline — the
      device_eui is the join key between ChirpStack and NUWACO.

## 5. MQTT verification

- [ ] Confirm ChirpStack's MQTT integration is actually publishing (not
      just that mosquitto is up):
      ```bash
      docker exec geedsan-mosquitto mosquitto_sub -t 'application/#' -v -C 1
      ```
      Trigger an uplink on the meter (or wait for its next scheduled
      report) and confirm a message appears within its report interval.
- [ ] Confirm the backend's own MQTT client is connected:
      ```bash
      curl -s http://localhost:5000/api/system/health -H "Authorization: Bearer $TOKEN" | grep -A2 '"mqtt"'
      ```

## 6. Uplink verification

- [ ] Confirm the reading actually landed in the database:
      ```bash
      docker exec geedsan-postgres psql -U geedsan -d geedsan_wms -c \
        "SELECT timestamp, total_consumption, battery_voltage, pressure, rssi, gateway_eui FROM meter_readings WHERE device_eui='<DEVEUI>' ORDER BY timestamp DESC LIMIT 5;"
      ```
- [ ] Confirm it shows up in the dashboard: Meters → find the meter →
      should show "Online" and recent "Last Seen".
- [ ] Check the raw packet on the meter's **Diagnostics** tab (signal
      quality chart + packet history table with the raw hex frame) — this
      is the fastest way to confirm what the device is actually sending
      before debating whether the decoder is wrong.

## 7. Decoder validation

- [ ] Cross-check the decoded values against the meter's local display (if
      it has one) or a known reference reading — consumption in particular,
      since pulse-count → liters depends on the **pulse constant**
      (`T=0x14`) matching what's actually configured on the device. If
      consumption looks off by a factor of 10/100, this is almost always
      the pulse constant mismatch — check/set it via:
      ```bash
      curl -X POST http://localhost:5000/api/downlinks/config \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d '{"meter_id":"<METER_UUID>","field":"pulse_constant","value":100}'
      ```
- [ ] If a status-word bit looks wrong (e.g. valve shows closed when it's
      physically open), check the raw status word in the packet history
      table and cross-reference against the bit tables in
      `backend/src/services/shengdaProtocol.js` (`decodeStatusWord1`/`2`) —
      these were verified byte-for-byte against the vendor protocol PDF, so
      a mismatch here usually means the physical device's firmware/wiring
      doesn't match the assumed meter variant (water vs. gas vs. heat —
      each has a different status-word bit layout per the protocol; this
      codebase only implements the water meter variant).
- [ ] If the checksum is wrong (frame gets silently dropped — check
      backend logs for nothing happening despite mosquitto showing the
      message), verify with:
      ```bash
      docker exec geedsan-backend node -e "
        const s = require('./src/services/shengdaProtocol');
        const buf = Buffer.from('<BASE64_FROM_MOSQUITTO_SUB>', 'base64');
        console.log(s.decodeFrame(buf));
      "
      ```
      `checksumValid: false` means either real transmission corruption or
      the frame isn't actually in the expected format — compare against the
      worked examples in the vendor protocol PDF.

## Troubleshooting quick reference

| Symptom | Likely cause | Check |
|---|---|---|
| Gateway never appears in ChirpStack | Network/firewall, wrong server address on gateway | Gateway's own packet-forwarder logs |
| Device never joins | Wrong DevEUI/AppKey, wrong region/frequency plan | ChirpStack device "Join requests" tab |
| Joins but no uplinks reach NUWACO | mosquitto not reachable from ChirpStack, or meter not created in NUWACO yet | `mosquitto_sub`, step 4 |
| Uplinks arrive but consumption is wrong | Pulse constant mismatch | `/api/downlinks/config` (pulse_constant) |
| Meter shows offline despite reporting | `last_seen` not updating — check raw_payload/checksum | Packet history tab, decodeFrame test above |
| Valve status looks backwards | Wiring vs. firmware bit convention mismatch (check with vendor) | Manual valve test + packet history |
