{
    'name': 'NUWACO WMS Integration',
    'version': '18.0.2.0.0',
    'category': 'Industries',
    'summary': 'Smart Water Meter Management System — ERP integration layer',
    'description': """
NUWACO WMS Integration
======================
Bridges the NUWACO Smart Water Meter Management System (Node.js / PostgreSQL)
with Odoo 18 Community ERP via XML-RPC.

Synced entities
---------------
- Customers    → res.partner  (with WMS reference fields)
- Water Meters → nuwaco.meter
- Meter Reads  → nuwaco.reading
- Alarms       → nuwaco.alarm
- Invoices     → account.move (out_invoice)
- Payments     → account.payment

Data flow: WMS backend (Node.js) → Odoo XML-RPC only.
ChirpStack and MQTT never touch Odoo directly.
    """,
    'author': 'NUWACO',
    'website': '',
    'license': 'LGPL-3',
    'depends': ['base', 'account', 'mail'],
    'data': [
        'security/security.xml',
        'security/ir.model.access.csv',
        'data/ir_sequence_data.xml',
        'views/res_partner_views.xml',
        'views/nuwaco_meter_views.xml',
        'views/nuwaco_reading_views.xml',
        'views/nuwaco_alarm_views.xml',
        'views/account_move_views.xml',
        'views/menu_views.xml',
    ],
    'installable': True,
    'auto_install': False,
    'application': True,
}
