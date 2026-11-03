# AI Virtual Software House - Security Specification

## 1. Security Philosophy
The AI Virtual Software House executes automated code generation, dependency installation, and script execution. Because automated agents can be manipulated via prompt injection or generate dangerous instructions, security is established through **defense-in-depth, strict boundary isolation, resource containment, and mandatory human checkpoints**.

---

## 2. Threat Modeling & Mitigations

| Threat | Description | Mitigation Strategy |
| :--- | :--- | :--- |
| **Sandbox Breakout** | Agent executes commands designed to inspect or alter the host system | Restricted working directory jail, command blacklist, stripped environment variables, non-root execution. |
| **Path Traversal** | Agent accesses files outside the assigned project sandbox (e.g. `../../.ssh`) | Canonical path resolution (`path.resolve`) with strict prefix enforcement against `project_dir`. Relative paths containing `..` escape attempts are instantly aborted. |
| **Denial of Wallet / Budget Exhaustion** | Agent enters infinite generation loop or recursive task explosion | Hard-stop token quotas enforced at the `BudgetManager` layer. If budget is exceeded, task aborts immediately. |
| **Unauthorized Deployment** | Autonomous agent deploys code to production without review | **Non-bypassable gate**: Production deployments require human explicit cryptographic approval. |
| **Command Injection** | Unsanitized user inputs or agent outputs concatenated into shell commands | Strict argument validation, execution via spawned arguments without raw subshells where feasible, and rejection of dangerous command sequences (`rm -rf`, `curl | sh`, `mkfs`, etc.). |
| **Secret Leaks** | Host environment secrets (tokens, API keys, user SSH keys) exposed to agent-generated code | Sandbox execution processes run with an explicit empty or sanitized environment whitelist (`SANDBOX_ENV`). No host `process.env` is inherited by default. |

---

## 3. Sandboxed Execution Standards

### 3.1 Directory Containment (Jail)
- Every project has a dedicated isolation root: `data/workspaces/{project_id}/`.
- All file reads, writes, and command executions must resolve strictly inside this root:
  ```javascript
  const canonicalTarget = path.resolve(sandboxRoot, userRelativePath);
  if (!canonicalTarget.startsWith(sandboxRoot + path.sep)) {
    throw new SecurityException("Path traversal attempt detected");
  }
  ```

### 3.2 Command Blacklisting & Dangerous Pattern Filtering
The following command patterns are forbidden:
- Root deletion / mass destruction: `rm -rf /`, `rm -rf ~`, `mkfs`, `dd`
- System control: `shutdown`, `reboot`, `halt`, `killall`
- Privilege escalation: `sudo`, `su`, `chmod 777 /`
- Network piping: `curl ... | bash`, `wget ... | sh`
- Shell escape characters / fork bombs: `:(){ :|:& };:`

### 3.3 Resource Limits & Execution Timeouts
- Maximum process execution duration: **30 seconds** (configurable, max default 60s).
- Maximum standard output capture: **1 MB** to prevent buffer overflow or memory exhaustion.
- Explicit SIGTERM followed by SIGKILL if process exceeds timeout.

---

## 4. Human-in-the-Loop Explicit Approval Gates

### 4.1 Strict Production Deployment Gate
No automated agent has the capability or authorization to trigger a production deployment independently.
- The deployment action transitions to `PENDING_APPROVAL`.
- The human operator is provided with:
  1. Full Git/diff summary
  2. Test results from QA agent
  3. Security audit report from DevOps agent
  4. Estimated operational cost
- Only an explicit POST request with human sign-off (`decision: "APPROVE"`) transitions the state to `APPROVED` and allows release execution.

### 4.2 Audit Log Integrity
All security events, budget halts, sandbox violations, and approvals are written synchronously to the SQLite `audit_logs` table with immutable timestamps.
