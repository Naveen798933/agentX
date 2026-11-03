# AI VIRTUAL SOFTWARE HOUSE 2.0
## Master API Architecture & Specification (`V2_API_DESIGN.md`)

---

## 1. API Architecture & Versioning Strategy

The V2.0 API introduces an enterprise-grade gateway layer under the `/api/v2` namespace while maintaining **100% backward compatibility** with all existing `/api/*` endpoints.

- **Gateway Architecture:** Node.js native WHATWG URL routing + WebSocket upgrade protocol (`ws://` / `wss://`) for bidirectional real-time communication.
- **Content-Type:** `application/json` for REST payloads, `text/event-stream` for SSE, `application/zip` for exports, `image/png` for QA screenshots.
- **Authentication:** Standardized `Authorization: Bearer <jwt_access_token>` with RBAC permission enforcement.
- **Tenant Context:** Automatically derived from JWT token claims and enforced via `TenantGuard`.

---

## 2. API Endpoint Directory (V2.0 Extensions)

### 2.1 Multi-Model AI Gateway Endpoints

#### 1. `GET /api/v2/models/providers`
- **Auth:** `DEVELOPER` or higher.
- **Purpose:** Lists all configured model providers, active models, and real-time operational status (Circuit Breaker status: `CLOSED`, `OPEN`, `HALF-OPEN`).
- **Response `200 OK`:**
```json
{
  "providers": [
    {
      "id": "prov_gemini",
      "providerType": "GEMINI",
      "displayName": "Google Gemini",
      "models": ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.0-pro"],
      "status": "HEALTHY",
      "rateLimitRPM": 14,
      "circuitBreaker": "CLOSED"
    },
    {
      "id": "prov_claude",
      "providerType": "ANTHROPIC",
      "displayName": "Anthropic Claude",
      "models": ["claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku"],
      "status": "HEALTHY",
      "rateLimitRPM": 50,
      "circuitBreaker": "CLOSED"
    }
  ]
}
```

#### 2. `PUT /api/v2/models/routing`
- **Auth:** `PLATFORM_ADMIN` or `ORG_ADMIN`.
- **Purpose:** Updates tenant model routing policy, mapping task domains to primary and fallback models.
- **Request Body:**
```json
{
  "taskDomain": "ARCHITECTURE",
  "primaryProviderId": "prov_claude",
  "primaryModelName": "claude-3-7-sonnet",
  "fallbackProviderId": "prov_gemini",
  "fallbackModelName": "gemini-3.5-flash",
  "temperature": 0.40,
  "maxOutputTokens": 8192
}
```
- **Response `200 OK`:** Returns updated routing policy object.

#### 3. `POST /api/v2/models/generate`
- **Auth:** `DEVELOPER` or internal agent service call.
- **Purpose:** Direct unified inference through the multi-model gateway with automatic fallback cascade.
- **Request Body:**
```json
{
  "domain": "CODE_GEN",
  "systemPrompt": "You are a Senior Backend Engineer...",
  "userMessage": "Generate the REST API controller for user registration...",
  "stream": false,
  "temperature": 0.2
}
```
- **Response `200 OK`:**
```json
{
  "providerUsed": "ANTHROPIC",
  "modelUsed": "claude-3-5-sonnet",
  "fallbackTriggered": false,
  "tokensUsed": { "input": 450, "output": 1280, "total": 1730 },
  "costUsd": 0.0205,
  "content": "export class UserController { ... }"
}
```

---

### 2.2 Persistent Organizational Memory Endpoints

#### 1. `GET /api/v2/memory/search`
- **Auth:** `DEVELOPER` or higher.
- **Parameters:**
  - `q` (string, required): Natural language query or code signature.
  - `type` (optional): `ADR`, `PRD`, `BUG_FIX`, `CODING_STANDARD`, `SECURITY_RULE`.
  - `limit` (integer, default 5, max 20).
- **Purpose:** Semantic vector similarity search over organizational memory.
- **Response `200 OK`:**
```json
{
  "query": "jwt refresh token rotation reuse defense",
  "results": [
    {
      "id": "mem_01h98x",
      "memoryType": "SECURITY_RULE",
      "title": "Refresh Token Reuse Detection Standards",
      "similarityScore": 0.924,
      "content": "When a revoked refresh token is presented, revoke all active sessions for the user...",
      "sourceFile": "docs/SECURITY.md",
      "metadata": { "appliesTo": ["auth", "tokens"] }
    }
  ]
}
```

#### 2. `POST /api/v2/memory/ingest`
- **Auth:** `PROJECT_MANAGER` or higher.
- **Purpose:** Chunks, generates vector embeddings, and stores new organizational knowledge.
- **Request Body:**
```json
{
  "memoryType": "ADR",
  "title": "ADR-004: Multi-Model Gateway Failover Cascade",
  "content": "We decide to implement an automated circuit breaker failover...",
  "sourceFile": "docs/ADR-004.md",
  "metadata": { "tags": ["architecture", "llm"] }
}
```
- **Response `201 Created`:** Returns created memory record with vector ID.

---

### 2.3 Agent-to-Agent (A2A) Collaboration Endpoints

