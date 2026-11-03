import crypto from 'node:crypto';

export const SSOProviderTypes = Object.freeze({
  OIDC: 'OIDC',
  SAML2: 'SAML2'
});

export const PlatformRoles = Object.freeze({
  ADMIN: 'ADMIN',
  TECH_LEAD: 'TECH_LEAD',
  DEVELOPER: 'DEVELOPER',
  VIEWER: 'VIEWER'
});

/**
 * SSOAdapter
 * Enterprise Single Sign-On (SSO) engine supporting OpenID Connect (OIDC)
 * and SAML 2.0 federation with corporate identity providers (Okta, Azure AD, Google Workspace).
 */
export class SSOAdapter {
  /**
   * Generates OIDC authorization redirect URL
   * @param {Object} config Enterprise SSO configuration
   * @param {string} [state] CSRF state nonce
   * @param {string} [redirectUri] Callback URL
   * @returns {string} Fully formed redirect URL
   */
  static generateOIDCLoginUrl(config, state = '', redirectUri = '') {
    if (!config || !config.idpSsoUrl || !config.clientId) {
      throw new Error('Incomplete OIDC configuration: idpSsoUrl and clientId are required');
    }

    const stateParam = state || crypto.randomBytes(16).toString('hex');
    const nonceParam = crypto.randomBytes(16).toString('hex');

    const url = new URL(config.idpSsoUrl);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', stateParam);
    url.searchParams.set('nonce', nonceParam);
    if (redirectUri) {
      url.searchParams.set('redirect_uri', redirectUri);
    }

    return url.toString();
  }

  /**
   * Validates OIDC JWT token payload and extracts user profile
   * @param {string} rawJwt JWT token
   * @param {Object} config
   * @returns {Object} User profile
   */
  static validateOIDCToken(rawJwt, config) {
    if (!rawJwt || typeof rawJwt !== 'string') {
      throw new Error('Invalid JWT: must be a non-empty string');
    }

    const parts = rawJwt.split('.');
    if (parts.length < 2) {
      throw new Error('Invalid JWT format: missing required dot-delimited segments');
    }

    let payload;
    try {
      const decodedJson = Buffer.from(parts[1], 'base64url').toString('utf8');
      payload = JSON.parse(decodedJson);
    } catch (err) {
      throw new Error(`Failed to decode JWT payload: ${err.message}`);
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // Expiration check
    if (payload.exp && payload.exp < nowSec) {
      throw new Error(`OIDC token expired at ${new Date(payload.exp * 1000).toISOString()}`);
    }

    // Issuer verification
    if (config.issuerUrl && payload.iss && payload.iss !== config.issuerUrl) {
      throw new Error(`OIDC token issuer mismatch: expected "${config.issuerUrl}", got "${payload.iss}"`);
    }

    // Audience verification
    if (config.clientId && payload.aud) {
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.includes(config.clientId)) {
        throw new Error(`OIDC token audience mismatch: expected "${config.clientId}" in ${JSON.stringify(auds)}`);
      }
    }

    const email = payload.email || `${payload.sub || 'user'}@corporate.sso`;
    const role = SSOAdapter.mapEnterpriseRole(payload.groups || payload.roles || [], config.defaultRole);

    return {
      sub: payload.sub || email,
      email,
      name: payload.name || payload.preferred_username || email.split('@')[0],
      role,
      provider: SSOProviderTypes.OIDC,
      rawClaims: payload
    };
  }

  /**
   * Generates SAML 2.0 AuthnRequest XML
   * @param {Object} config
   * @param {string} [relayState]
   * @returns {{ authnRequestXml: string, requestId: string, ssoUrl: string }}
   */
  static generateSAMLAuthnRequest(config, relayState = '') {
    if (!config || !config.idpSsoUrl) {
      throw new Error('Incomplete SAML configuration: idpSsoUrl is required');
    }

    const requestId = `_req_${crypto.randomUUID()}`;
    const issueInstant = new Date().toISOString();
    const entityId = config.idpEntityId || 'pulse-virtual-company-sp';

    const authnRequestXml = `
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${requestId}"
  Version="2.0"
  IssueInstant="${issueInstant}"
  Destination="${config.idpSsoUrl}"
  AssertionConsumerServiceURL="${config.acsUrl || ''}">
  <saml:Issuer>${entityId}</saml:Issuer>
  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>
</samlp:AuthnRequest>`.trim();

    return {
      requestId,
      authnRequestXml,
      ssoUrl: config.idpSsoUrl,
      relayState
    };
  }

  /**
   * Validates and parses SAML 2.0 Response XML assertion
   * @param {string} samlXml
   * @param {Object} config
   * @returns {Object} User profile
   */
  static validateSAMLResponse(samlXml, config = {}) {
    if (!samlXml || typeof samlXml !== 'string') {
      throw new Error('Invalid SAML response: XML payload required');
    }

    // Status check
    const statusMatch = samlXml.match(/<samlp:StatusCode\s+Value=["']urn:oasis:names:tc:SAML:2.0:status:Success["']/i) ||
                        samlXml.match(/StatusCode\s+Value=["'][^"']*status:Success["']/i);
    if (!statusMatch) {
      throw new Error('SAML authentication failed: IdP response did not indicate Success');
    }

    // Extract NameID (Subject / User Principal)
    const nameIdMatch = samlXml.match(/<saml:NameID[^>]*>([\s\S]*?)<\/saml:NameID>/i) ||
                        samlXml.match(/<NameID[^>]*>([\s\S]*?)<\/NameID>/i);
    if (!nameIdMatch) {
      throw new Error('SAML response missing required NameID subject assertion');
    }
    const email = nameIdMatch[1].trim();

    // Extract Attribute Statements
    const groups = [];
    const groupRegex = /<saml:AttributeValue[^>]*>([\s\S]*?)<\/saml:AttributeValue>/gi;
    let attrM;
    while ((attrM = groupRegex.exec(samlXml)) !== null) {
      const val = attrM[1].replace(/<[^>]+>/g, '').trim();
      if (val && !groups.includes(val)) groups.push(val);
    }

    const role = SSOAdapter.mapEnterpriseRole(groups, config.defaultRole);

    return {
      sub: email,
      email,
      name: email.split('@')[0],
      role,
      groups,
      provider: SSOProviderTypes.SAML2
    };
  }

  /**
   * Maps enterprise directory groups/roles to internal platform roles
   */
  static mapEnterpriseRole(groups = [], defaultRole = PlatformRoles.DEVELOPER) {
    if (!Array.isArray(groups)) return defaultRole;

    const lowerGroups = groups.map(g => String(g).toLowerCase());

    if (lowerGroups.some(g => g.includes('admin') || g.includes('secops') || g.includes('superuser'))) {
      return PlatformRoles.ADMIN;
    }
    if (lowerGroups.some(g => g.includes('tech-lead') || g.includes('lead') || g.includes('architect'))) {
      return PlatformRoles.TECH_LEAD;
    }
    if (lowerGroups.some(g => g.includes('dev') || g.includes('engineer') || g.includes('developer'))) {
      return PlatformRoles.DEVELOPER;
    }
    if (lowerGroups.some(g => g.includes('viewer') || g.includes('guest') || g.includes('auditor'))) {
      return PlatformRoles.VIEWER;
    }

    return defaultRole;
  }
}

