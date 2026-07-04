# NUWACO WMS

Production-ready LoRaWAN Water Meter Management System built with:

- ChirpStack v4
- MQTT (Mosquitto)
- PostgreSQL
- Redis
- Docker Compose
- Next.js Frontend
- Node.js Backend
- Odoo Integration

## Features

- Smart water meter monitoring
- Real-time meter readings
- Valve control (open / close / dredge)
- MQTT integration
- ChirpStack integration
- Alarm management
- Billing support
- Customer management
- Dashboard analytics
- Dockerized deployment

## Stack

| Service | Technology |
|---|---|
| Frontend | Next.js |
| Backend | Node.js |
| Database | PostgreSQL |
| Message Broker | Mosquitto MQTT |
| LoRaWAN Server | ChirpStack v4 |
| Cache | Redis |
| ERP | Odoo 16 |

## Ports

| Service | Port |
|---|---|
| Frontend | 3000 |
| Backend | 5000 |
| ChirpStack | 8080 |
| PostgreSQL | 5432 |
| MQTT | 1883 |

## Docker Deployment

```bash
docker compose up -d
