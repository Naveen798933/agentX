# AI Virtual Software House - Implementation Plan

## Executive Summary
The **AI Virtual Software House** is an autonomous, multi-agent software engineering organization platform. It simulates and coordinates a full-lifecycle software house (CEO/Product Manager, System Architect, Frontend Engineer, Backend Engineer, QA Engineer, DevOps/Security Engineer) to intake requirements, design architectures, implement production code, run tests in isolated sandboxes, enforce strict token/cost budgets, and require human-in-the-loop explicit approval for all sensitive transitions (especially production deployments).

---

## Phased Milestones Overview

| Milestone | Title | Focus & Core Deliverables | Target Gate |
| :--- | :--- | :--- | :--- |
| **Milestone 0** | **Foundation & Governance Core** | Repo bootstrap, Node 22 runtime, SQLite persistence, Sandboxed Execution Engine, Budget Metering & Hard-Stop, Explicit Approval Workflow, Comprehensive Tests | 100% Unit/Integration Test Pass |
| **Milestone 1** | **Multi-Agent Orchestration & Roles** | Role-based Agent specs (PM, Architect, Devs, QA, DevOps), Event-driven Message Bus, Inter-agent Communication, Context Management | Multi-agent coordination test pass |
| **Milestone 2** | **Project Lifecycle & Code Synthesis Engine** | Requirement parsing, Architecture Decision Records (ADRs), Task decomposition, Code generation, Test generation | Autonomous project build in sandbox |
| **Milestone 3** | **Interactive Web Dashboard & Real-Time Telemetry** | Premium Glassmorphism UI, Live Agent Thought & Stream feed, Sandboxed Output visualizer, Budget graphs, Interactive Approval Modal | Interactive verification in browser |
| **Milestone 4** | **End-to-End Verification, Security Hardening & Approval Gates** | Sandbox containment verification, Prompt injection defense, Budget overrun denial, Production deployment approval barrier | End-to-end security & regression pass |

---

## Detailed Milestone Breakdown

### Milestone 0: Foundation & Governance Core (Current Target)
- [x] **M0.1 - Environment & Runtime Baseline**: Zero-dependency Node.js v22 runtime wrapper utilizing bundled high-performance runtime; native `node:test`, `node:sqlite`, `node:crypto`, `node:http`.
- [x] **M0.2 - Database & State Store**: SQLite schema for projects, tasks, agent activities, token expenditures, budget allocations, and explicit approval states.
- [x] **M0.3 - Sandbox Isolation Layer**: Controlled execution environment with timeout protection, path containment inside project workspace, disallowed system commands, and process telemetry.
- [x] **M0.4 - Budget & Financial Guardrails**: Hard token caps, dollar-value cost conversion, pre-allocation per task, real-time tracking, and immediate hard-stop when quota is reached.
- [x] **M0.5 - Explicit Approval Gate Engine**: Non-bypassable human approval system for sensitive operations (file system modifications outside target project, cloud credentials, database drops, and specifically **Production Deployment**).
- [x] **M0.6 - Test Harness & Validation**: Comprehensive test suite verifying database integrity, sandbox restrictions, budget halts, and approval requirements.

### Milestone 1: Multi-Agent Orchestration Engine
- [x] **M1.1 - Agent Persona & Role Framework**: Abstract `BaseAgent` class with prompt engineering templates for:
  - **Product Manager (PM)**: Requirement refinement, user stories, acceptance criteria.
  - **System Architect**: System design, technology choices, API contracts.
  - **Backend Engineer**: API implementation, database models, business logic.
  - **Frontend Engineer**: Component implementation, UI/UX aesthetics, client state.
  - **QA Engineer**: Test cases, edge case validation, automated assertions.
  - **DevOps/SecOps Engineer**: Security review, sandbox configuration, deployment checks.
- [x] **M1.2 - Event-Driven Message Bus**: Asynchronous publish/subscribe message bus with typed events (`AGENT_DISPATCH`, `CODE_PRODUCED`, `TEST_EXECUTION_REQUESTED`, `APPROVAL_REQUIRED`, `AGENT_THOUGHT`).
- [x] **M1.3 - Context Window & Thought Streaming**: Streaming reasoning trace and event history buffer for real-time telemetry replay.

### Milestone 2: Project Lifecycle & Execution Pipeline
- [x] **M2.1 - Requirement Intake & Spec Generation**: Automated PRD and ADR generation with Gemini LLM & intelligent simulation fallback.
- [x] **M2.2 - Task Breakdown & Dependency Graph**: Directed Acyclic Graph (DAG) with topological sorting, dependency checks, and stage status progression.
- [x] **M2.3 - Code Synthesis & File Generation**: Automated file creation, syntax checking, safe file writes, and Git version control ledger with signed commits.
- [x] **M2.4 - Sandboxed Test Execution Loop**: Continuous execution of test scripts in the sandbox; feedback loop sending stack traces back to agent for automated self-healing.

### Milestone 3: Real-Time Web Dashboard & Control Center
- [x] **M3.1 - HTTP & SSE Server**: Native zero-external-dependency HTTP server with REST endpoints and Server-Sent Events (SSE) for real-time telemetry.
- [x] **M3.2 - Modern UI**: Curated dark-mode glassmorphic interface with interactive DAG visualizer, live thought stream, file explorer, commit graph, and budget gauge.
- [x] **M3.3 - Interactive Approval Panel**: Real-time modal prompting human operator for explicit Yes/No approval with full diffs and risk assessment before sensitive actions.

### Milestone 4: Security Hardening & Production Gate Enforcement
- [x] **M4.1 - Path Traversal & Command Injection Defense**: Strict path sanitization preventing access to parent folders or sensitive OS paths, and command blacklist.
- [x] **M4.2 - Production Deployment Safety Lock**: Hard-coded gate forbidding any deployment trigger without explicit human operator cryptographic approval.
- [x] **M4.3 - Full End-to-End System Test**: Autonomous software project created from prompt to verified build under strict budget across 70 automated tests.
