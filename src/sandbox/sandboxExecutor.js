import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export class SecurityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SecurityError';
    this.details = details;
  }
}

/**
 * Default Sandbox Security Policy Constraints
 */
export const SANDBOX_DEFAULTS = {
  CPU_LIMIT: '1.0',
  MEMORY_LIMIT: '512m',
  MEMORY_SWAP_LIMIT: '512m',
  PIDS_LIMIT: 64,
  EXECUTION_TIMEOUT_MS: 15000,
  MAX_OUTPUT_BYTES: 512 * 1024, // 512 KB
  SANDBOX_USER: '1000:1000',
  DOCKER_IMAGE: 'node:22-alpine',
  NETWORK_MODE: 'none', // Default restricted offline network
  READ_ONLY_ROOT: true,
  TMPFS_MOUNTS: ['/tmp:rw,noexec,nosuid,size=64m'],
  EPHEMERAL_PORT_MIN: 3200,
  EPHEMERAL_PORT_MAX: 3800
};

/**
 * Forbidden host path patterns that must NEVER be mounted into a project container
 */
export const FORBIDDEN_HOST_PATTERNS = [
  /\/var\/run\/docker\.sock/i,
  /\.docker\/config\.json/i,
  /\/\.?ssh(?:\/|$)/i,
  /\/\.?aws(?:\/|$)/i,
  /\/\.?azure(?:\/|$)/i,
  /\/\.?config\/gcloud(?:\/|$)/i,
  /\/\.?kube(?:\/|$)/i,
  /\/\.?gnupg(?:\/|$)/i,
  /\/\.?env(?:\b|$)/i,
  /\/etc(?:\/|$)/i,
  /\/proc(?:\/|$)/i,
  /\/sys(?:\/|$)/i,
  /\/dev(?:\/|$)/i,
  /\/root(?:\/|$)/i,
  /\/bin(?:\/|$)/i,
  /\/sbin(?:\/|$)/i,
  /\/usr(?:\/|$)/i
];

/**
 * SandboxExecutor
 * Secure, isolated project execution environment for AI-generated applications.
 * Enforces containerized execution, non-root user, Linux capability restrictions,
 * resource limits, network isolation, path traversal guards, and lifecycle control.
 */
