'use strict';

const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../swagger.json');
const { CONFIG } = require('@ai-fleet/shared-core/config');

// Production mode requires this header to access API docs.
// In dev/local (MESSAGING_MODE !== 'pubsub'), docs are always available.
const API_DOCS_HEADER = 'x-ai-fleet-api-docs';

const IS_CLOUD = CONFIG.MESSAGING_MODE === 'pubsub';

/**
 * Pure gating decision — kept free of Express/CONFIG so it is directly testable.
 * Local dev (isCloud=false) always allows access; cloud requires any non-empty
 * header value.
 */
function docsAllowed({ isCloud, headerValue }) {
  if (!isCloud) return true;
  return typeof headerValue === 'string' && headerValue.trim() !== '';
}

/** Read the docs header off a request, tolerating both Express and plain req shapes. */
function readDocsHeader(req) {
  if (req && typeof req.get === 'function') return req.get(API_DOCS_HEADER) || '';
  if (req && req.headers) return req.headers[API_DOCS_HEADER] || '';
  return '';
}

/**
 * Check if API docs should be accessible for this request.
 * Cloud deployments require the x-ai-fleet-api-docs header for security.
 * Local dev always allows access (no header needed).
 */
function isApiDocsEnabled(req) {
  return docsAllowed({ isCloud: IS_CLOUD, headerValue: readDocsHeader(req) });
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
  docsAllowed,
  readDocsHeader,
  API_DOCS_HEADER,
};
