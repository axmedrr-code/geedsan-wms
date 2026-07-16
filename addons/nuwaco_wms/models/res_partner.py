from odoo import fields, models, api


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

    @api.depends('wms_meter_ids')
    def _compute_wms_meter_count(self):
        for rec in self:
            rec.wms_meter_count = len(rec.wms_meter_ids)
