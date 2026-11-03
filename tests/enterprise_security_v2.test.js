import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { TamperAuditLogger, GENESIS_HASH } from '../src/observability/tamperAuditLogger.js';
import { SSOAdapter, PlatformRoles, SSOProviderTypes } from '../src/auth/ssoAdapter.js';
import { WebSocketGateway } from '../src/server/websocketGateway.js';
import { V2Router } from '../src/server/v2Router.js';
import { StorageEngine } from '../src/storage/db.js';
import { Orchestrator } from '../src/core/orchestrator.js';

describe('V2.0 — Enterprise Security, Audit Hash-Chain & V2 Gateway Suite', () => {
  let tmpDir;
  let dbPath;
  let storage;
  let orchestrator;
  let auditLogger;
  let v2Router;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-v2-security-test-'));
    dbPath = path.join(tmpDir, 'test_security.db');
    storage = new StorageEngine(dbPath);
    orchestrator = new Orchestrator({ storage });
    auditLogger = new TamperAuditLogger({ storage, signingKey: 'test-hmac-secret-32-chars-length!!' });
    v2Router = new V2Router({ orchestrator, storage });
  });

  after(() => {
    try {
      storage.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('1. Cryptographic Tamper-Evident Audit Hash Chain', () => {
    test('appends sequential audit logs with cryptographic hash chaining and HMAC signatures', () => {
      const entry1 = auditLogger.log({
        tenantId: 'tenant-sec-test',
        eventType: 'USER_LOGIN',
        actor: 'admin@pulse.enterprise',
        payload: { ip: '10.0.0.1', method: 'SAML_SSO' }
      });

      assert.strictEqual(entry1.sequenceNumber, 1);
      assert.strictEqual(entry1.previousHash, GENESIS_HASH);
      assert.strictEqual(entry1.currentHash.length, 64);
      assert.strictEqual(entry1.signature.length, 64);

      const entry2 = auditLogger.log({
        tenantId: 'tenant-sec-test',
        eventType: 'PROJECT_SYNTHESIS_INITIATED',
        actor: 'lead_dev@pulse.enterprise',
        payload: { projectId: 'proj-001', budgetUsd: 50.0 }
      });

      assert.strictEqual(entry2.sequenceNumber, 2);
      assert.strictEqual(entry2.previousHash, entry1.currentHash, 'Entry #2 previousHash must link to Entry #1 currentHash');

      const entry3 = auditLogger.log({
        tenantId: 'tenant-sec-test',
        eventType: 'GATE_APPROVAL_GRANTED',
        actor: 'secops@pulse.enterprise',
        payload: { action: 'DEPLOY_PRODUCTION', approved: true }
      });

      assert.strictEqual(entry3.sequenceNumber, 3);
      assert.strictEqual(entry3.previousHash, entry2.currentHash);
    });

    test('verifies integrity of unbroken audit hash chain', () => {
      const verification = auditLogger.verifyChainIntegrity('tenant-sec-test');
      assert.strictEqual(verification.valid, true);
      assert.strictEqual(verification.totalEntries, 3);
      assert.ok(verification.lastHash.length === 64);
    });

    test('detects unauthorized database row modification / payload tampering', () => {
      // Simulate malicious row edit directly in SQLite database
      const updateStmt = storage.db.prepare(`
        UPDATE tamper_evident_audit_log
        SET payload_json = '{"action":"DEPLOY_PRODUCTION","approved":true,"MALICIOUS_INJECTION":true}'
        WHERE tenant_id = 'tenant-sec-test' AND sequence_number = 3
      `);
      updateStmt.run();

      const verification = auditLogger.verifyChainIntegrity('tenant-sec-test');
      assert.strictEqual(verification.valid, false);
      assert.strictEqual(verification.brokenAtSequence, 3);
      assert.ok(verification.reason.includes('Hash tampering detected at #3'));
    });

    test('detects signature forgery or signature mismatch', () => {
      // Restore valid payload but forge signature
      const fixPayload = storage.db.prepare(`
        UPDATE tamper_evident_audit_log
        SET payload_json = '{"action":"DEPLOY_PRODUCTION","approved":true}',
            signature = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        WHERE tenant_id = 'tenant-sec-test' AND sequence_number = 3
      `);
      fixPayload.run();

      const verification = auditLogger.verifyChainIntegrity('tenant-sec-test');
      assert.strictEqual(verification.valid, false);
      assert.strictEqual(verification.brokenAtSequence, 3);
      assert.ok(verification.reason.includes('signature forgery detected'));
    });
  });

  describe('2. Enterprise SSO Adapter (OIDC & SAML 2.0)', () => {
    test('generates valid OIDC login redirect URL with security nonces', () => {
      const config = {
        idpSsoUrl: 'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/authorize',
        clientId: 'pulse-client-app-id',
        defaultRole: PlatformRoles.DEVELOPER
      };

      const url = SSOAdapter.generateOIDCLoginUrl(config, 'state_abc', 'https://pulse.local/api/v2/auth/sso/callback');
      const parsed = new URL(url);
      assert.strictEqual(parsed.origin, 'https://login.microsoftonline.com');
      assert.strictEqual(parsed.searchParams.get('client_id'), 'pulse-client-app-id');
      assert.strictEqual(parsed.searchParams.get('state'), 'state_abc');
      assert.ok(parsed.searchParams.get('nonce'));
      assert.strictEqual(parsed.searchParams.get('redirect_uri'), 'https://pulse.local/api/v2/auth/sso/callback');
    });

    test('validates OIDC JWT token and maps enterprise groups to platform roles', () => {
      const config = {
        clientId: 'pulse-client-app-id',
        issuerUrl: 'https://login.microsoftonline.com/tenant-123/v2.0',
        defaultRole: PlatformRoles.DEVELOPER
      };

      const nowSec = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: 'user-azure-789',
        email: 'alex.rivera@enterprise.com',
        name: 'Alex Rivera',
        iss: 'https://login.microsoftonline.com/tenant-123/v2.0',
        aud: 'pulse-client-app-id',
        exp: nowSec + 3600,
        groups: ['Engineering-Leads', 'Platform-Tech-Lead']
      })).toString('base64url');
      const fakeJwt = `${header}.${payload}.sig`;

      const profile = SSOAdapter.validateOIDCToken(fakeJwt, config);
      assert.strictEqual(profile.email, 'alex.rivera@enterprise.com');
      assert.strictEqual(profile.role, PlatformRoles.TECH_LEAD, 'Groups matching tech-lead must map to TECH_LEAD');
      assert.strictEqual(profile.provider, SSOProviderTypes.OIDC);
    });

    test('generates compliant SAML 2.0 AuthnRequest XML and parses response assertion', () => {
      const samlConfig = {
        idpSsoUrl: 'https://idp.okta.com/app/pulse/sso/saml',
        idpEntityId: 'https://pulse.enterprise.sp',
        defaultRole: PlatformRoles.DEVELOPER
      };

      const authn = SSOAdapter.generateSAMLAuthnRequest(samlConfig, 'relay_123');
      assert.ok(authn.authnRequestXml.includes('samlp:AuthnRequest'));
      assert.ok(authn.authnRequestXml.includes('Destination="https://idp.okta.com/app/pulse/sso/saml"'));

      const mockSamlResponseXml = `
        <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
          <samlp:Status>
            <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
          </samlp:Status>
          <saml:Assertion>
            <saml:Subject>
              <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">secops@pulse.corp</saml:NameID>
            </saml:Subject>
            <saml:AttributeStatement>
              <saml:Attribute Name="groups">
                <saml:AttributeValue>Security-Admins</saml:AttributeValue>
              </saml:Attribute>
            </saml:AttributeStatement>
          </saml:Assertion>
        </samlp:Response>
      `;

      const profile = SSOAdapter.validateSAMLResponse(mockSamlResponseXml, samlConfig);
      assert.strictEqual(profile.email, 'secops@pulse.corp');
      assert.strictEqual(profile.role, PlatformRoles.ADMIN, 'Security-Admins group must map to ADMIN');
      assert.strictEqual(profile.provider, SSOProviderTypes.SAML2);
    });
  });

  describe('3. WebSocket Real-Time Gateway & Channel Subscriptions', () => {
    test('instantiates gateway and manages channel subscriptions and broadcasts', () => {
      const wsGateway = new WebSocketGateway();
      assert.strictEqual(wsGateway.getActiveConnectionsCount(), 0);

      // Simulate mock socket session
      const mockSocket = {
        destroyed: false,
        writable: true,
        writtenData: [],
        write(data) { this.writtenData.push(data); },
        end() { this.destroyed = true; }
      };

      const session = {
        id: 'sess-test-01',
        socket: mockSocket,
        tenantId: 'tenant-ws-test',
        channels: new Set()
      };

      wsGateway.clients.set(mockSocket, session);
      assert.strictEqual(wsGateway.getActiveConnectionsCount(), 1);

      // Simulate client subscribing to project channel
      wsGateway._processClientMessage(session, {
        action: 'SUBSCRIBE',
        channel: 'project:proj-100'
      });

      assert.ok(session.channels.has('project:proj-100'));
      assert.strictEqual(mockSocket.writtenData.length, 1);

      // Broadcast to project
      wsGateway.broadcastToProject('proj-100', 'STAGE_UPDATED', { stage: 'STAGE_ARCHITECTURE' });
      assert.strictEqual(mockSocket.writtenData.length, 2);

      // Cleanup
      wsGateway._removeClient(mockSocket);
      assert.strictEqual(wsGateway.getActiveConnectionsCount(), 0);
    });
  });

  describe('4. Version 2.0 Router REST API Endpoints', () => {
    test('handles GET /api/v2/system/health returning UP and version 2.0.0', async () => {
      let responseBody = '';
      let responseStatus = 0;
      const res = {
        writeHead(status) { responseStatus = status; },
        end(data) { responseBody = data; }
      };

      const handled = await v2Router.handle({}, res, {
        pathname: '/api/v2/system/health',
        method: 'GET',
        tenantId: 'tenant-default'
      });

      assert.strictEqual(handled, true);
      assert.strictEqual(responseStatus, 200);
      const parsed = JSON.parse(responseBody);
      assert.strictEqual(parsed.status, 'UP');
      assert.strictEqual(parsed.version, '2.0.0');
      assert.strictEqual(parsed.vectorMemory.enabled, true);
      assert.strictEqual(parsed.browserQA.enabled, true);
    });

    test('handles POST /api/v2/memory/ingest and POST /api/v2/memory/search', async () => {
      let resBody = '';
      let resStatus = 0;
      const res = {
        writeHead(status) { resStatus = status; },
        end(data) { resBody = data; }
      };

      // Ingest
      await v2Router.handle({}, res, {
        pathname: '/api/v2/memory/ingest',
        method: 'POST',
        tenantId: 'tenant-v2-router-test',
        body: {
          title: 'ADR-099: Realtime Telemetry WebSocket Protocol',
          content: 'RFC 6455 WebSockets with JWT token handshake authentication for multi-agent thought streaming.',
          memoryType: 'ADR'
        }
      });

      assert.strictEqual(resStatus, 201);
      const ingestJson = JSON.parse(resBody);
      assert.strictEqual(ingestJson.success, true);

      // Search
      await v2Router.handle({}, res, {
        pathname: '/api/v2/memory/search',
        method: 'POST',
        tenantId: 'tenant-v2-router-test',
        body: {
          query: 'RFC 6455 websocket telemetry token handshake'
        }
      });

      assert.strictEqual(resStatus, 200);
      const searchJson = JSON.parse(resBody);
      assert.ok(searchJson.results.length > 0);
      assert.ok(searchJson.results[0].title.includes('Realtime Telemetry'));
    });
  });
});