#### 1. `GET /api/v2/projects/:id/threads`
- **Auth:** `PROJECT_READ`.
- **Purpose:** Lists all peer-to-peer and squad consultation threads for a project.
- **Response `200 OK`:**
```json
{
  "threads": [
    {
      "id": "thrd_87a912",
      "topic": "System Architecture Contract Review",
      "initiatorRole": "ARCHITECT",
      "targetRole": "BACKEND",
      "stage": "STAGE_ARCHITECTURE",
      "status": "RESOLVED",
      "messageCount": 4,
      "updatedAt": "2026-11-03T08:30:00.000Z"
    }
  ]
}
```

#### 2. `GET /api/v2/projects/:id/threads/:threadId/messages`
- **Auth:** `PROJECT_READ`.
- **Purpose:** Fetches full conversation history and attached code critiques for a specific thread.
- **Response `200 OK`:**
```json
{
  "threadId": "thrd_87a912",
  "messages": [
    {
      "id": "msg_01",
      "fromRole": "ARCHITECT",
      "toRole": "BACKEND",
      "intent": "PROPOSE",
      "content": "Proposed REST contract for user authentication...",
      "sequenceNumber": 1,
      "createdAt": "2026-11-03T08:20:00.000Z"
    },
    {
      "id": "msg_02",
      "fromRole": "BACKEND",
      "toRole": "ARCHITECT",
      "intent": "CRITIQUE",
      "content": "Endpoint requires query pagination parameter limit ceiling...",
      "sequenceNumber": 2,
      "critiques": [
        {
          "id": "crit_01",
          "filePath": "src/api.js",
          "lineNumber": 45,
          "severity": "BLOCKING",
          "issueDescription": "Missing safeLimit validation on page size"
        }
      ],
      "createdAt": "2026-11-03T08:22:00.000Z"
    }
  ]
}
```

#### 3. `POST /api/v2/projects/:id/critiques/:critiqueId/resolve`
- **Auth:** `DEVELOPER` or higher.
- **Purpose:** Marks a code review or security critique as resolved with resolution evidence.
- **Request Body:**
```json
{
  "resolutionNote": "Implemented safeLimit(options.limit, 100, 500) with parameterized placeholder.",
  "commitSha": "a89cf12"
}
```
- **Response `200 OK`:** Returns resolved critique record.

---

### 2.4 Autonomous Browser QA Endpoints

#### 1. `POST /api/v2/projects/:id/qa/browser-test`
- **Auth:** `TEST_RUN` permission.
- **Purpose:** Dispatches containerized headless Playwright browser to execute automated interaction, visual, and accessibility testing against live project preview.
- **Request Body:**
```json
{
  "browserType": "CHROMIUM",
  "viewport": { "width": 1280, "height": 800 },
  "scenarios": [
    { "name": "Form Submission Test", "path": "/register", "actions": ["FILL_EMAIL", "FILL_PASSWORD", "CLICK_SUBMIT"] },
    { "name": "WCAG Accessibility Audit", "path": "/", "auditAxe": true }
  ],
  "captureScreenshots": true
}
```
- **Response `202 Accepted`:**
```json
{
  "sessionId": "bqa_sess_99a81",
  "status": "RUNNING",
  "targetUrl": "http://127.0.0.1:3240/",
  "createdAt": "2026-11-03T08:45:00.000Z"
}
```

#### 2. `GET /api/v2/projects/:id/qa/sessions/:sessionId`
- **Auth:** `PROJECT_READ`.
- **Purpose:** Fetches complete results of a browser QA run, including step logs, assertion failures, Axe accessibility violations, and visual screenshot links.
- **Response `200 OK`:**
```json
{
  "sessionId": "bqa_sess_99a81",
  "status": "PASSED",
  "totalAssertions": 12,
  "passedAssertions": 12,
  "failedAssertions": 0,
  "axeViolationsCount": 0,
  "durationMs": 4210,
  "artifacts": [
    {
      "artifactId": "art_qa_screen_01",
      "artifactType": "SCREENSHOT_PNG",
      "downloadUrl": "/api/v2/projects/proj-123/qa/artifacts/art_qa_screen_01"
    }
  ]
}
```

---

### 2.5 Real-Time Communication Protocol (WebSocket & SSE)

#### 1. `GET /api/v2/ws` (WebSocket Protocol Upgrade)
- **Protocol:** `Sec-WebSocket-Protocol: pulse-v2-token, <jwt_token>`
- **Capabilities:**
  - Real-time token streaming from active LLMs.
  - Interactive browser test live DOM event streaming.
  - Bidirectional human operator intervention during agent debates.
- **Client Frame Example:**
```json
{ "type": "SUBSCRIBE_AGENT_THREAD", "threadId": "thrd_87a912" }
```
- **Server Frame Example:**
```json
{
  "type": "AGENT_THOUGHT_DELTA",
  "threadId": "thrd_87a912",
  "agentRole": "SECURITY",
  "textDelta": "Validating password hashing implementation with timingSafeEqual..."
}
```

#### 2. `GET /api/v2/stream` (SSE Telemetry Fallback)
- Operates identically to existing `/api/stream` with enhanced V2 payload typing (`MODEL_SWITCHED`, `A2A_CRITIQUE_EMITTED`, `BROWSER_QA_STEP_COMPLETED`).

