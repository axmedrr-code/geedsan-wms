from odoo import fields, models, api


class NuwacoAlarm(models.Model):
    _name        = 'nuwaco.alarm'
    _description = 'WMS Alarm'
    _inherit     = ['mail.thread', 'mail.activity.mixin']
    _order       = 'triggered_at desc'

    wms_alarm_id = fields.Char(
        string='WMS Alarm ID', index=True, copy=False,
        help='UUID from alarms table in WMS PostgreSQL.',
    )
    meter_id = fields.Many2one(
        comodel_name='nuwaco.meter',
        string='Meter',
        index=True,
        ondelete='set null',
    )
    partner_id = fields.Many2one(
        related='meter_id.partner_id',
        string='Customer',
        store=True,
        index=True,
    )
    alarm_type = fields.Char(
        string='Alarm Type', required=True,
        help='Free-form type from WMS: leak, tamper, low_battery, overflow, backflow …',
    )
    severity = fields.Selection(
        selection=[
            ('info',     'Info'),
            ('warning',  'Warning'),
            ('critical', 'Critical'),
        ],
        string='Severity', default='warning', tracking=True,
    )
    message     = fields.Text(string='Message')
    triggered_at = fields.Datetime(string='Triggered At')
    resolved_at  = fields.Datetime(string='Resolved At')

    status = fields.Selection(
        selection=[
            ('active',       'Active'),
            ('acknowledged', 'Acknowledged'),
            ('resolved',     'Resolved'),
        ],
        string='Status', default='active', tracking=True,
    )

    name = fields.Char(compute='_compute_name', store=True)

    @api.depends('alarm_type', 'meter_id', 'triggered_at')
    def _compute_name(self):
        for rec in self:
            parts = [rec.alarm_type or 'ALARM']
            if rec.meter_id:
                parts.append(rec.meter_id.name)
            if rec.triggered_at:
                parts.append(rec.triggered_at.strftime('%Y-%m-%d'))
            rec.name = ' / '.join(parts)
