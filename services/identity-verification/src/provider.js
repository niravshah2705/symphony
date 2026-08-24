'use strict';

class ProviderUnavailable extends Error {
  constructor(message = 'DigiLocker provider is not configured.') {
    super(message);
    this.status = 503;
    this.code = 'provider_unavailable';
  }
}

function createMockProvider(env = process.env) {
  return {
    async createAuthorization({ sessionId, requestedChecks }) {
      return {
        provider: 'digilocker',
        authorizeUrl: `/api/identity/mock/authorize?sessionId=${encodeURIComponent(sessionId)}&checks=${encodeURIComponent(requestedChecks.join(','))}`,
        tokenExpiresAt: null,
      };
    },
    async fetchVerifiedFacts({ requestedChecks }) {
      const parsed = env.IDENTITY_MOCK_RESULT_JSON ? JSON.parse(env.IDENTITY_MOCK_RESULT_JSON) : {};
      return {
        pan: requestedChecks.includes('pan') ? (parsed.pan || { number: 'ABCDE1234F', holderName: 'Demo User', documentUri: 'in.gov.pan-demo' }) : undefined,
        ageProof: requestedChecks.includes('ageProof') ? (parsed.ageProof || { dateOfBirth: '1995-01-01', sourceDocumentType: 'Aadhaar', documentUri: 'in.gov.uidai-demo' }) : undefined,
        academic: (requestedChecks.includes('degree') || requestedChecks.includes('apaar'))
          ? (parsed.academic || { degreeVerified: true, institutionName: 'Demo University', awardName: 'Bachelor of Technology', yearOfPassing: '2017', apaarId: 'APAAR12345678', abcLinked: true, nadDocumentUri: 'in.gov.nad-demo' })
          : undefined,
      };
    },
    async revoke() {},
  };
}

function createDigiLockerProvider(config = {}) {
  if (config.mock) return createMockProvider(config.env);
  return {
    async createAuthorization() {
      throw new ProviderUnavailable('DigiLocker partner credentials are not configured.');
    },
    async fetchVerifiedFacts() {
      throw new ProviderUnavailable('DigiLocker partner credentials are not configured.');
    },
    async revoke() {},
  };
}

module.exports = { ProviderUnavailable, createMockProvider, createDigiLockerProvider };
