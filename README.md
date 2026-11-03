# AgentX — Autonomous AI Software House 2.0
> Enterprise-grade autonomous AI software engineering organization that conceives, architects, codes, reviews, tests, visual-audits, self-heals, and deploys full-stack software applications.

---

## 🌟 Executive Overview

**AgentX** is an autonomous virtual software enterprise platform built to coordinate autonomous AI agents working collaboratively in cross-functional squads. Governed by a **Tech Lead** arbitrator and structured **Agent-to-Agent (A2A)** protocols, AgentX autonomously turns product ideas and natural language specifications into fully tested, production-grade applications.

---

## 🏛️ Core Architectural Pillars (Version 2.0)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PULSE 2.0 GLASSMORPHISM ENTERPRISE IDE                 │
│        (Multi-Stream Telemetry • Visual DAG Canvas • Live Preview • QA)      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ WebSocket (RFC 6455) & REST (/api/v2/*)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                        VERSION 2.0 API & EVENT GATEWAY                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  • SSO Identity Adapter (OIDC / SAML 2.0 with Enterprise Role Mapping)      │
│  • Cryptographic Tamper-Evident SHA-256 Hash-Chained Audit Logger (SOC 2)   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         ▼                             ▼                             ▼
┌───────────────────┐        ┌───────────────────┐        ┌───────────────────┐
│   PRODUCT SQUAD   │        │ ENGINEERING SQUAD │        │  ASSURANCE SQUAD  │
├───────────────────┤        ├───────────────────┤        ├───────────────────┤
│ • Sofia Ramos     │◄──────►│ • Alex Rivera     │◄──────►│ • Kaito Tanaka    │
│   (PM / Lead)     │  A2A   │   (Tech Lead)     │  A2A   │   (Code Review)   │
│ • Elena Rostova   │  Bus   │ • Aria Patel (FE) │  Bus   │ • Quinn Sterling  │
│   (Business Analyst)       │ • David Chen (BE) │        │   (QA Automation) │
│ • Maya Lin        │        │ • Tariq Al-Mansoor│        │ • Valerie Vance   │
│   (UI/UX Designer)│        │   (Database)      │        │   (Security Lead) │
│                   │        │ • Dr. Aris Thorne │        │ • Marcus Bell     │
│                   │        │   (AI Engineer)   │        │   (Performance)   │
│                   │        │ • Devon Kross     │        │                   │
│                   │        │   (DevOps Cloud)  │        │                   │
└───────────────────┘        └───────────────────┘        └───────────────────┘
         │                             │                             │
         └─────────────────────────────┼─────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 MULTI-MODEL RESILIENT AI GATEWAY & CASCADE                  │
│       Anthropic Claude 3.5 Sonnet ──► Google Gemini 3.5 ──► DeepSeek Coder  │
│         [Circuit Breaker: CLOSED / OPEN / HALF_OPEN • Key Redaction]        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     AUTONOMOUS TEST & EXECUTION ENGINES                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Autonomous Browser QA Runner: Step actions, form fills, DOM assertions    │
│ • Visual Regression Comparator: Pixel-diff engine (< 1% threshold failure) │
│ • Automated WCAG 2.1 AA Auditor: Image alt, form labels, headings, contrast │
│ • Persistent Organizational Vector Memory: 64-dim unit vector cosine search │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🤖 13-Agent Persona Roster & Squad Organization

AgentX organizes its 13 specialized engineering roles into 3 functional squads:

| Squad | Agent Persona | Role | Domain Expertise |
| :--- | :--- | :--- | :--- |
| **Engineering** | **Alex Rivera** | `TECH_LEAD` | Architecture arbitration, tech stack decisions, PR approval |
| **Engineering** | Aria Patel | `FRONTEND` | Glassmorphic UI, responsive layout, reactive frontend state |
| **Engineering** | David Chen | `BACKEND` | Microservices, REST/WebSocket APIs, background tasks |
| **Engineering** | Tariq Al-Mansoor | `DATABASE` | SQLite WAL / PostgreSQL 16 schema modeling, ACID transactions |
| **Engineering** | Dr. Aris Thorne | `AI_ENGINEER` | LLM prompt engineering, vector embeddings, token metering |
| **Engineering** | Devon Kross | `DEVOPS` | Docker containers, CI/CD pipelines, release packaging |
| **Product** | **Sofia Ramos** | `PM` | Project roadmap, DAG stage scheduling, resource allocation |
| **Product** | Elena Rostova | `BA` | User stories, acceptance criteria, domain synthesis |
| **Product** | Maya Lin | `DESIGNER` | Design systems, micro-interactions, accessibility tokens |
| **Assurance** | **Kaito Tanaka** | `CODE_REVIEWER` | Static analysis, code quality gates, defect discovery |
| **Assurance** | Quinn Sterling | `QA` | Integration testing, regression suites, browser automation |
| **Assurance** | Valerie Vance | `SECURITY` | Sandbox jail confinement, secret isolation, CVE scanning |
| **Assurance** | Marcus Bell | `PERFORMANCE` | Load testing, memory profiling, latency optimization |

---

## ⚡ Key Version 2.0 Capabilities

### 1. Multi-Model AI Gateway & Cascading Failover
- **Domain-Specific Routing**: Dispatches requests to the optimal provider based on task domain (`ARCHITECTURE`, `CODE_GEN`, `SECURITY`, `QA`, `GENERAL`).
- **Resilient Circuit Breaker**: Prevents cascade failures with a three-state machine (`CLOSED`, `OPEN`, `HALF_OPEN`), tripping after 3 consecutive errors and cooling down for 60 seconds.
- **Automatic Fallback Cascade**: Claude 3.5 Sonnet $\rightarrow$ Google Gemini 3.5 $\rightarrow$ DeepSeek Coder $\rightarrow$ Local Ollama $\rightarrow$ Intelligent Simulation.

### 2. A2A Collaboration & Squad Coordination Protocol
- Structured inter-agent communication bus with typed message intents: `PROPOSE`, `CRITIQUE`, `REVISE`, `APPROVE`, `ESCALATE`.
- Multi-turn peer review workflow with blocking critiques and automated dispute escalation to the Tech Lead for binding arbitration.

### 3. Persistent Organizational Vector Memory
- 64-dimensional normalized unit vector embeddings generated via subword/n-gram hashing with stop-word dampening.
- Sub-millisecond cosine similarity semantic search across Architecture Decision Records (ADRs), PRDs, security rules, and historical bug fixes.
- Dual-compatibility: native PostgreSQL 16 + `pgvector` in cloud production, zero-dependency SQLite fallback in local development.

### 4. Autonomous Browser QA & Interaction Testing Engine
- Headless scenario runner supporting automated navigation, input typing, button clicks, text assertions, and DOM structure verification.
- **Pixel Visual Regression Engine**: Detects layout breaks exceeding a 1% pixel diff threshold and renders highlight masks in bright magenta.
- **Automated WCAG 2.1 AA Compliance Auditor**: Evaluates images, labels, headings, and contrast to guarantee accessible UI synthesis.
- **Self-Healing Diagnostics**: Translates test failures directly into actionable prompt context for Developer and QA agents to heal defects automatically.

### 5. Enterprise Infrastructure & Security
- **Tamper-Evident Hash-Chained Audit Log**: Cryptographic append-only log with SHA-256 hash chaining and HMAC-SHA256 signatures for SOC 2 Type II compliance.
- **Enterprise SSO**: OIDC and SAML 2.0 authentication adapters mapping corporate groups (Okta, Azure AD) to platform roles (`ADMIN`, `TECH_LEAD`, `DEVELOPER`, `VIEWER`).
- **RFC 6455 WebSocket Gateway**: Real-time multi-agent reasoning thought streams, live DAG execution updates, and project channel broadcasts.
- **Glassmorphism 2.0 IDE**: Translucent blur-backed dark interface at `/v2/` featuring real-time multi-stream thoughts, visual DAG canvas, and code diff inspector.

---

## 🚀 Quick Start Guide

### Prerequisites
- Node.js $\ge$ 20.0.0 (or bundled hermetic binary `./bin/node`)
- Git

### 1. Clone & Configure
```bash
git clone https://github.com/Naveen798933/agentX.git
cd agentX
cp .env.example .env
```

### 2. Configure Environment Keys (Optional for Live LLMs)
Edit `.env` to configure your preferred model provider keys:
```env
# Multi-Model AI Gateway
ENABLE_V2_MULTI_MODEL_GATEWAY=true
GEMINI_API_KEY=your_gemini_key
ANTHROPIC_API_KEY=your_anthropic_key
DEEPSEEK_API_KEY=your_deepseek_key

# Enterprise Security
AUTH_ENABLED=false # Set to true for production JWT/SSO auth
AUDIT_SIGNING_KEY=your_secret_signing_key_32_chars
```
*(If no keys are supplied, AgentX operates in Intelligent Simulation Mode with zero external dependencies).*

### 3. Start the Server
```bash
./bin/node src/server/server.js
```
The application will launch on `http://127.0.0.1:3000`:
- **Glassmorphism 2.0 Enterprise IDE**: [`http://127.0.0.1:3000/v2/`](http://127.0.0.1:3000/v2/)
- **Classic Control Center**: [`http://127.0.0.1:3000/`](http://127.0.0.1:3000/)

---

## 🧪 Comprehensive Verification Suite

Run all test suites locally:
```bash
# Execute V2.0 Enterprise Engine Suites
./bin/node --test tests/model_gateway.test.js \
                  tests/a2a_collaboration.test.js \
                  tests/organizational_memory.test.js \
                  tests/browser_qa_engine.test.js \
                  tests/enterprise_security_v2.test.js

# Execute Core Governance & Sandbox Suites
./bin/node --test tests/milestone0.test.js \
                  tests/agents.test.js \
                  tests/lifecycle.test.js
```

---

## 📚 Technical Documentation Directory

- [V2 Architecture Blueprint](file:///Users/kotanaveen/Documents/virtual%20company/V2_ARCHITECTURE.md)
- [V2 Database Design & Schema](file:///Users/kotanaveen/Documents/virtual%20company/V2_DATABASE_DESIGN.md)
- [V2 API Specifications](file:///Users/kotanaveen/Documents/virtual%20company/V2_API_DESIGN.md)
- [V2 Agent Organization & Hierarchy](file:///Users/kotanaveen/Documents/virtual%20company/V2_AGENT_ORGANIZATION.md)
- [V2 Implementation Roadmap](file:///Users/kotanaveen/Documents/virtual%20company/V2_IMPLEMENTATION_ROADMAP.md)
- [V2 Risk Register](file:///Users/kotanaveen/Documents/virtual%20company/V2_RISK_REGISTER.md)
- [Master System Knowledge Document](file:///Users/kotanaveen/Documents/virtual%20company/docs/PROJECT_MASTER_KNOWLEDGE_DOCUMENT.md)

---

## 🛡️ License & Attestation

Built with Node.js ES Modules, SQLite WAL, and PostgreSQL 16. Designed for enterprise deployment.
