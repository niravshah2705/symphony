'use strict';

const express = require('express');
const { asyncHandler } = require('@ai-fleet/shared-core/util');
const { cleanContextId } = require('../request-context');
const { PipelineAdmissionError, createPipelineAdmission } = require('../pipeline-admission');

function runId(value) {
  const id = cleanContextId(String(value || ''));
  if (!id) {
    throw new PipelineAdmissionError(
      'A valid runId is required.',
      400,
      'invalid_pipeline_run_id',
    );
  }
  return id;
}

function passthrough(req, res, next) { next(); }

function createPipelineRouter({ admission = createPipelineAdmission(), startMiddleware = passthrough } = {}) {
  const router = express.Router();
  router.post('/runs', startMiddleware, asyncHandler(async (req, res) => {
    res.status(202).json(await admission.submit(req));
  }));
  router.get('/runs/:runId', asyncHandler(async (req, res) => {
    res.json(await admission.status(req, runId(req.params.runId)));
  }));
  router.post('/runs/:runId/cancel', asyncHandler(async (req, res) => {
    res.json(await admission.cancel(req, runId(req.params.runId)));
  }));
  router.post('/runs/:runId/resume', asyncHandler(async (req, res) => {
    res.json(await admission.resume(req, runId(req.params.runId)));
  }));
  return router;
}

module.exports = { createPipelineRouter, runId };
