from odoo import fields, models, api


class NuwacoReading(models.Model):
    _name        = 'nuwaco.reading'
    _description = 'Meter Reading'
    _order       = 'timestamp desc'
    _rec_name    = 'display_name'

    wms_reading_id = fields.Integer(
        string='WMS Reading ID', index=True, copy=False,
        help='BIGSERIAL id from meter_readings in WMS PostgreSQL.',
    )
    meter_id = fields.Many2one(
        comodel_name='nuwaco.meter',
        string='Meter',
        required=True,
        index=True,
        ondelete='cascade',
    )
    partner_id = fields.Many2one(
        related='meter_id.partner_id',
        string='Customer',
        store=True,
        index=True,
    )
    timestamp         = fields.Datetime(string='Timestamp', required=True)
    total_consumption = fields.Float(string='Total Consumption (m³)', digits=(12, 3))
    current_flow      = fields.Float(string='Flow (m³/h)',            digits=(8, 3))
    battery_voltage   = fields.Float(string='Battery (V)',            digits=(4, 2))
    rssi              = fields.Integer(string='RSSI (dBm)')

    display_name = fields.Char(compute='_compute_display_name', store=False)

    @api.depends('meter_id', 'timestamp')
    def _compute_display_name(self):
        for rec in self:
            meter = rec.meter_id.name or ''
            ts    = rec.timestamp.strftime('%Y-%m-%d %H:%M') if rec.timestamp else ''
            rec.display_name = f'{meter} / {ts}'
