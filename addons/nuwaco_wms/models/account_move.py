from odoo import fields, models


class AccountMove(models.Model):
    _inherit = 'account.move'

    wms_invoice_id = fields.Char(
        string='WMS Invoice ID', index=True, copy=False,
        help='UUID of the invoice in the NUWACO WMS PostgreSQL database.',
    )
    wms_invoice_number = fields.Char(
        string='WMS Invoice Number', copy=False,
        help='Human-readable invoice number from the WMS (e.g. INV-202501-CUST001).',
    )
    wms_meter_id = fields.Many2one(
        comodel_name='nuwaco.meter',
        string='Water Meter',
        index=True,
        ondelete='set null',
        help='The primary meter this billing cycle covers.',
    )
    wms_period_start = fields.Date(string='Billing Period Start')
    wms_period_end   = fields.Date(string='Billing Period End')
    wms_water_volume = fields.Float(string='Water Volume (m³)', digits=(12, 3))
