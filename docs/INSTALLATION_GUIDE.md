# GEEDSAN Water Meter Management System
## Complete Installation & Deployment Guide

---

## 🚀 Quick Start (Docker — Recommended)

### Prerequisites
- Docker Desktop (installed and running)
- Git

### 1. Setup Environment
```bash
cd geedsan-wms
cp .env.example .env
# Edit .env with your actual values (API keys, passwords, etc.)
notepad .env   # Windows
# nano .env    # Linux/Mac
```

### 2. Launch Everything
```bash
docker-compose up -d
```

### 3. Access the Dashboard
- **Frontend:** http://localhost:3000
- **API:**      http://localhost:5000
- **Via Nginx:**  http://localhost (port 80)

### Default Login
| Role     | Username   | Password             |
|----------|------------|----------------------|
| Admin    | admin      | Admin@Geedsan2024    |
| Operator | operator1  | Operator@2024        |
| Viewer   | viewer1    | Viewer@2024          |

---

## 🛠️ Manual Installation (Development)

### Requirements
- Node.js 18+ (https://nodejs.org)
- PostgreSQL 14+ (https://postgresql.org)

### Backend Setup
```bash
cd backend
cp .env.example .env
# Edit .env with your DB credentials and API keys
npm install
# Create database:
# psql -U postgres -c "CREATE DATABASE geedsan_wms;"
# psql -U postgres -d geedsan_wms -f ../database/schema.sql
npm run dev
```

### Frontend Setup
```bash
cd frontend
# Create .env.local:
echo "NEXT_PUBLIC_API_URL=http://localhost:5000" > .env.local
npm install
npm run dev
```

---

## 📡 ChirpStack Integration

### 1. Get API Key
- Login to ChirpStack → API Keys → Create API Key
- Copy the key to `CHIRPSTACK_API_KEY` in your `.env`

### 2. Configure Webhook (Uplink)
In ChirpStack → Applications → Your App → Integrations → HTTP:
- **URL:** `http://your-server-ip:5000/api/webhook/chirpstack`
- **Method:** POST
- **Events:** Uplink, Join, ACK

### 3. Valve Commands (Downlink)
| Command     | HEX        | Base64   | fPort |
|-------------|------------|----------|-------|
| Open Valve  | 261F0045   | Jh8ARQ== | 5     |
| Close Valve | 261F0146   | Jh8BRg== | 5     |
| Dredge      | 261F0247   | Jh8CRw== | 5     |

---

## 🗃️ Database

### Tables
| Table              | Purpose                         |
|--------------------|---------------------------------|
| users              | System user accounts            |
| customers          | Water meter customers           |
| meters             | LoRaWAN meter devices           |
| meter_readings     | Time-series consumption data    |
| alarms             | Alarm events and status         |
| downlink_commands  | Sent valve commands             |
| reports            | Generated report records        |
| notifications      | Sent alert history              |
| notification_settings | Per-user alert config        |
| system_settings    | Global configuration            |
| audit_log          | User action audit trail         |

### Backup
```bash
# Backup
docker exec geedsan-postgres pg_dump -U geedsan geedsan_wms > backup.sql

# Restore
docker exec -i geedsan-postgres psql -U geedsan geedsan_wms < backup.sql
```

---

## 🔌 API Reference

### Authentication
```
POST /api/auth/login          Login
POST /api/auth/refresh        Refresh token
GET  /api/auth/me             Current user
POST /api/auth/logout         Logout
POST /api/auth/change-password Change password
```

### Dashboard
```
GET /api/dashboard/stats              Summary stats
GET /api/dashboard/consumption-chart  Trend chart data
GET /api/dashboard/alarm-summary      Alarm breakdown
GET /api/dashboard/recent-alarms      Active alarms
GET /api/dashboard/meter-distribution Status distribution
GET /api/dashboard/top-consumers      Top consumers
```

### Meters
```
GET    /api/meters                List meters (+ search/filter)
GET    /api/meters/:id            Meter detail + readings + alarms
POST   /api/meters                Create meter (Admin/Operator)
PUT    /api/meters/:id            Update meter (Admin/Operator)
DELETE /api/meters/:id            Delete meter (Admin only)
GET    /api/meters/:id/readings   Historical readings (with date range)
```

### Downlinks
```
POST /api/downlinks/valve         Send valve command
GET  /api/downlinks               List sent commands
GET  /api/downlinks/commands      Available commands + Base64
```

### Alarms
```
GET  /api/alarms                  List alarms (filterable)
POST /api/alarms/:id/acknowledge  Acknowledge alarm
POST /api/alarms/:id/resolve      Resolve alarm
POST /api/alarms                  Create manual alarm
DELETE /api/alarms/:id            Delete alarm
```

### AI Features
```
POST /api/ai/leak-detection       Analyze meter for leaks
POST /api/ai/consumption-forecast 7-day usage forecast
POST /api/ai/analyze-alarm        AI alarm root cause analysis
GET  /api/ai/anomalies            Fleet-wide anomaly detection
```

### Reports
```
GET  /api/reports             List generated reports
POST /api/reports/generate    Generate report (PDF/Excel)
GET  /api/reports/:id/download Download report file
```

### Webhook (ChirpStack)
```
POST /api/webhook/chirpstack  Receive uplink / join / ACK events
```

---

## 🤖 AI Features

### Leak Detection
Analyzes 7 days of hourly data for:
- Night-time flow anomalies (1am–5am)
- Flow rate significantly above historical average
- Continuous unexpected consumption

### Consumption Forecast
7-day prediction using moving average with:
- Historical baseline (30 days)
- Confidence intervals (±15%)
- Interactive chart overlay

### Abnormal Consumption Detection
Fleet-wide statistical analysis:
- Z-score based anomaly detection (2σ / 3σ thresholds)
- Flags reversed flow, extreme consumption spikes

### AI Alarm Analysis (Claude)
Auto-analyzes active alarms using Anthropic Claude:
- Root cause assessment
- Recommended action with urgency level

---

## 🔔 Notifications

### Email Setup (Gmail)
1. Enable 2FA on your Gmail account
2. Create App Password: Google Account → Security → App Passwords
3. Set `EMAIL_USER` and `EMAIL_PASS` in `.env`

### Telegram Setup
1. Create bot via @BotFather: `/newbot`
2. Copy bot token → `TELEGRAM_BOT_TOKEN`
3. Get your Chat ID: Send message to bot, then:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Enter Chat ID in notification settings

### WhatsApp Setup
Uses WhatsApp Business API. Set:
- `WHATSAPP_API_URL` - Your API endpoint
- `WHATSAPP_API_KEY` - Your API key

---

## 🔒 Security

### Role Permissions
| Action                | Admin | Operator | Viewer |
|-----------------------|-------|----------|--------|
| View dashboard        | ✅    | ✅       | ✅     |
| View meters/alarms    | ✅    | ✅       | ✅     |
| Send valve commands   | ✅    | ✅       | ❌     |
| Acknowledge alarms    | ✅    | ✅       | ❌     |
| Add/edit meters       | ✅    | ✅       | ❌     |
| Generate reports      | ✅    | ✅       | ✅     |
| Manage users          | ✅    | ❌       | ❌     |
| System settings       | ✅    | ❌       | ❌     |

### Production Checklist
- [ ] Change all default passwords in `.env`
- [ ] Use strong JWT secrets (32+ random characters)
- [ ] Enable HTTPS (update nginx.conf with SSL)
- [ ] Set up database backups (daily cron)
- [ ] Configure firewall (allow only 80/443 publicly)
- [ ] Review and rotate ChirpStack API keys

---

## 📊 Monitoring

### Docker Logs
```bash
docker logs geedsan-backend -f     # API logs
docker logs geedsan-frontend -f    # Frontend logs
docker logs geedsan-postgres -f    # Database logs
docker logs geedsan-nginx -f       # Nginx logs
```

### Health Checks
```
GET http://localhost:5000/health   API health
GET http://localhost:3000          Frontend
```

---

## 🔄 Updates

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

---

## 📞 Support

**GEEDSAN Water Meter Management System v1.0**
Built for LoRaWAN MLW Meter fleets

For issues, check:
1. Docker container logs
2. Database connectivity
3. ChirpStack webhook configuration
4. API key validity
