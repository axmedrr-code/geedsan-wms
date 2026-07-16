from odoo import fields, models, api


class NuwacoMeter(models.Model):
    _name        = 'nuwaco.meter'
    _description = 'Water Meter'
    _inherit     = ['mail.thread', 'mail.activity.mixin']
    _order       = 'name asc'

    name = fields.Char(
        string='Meter Number', required=True, tracking=True,
        help='Human-readable meter number (e.g. MTR-0001) or Device EUI.',
    )
    wms_meter_id = fields.Char(
        string='WMS Meter ID', index=True, copy=False,
        help='UUID of this meter in the NUWACO WMS PostgreSQL database.',
    )
    device_eui = fields.Char(string='Device EUI', index=True, copy=False)
    meter_serial = fields.Char(string='Serial Number')

    partner_id = fields.Many2one(
        comodel_name='res.partner',
        string='Customer',
        index=True,
        tracking=True,
        domain="[('is_water_customer', '=', True)]",
    )

    meter_type = fields.Selection(
        selection=[
            ('residential', 'Residential'),
            ('commercial',  'Commercial'),
            ('industrial',  'Industrial'),
            ('government',  'Government'),
        ],
        string='Meter Type', default='residential', tracking=True,
    )
    status = fields.Selection(
        selection=[
            ('active',   'Active'),
            ('inactive', 'Inactive'),
            ('faulty',   'Faulty'),
            ('removed',  'Removed'),
        ],
        string='Status', default='active', tracking=True,
    )
    valve_status = fields.Selection(
        selection=[
            ('open',    'Open'),
            ('closed',  'Closed'),
            ('unknown', 'Unknown'),
            ('fault',   'Fault'),
        ],
        string='Valve', default='unknown',
    )
    is_online = fields.Boolean(string='Online', default=False)

    total_consumption = fields.Float(string='Total Consumption (m³)', digits=(12, 3))
    current_flow      = fields.Float(string='Current Flow (m³/h)',    digits=(8, 3))
    battery_voltage   = fields.Float(string='Battery Voltage (V)',    digits=(4, 2))

    latitude             = fields.Float(string='Latitude',  digits=(10, 7))
    longitude            = fields.Float(string='Longitude', digits=(10, 7))
    installation_address = fields.Text(string='Installation Address')
    installed_at         = fields.Datetime(string='Installed At')
    last_seen            = fields.Datetime(string='Last Seen')

    reading_ids = fields.One2many(
        comodel_name='nuwaco.reading',
        inverse_name='meter_id',
        string='Readings',
    )
    reading_count = fields.Integer(compute='_compute_reading_count')

    alarm_ids = fields.One2many(
        comodel_name='nuwaco.alarm',
        inverse_name='meter_id',
        string='Alarms',
    )
    alarm_count = fields.Integer(compute='_compute_alarm_count')

    invoice_ids = fields.Many2many(
        comodel_name='account.move',
        relation='nuwaco_meter_invoice_rel',
        column1='meter_id',
        column2='move_id',
        string='Invoices',
        compute='_compute_invoice_ids',
        store=False,
    )
    invoice_count = fields.Integer(compute='_compute_invoice_count')

    @api.depends('reading_ids')
    def _compute_reading_count(self):
        for rec in self:
            rec.reading_count = len(rec.reading_ids)

    @api.depends('alarm_ids')
    def _compute_alarm_count(self):
        for rec in self:
            rec.alarm_count = len(rec.alarm_ids)

    def _compute_invoice_ids(self):
        for rec in self:
            rec.invoice_ids = self.env['account.move'].search([
                ('wms_meter_id', '=', rec.id),
                ('move_type', '=', 'out_invoice'),
            ])

    @api.depends()
    def _compute_invoice_count(self):
        for rec in self:
            rec.invoice_count = self.env['account.move'].search_count([
                ('wms_meter_id', '=', rec.id),
                ('move_type', '=', 'out_invoice'),
            ])

    def action_view_readings(self):
        return {
            'type': 'ir.actions.act_window',
            'name': 'Readings',
            'res_model': 'nuwaco.reading',
            'view_mode': 'list,form',
            'domain': [('meter_id', '=', self.id)],
            'context': {'default_meter_id': self.id},
        }

    def action_view_alarms(self):
        return {
            'type': 'ir.actions.act_window',
            'name': 'Alarms',
            'res_model': 'nuwaco.alarm',
            'view_mode': 'list,form',
            'domain': [('meter_id', '=', self.id)],
            'context': {'default_meter_id': self.id},
        }
