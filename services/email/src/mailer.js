'use strict';

const nodemailer = require('nodemailer');
const { configErrors } = require('./config');
const { renderBillingAlert, renderInvitation } = require('./templates');

function createTransport(config) {
  if (!config.smtp.host) return null;
  const auth = config.smtp.user && config.smtp.password
    ? { user: config.smtp.user, pass: config.smtp.password }
    : undefined;
  return nodemailer.createTransport(
    {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      requireTLS: config.smtp.requireTls,
      ...(auth ? { auth } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    },
    { from: config.from },
  );
}

function createMailer(config, { transport } = {}) {
  const resolvedTransport = transport === undefined ? createTransport(config) : transport;

  async function ready() {
    if (configErrors(config).length || !resolvedTransport) return false;
    if (typeof resolvedTransport.verify === 'function') await resolvedTransport.verify();
    return true;
  }

  async function send(job) {
    if (configErrors(config).length || !resolvedTransport) {
      const error = new Error('Email delivery is not configured');
      error.code = 'email_not_configured';
      throw error;
    }
    let rendered;
    if (job.template === 'invitation') rendered = renderInvitation(job, config.publicAppUrl);
    else if (job.template === 'billing_alert') rendered = renderBillingAlert(job);
    else throw new Error('Unsupported email template');
    return resolvedTransport.sendMail({
      to: job.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }


  async function sendInvitation(job) {
    return send(job);
  }

  async function sendBillingAlert(job) {
    return send(job);
  }

  function close() {
    if (resolvedTransport && typeof resolvedTransport.close === 'function') resolvedTransport.close();
  }

  return Object.freeze({ ready, send, sendInvitation, sendBillingAlert, close });
}

module.exports = { createMailer, createTransport };
