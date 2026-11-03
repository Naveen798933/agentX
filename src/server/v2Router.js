import { TamperAuditLogger } from '../observability/tamperAuditLogger.js';
import { SSOAdapter } from '../auth/ssoAdapter.js';
import { MemoryTypes } from '../memory/index.js';
import { StepActions } from '../qa/index.js';

/**
 * V2Router
 * Dispatches enterprise REST API endpoints under /api/v2/
 */
export class V2Router {
  /**
   * @param {Object} options
   * @param {import('../core/orchestrator.js').Orchestrator} options.orchestrator
   * @param {import('../storage/db.js').StorageEngine} options.storage
   * @param {import('./websocketGateway.js').WebSocketGateway} [options.wsGateway]
   */
  constructor(options = {}) {
    this.orchestrator = options.orchestrator;
    this.storage = options.storage;
    this.wsGateway = options.wsGateway || null;
    this.auditLogger = new TamperAuditLogger({ storage: this.storage });
  }

  /**
   * Dispatches incoming HTTP requests matching /api/v2/*
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {Object} context { user, tenantId, url, pathname, method, body }
   * @returns {Promise<boolean>} True if handled, false otherwise
   */
  async handle(req, res, context) {
    const { pathname, method, body } = context;
    const tenantId = context.tenantId || context.user?.tenantId || 'tenant-default';

    // 1. System Health & Gateway State
    if (pathname === '/api/v2/system/health' && method === 'GET') {
      const providers = this.orchestrator?.llm?.getRegisteredProviders ? this.orchestrator.llm.getRegisteredProviders() : [];
      return this._json(res, 200, {
        status: 'UP',
        version: '2.0.0',
        multiModelGateway: {
          enabled: process.env.ENABLE_V2_MULTI_MODEL_GATEWAY === 'true',
          providers
        },
        vectorMemory: {
          enabled: true,
          vectorDimensions: 64
        },
        browserQA: {
          enabled: true
        },
        timestamp: new Date().toISOString()
      });
    }

    // 2. Security Audit Chain Integrity Verification
    if (pathname === '/api/v2/security/audit-chain/verify' && method === 'GET') {
      const report = this.auditLogger.verifyChainIntegrity(tenantId);
      return this._json(res, 200, report);
    }

    // 3. Enterprise SSO Flow
    if (pathname === '/api/v2/auth/sso/login' && method === 'POST') {
      const config = this.storage.getSSOConfig(tenantId);
      if (!config || !config.is_active) {
        return this._json(res, 404, { error: 'No active SSO configuration found for this tenant' });
      }
      if (config.provider_type === 'OIDC') {
        const loginUrl = SSOAdapter.generateOIDCLoginUrl(config, body?.state, body?.redirectUri);
        return this._json(res, 200, { loginUrl, provider: 'OIDC' });
      } else {
        const saml = SSOAdapter.generateSAMLAuthnRequest(config, body?.relayState);
        return this._json(res, 200, { ...saml, provider: 'SAML2' });
      }
    }

    if (pathname === '/api/v2/auth/sso/callback' && method === 'POST') {
      const config = this.storage.getSSOConfig(tenantId);
      if (!config) {
        return this._json(res, 404, { error: 'No SSO configuration found for tenant' });
      }
      try {
        let userProfile;
        if (body?.idToken) {
          userProfile = SSOAdapter.validateOIDCToken(body.idToken, config);
        } else if (body?.samlResponse) {
          userProfile = SSOAdapter.validateSAMLResponse(body.samlResponse, config);
        } else {
          return this._json(res, 400, { error: 'Missing idToken or samlResponse in callback body' });
        }

        this.auditLogger.log({
          tenantId,
          eventType: 'USER_SSO_LOGIN',
          actor: userProfile.email,
          payload: { provider: userProfile.provider, role: userProfile.role }
        });

        return this._json(res, 200, { success: true, user: userProfile });
      } catch (err) {
        return this._json(res, 401, { error: err.message });
      }
    }

    // 4. Organizational Vector Memory Search & Ingestion
    if (pathname === '/api/v2/memory/search' && method === 'POST') {
      const memoryService = this.orchestrator?.getMemoryService ? this.orchestrator.getMemoryService() : null;
      if (!memoryService) {
        return this._json(res, 503, { error: 'Memory service not available' });
      }
      const results = await memoryService.search({
        tenantId,
        query: body?.query || '',
        memoryType: body?.memoryType || null,
        limit: body?.limit || 5,
        minScore: body?.minScore || 0.25
      });
      return this._json(res, 200, { results, total: results.length });
    }

    if (pathname === '/api/v2/memory/ingest' && method === 'POST') {
      const memoryService = this.orchestrator?.getMemoryService ? this.orchestrator.getMemoryService() : null;
      if (!memoryService) {
        return this._json(res, 503, { error: 'Memory service not available' });
      }
      try {
        const created = await memoryService.ingest({
          tenantId,
          projectId: body?.projectId || null,
          memoryType: body?.memoryType || MemoryTypes.GENERAL,
          title: body?.title,
          content: body?.content,
          sourceFile: body?.sourceFile || null,
          metadata: body?.metadata || {}
        });

        this.auditLogger.log({
          tenantId,
          eventType: 'MEMORY_INGESTED',
          actor: context.user?.email || 'system',
          payload: { count: created.length, title: body?.title }
        });

        return this._json(res, 201, { success: true, createdCount: created.length, memories: created });
      } catch (err) {
        return this._json(res, 400, { error: err.message });
      }
    }

    // 5. Project-Scoped Endpoints: /api/v2/projects/:id/*
    const projectMatch = pathname.match(/^\/api\/v2\/projects\/([^/]+)\/(.+)$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      const subPath = projectMatch[2];

      // A2A Conversation Threads
      if (subPath === 'agents/threads' && method === 'GET') {
        const threads = this.storage.listAgentConversations ? this.storage.listAgentConversations(projectId, tenantId) : [];
        return this._json(res, 200, { threads });
      }

      const threadDetailMatch = subPath.match(/^agents\/threads\/([^/]+)$/);
      if (threadDetailMatch && method === 'GET') {
        const threadId = threadDetailMatch[1];
        const a2aBus = this.orchestrator?.getA2ABus ? this.orchestrator.getA2ABus() : null;
        if (!a2aBus) return this._json(res, 503, { error: 'A2A Bus not initialized' });

        const messages = a2aBus.getThreadMessages(threadId);
        const critiques = a2aBus.getThreadCritiques(threadId);
        return this._json(res, 200, { threadId, messages, critiques });
      }

      // Tech Lead Arbitration
      if (subPath === 'agents/arbitrate' && method === 'POST') {
        const coordinator = this.orchestrator?.getSquadCoordinator ? this.orchestrator.getSquadCoordinator() : null;
        if (!coordinator) return this._json(res, 503, { error: 'Squad coordinator not available' });

        const ruling = await coordinator.arbitrateDispute({
          projectId,
          threadId: body?.threadId,
          reason: body?.reason
        });

        if (this.wsGateway) {
          this.wsGateway.broadcastToProject(projectId, 'TECH_LEAD_ARBITRATION', ruling);
        }

        return this._json(res, 200, ruling);
      }

      // Autonomous Browser QA Execution
      if (subPath === 'qa/browser-test' && method === 'POST') {
        const runner = this.orchestrator?.getBrowserQARunner ? this.orchestrator.getBrowserQARunner() : null;
        if (!runner) return this._json(res, 503, { error: 'Browser QA runner not initialized' });

        try {
          const report = await runner.executeSession({
            tenantId,
            projectId,
            sessionName: body?.sessionName || 'Autonomous Browser QA Run',
            targetUrl: body?.targetUrl,
            steps: body?.steps || [{ action: StepActions.NAVIGATE }]
          });

          if (this.wsGateway) {
            this.wsGateway.broadcastToProject(projectId, 'BROWSER_QA_COMPLETED', report);
          }

          return this._json(res, 200, report);
        } catch (err) {
          return this._json(res, 400, { error: err.message });
        }
      }

      const qaSessionMatch = subPath.match(/^qa\/sessions\/([^/]+)$/);
      if (qaSessionMatch && method === 'GET') {
        const sessionId = qaSessionMatch[1];
        const session = this.storage.getBrowserQASession ? this.storage.getBrowserQASession(sessionId) : null;
        if (!session) return this._json(res, 404, { error: 'Browser QA session not found' });

        const steps = this.storage.listBrowserQASteps ? this.storage.listBrowserQASteps(sessionId) : [];
        const artifacts = this.storage.listBrowserQAArtifacts ? this.storage.listBrowserQAArtifacts(sessionId) : [];
        return this._json(res, 200, { session, steps, artifacts });
      }
    }

    return false; // Not a recognized V2 route
  }

  _json(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(payload));
    return true;
  }
}

