'use strict';

const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../swagger.json');
const { CONFIG } = require('@ai-fleet/shared-core/config');

// Production mode requires this header to access API docs.
// In dev/local (MESSAGING_MODE !== 'pubsub'), docs are always available.
const API_DOCS_HEADER = 'x-ai-fleet-api-docs';
const API_DOCS_MODES = new Set(['enabled', 'true', '1']);

const IS_CLOUD = CONFIG.MESSAGING_MODE === 'pubsub';

/**
 * Check if API docs should be accessible for this request.
 * Cloud deployments require the x-ai-fleet-api-docs header for security.
 * Local dev always allows access (no header needed).
 */
function isApiDocsEnabled(req) {
  // Dev/local: always enabled
  if (!IS_CLOUD) {
    return true;
  }
  // Production: check for mode header (any non-empty value is treated as enabled)
  const headerValue = (req && typeof req.get === 'function')
    ? req.get(API_DOCS_HEADER) || ''
    : '';
  return headerValue.trim() !== '';
}

/**
 * Gate middleware — returns 404 if API docs are not enabled
 */
function createApiDocsGate() {
  return (req, res, next) => {
    if (!isApiDocsEnabled(req)) {
      return res.status(404).json({
        error: 'API documentation is not available.',
        code: 'docs_not_available',
      });
    }
    next();
  };
}

/**
 * Serve the OpenAPI specification JSON
 */
function serveSwaggerJson() {
  return (req, res) => {
    if (!isApiDocsEnabled(req)) {
      return res.status(404).json({
        error: 'API documentation is not available.',
        code: 'docs_not_available',
      });
    }
    res.json(swaggerDocument);
  };
}

/**
 * Create the Swagger UI middleware with custom settings
 */
function createSwaggerMiddleware() {
  return swaggerUi.serve;
}

function createSwaggerUISetup() {
  return swaggerUi.setup(swaggerDocument, {
    swaggerOptions: {
      urls: [
        {
          url: '/swagger.json',
          name: 'Gateway API',
        },
      ],
    },
    customCss: `.swagger-ui .topbar { display: none }`,
    customSiteTitle: 'AI Fleet Gateway API Docs',
  });
}

module.exports = {
  createApiDocsGate,
  serveSwaggerJson,
  createSwaggerMiddleware,
  createSwaggerUISetup,
  swaggerDocument,
  isApiDocsEnabled,
  API_DOCS_HEADER,
};
