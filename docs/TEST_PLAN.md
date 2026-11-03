# AI Virtual Software House - Test Plan & Verification Strategy

## 1. Overview
The testing framework uses Node.js 22's built-in `node:test` and `node:assert/strict` modules. This provides enterprise-grade, deterministic, asynchronous test execution without third-party dependencies.

---

## 2. Test Execution Matrix

| Test Suite | File | Focus Areas | Target Milestone | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Milestone 0 Core** | `tests/milestone0.test.js` | Database initialization, Budget limits, Sandbox isolation, Explicit approvals | **Milestone 0** | 15/15 Passed |
| **Multi-Agent Engine** | `tests/agents.test.js` | Role prompt generation, EventBus pub/sub, Inter-agent message handoff | **Milestone 1** | 9/9 Passed |
| **Project Lifecycle** | `tests/lifecycle.test.js` | Requirement parsing, Task DAG ordering, Code writing in sandbox | **Milestone 2** | 7/7 Passed |
| **API & Telemetry** | `tests/server.test.js` | REST endpoints, SSE streams, Approval HTTP submission | **Milestone 3** | 12/12 Passed |
| **Security Hardening** | `tests/security.test.js` | Path traversal attacks, command injection blocks, unauthorized deployment block | **Milestone 4** | 30/30 Passed |
| **Preview Management** | `tests/preview_manager.test.js` | Isolated runtime detection, SPA fallback, dynamic live-reload bridge | **Milestone 6** | 8/8 Passed |
| **Autonomous Build** | `tests/autonomous_build.test.js` | End-to-end full lifecycle synthesis, DAG execution, artifact creation | **Engine Core** | 4/4 Passed |
| **Audit Engine Suite** | `tests/audit_engine.test.js` | Strict scope verification, rogue feature prevention, self-healing, matrix audits | **Milestone 6** | 11/11 Passed |
| **Pulse Workspace** | `apps/collaborative-workspace/tests/workspace.test.js` | SQLite WAL persistence, SSE replay, real-time channels & Kanban | **Milestone 5** | 11/11 Passed |

---

## 3. Detailed Test Suites

### 3.1 Storage & Schema Validation (`src/storage/db.js`)
- [x] **TC-DB-01**: Initialize SQLite database in memory or file. Verify all tables (`projects`, `tasks`, `approvals`, `audit_logs`, `sandbox_runs`, `build_runs`) are created with correct constraints.
- [x] **TC-DB-02**: Create, read, update, and delete project records; verify foreign key constraints, atomic token deduction, and timestamp updates.
- [x] **TC-DB-03**: Verify transactional integrity, WAL mode journal mode, and audit log writing.

### 3.2 Budget & Token Quota Enforcement (`src/budget/budgetManager.js`)
- [x] **TC-BUD-01**: Initialize project with a fixed token budget (e.g. 10,000 tokens). Record normal token usage (e.g. 2,000 tokens) and verify remaining balance is updated.
- [x] **TC-BUD-02**: Attempt to record token usage that exceeds the project budget. Verify `BudgetExceededError` is thrown and project status transitions to `BUDGET_EXCEEDED`.
- [x] **TC-BUD-03**: Verify pre-flight check `canAfford(tokens)` accurately predicts whether a request can be executed without exceeding ceiling.

### 3.3 Sandbox Isolation & Execution (`src/sandbox/sandboxExecutor.js`)
- [x] **TC-SBX-01**: Execute benign commands inside the assigned project sandbox; verify exit code 0 and stdout capture.
- [x] **TC-SBX-02**: Attempt path traversal by specifying working directories outside the sandbox (e.g. `../../`); verify execution is blocked with `SecurityError`.
- [x] **TC-SBX-03**: Attempt to execute blacklisted commands (`rm -rf /`, `curl | bash`, fork bombs); verify immediate rejection prior to process spawn.
- [x] **TC-SBX-04**: Execute commands that exceed timeout limits; verify process is forcefully terminated with timeout flag.
- [x] **TC-SBX-05**: Verify environment isolation: host environment secrets are not leaked into the sandboxed process.

### 3.4 Explicit Human Approval Workflow (`src/approval/approvalManager.js`)
- [x] **TC-APP-01**: Create an approval request for `PRODUCTION_DEPLOYMENT`. Verify status is `PENDING`.
- [x] **TC-APP-02**: Verify that any attempt to proceed with the action while status is `PENDING` is strictly blocked.
- [x] **TC-APP-03**: Grant explicit approval (`APPROVE`); verify transition to `APPROVED` with operator signature and timestamp.
- [x] **TC-APP-04**: Reject approval request (`REJECT`); verify transition to `REJECTED` and pipeline halt.
- [x] **TC-APP-05**: Enforce approval expiration TTL (24h default); reject stale approval attempts.

### 3.5 Requirement-Accurate Self-Auditing Engine (`tests/audit_engine.test.js`)
- [x] **TC-AUD-01**: Domain accuracy assertion: building an Auth Portal must generate Login & Signup forms and never a Shopping Cart.
- [x] **TC-AUD-02**: E-commerce domain assertion: building a Cart properly generates Cart & Checkout button.
- [x] **TC-AUD-03**: Controlled syntax/compilation error detection with automatic self-healing repair.
- [x] **TC-AUD-04**: Honest 12-dimension verification reporting without false passes.
- [x] **TC-AUD-05**: Audit report persistence to SQLite and workspace filesystem.
- [x] **TC-AUD-06**: Stale preview detection and non-destructive preservation of unrelated files.

### 3.6 Pulse Collaborative Workspace (`apps/collaborative-workspace/tests/workspace.test.js`)
- [x] **TC-PLS-01**: Storage engine seeds default users, channels, and tasks with ACID SQLite WAL mode.
- [x] **TC-PLS-02**: Multi-channel message broadcasting and emoji reaction toggle.
- [x] **TC-PLS-03**: Kanban task stage transitions and task deletion.
- [x] **TC-PLS-04**: SSE keep-alive stream connection and event replay.

---

## 4. How to Run Tests

Execute test suites using the local runner or npm commands:

```bash
# Run all tests across the entire platform
npm test

# Run specific milestone suites
npm run test:m0          # Milestone 0 Core
npm run test:m1          # Milestone 1 Agents
npm run test:m2          # Milestone 2 Lifecycle
npm run test:m3          # Milestone 3 Web Server
npm run test:m4          # Milestone 4 Security
npm run test:audit       # Self-Auditing Engine
npm run test:preview     # Browser Preview Manager
npm run test:realtime    # Pulse Workspace
```

All 109+ tests must pass with zero failures.
