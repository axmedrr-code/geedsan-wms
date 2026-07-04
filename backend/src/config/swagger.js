const swaggerJsdoc = require('swagger-jsdoc');

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'NUWACO WMS API',
      version: '1.0.0',
      description: 'LoRaWAN Smart Water Meter Management System — backend API for meters, readings, alarms, billing, customers, gateways, and Odoo/ChirpStack integration.'
    },
    servers: [{ url: '/api' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
      }
    },
    security: [{ bearerAuth: [] }]
  },
  apis: [`${__dirname}/../routes/*.js`]
});

module.exports = spec;
