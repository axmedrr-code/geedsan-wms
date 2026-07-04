const { query } = require('../config/database');
const { sendDownlink } = require('./chirpstackService');

const MAX_RETRIES = 3;

const processFailedDownlinks = async () => {
  const r = await query(
    `SELECT * FROM downlink_commands WHERE status='failed' AND retry_count < $1 AND (next_retry_at IS NULL OR next_retry_at <= NOW()) ORDER BY created_at ASC LIMIT 20`,
    [MAX_RETRIES]
  );
  if (!r.rows.length) return 0;

  for (const cmd of r.rows) {
    const { status, chirpstackId, errorMessage } = await sendDownlink(cmd.device_eui, cmd.command_base64, cmd.f_port);
    const retryCount = cmd.retry_count + 1;
    const nextRetryAt = status === 'failed' && retryCount < MAX_RETRIES ? new Date(Date.now() + retryCount * 5 * 60 * 1000) : null;
    await query(
      `UPDATE downlink_commands SET status=$1,chirpstack_id=$2,error_message=$3,retry_count=$4,next_retry_at=$5 WHERE id=$6`,
      [status, chirpstackId, errorMessage, retryCount, nextRetryAt, cmd.id]
    );
    if (status === 'sent') {
      const newValveStatus = cmd.command_type === 'open_valve' ? 'open' : cmd.command_type === 'close_valve' ? 'closed' : 'unknown';
      await query('UPDATE meters SET valve_status=$1,updated_at=NOW() WHERE id=$2', [newValveStatus, cmd.meter_id]);
    }
  }

  return r.rows.length;
};

module.exports = { processFailedDownlinks };
