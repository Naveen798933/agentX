# Phase 1: Secure Project Execution Sandbox Guide

This document describes the architecture, security boundaries, setup requirements, and operational procedures for the isolated project execution environment in the **AI Virtual Software House (PULSE)**.

---

## 1. Sandbox Architecture Overview

Generated applications and arbitrary agent-executed tasks run inside strictly isolated Docker containers. The architecture guarantees that generated code has no access to host secrets, cloud credentials, the host filesystem, or other projects.

```
┌────────────────────────────────────────────────────────────────────────┐
│                              HOST SYSTEM                               │
│  Node 22 Orchestrator / Server / Preview Manager                       │
│  Storage: data/virtual_company.db | Workspaces: data/workspaces/       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                  Docker CLI Isolation Boundary (No host execution)
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                    DOCKER SANDBOX CONTAINER                            │
│  Name: pulse-sbx-<projectId>-<runId>                                   │
│  Image: node:22-alpine (or configured SANDBOX_DOCKER_IMAGE)            │
├────────────────────────────────────────────────────────────────────────┤
│  Security Controls:                                                    │
│  - User: 1000:1000 (Non-root user)                                     │
│  - No-new-privileges: true (Privilege escalation denied)               │
│  - Capabilities: ALL dropped (--cap-drop=ALL)                          │
│  - Root Filesystem: READ-ONLY (--read-only)                            │
│  - Network: STRICTLY RESTRICTED (--network=none by default)             │
│  - Tmpfs Mount: /tmp:rw,noexec,nosuid,size=64m                         │
│                                                                        │
│  Resource Limits:                                                      │
│  - CPU Quota: --cpus=1.0                                               │
│  - Memory Quota: --memory=512m                                         │
│  - Memory Swap Quota: --memory-swap=512m                               │
│  - Process Limit: --pids-limit=64 (Fork-bomb defense)                  │
│  - Execution Timeout: SIGKILL at configured limit (default 15s)        │
│                                                                        │
│  Volume Mounts (Strictly Validated):                                   │
│  - /workspace:rw -> data/workspaces/<projectId> ONLY                   │
│  - Host home (~), SSH keys, cloud credentials, docker.sock: FORBIDDEN │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Security Boundaries & Guardrails

| Boundary | Enforcement Mechanism | Failure Action |
| :--- | :--- | :--- |
| **Non-Root Execution** | `--user 1000:1000` | Process runs with unprivileged UID/GID inside container |
| **Privilege Escalation** | `--security-opt=no-new-privileges:true` | `setuid`/`setgid` calls blocked |
| **Kernel Capabilities** | `--cap-drop=ALL` | Linux kernel syscalls restricted |
| **Filesystem Mutation** | `--read-only` rootfs | Base image modification fails with `EROFS` |
| **Ephemeral Scratch** | `--tmpfs /tmp:rw,noexec,nosuid,size=64m` | Discarded on container termination |
| **Host Secrets Isolation** | `validateMountPath` validator blocks `~/.ssh`, `~/.aws`, `.env`, `docker.sock` | Throws `SecurityError`, container rejected |
| **Network Restriction** | `--network=none` by default | Zero inbound/outbound socket connectivity |
| **Path Traversal Guard** | `resolvePathSafely` checks canonical path, boundary escape, symlinks, null-bytes | Throws `SecurityError`, access rejected |
| **Destructive Commands** | Blacklist regex blocks `rm -rf /`, `mkfs`, fork bombs, reverse shells | Throws `SecurityError` before spawn |
| **Timeout & Runaways** | `setTimeout` timer kills container/process with SIGKILL | Return `exitCode: 124`, `timedOut: true` |
| **Cross-Project Isolation** | Independent directories (`data/workspaces/<projectId>`), unique ports, isolated logs | Cross-read/write rejected |
| **Host Execution Denial** | If Docker is offline, commands are NOT executed on host shell | Returns `backendUsed: 'UNAVAILABLE'`, `exitCode: 126` |

---

## 3. Host Setup Requirements

To run containerized executions in production or testing with Docker:

### A. Prerequisites
1. **Docker Desktop** (macOS / Windows) or **Docker Engine** (Linux).
2. Ensure Docker daemon is running:
   ```bash
   docker info
   ```
3. Pull the base Node sandbox image:
   ```bash
   docker pull node:22-alpine
   ```

### B. Environment Variables
Add to `.env` or export in your environment:
```env
# Sandbox Engine Backend ('DOCKER' | 'AUTO' | 'PROCESS_JAIL')
SANDBOX_BACKEND=AUTO

# Docker image used for sandbox execution
SANDBOX_DOCKER_IMAGE=node:22-alpine

# Set to true to strictly block execution when Docker is offline
SANDBOX_STRICT_ISOLATION=true

# Non-production fallback only (allows local process jail when Docker is offline)
SANDBOX_ALLOW_HOST_FALLBACK=false
```

---

## 4. Lifecycle API Usage

The `SandboxExecutor` provides complete lifecycle operations for projects:

```javascript
import { SandboxExecutor } from './src/sandbox/sandboxExecutor.js';

const sandbox = new SandboxExecutor('data/workspaces', storage, {
  defaultTimeoutMs: 15000,
  cpuLimit: '1.0',
  memoryLimit: '512m'
});

// 1. Check Docker status
const dockerStatus = sandbox.checkDocker();
console.log('Docker Available:', dockerStatus.available);

// 2. Execute command inside isolated container
const runResult = await sandbox.executeCommand('proj-placement-001', 'node --test');
console.log('Exit Code:', runResult.exitCode);
console.log('Output:', runResult.stdout);

// 3. Start persistent application container with allocated port
const service = await sandbox.startProject('proj-placement-001', 'node src/api.js');
console.log(`Project running on port ${service.port}`);

// 4. Query project status
const status = sandbox.getProjectStatus('proj-placement-001');

// 5. Restart project service
await sandbox.restartProject('proj-placement-001', 'node src/api.js');

// 6. Stop and cleanup project
await sandbox.stopProject('proj-placement-001');
await sandbox.cleanupProject('proj-placement-001');
```

---

## 5. Test Suite Verification

Run the comprehensive sandbox security isolation suite:
```bash
./bin/node --test tests/sandbox_isolation.test.js
```

### Coverage Assertions:
- **19 Malicious script & destructive command attacks** blocked with `SecurityError`.
- **6 Path traversal & identifier escape vectors** blocked.
- **5 Sensitive host mount attempts** (`.ssh`, `docker.sock`, cloud creds, `/etc`) blocked.
- **4 Docker security argument assertions** (non-root UID, dropped caps, read-only root, network isolation).
- **2 Resource exhaustion & timeout defense assertions** verified.
- **3 Cross-project isolation & port partition assertions** verified.
- **3 Lifecycle assertions** (`start`, `status`, `restart`, `stop`, `cleanup`) verified.
- **3 Docker unavailability & host protection assertions** verified.