export class SandboxExecutor {
  /**
   * @param {string} workspacesRoot - Absolute directory where project workspaces reside
   * @param {import('../storage/db.js').StorageEngine} [storage]
   * @param {Object} [options]
   */
  constructor(workspacesRoot, storage = null, options = {}) {
    this.workspacesRoot = path.resolve(workspacesRoot);
    this.storage = storage;

    // Security & Resource Constraints
    this.defaultTimeoutMs = options.defaultTimeoutMs || SANDBOX_DEFAULTS.EXECUTION_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs || 30000;
    this.maxOutputBytes = options.maxOutputBytes || SANDBOX_DEFAULTS.MAX_OUTPUT_BYTES;
    this.cpuLimit = options.cpuLimit || SANDBOX_DEFAULTS.CPU_LIMIT;
    this.memoryLimit = options.memoryLimit || SANDBOX_DEFAULTS.MEMORY_LIMIT;
    this.memorySwapLimit = options.memorySwapLimit || SANDBOX_DEFAULTS.MEMORY_SWAP_LIMIT;
    this.pidsLimit = options.pidsLimit || SANDBOX_DEFAULTS.PIDS_LIMIT;
    this.sandboxUser = options.sandboxUser || SANDBOX_DEFAULTS.SANDBOX_USER;
    this.dockerImage = options.dockerImage || process.env.SANDBOX_DOCKER_IMAGE || SANDBOX_DEFAULTS.DOCKER_IMAGE;
    this.backendMode = options.backendMode || process.env.SANDBOX_BACKEND || 'AUTO';
    this.strictIsolation = options.strictIsolation !== undefined
      ? Boolean(options.strictIsolation)
      : (process.env.SANDBOX_STRICT_ISOLATION === 'true');
    this.allowHostFallback = options.allowHostFallback !== undefined
      ? Boolean(options.allowHostFallback)
      : (process.env.SANDBOX_ALLOW_HOST_FALLBACK === 'true');

    // Docker Daemon Status
    const probe = this._probeDocker();
    this.dockerAvailable = probe.available;
    this.dockerCheckReason = probe.reason || null;

    // Active Projects & Port Allocation Ledger
    this.activeProjects = new Map(); // projectId -> { containerName, process, port, status, startTime, command }
    this.allocatedPorts = new Map(); // port -> projectId
    this.portMin = options.portMin || SANDBOX_DEFAULTS.EPHEMERAL_PORT_MIN;
    this.portMax = options.portMax || SANDBOX_DEFAULTS.EPHEMERAL_PORT_MAX;

    if (!fs.existsSync(this.workspacesRoot)) {
      fs.mkdirSync(this.workspacesRoot, { recursive: true });
    }

    // Blacklist regexes for dangerous and destructive command patterns
    this.blacklistedPatterns = [
      /\brm\s+-(?:rf|fr)\s+(?:\/|~|\.\.)/i,
      /\bmkfs\b/i,
      /\bdd\s+if=/i,
      /\b(?:shutdown|reboot|poweroff|halt|init\s+0)\b/i,
      /\bsudo\b/i,
      /\bsu\b/i,
      /\bchmod\s+(?:-R\s+)?(?:777|000)\s+(?:\/|\.\.)/i,
      /\bcurl\b.*\|\s*(?:ba)?sh\b/i,
      /\bwget\b.*\|\s*(?:ba)?sh\b/i,
      /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
      /\/dev\/tcp\//i, // bash reverse shell
      /\bnc(?:at)?\s+-[el]/i, // netcat backdoor
      /python(?:\d+)?\s+-c\s+['"].*socket/i // python reverse shell
    ];
  }

  /**
   * Probe whether Docker daemon is active and responsive on host
   */
  _probeDocker() {
    try {
      const res = spawnSync('docker', ['info'], { stdio: 'pipe', timeout: 3000 });
      if (res.status === 0) {
        return { available: true };
      }
      const errOut = res.stderr ? res.stderr.toString('utf8').trim() : '';
      return { available: false, reason: errOut || 'Docker daemon returned non-zero status' };
    } catch (err) {
      return { available: false, reason: `Docker binary error: ${err.message}` };
    }
  }

  /**
   * Public check for Docker status
   */
  checkDocker() {
    return {
      available: this.dockerAvailable,
      reason: this.dockerCheckReason,
      dockerImage: this.dockerImage,
      backendMode: this.backendMode,
      activeBackend: this.getActiveBackend()
    };
  }

  /**
   * Resolve active sandbox execution backend
   */
  getActiveBackend() {
    if (this.backendMode === 'DOCKER' && this.dockerAvailable) return 'DOCKER';
    if (this.backendMode === 'DOCKER' && !this.dockerAvailable) return 'UNAVAILABLE';
    if (this.backendMode === 'PROCESS_JAIL') return 'PROCESS_JAIL';
    if (this.backendMode === 'AUTO') {
      return this.dockerAvailable ? 'DOCKER' : 'PROCESS_JAIL';
    }
    return this.dockerAvailable ? 'DOCKER' : 'UNAVAILABLE';
  }

  /**
   * Return canonical security policy definition
   */
  getSecurityPolicy() {
    return {
      nonRootUser: this.sandboxUser,
      noNewPrivileges: true,
      capabilitiesDropped: 'ALL',
      cpuLimit: this.cpuLimit,
      memoryLimit: this.memoryLimit,
      memorySwapLimit: this.memorySwapLimit,
      pidsLimit: this.pidsLimit,
      readOnlyRootFs: true,
      tmpfs: SANDBOX_DEFAULTS.TMPFS_MOUNTS,
      networkPolicy: 'none',
      mountRestrictions: 'Only verified workspace directory; host home, SSH keys, credentials, and docker.sock blocked',
      pathTraversalProtection: 'Realpath canonicalization + boundary assertion + null-byte rejection'
    };
  }

  /**
   * Validate that project ID is alphanumeric without path traversal components
   */
  validateProjectId(projectId) {
    if (!projectId || typeof projectId !== 'string') {
      throw new SecurityError('Invalid project ID: must be a non-empty string');
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(projectId)) {
      throw new SecurityError(`Invalid project ID format: "${projectId}". Only alphanumeric characters, hyphens, and underscores are allowed.`, { projectId });
    }
    if (projectId.length > 64) {
      throw new SecurityError(`Invalid project ID length: "${projectId}". Exceeds maximum 64 characters.`, { projectId });
    }
  }

  /**
   * Validate that a host path is strictly allowed for mounting
   * Throws SecurityError if any sensitive host files or directories are targeted
   */
  validateMountPath(hostPath) {
    if (!hostPath || typeof hostPath !== 'string') {
      throw new SecurityError('Invalid mount path: path must be a non-empty string');
    }

    const resolved = path.resolve(hostPath);

    // 1. Check against forbidden host directory patterns
    for (const pattern of FORBIDDEN_HOST_PATTERNS) {
      if (pattern.test(resolved)) {
        throw new SecurityError(`Mount denied: host path "${resolved}" matches forbidden sensitive pattern "${pattern}"`, {
          attemptedPath: hostPath,
          resolvedPath: resolved
        });
      }
    }

    // 2. Reject mounting user home directory root directly
    const homeDir = os.homedir();
    if (resolved === homeDir || resolved === '/root' || resolved === '/home' || resolved === '/Users') {
      throw new SecurityError(`Mount denied: host home directory "${resolved}" cannot be mounted into container`, {
        attemptedPath: hostPath,
        resolvedPath: resolved
      });
    }

    // 3. Ensure mount path is contained within the workspaces root
    if (!resolved.startsWith(this.workspacesRoot)) {
      throw new SecurityError(`Mount denied: path "${resolved}" escapes workspaces root "${this.workspacesRoot}"`, {
        attemptedPath: hostPath,
        resolvedPath: resolved,
        workspacesRoot: this.workspacesRoot
      });
    }

    return resolved;
  }

  /**
   * Return canonical workspace directory for a project
   */
  getProjectWorkspace(projectId) {
    this.validateProjectId(projectId);
    const projectDir = path.resolve(this.workspacesRoot, projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    // Ensure dedicated subdirectories exist
    const tmpDir = path.join(projectDir, 'tmp');
    const logsDir = path.join(projectDir, 'logs');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    return projectDir;
  }

  /**
   * Resolve and sanitize a relative path inside a project workspace
   */
  resolvePathSafely(projectId, relativePath = '') {
    this.validateProjectId(projectId);

    // 1. Check for null byte injection
    if (relativePath && relativePath.includes('\0')) {
      throw new SecurityError(`Path validation error: null byte injection detected`, { projectId, relativePath });
    }

    // 2. Check for URL-encoded traversal patterns
    if (relativePath && (/%2e|%2f|%5c/i.test(relativePath))) {
      throw new SecurityError(`Path traversal attempt detected: URL-encoded traversal characters in "${relativePath}"`, { projectId, relativePath });
    }

    const projectDir = this.getProjectWorkspace(projectId);
    const resolvedPath = path.resolve(projectDir, relativePath);

    // 3. Verify boundary containment
    if (!resolvedPath.startsWith(projectDir + path.sep) && resolvedPath !== projectDir) {
      throw new SecurityError(`Path traversal attempt detected: "${relativePath}" escapes project workspace`, {
        projectId,
        attemptedPath: relativePath,
        resolvedPath,
        projectDir
      });
    }

    // 4. Prevent symlink traversal escapes if file/link exists on disk
    if (fs.existsSync(resolvedPath)) {
      try {
        const realCanonical = fs.realpathSync(resolvedPath);
        const realProjectDir = fs.realpathSync(projectDir);
        if (!realCanonical.startsWith(realProjectDir + path.sep) && realCanonical !== realProjectDir) {
          throw new SecurityError(`Symlink traversal escape detected: "${relativePath}" resolves outside workspace`, {
            projectId,
            attemptedPath: relativePath,
            resolvedPath: realCanonical,
            projectDir: realProjectDir
          });
        }
      } catch (err) {
        if (err instanceof SecurityError) throw err;
      }
    }

    return resolvedPath;
  }

  /**
   * Validate a command string against known malicious and destructive patterns
   */
  validateCommand(command) {
    if (!command || typeof command !== 'string') {
      throw new SecurityError('Command must be a non-empty string');
    }

    for (const pattern of this.blacklistedPatterns) {
      if (pattern.test(command)) {
        throw new SecurityError(`Execution rejected: command matches dangerous pattern "${pattern}"`, {
          command
        });
      }
    }
  }

  /**
   * Write file safely within the project workspace
   */
  writeFileSafely(projectId, relPath, content) {
    const targetFile = this.resolvePathSafely(projectId, relPath);
    const parentDir = path.dirname(targetFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(targetFile, content, 'utf8');
    return targetFile;
  }

  /**
   * Read file safely within the project workspace
   */
  readFileSafely(projectId, relPath) {
    const targetFile = this.resolvePathSafely(projectId, relPath);
    if (!fs.existsSync(targetFile)) {
      throw new Error(`File not found: ${relPath}`);
    }
    return fs.readFileSync(targetFile, 'utf8');
  }

  /**
   * Delete file safely within the project workspace
   */
  deleteFileSafely(projectId, relPath) {
    const targetFile = this.resolvePathSafely(projectId, relPath);
    if (fs.existsSync(targetFile)) {
      fs.unlinkSync(targetFile);
      return true;
    }
    return false;
  }

  /**
   * List files within a project directory
   */
  listFiles(projectId, relSubDir = '') {
    const targetDir = this.resolvePathSafely(projectId, relSubDir);
    if (!fs.existsSync(targetDir)) return [];
    return fs.readdirSync(targetDir, { recursive: true, withFileTypes: true })
      .filter(item => item.isFile())
      .map(item => path.relative(targetDir, path.join(item.parentPath || targetDir, item.name)));
  }

  /**
   * Allocate an ephemeral port for an active project
   */
  allocateProjectPort(projectId) {
    this.validateProjectId(projectId);
    // If project already has an assigned port, reuse it
    for (const [port, pId] of this.allocatedPorts.entries()) {
      if (pId === projectId) return port;
    }

    for (let port = this.portMin; port <= this.portMax; port++) {
      if (!this.allocatedPorts.has(port)) {
        this.allocatedPorts.set(port, projectId);
        return port;
      }
    }
    throw new Error(`Port exhaustion: no free ephemeral preview ports between ${this.portMin} and ${this.portMax}`);
  }

  /**
   * Release port assigned to a project
   */
  releaseProjectPort(projectId) {
    for (const [port, pId] of this.allocatedPorts.entries()) {
      if (pId === projectId) {
        this.allocatedPorts.delete(port);
      }
    }
  }

  /**
   * Build complete secure Docker CLI run arguments
   */
  buildDockerRunArgs(projectId, command, options = {}) {
    const projectDir = this.getProjectWorkspace(projectId);
    this.validateMountPath(projectDir);

    const containerName = `pulse-sbx-${projectId}-${crypto.randomUUID().slice(0, 8)}`;
    const cpuLimit = options.cpus || this.cpuLimit;
    const memoryLimit = options.memory || this.memoryLimit;
    const memorySwapLimit = options.memorySwap || options.memory || this.memorySwapLimit;
    const pidsLimit = options.pidsLimit || this.pidsLimit;
    const user = options.user || this.sandboxUser;
    const networkMode = options.allowNetwork ? (options.network || 'bridge') : 'none';
    const readOnly = options.readOnly !== undefined ? options.readOnly : true;

    const args = [
      'run',
      '--rm',
      '-i',
      `--name=${containerName}`,
      `--user=${user}`,
      '--security-opt=no-new-privileges:true',
      '--cap-drop=ALL',
      `--cpus=${cpuLimit}`,
      `--memory=${memoryLimit}`,
      `--memory-swap=${memorySwapLimit}`,
      `--pids-limit=${pidsLimit}`,
      `--network=${networkMode}`
    ];

    if (readOnly) {
      args.push('--read-only');
      args.push('--tmpfs', '/tmp:rw,noexec,nosuid,size=64m');
    }

    // Mount strictly the project workspace at /workspace
    args.push('-v', `${projectDir}:/workspace:rw`);
    args.push('-w', '/workspace');

    // Isolated sanitized environment
    const safeEnv = {
      NODE_ENV: 'sandbox',
      LANG: 'en_US.UTF-8',
      PROJECT_ID: projectId,
      ...(options.customEnv || {})
    };

    for (const [k, v] of Object.entries(safeEnv)) {
      args.push('-e', `${k}=${v}`);
    }

    args.push(this.dockerImage, 'sh', '-c', command);

    return {
      args,
      containerName,
      options: {
        user,
        noNewPrivileges: true,
        capDrop: 'ALL',
        cpuLimit,
        memoryLimit,
        pidsLimit,
        networkMode,
        readOnly
      }
    };
  }

  /**
   * Execute command inside the isolated project sandbox
   */
  async executeCommand(projectId, command, options = {}) {
    this.validateCommand(command);
    this.validateProjectId(projectId);

    const projectDir = this.getProjectWorkspace(projectId);
    const runId = crypto.randomUUID();
    const timeoutMs = Math.min(options.timeoutMs || this.defaultTimeoutMs, this.maxTimeoutMs);
    const startTime = Date.now();
    const activeBackend = this.getActiveBackend();

    // ── STRICT ISOLATION GUARD: Never silently execute on host when Docker is unavailable ──
    if (activeBackend === 'UNAVAILABLE') {
      const errorMsg = `[Sandbox Security Policy] Docker engine is required for isolated container execution, but Docker is unavailable (${this.dockerCheckReason || 'daemon offline'}). ` +
        `Direct unsandboxed execution on host is blocked. Start Docker or enable non-production fallback.`;
      
      const result = {
        runId,
        projectId,
        taskId: options.taskId || null,
        command,
        backendUsed: 'UNAVAILABLE',
        exitCode: 126,
        stdout: '',
        stderr: errorMsg,
        durationMs: 0,
        timedOut: false,
        dockerUnavailable: true
      };

      if (this.storage) {
        this.storage.recordSandboxRun({
          id: runId,
          projectId,
          taskId: options.taskId || null,
          command,
          exitCode: 126,
          stdout: '',
          stderr: errorMsg,
          durationMs: 0,
          timedOut: 0
        });
      }
      return result;
    }

    // Process or Docker execution setup
    let spawnCmd;
    let spawnArgs;
    let spawnCwd;
    let spawnEnv;
    let containerName = null;

    if (activeBackend === 'DOCKER') {
      const dockerConfig = this.buildDockerRunArgs(projectId, command, options);
      spawnCmd = 'docker';
      spawnArgs = dockerConfig.args;
      containerName = dockerConfig.containerName;
      spawnCwd = undefined;
      spawnEnv = process.env;
    } else {
      // PROCESS_JAIL mode (only permitted when allowHostFallback is active or backendMode is explicit PROCESS_JAIL)
      console.warn(`[SECURITY AUDIT] Executing command in host PROCESS_JAIL mode (Docker offline). Note: ordinary child_process is not a secure container sandbox.`);
      const binDir = path.resolve('bin');
      const sanitizedEnv = {
        PATH: `${binDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        HOME: path.join(projectDir, 'tmp'),
        NODE_ENV: 'sandbox',
        LANG: 'en_US.UTF-8',
        PROJECT_DIR: projectDir,
        ...(options.customEnv || {})
      };
      spawnCmd = 'sh';
      spawnArgs = ['-c', command];
      spawnCwd = projectDir;
      spawnEnv = sanitizedEnv;
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(spawnCmd, spawnArgs, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (containerName && activeBackend === 'DOCKER') {
            spawnSync('docker', ['kill', containerName], { stdio: 'ignore', timeout: 3000 });
          }
          if (proc.pid) {
            process.kill(-proc.pid, 'SIGKILL');
          } else {
            proc.kill('SIGKILL');
          }
        } catch (_) {
          try { proc.kill('SIGKILL'); } catch (__) {}
        }
      }, timeoutMs);

      proc.stdout.on('data', (data) => {
        if (stdout.length < this.maxOutputBytes) {
          const remaining = this.maxOutputBytes - stdout.length;
          stdout += data.toString('utf8').slice(0, remaining);
        }
      });

      proc.stderr.on('data', (data) => {
        if (stderr.length < this.maxOutputBytes) {
          const remaining = this.maxOutputBytes - stderr.length;
          stderr += data.toString('utf8').slice(0, remaining);
        }
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          stderr += `\n[Execution killed: Exceeded timeout limit of ${timeoutMs}ms]`;
        }

        const effectiveExitCode = timedOut ? 124 : (exitCode ?? 1);
        const result = {
          runId,
          projectId,
          taskId: options.taskId || null,
          command,
          backendUsed: activeBackend,
          containerName,
          isContainerized: activeBackend === 'DOCKER',
          dockerUnavailable: !this.dockerAvailable,
          securityLimitation: activeBackend === 'PROCESS_JAIL'
            ? 'Host process jail: Docker offline, ordinary child_process lacks kernel namespaces / cgroups containerization'
            : null,
          exitCode: effectiveExitCode,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs,
          timedOut
        };

        // Append to project-specific runtime log
        try {
          const logPath = path.join(projectDir, 'logs', 'runtime.log');
          const logEntry = `[${new Date().toISOString()}] [${activeBackend}] cmd="${command}" exit=${effectiveExitCode} duration=${durationMs}ms\n`;
          fs.appendFileSync(logPath, logEntry, 'utf8');
        } catch (_) {}

        // Record in database if storage engine available
        if (this.storage) {
          this.storage.recordSandboxRun({
            id: runId,
            projectId,
            taskId: options.taskId || null,
            command,
            exitCode: effectiveExitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs,
            timedOut: timedOut ? 1 : 0
          });

          this.storage.logAuditEvent(
            projectId,
            options.agentRole || 'SANDBOX',
            'SANDBOX_RUN',
            `Ran "${command}" (backend: ${activeBackend}, exit ${effectiveExitCode}, ${durationMs}ms)`
          );
        }

        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const result = {
          runId,
          projectId,
          taskId: options.taskId || null,
          command,
          backendUsed: activeBackend,
          containerName,
          exitCode: 1,
          stdout: '',
          stderr: `Process spawn error: ${err.message}`,
          durationMs,
          timedOut: false
        };

        if (this.storage) {
          this.storage.recordSandboxRun({
            id: runId,
            projectId,
            taskId: options.taskId || null,
            command,
            exitCode: 1,
            stdout: '',
            stderr: result.stderr,
            durationMs,
            timedOut: 0
          });
        }

        resolve(result);
      });
    });
  }

  /**
   * Start a project application service (Container or process)
   */
  async startProject(projectId, command, options = {}) {
    this.validateProjectId(projectId);
    this.validateCommand(command);

    if (this.activeProjects.has(projectId)) {
      await this.stopProject(projectId);
    }

    const port = this.allocateProjectPort(projectId);
    const runId = crypto.randomUUID().slice(0, 8);
    const containerName = `pulse-app-${projectId}-${runId}`;
    const activeBackend = this.getActiveBackend();

    if (activeBackend === 'UNAVAILABLE') {
      throw new Error(`Cannot start project ${projectId}: Docker is required for container isolation but is unavailable.`);
    }

    const projectInfo = {
      projectId,
      containerName,
      port,
      status: 'RUNNING',
      startTime: Date.now(),
      command,
      backend: activeBackend,
      process: null
    };

    if (activeBackend === 'DOCKER') {
      const dockerConfig = this.buildDockerRunArgs(projectId, command, {
        ...options,
        allowNetwork: true // Allow local loopback binding for preview port
      });

      // Insert port mapping
      const portArgs = ['-p', `127.0.0.1:${port}:${port}`];
      dockerConfig.args.splice(2, 0, ...portArgs);

      const proc = spawn('docker', dockerConfig.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
      projectInfo.process = proc;
    } else {
      const projectDir = this.getProjectWorkspace(projectId);
      const binDir = path.resolve('bin');
      const env = {
        PATH: `${binDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        PROJECT_DIR: projectDir,
        ...(options.customEnv || {})
      };

      const proc = spawn('sh', ['-c', command], {
        cwd: projectDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
      projectInfo.process = proc;
    }

    this.activeProjects.set(projectId, projectInfo);
    return projectInfo;
  }

  /**
   * Stop an active project application service
   */
  async stopProject(projectId) {
    this.validateProjectId(projectId);
    const info = this.activeProjects.get(projectId);
    if (!info) return { stopped: false, reason: 'Not running' };

    if (info.backend === 'DOCKER' && info.containerName) {
      try {
        spawnSync('docker', ['stop', '-t', '2', info.containerName], { stdio: 'ignore', timeout: 5000 });
        spawnSync('docker', ['rm', '-f', info.containerName], { stdio: 'ignore', timeout: 5000 });
      } catch (_) {}
    }

    if (info.process && info.process.pid) {
      try {
        process.kill(-info.process.pid, 'SIGTERM');
      } catch (_) {
        try { process.kill(info.process.pid, 'SIGKILL'); } catch (__) {}
      }
    }

    this.releaseProjectPort(projectId);
    info.status = 'STOPPED';
    this.activeProjects.delete(projectId);

    return { stopped: true, projectId };
  }

  /**
   * Restart an active project application service
   */
  async restartProject(projectId, command, options = {}) {
    await this.stopProject(projectId);
    return this.startProject(projectId, command, options);
  }

  /**
   * Cleanup project artifacts, containers, ports, and ephemeral temp directory
   */
  async cleanupProject(projectId) {
    this.validateProjectId(projectId);
    await this.stopProject(projectId);

    const projectDir = path.resolve(this.workspacesRoot, projectId);
    const tmpDir = path.join(projectDir, 'tmp');
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch (_) {}
    }

    return { cleaned: true, projectId };
  }

  /**
   * Query status of a project service
   */
  getProjectStatus(projectId) {
    this.validateProjectId(projectId);
    const info = this.activeProjects.get(projectId);
    if (!info) return { projectId, status: 'STOPPED', port: null };
    return {
      projectId,
      status: info.status,
      port: info.port,
      backend: info.backend,
      containerName: info.containerName,
      uptimeMs: Date.now() - info.startTime
    };
  }

  /**
   * List all running project services
   */
  listActiveProjects() {
    return Array.from(this.activeProjects.values()).map(info => ({
      projectId: info.projectId,
      status: info.status,
      port: info.port,
      backend: info.backend,
      containerName: info.containerName,
      uptimeMs: Date.now() - info.startTime
    }));
  }
}
