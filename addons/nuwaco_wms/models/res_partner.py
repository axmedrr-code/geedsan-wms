from odoo import fields, models, api

_WMS_URL_PARAM = 'nuwaco.wms_url'
_WMS_URL_DEFAULT = 'http://localhost:3000'


class ResPartner(models.Model):
    _inherit = 'res.partner'

    wms_customer_id = fields.Char(
        string='WMS Customer ID',
        index=True,
        copy=False,
        help='UUID of this customer in the NUWACO WMS PostgreSQL database.',
    )
    wms_customer_number = fields.Char(
        string='Customer Number',
        index=True,
        copy=False,
        help='Human-readable customer number from the WMS (e.g. CUST-001).',
    )
    wms_tariff_type = fields.Selection(
        selection=[
            ('residential', 'Residential'),
            ('commercial',  'Commercial'),
            ('industrial',  'Industrial'),
            ('government',  'Government'),
        ],
        string='Tariff Type',
        default='residential',
    )
    wms_account_status = fields.Selection(
        selection=[
            ('active',      'Active'),
            ('inactive',    'Inactive'),
            ('suspended',   'Suspended'),
            ('terminated',  'Terminated'),
        ],
        string='WMS Account Status',
        default='active',
    )
    is_water_customer = fields.Boolean(
        string='Water Customer',
        default=False,
        help='Set automatically when this partner is synced from the WMS.',
    )
    wms_meter_ids = fields.One2many(
        comodel_name='nuwaco.meter',
        inverse_name='partner_id',
        string='Water Meters',
    )
    wms_meter_count = fields.Integer(
        string='Meters',
        compute='_compute_wms_meter_count',
    )

    # Phase-2 master record fields
    wms_primary_meter = fields.Char(
        string='Primary Meter Number',
        copy=False,
        help='Meter number of the primary active meter assigned to this customer in the WMS.',
    )
    wms_national_id = fields.Char(
        string='National ID',
        copy=False,
        help='National identification number from the WMS customer record.',
    )
    wms_house_number = fields.Char(
        string='House Number',
        copy=False,
        help='House/plot number from the WMS customer record.',
    )
    wms_gps_lat = fields.Float(
        string='GPS Latitude',
        digits=(9, 6),
        help='GPS latitude of the meter installation site.',
    )
    wms_gps_lng = fields.Float(
        string='GPS Longitude',
        digits=(9, 6),
        help='GPS longitude of the meter installation site.',
    )
    wms_connection_date = fields.Date(
        string='Connection Date',
        help='Date the water connection was established, from the WMS.',
    )
    wms_last_sync = fields.Datetime(
        string='Last WMS Sync',
        readonly=True,
        copy=False,
        help='Timestamp of the most recent successful sync from NUWACO WMS.',
    )

    @api.depends('wms_meter_ids')
    def _compute_wms_meter_count(self):
        for rec in self:
            rec.wms_meter_count = len(rec.wms_meter_ids)

    def action_open_in_wms(self):
        self.ensure_one()
        base_url = self.env['ir.config_parameter'].sudo().get_param(
            _WMS_URL_PARAM, default=_WMS_URL_DEFAULT
        )
        url = '{}/dashboard/customers/{}'.format(base_url.rstrip('/'), self.wms_customer_id)
        return {
            'type': 'ir.actions.act_url',
            'url': url,
            'target': 'new',
        }
