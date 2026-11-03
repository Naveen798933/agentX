/**
 * ============================================================================
 * SYNAPSE — AI VIRTUAL SOFTWARE HOUSE
 * Master Application Controller & Living Office Canvas Engine
 * ============================================================================
 */

(function () {
  'use strict';

  // --- AUDIO SYNTHESIZER (WEB AUDIO API) -----------------------------------
  class SoundManager {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }

    _init() {
      if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx();
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    }

    playClick() {
      if (!this.enabled) return;
      this._init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, this.ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.04, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.04);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.04);
    }

    playHandoff() {
      if (!this.enabled) return;
      this._init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.06, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.12);
    }

    playChime() {
      if (!this.enabled) return;
      this._init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);
        gain.gain.setValueAtTime(0.08, now + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.25);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.25);
      });
    }

    playAlert() {
      if (!this.enabled) return;
      this._init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.setValueAtTime(600, now + 0.1);
      osc.frequency.setValueAtTime(400, now + 0.2);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    }

    playError() {
      this.playAlert();
    }
  }

  const sound = new SoundManager();

  // --- OFFICE DEPARTMENTS DEFINITION --------------------------------------
  const DEPARTMENTS = {
    ceo_cabin: {
      id: 'ceo_cabin',
      name: 'CEO Cabin (Executive)',
      desc: 'Chief Architect & Project Owner Suite',
      x: 70, y: 70, w: 230, h: 250,
      color: '#38bdf8',
      center: { x: 185, y: 195 },
      desk: { x: 185, y: 180 }
    },
    pm_area: {
      id: 'pm_area',
      name: 'Project Management Office',
      desc: 'Sofia Ramos (PM & Orchestrator)',
      x: 330, y: 70, w: 210, h: 250,
      color: '#0ea5e9',
      center: { x: 435, y: 195 },
      desk: { x: 435, y: 180 }
    },
    meeting_room: {
      id: 'meeting_room',
      name: 'Planning & Conference Room',
      desc: 'Sprint Meetings & Architectural Handoffs',
      x: 570, y: 70, w: 290, h: 250,
      color: '#818cf8',
      center: { x: 715, y: 195 },
      table: { x: 715, y: 195 }
    },
    backend: {
      id: 'backend',
      name: 'Backend Engineering Hub',
      desc: 'David Chen & Server Racks',
      x: 890, y: 70, w: 240, h: 250,
      color: '#34d399',
      center: { x: 1010, y: 195 },
      desk: { x: 1010, y: 180 }
    },
    db_eng: {
      id: 'db_eng',
      name: 'Database Architecture Cell',
      desc: 'Tariq Al-Mansoor (SQLite WAL)',
      x: 1160, y: 70, w: 220, h: 250,
      color: '#fbbf24',
      center: { x: 1270, y: 195 },
      desk: { x: 1270, y: 180 }
    },
    ai_ml: {
      id: 'ai_ml',
      name: 'AI/ML Research Center',
      desc: 'Dr. Aris Thorne (Prompt Topology)',
      x: 1410, y: 70, w: 220, h: 250,
      color: '#c084fc',
      center: { x: 1520, y: 195 },
      desk: { x: 1520, y: 180 }
    },
    reception: {
      id: 'reception',
      name: 'Reception & Entrance',
      desc: 'Main Office Portal & Visitor Lounge',
      x: 70, y: 390, w: 230, h: 240,
      color: '#94a3b8',
      center: { x: 185, y: 510 },
      desk: { x: 185, y: 490 }
    },
    ui_ux: {
      id: 'ui_ux',
      name: 'UI/UX & Business Studio',
      desc: 'Maya Lin & Elena Rostova',
      x: 330, y: 390, w: 230, h: 240,
      color: '#f472b6',
      center: { x: 445, y: 510 },
      desk: { x: 445, y: 490 }
    },
    frontend: {
      id: 'frontend',
      name: 'Frontend Engineering Lab',
      desc: 'Aria Patel & UI Device Rigs',
      x: 590, y: 390, w: 250, h: 240,
      color: '#a78bfa',
      center: { x: 715, y: 510 },
      desk: { x: 715, y: 490 }
    },
    code_review: {
      id: 'code_review',
      name: 'Code Review & Audit Station',
      desc: 'Kaito Tanaka & Valerie Vance',
      x: 870, y: 390, w: 250, h: 240,
      color: '#2dd4bf',
      center: { x: 995, y: 510 },
      desk: { x: 995, y: 490 }
    },
    qa_lab: {
      id: 'qa_lab',
      name: 'QA & Testing Laboratory',
      desc: 'Quinn Sterling & Automated Test Rig',
      x: 1150, y: 390, w: 230, h: 240,
      color: '#fb7185',
      center: { x: 1265, y: 510 },
      desk: { x: 1265, y: 490 }
    },
    devops_hub: {
      id: 'devops_hub',
      name: 'DevOps & Cloud Deployment',
      desc: 'Devon Kross & Release Terminal',
      x: 1410, y: 390, w: 220, h: 240,
      color: '#f97316',
      center: { x: 1520, y: 510 },
      desk: { x: 1520, y: 490 }
    }
  };

  // Main navigation corridors
  const HALLWAY_Y = 355; // horizontal central corridor

  // --- THE 11 AI EMPLOYEES ROSTER ----------------------------------------
  const EMPLOYEES = [
    {
      id: 'emp-pm',
      name: 'Sofia Ramos',
      role: 'PM',
      title: 'Project Manager / Orchestrator',
      dept: 'pm_area',
      avatarColor: '#38bdf8',
      suitColor: '#0284c7',
      hairColor: '#3b2f2f',
      skills: ['Roadmaps', 'PRD', 'DAG Scheduling', 'Resource Allocation'],
      status: 'WORKING',
      task: 'Coordinating Organization Pipeline',
      completion: 80,
      home: { x: 435, y: 195 },
      x: 435, y: 195,
      targetX: 435, targetY: 195,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Drafting milestone dependencies...', 'Monitoring DAG execution speed.']
    },
    {
      id: 'emp-ba',
      name: 'Elena Rostova',
      role: 'BA',
      title: 'Senior Business Analyst',
      dept: 'ui_ux',
      avatarColor: '#818cf8',
      suitColor: '#4f46e5',
      hairColor: '#d97706',
      skills: ['User Stories', 'Acceptance Criteria', 'Edge Cases', 'Domain Modeling'],
      status: 'IDLE',
      task: 'Eliciting Functional Requirements',
      completion: 100,
      home: { x: 410, y: 490 },
      x: 410, y: 490,
      targetX: 410, targetY: 490,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Refining acceptance criteria for checkout flow.']
    },
    {
      id: 'emp-designer',
      name: 'Maya Lin',
      role: 'DESIGNER',
      title: 'Lead UI/UX Designer',
      dept: 'ui_ux',
      avatarColor: '#f472b6',
      suitColor: '#db2777',
      hairColor: '#1e1b4b',
      skills: ['Design Systems', 'Micro-interactions', 'Accessibility', 'Figma Tokens'],
      status: 'IDLE',
      task: 'Polishing Glassmorphic Design System',
      completion: 100,
      home: { x: 475, y: 490 },
      x: 475, y: 490,
      targetX: 475, targetY: 490,
      path: [],
      state: 'idle',
      facing: 1,
      thoughts: ['Testing WCAG 2.1 AA contrast ratios on cyan pills.']
    },
    {
      id: 'emp-frontend',
      name: 'Aria Patel',
      role: 'FRONTEND',
      title: 'Lead Frontend Developer',
      dept: 'frontend',
      avatarColor: '#a78bfa',
      suitColor: '#7c3aed',
      hairColor: '#172554',
      skills: ['HTML5/CSS3', 'ES Modules', 'State Management', 'Web Animations'],
      status: 'WORKING',
      task: 'Synthesizing Interactive Components',
      completion: 70,
      home: { x: 715, y: 490 },
      x: 715, y: 490,
      targetX: 715, targetY: 490,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Compiling responsive layout with subpixel canvas rendering.']
    },
    {
      id: 'emp-backend',
      name: 'David Chen',
      role: 'BACKEND',
      title: 'Senior Backend Developer',
      dept: 'backend',
      avatarColor: '#34d399',
      suitColor: '#059669',
      hairColor: '#0f172a',
      skills: ['Node.js APIs', 'Microservices', 'Business Logic', 'Self-Healing'],
      status: 'WORKING',
      task: 'Implementing REST API & SQLite Services',
      completion: 85,
      home: { x: 1010, y: 195 },
      x: 1010, y: 195,
      targetX: 1010, targetY: 195,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Binding SQLite WAL transactions for atomic order checkout.']
    },
    {
      id: 'emp-database',
      name: 'Tariq Al-Mansoor',
      role: 'DATABASE',
      title: 'Principal Database Engineer',
      dept: 'db_eng',
      avatarColor: '#fbbf24',
      suitColor: '#d97706',
      hairColor: '#262626',
      skills: ['SQLite WAL', 'Schema Modeling', 'ACID Transactions', 'Query Tuning'],
      status: 'IDLE',
      task: 'Indexing Schema for Sub-10ms Queries',
      completion: 100,
      home: { x: 1270, y: 195 },
      x: 1270, y: 195,
      targetX: 1270, targetY: 195,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Verifying zero disk locks with WAL mode.']
    },
    {
      id: 'emp-ai',
      name: 'Dr. Aris Thorne',
      role: 'AI_ENGINEER',
      title: 'Staff AI/ML Engineer',
      dept: 'ai_ml',
      avatarColor: '#c084fc',
      suitColor: '#9333ea',
      hairColor: '#6b7280',
      skills: ['LLM Inferences', 'Embeddings', 'Prompt Topology', 'Vector Memory'],
      status: 'IDLE',
      task: 'Reranking Context Inferences',
      completion: 100,
      home: { x: 1520, y: 195 },
      x: 1520, y: 195,
      targetX: 1520, targetY: 195,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Monitoring token temperature and prompt grounding.']
    },
    {
      id: 'emp-reviewer',
      name: 'Kaito Tanaka',
      role: 'CODE_REVIEWER',
      title: 'Principal Code Reviewer',
      dept: 'code_review',
      avatarColor: '#2dd4bf',
      suitColor: '#0d9488',
      hairColor: '#18181b',
      skills: ['Static Analysis', 'Security Audit', 'Code Smells', 'Refactoring'],
      status: 'IDLE',
      task: 'Diff Inspection & Linter Checks',
      completion: 100,
      home: { x: 965, y: 490 },
      x: 965, y: 490,
      targetX: 965, targetY: 490,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Checking cyclomatic complexity and exception handlers.']
    },
    {
      id: 'emp-security',
      name: 'Valerie Vance',
      role: 'SECURITY',
      title: 'Security & Compliance Lead',
      dept: 'code_review',
      avatarColor: '#e879f9',
      suitColor: '#c026d3',
      hairColor: '#9f1239',
      skills: ['Sandbox Jail Containment', 'Secret Isolation', 'CVE Scanning', 'Policy Gates'],
      status: 'IDLE',
      task: 'Auditing Sandbox Jail Boundaries',
      completion: 100,
      home: { x: 1030, y: 490 },
      x: 1030, y: 490,
      targetX: 1030, targetY: 490,
      path: [],
      state: 'idle',
      facing: 1,
      thoughts: ['Verifying symlink escape protection on sandbox file paths.']
    },
    {
      id: 'emp-qa',
      name: 'Quinn Sterling',
      role: 'QA',
      title: 'QA & Test Automation Lead',
      dept: 'qa_lab',
      avatarColor: '#fb7185',
      suitColor: '#e11d48',
      hairColor: '#78350f',
      skills: ['Integration Tests', 'Boundary Analysis', 'Regression Suites', 'Assertion Trees'],
      status: 'WORKING',
      task: 'Executing node:test In Jailed Workspace',
      completion: 90,
      home: { x: 1265, y: 490 },
      x: 1265, y: 490,
      targetX: 1265, targetY: 490,
      path: [],
      state: 'testing',
      facing: 1,
      thoughts: ['Automated test suite: 12 assertions verified, 0 regressions.']
    },
    {
      id: 'emp-devops',
      name: 'Devon Kross',
      role: 'DEVOPS',
      title: 'DevOps & Cloud Architect',
      dept: 'devops_hub',
      avatarColor: '#f97316',
      suitColor: '#ea580c',
      hairColor: '#451a03',
      skills: ['Release Packaging', 'CI/CD Pipelines', 'Gated Approvals', 'Artifact Attestation'],
      status: 'IDLE',
      task: 'Awaiting Operator Sign-Off For Prod Release',
      completion: 95,
      home: { x: 1520, y: 490 },
      x: 1520, y: 490,
      targetX: 1520, targetY: 490,
      path: [],
      state: 'working',
      facing: 1,
      thoughts: ['Staged release artifact v1.0.0. Cryptographic human gate primed.']
    }
  ];

  // --- STATE CONTAINER ----------------------------------------------------
  const state = {
    mode: 'live', // 'live' | 'demo'
    activeView: 'office',
    selectedEmployee: null,
    activeProject: null,
    projects: [],
    tasks: [],
    approvals: [],
    files: [],
    gitLog: [],
    budget: null,
    llmMode: 'SIMULATION',
    camera: {
      x: 850,
      y: 350,
      zoom: 0.85,
      targetX: 850,
      targetY: 350,
      targetZoom: 0.85,
      isDragging: false,
      dragStartX: 0,
      dragStartY: 0
    },
    hoveredDept: null,
    hoveredEmployee: null,
    particles: [],
    handoffArcs: [],
    meetingActive: false,
    demoStep: 0,
    demoTimer: null,
    reducedMotion: false
  };

  // --- OFFICE CANVAS RENDERER ---------------------------------------------
  const canvas = document.getElementById('office-canvas');
  const ctx = canvas.getContext('2d');
  const viewport = document.getElementById('office-viewport');

  function resizeCanvas() {
    const rect = viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Pre-seed particle sparks
  function spawnSparks(x, y, color = '#38bdf8', count = 8) {
    for (let i = 0; i < count; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 0.5) * 3 - 1,
        color,
        size: Math.random() * 3 + 1.5,
        life: 1.0,
        decay: Math.random() * 0.04 + 0.02
      });
    }
  }

  // Draw living office scene
  function renderOffice(timestamp) {
    const rect = viewport.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Camera interpolation
    state.camera.x += (state.camera.targetX - state.camera.x) * 0.08;
    state.camera.y += (state.camera.targetY - state.camera.y) * 0.08;
    state.camera.zoom += (state.camera.targetZoom - state.camera.zoom) * 0.08;

    // Clear
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    // Transform to camera
    ctx.translate(width / 2, height / 2);
    ctx.scale(state.camera.zoom, state.camera.zoom);
    ctx.translate(-state.camera.x, -state.camera.y);

    // 1. Draw Architectural Floor Grid
    drawFloorGrid();

    // 2. Draw Corridors & Pathways
    drawCorridors();

    // 3. Draw All 12 Departments
    Object.values(DEPARTMENTS).forEach(dept => {
      drawDepartment(dept);
    });

    // 4. Draw Connecting Handoff Arcs & Beams
    drawHandoffArcs();

    // 5. Update & Draw All 11 Employees
    EMPLOYEES.forEach(emp => {
      updateEmployee(emp);
      drawEmployee(emp, timestamp);
    });

    // 6. Draw Particles & Sparks
    drawParticles();

    ctx.restore();

    requestAnimationFrame(renderOffice);
  }

  function drawFloorGrid() {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    const minX = 0, maxX = 1700, minY = 0, maxY = 700;

    ctx.beginPath();
    for (let x = minX; x <= maxX; x += gridSize) {
      ctx.moveTo(x, minY);
      ctx.lineTo(x, maxY);
    }
    for (let y = minY; y <= maxY; y += gridSize) {
      ctx.moveTo(minX, y);
      ctx.lineTo(maxX, y);
    }
    ctx.stroke();

    // Outer company perimeter glass wall
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(40, 40, 1620, 620);
  }

  function drawCorridors() {
    // Main hallway glow track
    ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
    ctx.fillRect(50, 325, 1600, 60);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.1)';
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(60, 355);
    ctx.lineTo(1640, 355);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawDepartment(dept) {
    const isHovered = state.hoveredDept === dept.id;

    // Dept floor plate
    ctx.fillStyle = isHovered ? 'rgba(30, 41, 59, 0.85)' : 'rgba(13, 20, 36, 0.75)';
    ctx.strokeStyle = isHovered ? dept.color : 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = isHovered ? 2 : 1;

    // Rounded department boundary
    drawRoundedRect(ctx, dept.x, dept.y, dept.w, dept.h, 12, true, true);

    // Glowing border accent on top
    ctx.fillStyle = dept.color;
    ctx.fillRect(dept.x + 12, dept.y, dept.w - 24, 3);

    // Header label
    ctx.font = '700 11px Outfit, sans-serif';
    ctx.fillStyle = isHovered ? '#fff' : '#cbd5e1';
    ctx.fillText(dept.name.toUpperCase(), dept.x + 14, dept.y + 24);

    ctx.font = '500 9px Outfit, sans-serif';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.fillText(dept.desc, dept.x + 14, dept.y + 38);

    // Glass Partition dividers inside
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.strokeRect(dept.x + 8, dept.y + 46, dept.w - 16, dept.h - 54);

    // Specific Zone Furnishings:
    if (dept.id === 'ceo_cabin') {
      // Mahogany Executive Desk
      ctx.fillStyle = '#451a03';
      ctx.fillRect(dept.x + 65, dept.y + 110, 100, 50);
      ctx.strokeStyle = '#78350f';
      ctx.strokeRect(dept.x + 65, dept.y + 110, 100, 50);
      // Executive Monitor
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(dept.x + 95, dept.y + 105, 40, 6);
      // Skyline window backdrop
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fillRect(dept.x + 16, dept.y + 50, dept.w - 32, 28);
      ctx.font = '600 8px JetBrains Mono';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText('CITY SKYLINE // EXECUTIVE METRICS', dept.x + 24, dept.y + 68);
    } else if (dept.id === 'meeting_room') {
      // Large Conference Table
      ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.4)';
      ctx.lineWidth = 2;
      drawRoundedRect(ctx, dept.x + 45, dept.y + 90, 200, 80, 20, true, true);
      // Interactive Whiteboard / Smart Wall
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(dept.x + 50, dept.y + 48, 190, 22);
      ctx.strokeStyle = '#818cf8';
      ctx.strokeRect(dept.x + 50, dept.y + 48, 190, 22);
      ctx.font = '600 8.5px JetBrains Mono';
      ctx.fillStyle = state.meetingActive ? '#4ade80' : '#818cf8';
      ctx.fillText(state.meetingActive ? '● SPRINT MEETING: ACTIVE SPEC DISCUSSION' : 'INTERACTIVE SMART PRESENTATION WALL', dept.x + 60, dept.y + 62);
    } else if (dept.id === 'backend') {
      // Server Racks with Blinking LEDs
      ctx.fillStyle = '#020617';
      ctx.fillRect(dept.x + 20, dept.y + 90, 36, 110);
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.4)';
      ctx.strokeRect(dept.x + 20, dept.y + 90, 36, 110);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = Math.sin(Date.now() * 0.005 + i) > 0 ? '#10b981' : '#059669';
        ctx.fillRect(dept.x + 25, dept.y + 100 + i * 16, 6, 4);
      }
      // Dev Workstation
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(dept.x + 75, dept.y + 120, 80, 40);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(dept.x + 95, dept.y + 115, 40, 6); // Monitor
    } else if (dept.id === 'qa_lab') {
      // QA Test Automation Rig
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(dept.x + 70, dept.y + 110, 90, 45);
      // Test matrix screen
      ctx.fillStyle = '#030712';
      ctx.fillRect(dept.x + 85, dept.y + 75, 60, 32);
      ctx.strokeStyle = '#fb7185';
      ctx.strokeRect(dept.x + 85, dept.y + 75, 60, 32);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4; c++) {
          ctx.fillStyle = (r * 4 + c) % 5 === 0 && Math.sin(Date.now() * 0.003) > 0.3 ? '#f43f5e' : '#10b981';
          ctx.fillRect(dept.x + 90 + c * 12, dept.y + 80 + r * 8, 8, 5);
        }
      }
    } else if (dept.id === 'devops_hub') {
      // Cloud Release Terminal
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(dept.x + 65, dept.y + 115, 90, 40);
      ctx.fillStyle = '#f97316';
      ctx.fillRect(dept.x + 85, dept.y + 110, 50, 6);
      // Cloud topology node
      ctx.fillStyle = 'rgba(249, 115, 22, 0.15)';
      ctx.fillRect(dept.x + 20, dept.y + 60, dept.w - 40, 30);
      ctx.font = '600 8.5px JetBrains Mono';
      ctx.fillStyle = '#fb923c';
      ctx.fillText('K8S CLUSTER // PROD RELEASE GATE', dept.x + 26, dept.y + 78);
    } else {
      // Standard Specialist Workstation
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(dept.x + 65, dept.y + 120, 90, 40);
      ctx.fillStyle = dept.color;
      ctx.fillRect(dept.x + 85, dept.y + 115, 50, 6); // Dual monitor
    }

    // Office Decorative Potted Plant
    ctx.fillStyle = '#14532d';
    ctx.beginPath();
    ctx.arc(dept.x + dept.w - 24, dept.y + dept.h - 24, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(dept.x + dept.w - 24, dept.y + dept.h - 26, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawRoundedRect(c, x, y, w, h, r, fill, stroke) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
    if (fill) c.fill();
    if (stroke) c.stroke();
  }

  // --- WAYPOINT NAVIGATION PATHFINDING -------------------------------------
  function moveEmployeeTo(emp, targetX, targetY, onComplete = null) {
    emp.path = [];
    const currentX = emp.x;
    const currentY = emp.y;

    // Path plan: Exit department to hallway, traverse hallway, enter target dept
    emp.path.push({ x: currentX, y: HALLWAY_Y });
    emp.path.push({ x: targetX, y: HALLWAY_Y });
    emp.path.push({ x: targetX, y: targetY });

    emp.targetX = targetX;
    emp.targetY = targetY;
    emp.state = 'walking';
    emp.onArrival = onComplete;
  }

  function updateEmployee(emp) {
    if (emp.path.length > 0) {
      const nextWp = emp.path[0];
      const dx = nextWp.x - emp.x;
      const dy = nextWp.y - emp.y;
      const dist = Math.hypot(dx, dy);

      const speed = state.reducedMotion ? 8 : 3.5;

      if (dist < speed) {
        emp.x = nextWp.x;
        emp.y = nextWp.y;
        emp.path.shift();
        if (emp.path.length === 0) {
          emp.state = 'working';
          if (emp.onArrival) {
            emp.onArrival();
            emp.onArrival = null;
          }
        }
      } else {
        emp.facing = dx >= 0 ? 1 : -1;
        emp.x += (dx / dist) * speed;
        emp.y += (dy / dist) * speed;
        emp.state = 'walking';
      }
    }
  }

  // Draw 2D Character Sprite
  function drawEmployee(emp, timestamp) {
    const isSelected = state.selectedEmployee && state.selectedEmployee.id === emp.id;
    const isHovered = state.hoveredEmployee && state.hoveredEmployee.id === emp.id;

    ctx.save();
    ctx.translate(emp.x, emp.y);

    // Selection Halo
    if (isSelected || isHovered) {
      ctx.strokeStyle = emp.avatarColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Shadow on floor
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 16, 12, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Walking animation bobbing
    const walkBob = emp.state === 'walking' && !state.reducedMotion ? Math.sin(timestamp * 0.015) * 2.5 : 0;
    const legSwing = emp.state === 'walking' && !state.reducedMotion ? Math.sin(timestamp * 0.015) * 6 : 0;

    // Legs
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-4, 6 + walkBob);
    ctx.lineTo(-4 - legSwing * emp.facing, 15);
    ctx.moveTo(4, 6 + walkBob);
    ctx.lineTo(4 + legSwing * emp.facing, 15);
    ctx.stroke();

    // Body (Suit)
    ctx.fillStyle = emp.suitColor;
    drawRoundedRect(ctx, -9, -10 + walkBob, 18, 18, 4, true, false);

    // Head
    ctx.fillStyle = '#fed7aa'; // skin tone
    ctx.beginPath();
    ctx.arc(0, -16 + walkBob, 7, 0, Math.PI * 2);
    ctx.fill();

    // Hair
    ctx.fillStyle = emp.hairColor;
    ctx.beginPath();
    ctx.arc(0, -18 + walkBob, 7, Math.PI, Math.PI * 2);
    ctx.fill();

    // Role Indicator Badge
    ctx.fillStyle = emp.avatarColor;
    ctx.fillRect(-6, -2 + walkBob, 12, 4);

    // State Visuals (Typing Particles / Thought Bubble)
    if (emp.state === 'working' && !state.reducedMotion) {
      if (Math.random() < 0.15) {
        spawnSparks(emp.x + (Math.random() - 0.5) * 14, emp.y - 10, emp.avatarColor, 1);
      }
    } else if (emp.state === 'testing') {
      // Small test icon badge
      ctx.fillStyle = '#fb7185';
      ctx.beginPath();
      ctx.arc(10, -22 + walkBob, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Floating Name Label
    ctx.font = '600 9px Outfit, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(emp.name.split(' ')[0], 0, -26 + walkBob);

    ctx.restore();
  }

  // Draw Handoff Arcs & Dynamic Beams
  function drawHandoffArcs() {
    for (let i = state.handoffArcs.length - 1; i >= 0; i--) {
      const arc = state.handoffArcs[i];
      arc.progress += 0.025;

      const from = arc.from;
      const to = arc.to;
      const curX = from.x + (to.x - from.x) * arc.progress;
      const curY = from.y + (to.y - from.y) * arc.progress - Math.sin(arc.progress * Math.PI) * 40;

      // Arc curve line
      ctx.strokeStyle = arc.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y - 12);
      ctx.quadraticCurveTo((from.x + to.x) / 2, Math.min(from.y, to.y) - 50, to.x, to.y - 12);
      ctx.stroke();
      ctx.setLineDash([]);

      // Floating data packet
      ctx.fillStyle = arc.color;
      ctx.beginPath();
      ctx.arc(curX, curY, 5, 0, Math.PI * 2);
      ctx.fill();

      if (arc.progress >= 1.0) {
        spawnSparks(to.x, to.y - 12, arc.color, 12);
        sound.playHandoff();
        state.handoffArcs.splice(i, 1);
      }
    }
  }

  function drawParticles() {
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;

      if (p.life <= 0) {
        state.particles.splice(i, 1);
        continue;
      }

      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
  }

  // --- INTERACTION & CAMERA CONTROLS ---------------------------------------
  viewport.addEventListener('mousedown', (e) => {
    state.camera.isDragging = true;
    state.camera.dragStartX = e.clientX;
    state.camera.dragStartY = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    state.camera.isDragging = false;
  });

  viewport.addEventListener('mousemove', (e) => {
    if (state.camera.isDragging) {
      const dx = (e.clientX - state.camera.dragStartX) / state.camera.zoom;
      const dy = (e.clientY - state.camera.dragStartY) / state.camera.zoom;
      state.camera.targetX -= dx;
      state.camera.targetY -= dy;
      state.camera.dragStartX = e.clientX;
      state.camera.dragStartY = e.clientY;
    }

    // Hit test mouse in office coordinates
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - rect.width / 2) / state.camera.zoom + state.camera.x;
    const worldY = (mouseY - rect.height / 2) / state.camera.zoom + state.camera.y;

    // Check hovered employee
    state.hoveredEmployee = EMPLOYEES.find(emp => Math.hypot(emp.x - worldX, emp.y - worldY) < 22) || null;

    // Check hovered department
    state.hoveredDept = null;
    for (const [id, dept] of Object.entries(DEPARTMENTS)) {
      if (worldX >= dept.x && worldX <= dept.x + dept.w && worldY >= dept.y && worldY <= dept.y + dept.h) {
        state.hoveredDept = id;
        break;
      }
    }
  });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    state.camera.targetZoom = Math.max(0.4, Math.min(2.0, state.camera.targetZoom * zoomFactor));
    updateZoomDisplay();
  }, { passive: false });

  viewport.addEventListener('click', (e) => {
    if (state.hoveredEmployee) {
      selectEmployee(state.hoveredEmployee);
      sound.playClick();
    } else if (state.hoveredDept) {
      focusDepartment(state.hoveredDept);
      sound.playClick();
    }
  });

  function updateZoomDisplay() {
    const el = document.getElementById('cam-zoom-level');
    if (el) el.textContent = `${Math.round(state.camera.targetZoom * 100)}%`;
  }

  document.getElementById('btn-cam-zoom-in')?.addEventListener('click', () => {
    state.camera.targetZoom = Math.min(2.0, state.camera.targetZoom * 1.2);
    updateZoomDisplay();
  });
  document.getElementById('btn-cam-zoom-out')?.addEventListener('click', () => {
    state.camera.targetZoom = Math.max(0.4, state.camera.targetZoom / 1.2);
    updateZoomDisplay();
  });
  document.getElementById('btn-cam-reset')?.addEventListener('click', () => {
    state.camera.targetX = 850;
    state.camera.targetY = 350;
    state.camera.targetZoom = 0.85;
    updateZoomDisplay();
  });

  // Department shortcuts
  document.getElementById('dept-shortcuts')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.dept-chip');
    if (!chip) return;
    document.querySelectorAll('.dept-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    const deptId = chip.dataset.dept;
    if (deptId === 'all') {
      state.camera.targetX = 850;
      state.camera.targetY = 350;
      state.camera.targetZoom = 0.85;
    } else {
      focusDepartment(deptId);
    }
    sound.playClick();
  });

  function focusDepartment(deptId) {
    const dept = DEPARTMENTS[deptId];
    if (!dept) return;
    state.camera.targetX = dept.center.x;
    state.camera.targetY = dept.center.y;
    state.camera.targetZoom = 1.35;
    updateZoomDisplay();
  }

  function selectEmployee(emp) {
    state.selectedEmployee = emp;
    const drawer = document.getElementById('employee-drawer');
    if (!drawer) return;

    document.getElementById('drawer-name').textContent = emp.name;
    document.getElementById('drawer-title').textContent = emp.title;
    document.getElementById('drawer-avatar').textContent = emp.role;
    document.getElementById('drawer-avatar').style.background = emp.avatarColor;
    document.getElementById('drawer-dept').textContent = DEPARTMENTS[emp.dept]?.name || emp.dept;
    document.getElementById('drawer-task').textContent = emp.task;
    document.getElementById('drawer-status-badge').textContent = emp.status;
    document.getElementById('drawer-progress-fill').style.width = `${emp.completion}%`;
    document.getElementById('drawer-progress-text').textContent = `${emp.completion}%`;

    // Skills
    const skillsContainer = document.getElementById('drawer-skills');
    skillsContainer.innerHTML = emp.skills.map(s => `<span class="skill-tag">${s}</span>`).join('');

    // Thoughts
    const thoughtsContainer = document.getElementById('drawer-thoughts');
    thoughtsContainer.innerHTML = emp.thoughts.map(t => `
      <div class="drawer-thought-item">
        <span class="thought-time">Recent</span>
        <p class="thought-msg">"${t}"</p>
      </div>
    `).join('');

    drawer.classList.add('open');
  }

  document.getElementById('btn-close-drawer')?.addEventListener('click', () => {
    document.getElementById('employee-drawer')?.classList.remove('open');
  });

  document.getElementById('btn-drawer-focus-cam')?.addEventListener('click', () => {
    if (state.selectedEmployee) {
      state.camera.targetX = state.selectedEmployee.x;
      state.camera.targetY = state.selectedEmployee.y;
      state.camera.targetZoom = 1.5;
      updateZoomDisplay();
    }
  });

  document.getElementById('btn-drawer-ping-agent')?.addEventListener('click', () => {
    if (state.selectedEmployee) {
      showCanvasToast(`Pinged ${state.selectedEmployee.name} (${state.selectedEmployee.role})`);
      sound.playClick();
    }
  });

  function showCanvasToast(msg) {
    const toast = document.getElementById('canvas-toast');
    const text = document.getElementById('canvas-toast-msg');
    if (!toast || !text) return;
    text.textContent = msg;
    toast.style.display = 'flex';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.display = 'none';
    }, 3800);
  }

  // --- GLOBAL NAVIGATION CONTROLLER ---------------------------------------
  const navContainer = document.getElementById('primary-nav');
  navContainer?.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    const viewName = btn.dataset.view;
    switchView(viewName);
    sound.playClick();
  });

  function switchView(viewName) {
    state.activeView = viewName;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === viewName));
    document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('active', p.id === `view-${viewName}`));

    if (window.location.hash !== `#${viewName}`) {
      try {
        window.history.replaceState(null, '', `#${viewName}`);
      } catch (_) {}
    }

    if (viewName === 'office') {
      resizeCanvas();
    } else if (viewName === 'build') {
      refreshBuildStudio();
    } else if (viewName === 'tasks') {
      renderTaskBoard();
    } else if (viewName === 'team') {
      renderTeamRoster();
    } else if (viewName === 'projects') {
      renderProjectsList();
    } else if (viewName === 'approvals') {
      renderApprovals();
    }
  }

  // --- DATA FETCHING & SYNCHRONIZATION ------------------------------------
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();

      state.activeProject = data.activeProject;
      state.budget = data.budgetSummary;
      state.approvals = data.pendingApprovals || [];
      state.files = data.files || [];
      state.gitLog = data.gitLog || [];
      state.llmMode = data.llmMode || 'SIMULATION';

      updateHeaderStats();
    } catch (_) {}
  }

  function updateHeaderStats() {
    if (state.activeProject) {
      const pName = document.getElementById('office-project-name');
      if (pName) pName.textContent = state.activeProject.name;
      const pViewName = document.getElementById('pview-name');
      if (pViewName) pViewName.textContent = state.activeProject.name;
      const pViewDesc = document.getElementById('pview-desc');
      if (pViewDesc) pViewDesc.textContent = state.activeProject.description;
    }

    if (state.budget) {
      const used = state.budget.spentTokens || state.budget.usedTokens || 0;
      const cap = state.budget.budgetTokens || state.budget.limitTokens || 125000;
      const pct = Math.min(100, Math.round((used / cap) * 100));

      const tokEl = document.getElementById('office-token-stat');
      if (tokEl) tokEl.textContent = `${used.toLocaleString()} / ${cap.toLocaleString()}`;
      const progEl = document.getElementById('office-token-progress');
      if (progEl) progEl.style.width = `${pct}%`;

      const pviewTok = document.getElementById('pview-tokens-used');
      if (pviewTok) pviewTok.textContent = `${used.toLocaleString()} used / ${cap.toLocaleString()} cap`;
      const pviewFill = document.getElementById('pview-budget-fill');
      if (pviewFill) pviewFill.style.width = `${pct}%`;
      const pviewPct = document.getElementById('pview-budget-pct');
      if (pviewPct) pviewPct.textContent = `${pct}% Used`;
    }

    // Approval badge
    const badge = document.getElementById('nav-approval-badge');
    if (badge) {
      const count = state.approvals.filter(a => a.status === 'PENDING').length;
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  // --- SERVER-SENT EVENTS (SSE) STREAMING ---------------------------------
  function connectSSE() {
    const sse = new EventSource('/api/stream');

    sse.onmessage = (e) => {
      handleSSEEvent('message', e.data);
    };

    const trackedEvents = [
      'meeting.started', 'requirements.ready', 'task.created', 'task.assigned',
      'agent.moved', 'agent.working', 'task.handoff', 'code.generated',
      'review.started', 'test.started', 'test.passed', 'approval.required',
      'deployment.completed', 'task.completed', 'STAGE_STARTED', 'STAGE_COMPLETED',
      'AGENT_THOUGHT', 'TEST_PASSED', 'GIT_COMMIT', 'APPROVAL_REQUIRED',
      'PROJECT_CREATED', 'PIPELINE_COMPLETE', 'FILE_MODIFIED', 'preview.ready',
      'preview.updated', 'preview.error', 'preview.restarted',
      'FEATURE_BUILD_STARTED', 'REQUIREMENT_LOCKED', 'AUDIT_ITERATION_STARTED',
      'SELF_HEAL_TRIGGERED', 'AUDIT_VERIFIED', 'AUDIT_FAILED', 'AUDIT_BLOCKED', 'AUDIT_COMPLETE',
      'coverage.updated',
      'job.queued', 'job.started', 'job.progress', 'job.completed', 'job.failed', 'job.retrying', 'job.cancelled'
    ];

    trackedEvents.forEach(evtName => {
      sse.addEventListener(evtName, (e) => {
        try {
          const payload = JSON.parse(e.data);
          handleSSEEvent(evtName, payload);
        } catch (_) {}
      });
    });

    sse.onerror = () => {
      // Reconnect handled automatically by EventSource
    };
  }

  const STAGE_ORDER = [
    'STAGE_INTAKE',
    'STAGE_ARCHITECTURE',
    'STAGE_TASKS',
    'STAGE_DEV',
    'STAGE_REVIEW',
    'STAGE_QA',
    'STAGE_BUILD',
    'STAGE_PREVIEW'
  ];

  function updateStageStepper(currentStageId, status = 'RUNNING') {
    const curIdx = STAGE_ORDER.indexOf(currentStageId);
    STAGE_ORDER.forEach((id, idx) => {
      const el = document.getElementById(`step-${id}`);
      if (!el) return;
      el.classList.remove('active', 'completed');
      if (idx < curIdx || (idx === curIdx && status === 'COMPLETED')) {
        el.classList.add('completed');
      } else if (idx === curIdx) {
        el.classList.add('active');
      }
    });
    const tag = document.getElementById('office-stage-tag');
    if (tag) tag.textContent = `STAGE: ${currentStageId.replace('STAGE_', '')}`;
  }

  function handleSSEEvent(eventType, payload) {
    appendTelemetryLog(eventType, payload);

    if (eventType === 'meeting.started') {
      state.meetingActive = true;
      updateStageStepper('STAGE_INTAKE', 'RUNNING');
      showCanvasToast('Planning Meeting: Sofia & Elena in Planning Room');
      const pm = EMPLOYEES.find(e => e.role === 'PM');
      const ba = EMPLOYEES.find(e => e.role === 'BA');
      if (pm) moveEmployeeTo(pm, 680, 195);
      if (ba) moveEmployeeTo(ba, 740, 195);
      sound.playClick();
    } else if (eventType === 'requirements.ready') {
      updateStageStepper('STAGE_INTAKE', 'COMPLETED');
      updateStageStepper('STAGE_ARCHITECTURE', 'RUNNING');
      showCanvasToast(`PRD & Requirements verified for ${payload.domain || 'project'}`);
      sound.playClick();
    } else if (eventType === 'team.mobilized') {
      updateStageStepper('STAGE_TASKS', 'RUNNING');
      showCanvasToast(`Dynamic team of ${payload.team?.length || 11} agents assigned for ${payload.domain}`);
      sound.playClick();
    } else if (eventType === 'STAGE_STARTED') {
      const stage = payload.stageId;
      if (stage === 'STAGE_INTAKE') updateStageStepper('STAGE_INTAKE', 'RUNNING');
      else if (stage === 'STAGE_ARCHITECTURE') updateStageStepper('STAGE_ARCHITECTURE', 'RUNNING');
      else if (stage === 'STAGE_BACKEND' || stage === 'STAGE_FRONTEND') updateStageStepper('STAGE_DEV', 'RUNNING');
      else if (stage === 'STAGE_QA') updateStageStepper('STAGE_QA', 'RUNNING');
      else if (stage === 'STAGE_DEPLOY_REQUEST') updateStageStepper('STAGE_BUILD', 'RUNNING');
    } else if (eventType === 'STAGE_COMPLETED') {
      const stage = payload.stageId;
      if (stage === 'STAGE_INTAKE') updateStageStepper('STAGE_INTAKE', 'COMPLETED');
      else if (stage === 'STAGE_ARCHITECTURE') updateStageStepper('STAGE_ARCHITECTURE', 'COMPLETED');
      else if (stage === 'STAGE_FRONTEND' || stage === 'STAGE_BACKEND') updateStageStepper('STAGE_DEV', 'COMPLETED');
      else if (stage === 'STAGE_QA') updateStageStepper('STAGE_QA', 'COMPLETED');
      else if (stage === 'STAGE_DEPLOY_REQUEST') updateStageStepper('STAGE_BUILD', 'COMPLETED');
    } else if (eventType === 'task.handoff') {
      const fromEmp = EMPLOYEES.find(e => e.role === payload.fromRole);
      const toEmp = EMPLOYEES.find(e => e.role === payload.toRole);
      if (fromEmp && toEmp) {
        state.handoffArcs.push({
          from: { x: fromEmp.x, y: fromEmp.y },
          to: { x: toEmp.x, y: toEmp.y },
          color: toEmp.avatarColor,
          progress: 0
        });
        showCanvasToast(`Task Handoff: ${fromEmp.name} ➔ ${toEmp.name}`);
        sound.playHandoff();
      }
    } else if (eventType === 'agent.working') {
      const emp = EMPLOYEES.find(e => e.role === payload.agentRole);
      if (emp) {
        emp.status = 'WORKING';
        emp.task = payload.task || emp.task;
        emp.state = 'working';
      }
    } else if (eventType === 'code.generated') {
      updateStageStepper('STAGE_DEV', 'COMPLETED');
      updateStageStepper('STAGE_REVIEW', 'RUNNING');
      showCanvasToast(`Code synthesized: ${(payload.files || []).join(', ')}`);
      sound.playClick();
      refreshBuildStudio();
    } else if (eventType === 'review.started') {
      updateStageStepper('STAGE_REVIEW', 'RUNNING');
      const rev = EMPLOYEES.find(e => e.role === 'CODE_REVIEWER');
      if (rev) rev.state = 'working';
      showCanvasToast('Kaito Tanaka (Code Reviewer) inspecting code quality & security...');
    } else if (eventType === 'test.started') {
      updateStageStepper('STAGE_QA', 'RUNNING');
      const qa = EMPLOYEES.find(e => e.role === 'QA');
      if (qa) {
        qa.state = 'testing';
        showCanvasToast('Quinn Sterling running test suite inside sandbox via "node --test"...');
      }
    } else if (eventType === 'SELF_HEAL_TRIGGERED') {
      showCanvasToast(`🔧 QA detected issue. Backend agent auto-patching...`);
      const be = EMPLOYEES.find(e => e.role === 'BACKEND');
      if (be) be.state = 'working';
      const healingStat = document.getElementById('test-stat-healing');
      if (healingStat) healingStat.textContent = parseInt(healingStat.textContent || '0') + 1;
      sound.playAlert();
    } else if (eventType === 'test.passed') {
      updateStageStepper('STAGE_QA', 'COMPLETED');
      updateStageStepper('STAGE_BUILD', 'RUNNING');
      showCanvasToast('All Sandboxed Tests Passed (Exit: 0)');
      const badge = document.getElementById('build-test-status-badge');
      if (badge) {
        badge.className = 'test-status-badge status-pass';
        badge.textContent = 'TESTS PASSING';
      }
      sound.playChime();
    } else if (eventType === 'GIT_COMMIT') {
      updateStageStepper('STAGE_BUILD', 'COMPLETED');
      showCanvasToast(`Git commit created: ${payload.message || 'release package'}`);
      refreshBuildStudio();
    } else if (eventType === 'FILE_MODIFIED') {
      showCanvasToast(`⚡ Agent updated: ${payload.filename || 'source file'}`);
      const activityTag = document.getElementById('preview-agent-activity');
      if (activityTag) {
        activityTag.textContent = `● Modified by ${payload.agent || 'AI Specialist'}`;
      }
      const statusPill = document.getElementById('preview-status-pill');
      if (statusPill) {
        statusPill.className = 'url-status-pill status-building';
        statusPill.textContent = '● UPDATING PREVIEW...';
      }
      if (state.activeProject && payload.projectId === state.activeProject.id) {
        const curFile = document.getElementById('build-active-filename')?.textContent?.trim();
        const unsaved = document.getElementById('editor-unsaved-dot');
        if (curFile === payload.filename && (!unsaved || unsaved.classList.contains('hidden'))) {
          loadFileContent(payload.projectId, payload.filename);
        }
        const iframe = document.getElementById('build-preview-iframe');
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'SYNAPSE_HOT_RELOAD',
            filename: payload.filename,
            timestamp: Date.now()
          }, '*');
        }
        setTimeout(() => {
          if (statusPill) {
            statusPill.className = 'url-status-pill status-live';
            statusPill.textContent = '● LIVE COMPILED';
          }
        }, 800);
      }
    } else if (eventType === 'preview.ready' || eventType === 'preview.updated') {
      updateStageStepper('STAGE_PREVIEW', 'COMPLETED');
      showCanvasToast('🎉 Working software preview compiled and live in Build Studio!');
      sound.playChime();
      const statusPill = document.getElementById('preview-status-pill');
      if (statusPill) {
        statusPill.className = 'url-status-pill status-live';
        statusPill.textContent = '● LIVE COMPILED';
      }
      const spinner = document.getElementById('preview-loading-spinner');
      if (spinner) spinner.classList.add('hidden');
      const errorBanner = document.getElementById('preview-error-banner');
      if (errorBanner) errorBanner.classList.add('hidden');
      const iframe = document.getElementById('build-preview-iframe');
      const addressInput = document.getElementById('preview-address-input');
      const targetProject = payload.projectId || (state.activeProject ? state.activeProject.id : null);
      if (iframe && targetProject) {
        const targetUrl = `/api/projects/${targetProject}/preview/`;
        iframe.src = `${targetUrl}?t=${Date.now()}`;
        if (addressInput) {
          addressInput.value = targetUrl;
        }
      }
      refreshBuildStudio();
    } else if (eventType === 'preview.error') {
      const errorBanner = document.getElementById('preview-error-banner');
      const errorMsg = document.getElementById('preview-error-message');
      const statusPill = document.getElementById('preview-status-pill');
      if (errorBanner) errorBanner.classList.remove('hidden');
      if (errorMsg) errorMsg.textContent = payload.message || 'Build or runtime error detected';
      if (statusPill) {
        statusPill.className = 'url-status-pill status-error';
        statusPill.textContent = '● RUNTIME ERROR';
      }
    } else if (eventType === 'approval.required' || eventType === 'APPROVAL_REQUIRED') {
      sound.playAlert();
      showCanvasToast('HUMAN OPERATOR APPROVAL REQUIRED: Production Release Gate');
      fetchStatus();
    } else if (eventType === 'PIPELINE_PAUSED') {
      showCanvasToast('Workflow execution paused by operator');
      document.getElementById('btn-pipeline-pause').style.display = 'none';
      document.getElementById('btn-pipeline-resume').style.display = 'inline-flex';
    } else if (eventType === 'PIPELINE_RESUMED') {
      showCanvasToast('Workflow execution resumed');
      document.getElementById('btn-pipeline-resume').style.display = 'none';
      document.getElementById('btn-pipeline-pause').style.display = 'inline-flex';
    } else if (eventType === 'PIPELINE_CANCELLED') {
      showCanvasToast('Workflow execution cancelled');
      document.getElementById('office-stage-tag').textContent = 'STAGE: CANCELLED';
    } else if (eventType === 'AGENT_THOUGHT') {
      const thoughtText = payload.message || '';
      const thoughtEl = document.getElementById('ticker-thought-text');
      if (thoughtEl) {
        thoughtEl.textContent = `${payload.agentName || payload.agentRole}: "${thoughtText}"`;
      }
      const emp = EMPLOYEES.find(e => e.role === payload.agentRole);
      if (emp) {
        emp.thoughts.unshift(thoughtText);
        if (emp.thoughts.length > 5) emp.thoughts.pop();
      }
    } else if (eventType === 'PIPELINE_COMPLETE') {
      updateStageStepper('STAGE_PREVIEW', 'COMPLETED');
      showCanvasToast('Autonomous development complete. Ready for preview or export.');
      sound.playChime();
      fetchStatus();
      refreshBuildStudio();
    } else if (eventType === 'FEATURE_BUILD_STARTED' || eventType === 'AUDIT_ITERATION_STARTED') {
      const statusBadge = document.getElementById('audit-final-status-badge');
      if (statusBadge) {
        statusBadge.className = 'audit-final-status-badge status-building';
        statusBadge.textContent = 'RUNNING AUDIT...';
      }
      const iterTag = document.getElementById('audit-iteration-tag');
      if (iterTag && payload.iteration) {
        iterTag.textContent = `Iteration ${payload.iteration}`;
      }
      showCanvasToast(`Audit: ${payload.stage || 'Iteration ' + (payload.iteration || 1)}`);
    } else if (eventType === 'SELF_HEAL_TRIGGERED') {
      showCanvasToast(`Self-Healing: Patching ${payload.category || 'issue'}...`);
      const healingStat = document.getElementById('test-stat-healing');
      if (healingStat) healingStat.textContent = parseInt(healingStat.textContent || '0') + 1;
    } else if (eventType === 'AUDIT_VERIFIED' || eventType === 'AUDIT_COMPLETE') {
      if (payload.report) {
        renderAuditDashboard(payload.report);
      }
      showCanvasToast('Requirement verification complete!');
    } else if (eventType === 'coverage.updated') {
      const summary = payload.summary || payload;
      if (summary && typeof summary.coveragePercentage === 'number') {
        showCanvasToast(`🎯 Requirement Coverage: ${summary.coveragePercentage}% (${summary.verified || 0}/${summary.total || 0} REQs Verified)`);
      }
    } else if (eventType === 'job.queued') {
      const stageTag = document.getElementById('office-stage-tag');
      if (stageTag) stageTag.textContent = 'QUEUE: PENDING';
      showCanvasToast(`Job queued in background worker: ${payload.jobId || ''}`);
    } else if (eventType === 'job.started') {
      const stageTag = document.getElementById('office-stage-tag');
      if (stageTag) stageTag.textContent = 'QUEUE: RUNNING';
      showCanvasToast(`Background worker started processing job: ${payload.jobId || ''}`);
    } else if (eventType === 'job.progress') {
      const stageTag = document.getElementById('office-stage-tag');
      if (stageTag) stageTag.textContent = `STAGE: ${payload.stage?.replace('STAGE_', '') || 'RUNNING'} (${payload.pct || 0}%)`;
      if (payload.stage) updateStageStepper(payload.stage, 'RUNNING');
      showCanvasToast(`[${payload.pct}%] ${payload.message || 'Processing'}`);
    } else if (eventType === 'job.retrying') {
      showCanvasToast(`⚠️ Transient issue detected. Exponential backoff retry ${payload.attemptsMade}/${payload.maxRetries}...`);
      sound.playAlert();
    } else if (eventType === 'job.completed') {
      const stageTag = document.getElementById('office-stage-tag');
      if (stageTag) stageTag.textContent = 'STATUS: COMPLETED';
      updateStageStepper('STAGE_PREVIEW', 'COMPLETED');
      showCanvasToast('🎉 Background project generation job completed successfully!');
      sound.playChime();
      fetchStatus();
      if (state.activeProject) loadProjectData(state.activeProject.id);
    } else if (eventType === 'job.failed') {
      const stageTag = document.getElementById('office-stage-tag');
      if (stageTag) stageTag.textContent = 'STATUS: FAILED';
      showCanvasToast(`❌ Job failed: ${payload.error || 'Execution error'}`);
      sound.playAlert();
    } else if (eventType === 'job.cancelled') {
      const stageTag = document.getElementById('office-stage-tag');
      if (stageTag) stageTag.textContent = 'STATUS: CANCELLED';
      showCanvasToast(`Job cancelled: ${payload.reason || 'User aborted'}`);
    }
  }

  let currentJobPollTimer = null;
  function startJobPolling(jobId, projectId) {
    if (currentJobPollTimer) clearInterval(currentJobPollTimer);

    currentJobPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (!res.ok) return;
        const data = await res.json();
        const job = data.job;
        if (!job) return;

        const stageTag = document.getElementById('office-stage-tag');
        if (job.status === 'QUEUED') {
          if (stageTag) stageTag.textContent = 'QUEUE: PENDING';
        } else if (job.status === 'RUNNING') {
          if (stageTag) stageTag.textContent = `STAGE: ${job.stage?.replace('STAGE_', '') || 'RUNNING'} (${job.progressPct || 0}%)`;
          if (job.stage) updateStageStepper(job.stage, 'RUNNING');
        } else if (job.status === 'COMPLETED') {
          clearInterval(currentJobPollTimer);
          currentJobPollTimer = null;
          if (stageTag) stageTag.textContent = 'STATUS: COMPLETED';
          updateStageStepper('STAGE_PREVIEW', 'COMPLETED');
          showCanvasToast('🎉 Project generation complete!');
          sound.playChime();
          fetchStatus();
          if (projectId) loadProjectData(projectId);
        } else if (job.status === 'FAILED') {
          clearInterval(currentJobPollTimer);
          currentJobPollTimer = null;
          if (stageTag) stageTag.textContent = 'STATUS: FAILED';
          showCanvasToast(`❌ Job failed: ${job.errorMessage || 'Execution error'}`);
          sound.playAlert();
        } else if (job.status === 'CANCELLED') {
          clearInterval(currentJobPollTimer);
          currentJobPollTimer = null;
          if (stageTag) stageTag.textContent = 'STATUS: CANCELLED';
          showCanvasToast('Job cancelled');
        }
      } catch (_) {}
    }, 1200);
  }

  function appendTelemetryLog(type, payload) {
    const terminal = document.getElementById('global-telemetry-terminal');
    if (!terminal) return;
    const time = new Date().toLocaleTimeString();
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = `<span style="color:#64748b">[${time}]</span> <span style="color:#38bdf8;font-weight:700">[${type}]</span> <span style="color:#cbd5e1">${str.slice(0, 160)}</span>`;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  // --- IDEA STUDIO CONTROLLER ----------------------------------------------
  document.getElementById('btn-analyze-idea')?.addEventListener('click', async () => {
    const text = document.getElementById('idea-prompt-text')?.value?.trim();
    if (!text) {
      alert('Please enter an application idea description.');
      return;
    }

    const btn = document.getElementById('btn-analyze-idea');
    btn.disabled = true;
    btn.textContent = 'Analyzing Plan...';

    try {
      const res = await fetch('/api/idea/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea: text })
      });
      const data = await res.json();

      renderIdeaBlueprint(data);
      sound.playChime();
    } catch (err) {
      alert('Failed to analyze idea: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg> Analyze & Decompose Plan`;
    }
  });

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('idea-prompt-text').value = btn.dataset.prompt;
    });
  });

  document.getElementById('btn-clear-idea')?.addEventListener('click', () => {
    document.getElementById('idea-prompt-text').value = '';
  });

  function renderIdeaBlueprint(data) {
    const container = document.getElementById('plan-content');
    const title = document.getElementById('plan-title');
    const sub = document.getElementById('plan-sub');
    const launchBtn = document.getElementById('btn-launch-plan-execution');

    title.textContent = data.title;
    sub.textContent = data.summary;
    launchBtn.style.display = 'inline-flex';

    launchBtn.onclick = async () => {
      sound.playClick();
      // Create project and run
      try {
        const pRes = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: data.title,
            description: document.getElementById('idea-prompt-text').value.trim(),
            budgetTokens: data.estimatedTokens,
            autoRun: true
          })
        });
        const newProj = await pRes.json();
        state.activeProject = newProj;
        switchView('office');
        showCanvasToast(`Autonomous mobilization started for: ${newProj.name}`);
        sound.playChime();
      } catch (err) {
        alert('Could not start project: ' + err.message);
      }
    };

    container.innerHTML = `
      <div class="plan-section-block">
        <h4>1. ESSENTIAL CLARIFYING QUESTIONS</h4>
        <ul style="padding-left: 18px; color: #cbd5e1; font-size: 12px; margin-bottom: 6px;">
          ${data.clarifyingQuestions.map(q => `<li style="margin-bottom: 4px;">${q}</li>`).join('')}
        </ul>
      </div>

      <div class="plan-section-block">
        <h4>2. PRODUCT REQUIREMENTS & ARCHITECTURE SPECIFICATION</h4>
        <pre style="background:#030712;padding:10px;border-radius:6px;font-family:var(--font-mono);font-size:11px;color:#38bdf8;overflow-x:auto;">${data.prd}</pre>
      </div>

      <div class="plan-section-block">
        <h4>3. 11-AGENT WORK DISTRIBUTION & DEPENDENCY GRAPH</h4>
        <div class="plan-tasks-list">
          ${data.taskBreakdown.map(t => `
            <div class="plan-task-item">
              <span class="task-role-badge">${t.role}</span>
              <span class="task-item-title">${t.title}</span>
              <span style="font-size:10px;color:#94a3b8">${t.agent}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // --- BUILD STUDIO CONTROLLER & LIVE BROWSER PREVIEW -----------------------
  let buildStudioInitialized = false;

  function getFileIcon(filename) {
    if (!filename) return '📄';
    const lower = filename.toLowerCase();
    if (lower.endsWith('.html')) return '🌐';
    if (lower.endsWith('.css')) return '🎨';
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) return '⚡';
    if (lower.endsWith('.json')) return '📋';
    if (lower.endsWith('.md')) return '📝';
    if (lower.endsWith('.sql')) return '🗄️';
    if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.svg')) return '🖼️';
    return '📄';
  }

  async function refreshBuildStudio() {
    if (!buildStudioInitialized) {
      initBuildStudio();
      buildStudioInitialized = true;
    }

    if (!state.activeProject) return;
    const pId = state.activeProject.id;

    // Update Project Titles & Framework
    const projNameEl = document.getElementById('build-project-name');
    if (projNameEl) projNameEl.textContent = state.activeProject.name || 'Application Workspace';

    // Fetch Preview Session / Framework Status
    try {
      const statusRes = await fetch(`/api/projects/${pId}/preview/status`);
      if (statusRes.ok) {
        const previewInfo = await statusRes.json();
        const frameworkTag = document.getElementById('preview-framework-tag');
        if (frameworkTag) {
          const typeMap = {
            static_spa: 'Interactive SPA (Vanilla)',
            vite_react: 'Vite + React SPA',
            node_express: 'Node.js Fullstack Server',
            unknown: 'Sandboxed Application'
          };
          frameworkTag.textContent = typeMap[previewInfo.runtimeType] || previewInfo.runtimeType || 'Sandboxed Web App';
        }
      }
    } catch (_) {}

    // Refresh file list & render Explorer Tree + Tabs
    try {
      const res = await fetch(`/api/projects/${pId}/files`);
      const files = await res.json();
      state.files = files;

      const activeFilename = document.getElementById('build-active-filename')?.textContent?.trim() || files[0] || '';
      renderFileExplorerTree(files, activeFilename);
      renderFileChips(files, activeFilename);

      if (files.length > 0) {
        const fileToLoad = files.includes(activeFilename) ? activeFilename : files[0];
        loadFileContent(pId, fileToLoad);
      }

      // Git log
      const gitRes = await fetch(`/api/projects/${pId}/git/log`);
      const commits = await gitRes.json();
      state.gitLog = commits;
      renderGitTimeline(commits);

      // Check preview iframe src
      const iframe = document.getElementById('build-preview-iframe');
      const addressInput = document.getElementById('preview-address-input');
      const expectedUrl = `/api/projects/${pId}/preview/`;
      if (iframe && (!iframe.src || !iframe.src.includes(`/api/projects/${pId}/preview`))) {
        iframe.src = `${expectedUrl}?t=${Date.now()}`;
      }
      if (addressInput) {
        addressInput.value = expectedUrl;
      }
    } catch (_) {}
  }

  function renderFileExplorerTree(files, activeFilename) {
    const tree = document.getElementById('build-file-tree');
    const countLabel = document.getElementById('explorer-file-count');
    if (countLabel) countLabel.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
    if (!tree) return;

    tree.innerHTML = files.map(file => {
      const icon = getFileIcon(file);
      const isActive = file === activeFilename;
      return `
        <div class="tree-item ${isActive ? 'active' : ''}" data-file="${escapeHtml(file)}">
          <span class="tree-item-icon">${icon}</span>
          <span class="tree-item-name">${escapeHtml(file)}</span>
        </div>
      `;
    }).join('');

    // Attach tree item click
    tree.querySelectorAll('.tree-item').forEach(item => {
      item.addEventListener('click', () => {
        const file = item.dataset.file;
        if (!file || !state.activeProject) return;
        tree.querySelectorAll('.tree-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        loadFileContent(state.activeProject.id, file);
      });
    });
  }

  function renderFileChips(files, activeFilename) {
    const chips = document.getElementById('build-file-chips');
    if (!chips) return;

    chips.innerHTML = files.slice(0, 8).map(file => {
      const isActive = file === activeFilename;
      const icon = getFileIcon(file);
      return `
        <div class="file-chip ${isActive ? 'active' : ''}" data-file="${escapeHtml(file)}">
          <span style="font-size:11px">${icon}</span>
          <span>${escapeHtml(file)}</span>
        </div>
      `;
    }).join('');

    chips.querySelectorAll('.file-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const file = chip.dataset.file;
        if (!file || !state.activeProject) return;
        loadFileContent(state.activeProject.id, file);
      });
    });
  }

  async function loadFileContent(projectId, filename) {
    const activeFilenameEl = document.getElementById('build-active-filename');
    const iconEl = document.getElementById('editor-file-icon');
    const textarea = document.getElementById('build-code-textarea');
    const unsavedDot = document.getElementById('editor-unsaved-dot');

    if (activeFilenameEl) activeFilenameEl.textContent = filename;
    if (iconEl) iconEl.textContent = getFileIcon(filename);

    // Sync active state in tree & chips
    document.querySelectorAll('.tree-item').forEach(i => i.classList.toggle('active', i.dataset.file === filename));
    document.querySelectorAll('.file-chip').forEach(c => c.classList.toggle('active', c.dataset.file === filename));

    try {
      const res = await fetch(`/api/projects/${projectId}/files/content?file=${encodeURIComponent(filename)}`);
      const data = await res.json();
      if (textarea) {
        textarea.value = data.content || '';
        updateCodeLineNumbers();
      }
      if (unsavedDot) unsavedDot.classList.add('hidden');
    } catch (_) {
      if (textarea) {
        textarea.value = '// Error reading file content from workspace';
        updateCodeLineNumbers();
      }
    }
  }

  function updateCodeLineNumbers() {
    const textarea = document.getElementById('build-code-textarea');
    const lineNumbers = document.getElementById('code-line-numbers');
    if (!textarea || !lineNumbers) return;
    const lines = (textarea.value || '').split('\n').length;
    lineNumbers.textContent = Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n');
  }

  async function saveCurrentEditorFile() {
    if (!state.activeProject) return;
    const filename = document.getElementById('build-active-filename')?.textContent?.trim();
    const textarea = document.getElementById('build-code-textarea');
    if (!filename || !textarea) return;

    const content = textarea.value;
    const pId = state.activeProject.id;
    const saveBtn = document.getElementById('btn-save-code-editor');
    const unsavedDot = document.getElementById('editor-unsaved-dot');
    const statusPill = document.getElementById('preview-status-pill');
    const spinner = document.getElementById('preview-loading-spinner');

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving & Reloading...';
    }
    if (statusPill) {
      statusPill.className = 'url-status-pill status-building';
      statusPill.textContent = '● UPDATING PREVIEW...';
    }
    if (spinner) spinner.classList.remove('hidden');

    try {
      const res = await fetch(`/api/projects/${pId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to save');

      if (unsavedDot) unsavedDot.classList.add('hidden');
      showCanvasToast(`Saved ${filename} (hot reload applied)`);
      sound.playClick();

      // Trigger hot reload via postMessage bridge
      const iframe = document.getElementById('build-preview-iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'SYNAPSE_HOT_RELOAD',
          filename,
          timestamp: Date.now()
        }, '*');
      }

      // Check git log
      const gitRes = await fetch(`/api/projects/${pId}/git/log`);
      if (gitRes.ok) {
        state.gitLog = await gitRes.json();
        renderGitTimeline(state.gitLog);
      }

      setTimeout(() => {
        if (statusPill) {
          statusPill.className = 'url-status-pill status-live';
          statusPill.textContent = '● LIVE COMPILED';
        }
        if (spinner) spinner.classList.add('hidden');
      }, 700);
    } catch (err) {
      showCanvasToast(`Error saving file: ${err.message}`);
      if (statusPill) {
        statusPill.className = 'url-status-pill status-error';
        statusPill.textContent = '● ERROR';
      }
      if (spinner) spinner.classList.add('hidden');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> Save & Hot Reload`;
      }
    }
  }

  function initBuildStudio() {
    // 1. Draggable panel divider resizers
    const container = document.getElementById('build-split-container');
    const leftResizer = document.getElementById('build-resizer-left');
    const rightResizer = document.getElementById('build-resizer-right');
    const leftPanel = document.getElementById('build-panel-explorer');
    const rightPanel = document.getElementById('build-panel-preview');
    const iframe = document.getElementById('build-preview-iframe');

    let activeResizer = null;
    let startX = 0;
    let startLeftWidth = 0;
    let startRightWidth = 0;

    function onMouseDown(e, resizer) {
      activeResizer = resizer;
      startX = e.clientX;
      startLeftWidth = leftPanel.getBoundingClientRect().width;
      startRightWidth = rightPanel.getBoundingClientRect().width;
      document.body.classList.add('is-resizing');
      if (iframe) iframe.style.pointerEvents = 'none';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    }

    leftResizer?.addEventListener('mousedown', (e) => onMouseDown(e, 'left'));
    rightResizer?.addEventListener('mousedown', (e) => onMouseDown(e, 'right'));

    function onMouseMove(e) {
      if (!activeResizer) return;
      const delta = e.clientX - startX;
      const containerWidth = container.getBoundingClientRect().width;

      if (activeResizer === 'left') {
        const newWidth = Math.max(160, Math.min(420, startLeftWidth + delta));
        leftPanel.style.width = `${newWidth}px`;
      } else if (activeResizer === 'right') {
        const newWidth = Math.max(300, Math.min(containerWidth - 320, startRightWidth - delta));
        rightPanel.style.width = `${newWidth}px`;
      }
    }

    function onMouseUp() {
      activeResizer = null;
      document.body.classList.remove('is-resizing');
      if (iframe) iframe.style.pointerEvents = 'auto';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    // 2. Layout Mode Switcher
    const layoutBtns = {
      codeOnly: document.getElementById('btn-layout-code-only'),
      split: document.getElementById('btn-layout-split'),
      previewOnly: document.getElementById('btn-layout-preview-only'),
      fullscreen: document.getElementById('btn-layout-fullscreen')
    };

    function setLayout(mode) {
      if (!container) return;
      container.classList.remove('layout-code-only', 'layout-preview-only', 'layout-fullscreen-preview');
      Object.values(layoutBtns).forEach(b => b?.classList.remove('active'));

      if (mode === 'code') {
        container.classList.add('layout-code-only');
        layoutBtns.codeOnly?.classList.add('active');
      } else if (mode === 'preview') {
        container.classList.add('layout-preview-only');
        layoutBtns.previewOnly?.classList.add('active');
      } else if (mode === 'fullscreen') {
        container.classList.add('layout-fullscreen-preview');
        layoutBtns.fullscreen?.classList.add('active');
      } else {
        layoutBtns.split?.classList.add('active');
      }
      sound.playClick();
    }

    layoutBtns.codeOnly?.addEventListener('click', () => setLayout('code'));
    layoutBtns.split?.addEventListener('click', () => setLayout('split'));
    layoutBtns.previewOnly?.addEventListener('click', () => setLayout('preview'));
    layoutBtns.fullscreen?.addEventListener('click', () => setLayout('fullscreen'));

    document.getElementById('btn-toggle-preview-fullscreen')?.addEventListener('click', () => {
      if (container.classList.contains('layout-fullscreen-preview')) {
        setLayout('split');
      } else {
        setLayout('fullscreen');
      }
    });

    // 3. Code Editor Textarea & Controls
    const textarea = document.getElementById('build-code-textarea');
    const unsavedDot = document.getElementById('editor-unsaved-dot');

    textarea?.addEventListener('input', () => {
      updateCodeLineNumbers();
      if (unsavedDot) unsavedDot.classList.remove('hidden');
    });

    textarea?.addEventListener('scroll', () => {
      const lineNumbers = document.getElementById('code-line-numbers');
      if (lineNumbers) lineNumbers.scrollTop = textarea.scrollTop;
    });

    // Tab key indent & shortcut Ctrl/Cmd+S
    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        updateCodeLineNumbers();
        if (unsavedDot) unsavedDot.classList.remove('hidden');
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveCurrentEditorFile();
      }
    });

    document.getElementById('btn-save-code-editor')?.addEventListener('click', () => {
      saveCurrentEditorFile();
    });

    document.getElementById('btn-copy-code')?.addEventListener('click', async () => {
      if (!textarea) return;
      try {
        await navigator.clipboard.writeText(textarea.value);
        showCanvasToast('Code copied to clipboard');
      } catch (_) {
        showCanvasToast('Clipboard copy unavailable');
      }
    });

    // 4. Explorer Actions: New File & Refresh Tree
    document.getElementById('btn-new-file')?.addEventListener('click', async () => {
      if (!state.activeProject) return;
      const filename = prompt('Enter new file name (e.g. src/app.js, styles.css):');
      if (!filename || !filename.trim()) return;
      const cleanName = filename.trim();

      try {
        const res = await fetch(`/api/projects/${state.activeProject.id}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: cleanName, content: `// ${cleanName}\n` })
        });
        if (!res.ok) throw new Error('Failed to create file');
        showCanvasToast(`Created file: ${cleanName}`);
        await refreshBuildStudio();
        loadFileContent(state.activeProject.id, cleanName);
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btn-refresh-files')?.addEventListener('click', () => {
      refreshBuildStudio();
      showCanvasToast('Workspace tree refreshed');
    });

    // 5. Embedded Browser Preview Toolbar & Controls
    const addressInput = document.getElementById('preview-address-input');
    const goBtn = document.getElementById('btn-address-go');
    const spinner = document.getElementById('preview-loading-spinner');
    const statusPill = document.getElementById('preview-status-pill');
    const errorBanner = document.getElementById('preview-error-banner');
    const errorMsg = document.getElementById('preview-error-message');
    const retryBtn = document.getElementById('btn-retry-preview');
    const openTabBtn = document.getElementById('btn-open-preview-tab');
    const backBtn = document.getElementById('btn-preview-back');
    const fwdBtn = document.getElementById('btn-preview-forward');
    const refreshBtn = document.getElementById('btn-refresh-preview');
    const deviceFrame = document.getElementById('preview-device-frame');

    // Viewport presets
    const vpBtns = {
      desktop: document.getElementById('btn-vp-desktop'),
      tablet: document.getElementById('btn-vp-tablet'),
      mobile: document.getElementById('btn-vp-mobile')
    };

    function setViewport(vp) {
      if (!deviceFrame) return;
      deviceFrame.classList.remove('vp-desktop', 'vp-tablet', 'vp-mobile');
      Object.values(vpBtns).forEach(b => b?.classList.remove('active'));

      deviceFrame.classList.add(`vp-${vp}`);
      vpBtns[vp]?.classList.add('active');
      sound.playClick();
    }

    vpBtns.desktop?.addEventListener('click', () => setViewport('desktop'));
    vpBtns.tablet?.addEventListener('click', () => setViewport('tablet'));
    vpBtns.mobile?.addEventListener('click', () => setViewport('mobile'));

    // Address Bar Navigation
    function navigateToAddress() {
      if (!state.activeProject || !iframe) return;
      const raw = addressInput?.value?.trim() || '/';
      const pId = state.activeProject.id;
      let targetUrl = raw;

      if (raw.startsWith('/')) {
        if (!raw.startsWith('/api/projects/')) {
          targetUrl = `/api/projects/${pId}/preview${raw}`;
        }
      } else if (!raw.startsWith('http')) {
        targetUrl = `/api/projects/${pId}/preview/${raw}`;
      }

      if (spinner) spinner.classList.remove('hidden');
      if (statusPill) {
        statusPill.className = 'url-status-pill status-building';
        statusPill.textContent = '● LOADING...';
      }

      // First inform client bridge
      try {
        iframe.contentWindow?.postMessage({
          type: 'SYNAPSE_NAVIGATE',
          path: raw.startsWith('/') && !raw.startsWith('/api') ? raw : '/'
        }, '*');
      } catch (_) {}

      iframe.src = targetUrl;
    }

    addressInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigateToAddress();
    });
    goBtn?.addEventListener('click', navigateToAddress);

    refreshBtn?.addEventListener('click', () => {
      if (!iframe || !state.activeProject) return;
      if (spinner) spinner.classList.remove('hidden');
      const targetUrl = `/api/projects/${state.activeProject.id}/preview/`;
      iframe.src = `${targetUrl}?t=${Date.now()}`;
      if (addressInput) addressInput.value = targetUrl;
      sound.playClick();
    });

    openTabBtn?.addEventListener('click', () => {
      if (!state.activeProject) return;
      const url = `/api/projects/${state.activeProject.id}/preview/`;
      window.open(url, '_blank');
    });

    // 5b. Project ZIP Archive Export Handler (Cloud & Docker-Ready)
    function triggerProjectZipExport() {
      const pId = state.activeProject?.id || 'proj-ecommerce-core';
      if (!pId) {
        showCanvasToast('No active project found to export');
        return;
      }
      showCanvasToast(`📦 Compressing ${pId} into standalone Docker ZIP...`);
      sound.playClick();
      try {
        const link = document.createElement('a');
        link.href = `/api/projects/${encodeURIComponent(pId)}/export/zip`;
        link.download = `${pId}-standalone.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => {
          showCanvasToast(`✅ Export initiated! Includes Dockerfile, compose, and multi-backend sandbox.`);
        }, 1200);
      } catch (err) {
        showCanvasToast(`Export failed: ${err.message}`);
      }
    }

    document.getElementById('btn-export-project-zip')?.addEventListener('click', triggerProjectZipExport);
    document.getElementById('btn-export-project-zip-header')?.addEventListener('click', triggerProjectZipExport);

    backBtn?.addEventListener('click', () => {
      try {
        iframe?.contentWindow?.postMessage({ type: 'SYNAPSE_HISTORY', delta: -1 }, '*');
      } catch (_) {}
    });
    fwdBtn?.addEventListener('click', () => {
      try {
        iframe?.contentWindow?.postMessage({ type: 'SYNAPSE_HISTORY', delta: 1 }, '*');
      } catch (_) {}
    });

    iframe?.addEventListener('load', () => {
      if (spinner) spinner.classList.add('hidden');
      if (statusPill && !statusPill.classList.contains('status-error')) {
        statusPill.className = 'url-status-pill status-live';
        statusPill.textContent = '● LIVE COMPILED';
      }
    });

    retryBtn?.addEventListener('click', async () => {
      if (!state.activeProject) return;
      const pId = state.activeProject.id;
      if (errorBanner) errorBanner.classList.add('hidden');
      if (statusPill) {
        statusPill.className = 'url-status-pill status-building';
        statusPill.textContent = '● REBUILDING...';
      }
      if (spinner) spinner.classList.remove('hidden');

      try {
        await fetch(`/api/projects/${pId}/preview/restart`, { method: 'POST' });
        showCanvasToast('Preview server restarted');
        setTimeout(() => {
          if (iframe) iframe.src = `/api/projects/${pId}/preview/?t=${Date.now()}`;
        }, 600);
      } catch (err) {
        showCanvasToast(`Restart failed: ${err.message}`);
      }
    });

    // 6. Preview Logs Tab
    document.getElementById('btn-refresh-preview-logs')?.addEventListener('click', async () => {
      if (!state.activeProject) return;
      const out = document.getElementById('preview-logs-output');
      if (!out) return;
      try {
        const res = await fetch(`/api/projects/${state.activeProject.id}/preview/logs`);
        const data = await res.json();
        const logs = data.logs || [];
        if (logs.length === 0) {
          out.innerHTML = `<div class="term-line system">[PREVIEW] Session active. No warnings or errors logged.</div>`;
        } else {
          out.innerHTML = logs.map(l => {
            const cls = l.type === 'stderr' ? 'stderr' : l.type === 'stdout' ? 'stdout' : 'system';
            return `<div class="term-line ${cls}"><span style="color:#64748b">[${new Date(l.timestamp).toLocaleTimeString()}]</span> ${escapeHtml(l.text)}</div>`;
          }).join('');
          out.scrollTop = out.scrollHeight;
        }
      } catch (err) {
        out.innerHTML = `<div class="term-line stderr">Failed to fetch preview logs: ${escapeHtml(err.message)}</div>`;
      }
    });

    // 7. Injected Bridge Message Listener
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'SYNAPSE_ROUTE_CHANGED') {
        const path = data.pathname || '/';
        if (addressInput && document.activeElement !== addressInput) {
          addressInput.value = path;
        }
      } else if (data.type === 'SYNAPSE_RUNTIME_ERROR') {
        if (errorBanner) {
          errorBanner.classList.remove('hidden');
          if (errorMsg) {
            errorMsg.textContent = `${data.message || 'Application Error'} ${data.filename ? `in ${data.filename}:${data.lineno}` : ''}`;
          }
        }
        if (statusPill) {
          statusPill.className = 'url-status-pill status-error';
          statusPill.textContent = '● RUNTIME ERROR';
        }
      } else if (data.type === 'SYNAPSE_BRIDGE_READY') {
        if (spinner) spinner.classList.add('hidden');
        if (errorBanner) errorBanner.classList.add('hidden');
        if (statusPill) {
          statusPill.className = 'url-status-pill status-live';
          statusPill.textContent = '● LIVE COMPILED';
        }
      }
    });

    // 8. Re-Synthesize Pipeline Button
    document.getElementById('btn-studio-run-pipeline')?.addEventListener('click', async () => {
      if (!state.activeProject) return;
      sound.playClick();
      showCanvasToast('Re-synthesizing full application pipeline...');
      try {
        await fetch(`/api/pipeline/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: state.activeProject.id })
        });
      } catch (_) {}
    });

    // 9. Build Panel Tab Bar Switching (code, audit, tests, terminal, git, logs)
    const subtabs = {
      code: document.getElementById('build-subtab-code'),
      audit: document.getElementById('build-subtab-audit'),
      tests: document.getElementById('build-subtab-tests'),
      terminal: document.getElementById('build-subtab-terminal'),
      git: document.getElementById('build-subtab-git'),
      logs: document.getElementById('build-subtab-logs')
    };

    function switchBuildSubtab(tabName) {
      document.querySelectorAll('.panel-tab-bar .tab-pill').forEach(pill => {
        if (pill.dataset.buildTab === tabName) {
          pill.classList.add('active');
        } else {
          pill.classList.remove('active');
        }
      });
      Object.entries(subtabs).forEach(([k, el]) => {
        if (!el) return;
        if (k === tabName) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
      sound.playClick();
      if (tabName === 'audit' && state.activeProject) {
        loadLatestAuditReport(state.activeProject.id);
      }
    }

    document.querySelectorAll('.panel-tab-bar .tab-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const tab = pill.dataset.buildTab;
        if (tab) switchBuildSubtab(tab);
      });
    });

    // 10. Requirement-Accurate Feature Builder: Inspect Scope & Lock
    document.getElementById('btn-inspect-requirements')?.addEventListener('click', async () => {
      if (!state.activeProject) return;
      const input = document.getElementById('input-feature-instruction');
      const instruction = input?.value?.trim();
      if (!instruction) {
        showCanvasToast('⚠️ Please enter a feature instruction or requirement before inspecting scope.');
        input?.focus();
        sound.playError?.();
        return;
      }
      sound.playClick();
      showCanvasToast('Analyzing scope & extracting requirements...');

      try {
        const res = await fetch(`/api/projects/${state.activeProject.id}/requirements/parse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruction })
        });
        if (!res.ok) throw new Error('Failed to parse requirements');
        const spec = await res.json();
        renderRequirementScope(spec);
        switchBuildSubtab('audit');
        const lockTag = document.getElementById('feature-lock-tag');
        if (lockTag) {
          lockTag.textContent = 'SCOPE INSPECTED & LOCKED';
          lockTag.style.background = 'rgba(16, 185, 129, 0.2)';
          lockTag.style.color = '#10b981';
        }
        showCanvasToast(`Scope locked: ${spec.featureName}`);
      } catch (err) {
        alert(err.message);
      }
    });

    // 11. Requirement-Accurate Feature Builder: Build & Self-Audit
    async function triggerFeatureBuild() {
      if (!state.activeProject) return;
      const input = document.getElementById('input-feature-instruction');
      const instruction = input?.value?.trim();
      if (!instruction) {
        showCanvasToast('⚠️ Please enter a feature instruction or requirement to build.');
        input?.focus();
        sound.playError?.();
        return;
      }
      sound.playClick();
      switchBuildSubtab('audit');

      const statusBadge = document.getElementById('audit-final-status-badge');
      if (statusBadge) {
        statusBadge.className = 'audit-final-status-badge status-building';
        statusBadge.textContent = 'BUILDING & AUDITING...';
      }
      showCanvasToast('Running requirement-accurate build & self-audit loop...');

      try {
        const res = await fetch(`/api/projects/${state.activeProject.id}/feature-build`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruction, maxIterations: 5, autoFix: true })
        });
        const data = await res.json();
        if (data.report) {
          renderAuditDashboard(data.report);
        }
        await refreshBuildStudio();
        const iframe = document.getElementById('build-preview-iframe');
        if (iframe && state.activeProject) {
          iframe.src = `/api/projects/${state.activeProject.id}/preview/?t=${Date.now()}`;
        }
        showCanvasToast(data.success ? 'Feature verified with 0 errors!' : 'Build completed with issues');
      } catch (err) {
        if (statusBadge) {
          statusBadge.className = 'audit-final-status-badge status-failed';
          statusBadge.textContent = 'FAILED';
        }
        alert(err.message);
      }
    }

    document.getElementById('btn-run-feature-build')?.addEventListener('click', triggerFeatureBuild);
    document.getElementById('btn-rerun-audit-pipeline')?.addEventListener('click', triggerFeatureBuild);

    // 12. Persistent Audit Report Modal
    const auditModal = document.getElementById('modal-audit-report');
    const openAuditModalBtn = document.getElementById('btn-open-audit-modal');
    const closeAuditModalBtn = document.getElementById('btn-close-audit-modal');
    const closeAuditModalBtn2 = document.getElementById('btn-modal-close-audit-btn');
    const tabBtnSummary = document.getElementById('modal-tab-btn-summary');
    const tabBtnRaw = document.getElementById('modal-tab-btn-raw');
    const tabSummary = document.getElementById('modal-tab-summary');
    const tabRaw = document.getElementById('modal-tab-raw');
    const copyReportBtn = document.getElementById('btn-copy-audit-report');

    async function openAuditModal() {
      if (!state.activeProject) return;
      if (auditModal) auditModal.style.display = 'flex';
      sound.playClick();
      try {
        const res = await fetch(`/api/projects/${state.activeProject.id}/audit-report`);
        if (!res.ok) throw new Error('No audit report found yet. Run Build & Self-Audit first.');
        const report = await res.json();
        state.lastAuditReport = report;
        renderAuditModalContent(report);
      } catch (err) {
        const summaryEl = document.getElementById('modal-audit-summary-content');
        if (summaryEl) summaryEl.innerHTML = `<div style="padding:20px; color:#f87171;">${escapeHtml(err.message)}</div>`;
      }
    }

    openAuditModalBtn?.addEventListener('click', openAuditModal);
    document.getElementById('btn-open-coverage-ribbon')?.addEventListener('click', openAuditModal);
    closeAuditModalBtn?.addEventListener('click', () => { if (auditModal) auditModal.style.display = 'none'; });
    closeAuditModalBtn2?.addEventListener('click', () => { if (auditModal) auditModal.style.display = 'none'; });

    tabBtnSummary?.addEventListener('click', () => {
      tabBtnSummary.className = 'btn btn-xs btn-primary modal-tab-btn active';
      tabBtnRaw.className = 'btn btn-xs btn-outline modal-tab-btn';
      if (tabSummary) tabSummary.style.display = 'block';
      if (tabRaw) tabRaw.style.display = 'none';
    });

    tabBtnRaw?.addEventListener('click', () => {
      tabBtnRaw.className = 'btn btn-xs btn-primary modal-tab-btn active';
      tabBtnSummary.className = 'btn btn-xs btn-outline modal-tab-btn';
      if (tabRaw) tabRaw.style.display = 'block';
      if (tabSummary) tabSummary.style.display = 'none';
    });

    copyReportBtn?.addEventListener('click', async () => {
      if (!state.lastAuditReport) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(state.lastAuditReport, null, 2));
        showCanvasToast('Audit report copied to clipboard');
      } catch (_) {
        showCanvasToast('Copy failed');
      }
    });
  }

  // --- AUDIT DASHBOARD RENDERING HELPERS ------------------------------------
  async function loadLatestAuditReport(projectId) {
    try {
      const res = await fetch(`/api/projects/${projectId}/audit-report`);
      if (!res.ok) return;
      const report = await res.json();
      renderAuditDashboard(report);
    } catch (_) {}
  }

  function renderAuditDashboard(report) {
    if (!report) return;
    state.lastAuditReport = report;

    const runTag = document.getElementById('audit-run-id-tag');
    if (runTag) runTag.textContent = `RUN: ${report.runId || 'latest'}`;

    const domainBadge = document.getElementById('audit-domain-badge');
    if (domainBadge) domainBadge.textContent = `DOMAIN: ${report.domain || 'FEATURE'}`;

    const featTitle = document.getElementById('audit-feature-title');
    if (featTitle) featTitle.textContent = `Requested Feature: ${report.featureName || 'Requested Feature'}`;

    const quoteEl = document.getElementById('audit-instruction-quote');
    if (quoteEl) quoteEl.textContent = `"${report.instruction || ''}"`;

    const statusBadge = document.getElementById('audit-final-status-badge');
    if (statusBadge) {
      const isPassed = report.status === 'VERIFIED' || report.success === true;
      statusBadge.className = `audit-final-status-badge ${isPassed ? 'status-verified' : 'status-failed'}`;
      statusBadge.textContent = report.status || (isPassed ? 'VERIFIED' : 'FAILED');
    }

    const iterTag = document.getElementById('audit-iteration-tag');
    if (iterTag) iterTag.textContent = `Iteration ${report.iterationCount || 1}`;

    if (report.requirements) {
      renderRequirementScope(report.requirements);
    }

    if (report.verification) {
      renderVerificationMatrix(report.verification);
    }

    if (report.browserTest) {
      renderBrowserEvidence(report.browserTest);
    }

    renderErrorHistory(report.errorHistory || report.errors || []);

    if (report.requirements && report.requirements.traceabilityMatrix) {
      renderTraceabilityTable(report.requirements.traceabilityMatrix);
    }
  }

  function renderRequirementScope(spec) {
    if (!spec) return;
    const reqList = document.getElementById('audit-req-list');
    if (reqList && Array.isArray(spec.explicitRequirements)) {
      reqList.innerHTML = spec.explicitRequirements.map(req => `
        <div class="scope-item">
          <span>${escapeHtml(req.id)}</span> ${escapeHtml(req.text || req.description || '')}
        </div>
      `).join('');
    }

    const exclList = document.getElementById('audit-excl-list');
    if (exclList && Array.isArray(spec.explicitExclusions)) {
      exclList.innerHTML = spec.explicitExclusions.map((excl, i) => {
        const text = typeof excl === 'string' ? excl : (excl.description || excl.text || '');
        const id = typeof excl === 'object' && excl.id ? excl.id : `EXCL-0${i + 1}`;
        return `
          <div class="scope-item prohibited">
            <span>${escapeHtml(id)}</span> ${escapeHtml(text)}
          </div>
        `;
      }).join('');
    }

    if (spec.domain) {
      const domainBadge = document.getElementById('audit-domain-badge');
      if (domainBadge) domainBadge.textContent = `DOMAIN: ${spec.domain}`;
    }
    if (spec.featureName) {
      const featTitle = document.getElementById('audit-feature-title');
      if (featTitle) featTitle.textContent = `Requested Feature: ${spec.featureName}`;
    }
  }

  function renderVerificationMatrix(v) {
    if (!v) return;

    let passedCount = 0;
    const updateDimension = (key, pillId, cardId, detailId) => {
      const item = v[key];
      const pill = document.getElementById(pillId);
      const detail = document.getElementById(detailId);
      if (!item || !pill) return;

      const status = item.status;
      pill.textContent = status;
      pill.className = 'v-pill';

      if (status === 'Passed' || status === 'Clean' || status === 'Healthy') {
        pill.classList.add('pill-pass');
        passedCount++;
      } else if (status === 'Failed' || status === 'Errors detected' || status === 'Failures detected' || status === 'Findings detected' || status === 'Unavailable') {
        pill.classList.add('pill-fail');
      } else if (status === 'Blocked') {
        pill.classList.add('pill-blocked');
      } else {
        pill.classList.add('pill-idle');
      }

      if (detail && item.detail) {
        detail.textContent = item.detail;
        detail.title = item.detail;
      }
    };

    updateDimension('requirements', 'vpill-requirements', 'vcard-requirements', 'vdetail-requirements');
    updateDimension('lint', 'vpill-lint', 'vcard-lint', 'vdetail-lint');
    updateDimension('typecheck', 'vpill-typecheck', 'vcard-typecheck', 'vdetail-typecheck');
    updateDimension('build', 'vpill-build', 'vcard-build', 'vdetail-build');
    updateDimension('unitTests', 'vpill-unit', 'vcard-unit', 'vdetail-unit');
    updateDimension('integrationTests', 'vpill-integration', 'vcard-integration', 'vdetail-integration');
    updateDimension('browserTests', 'vpill-browser', 'vcard-browser', 'vdetail-browser');
    updateDimension('runtimeConsole', 'vpill-console', 'vcard-console', 'vdetail-console');
    updateDimension('networkRequests', 'vpill-network', 'vcard-network', 'vdetail-network');
    updateDimension('securityChecks', 'vpill-security', 'vcard-security', 'vdetail-security');
    updateDimension('regressionTests', 'vpill-regression', 'vcard-regression', 'vdetail-regression');
    updateDimension('previewHealth', 'vpill-preview', 'vcard-preview', 'vdetail-preview');

    const counter = document.getElementById('audit-verification-counter');
    if (counter) counter.textContent = `${passedCount} / 12 Verified`;
  }

  function renderBrowserEvidence(bt) {
    if (!bt) return;
    const urlCode = document.getElementById('audit-browser-target-url');
    if (urlCode && bt.url) urlCode.textContent = bt.url;

    const badge = document.getElementById('audit-browser-badge');
    if (badge) {
      badge.className = `test-status-badge ${bt.passed ? 'status-pass' : 'status-fail'}`;
      badge.textContent = bt.passed ? 'PASSED' : 'FAILED';
    }

    const assertionsList = document.getElementById('audit-browser-assertions-list');
    if (assertionsList && Array.isArray(bt.assertions)) {
      assertionsList.innerHTML = bt.assertions.map(a => `
        <div class="assertion-item ${a.passed ? 'pass' : 'fail'}">
          <span class="check-icon">${a.passed ? '✔' : '✖'}</span>
          <span><strong>${escapeHtml(a.id)}:</strong> ${escapeHtml(a.description || a.details)}</span>
        </div>
      `).join('');
    }
  }

  function renderErrorHistory(errors) {
    const tbody = document.getElementById('audit-error-tbody');
    if (!tbody) return;

    if (!Array.isArray(errors) || errors.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-audit-row">✔ No known errors detected. All verification gates passed.</td></tr>`;
      return;
    }

    tbody.innerHTML = errors.map(err => `
      <tr>
        <td><code>${escapeHtml(err.id || 'ERR')}</code></td>
        <td><span class="v-pill pill-fail">${escapeHtml(err.category || 'Error')}</span></td>
        <td>${escapeHtml(err.description || '')}</td>
        <td style="color:#f87171">${escapeHtml(err.rootCause || 'Unresolved')}</td>
        <td>${escapeHtml(err.fixAttempted || 'None')}</td>
        <td>${escapeHtml(err.retestResult || 'Pending')}</td>
        <td><span class="v-pill ${err.status === 'RESOLVED' ? 'pill-pass' : 'pill-fail'}">${escapeHtml(err.status || 'OPEN')}</span></td>
      </tr>
    `).join('');
  }

  function renderTraceabilityTable(matrix) {
    const tbody = document.getElementById('audit-traceability-tbody');
    if (!tbody || !Array.isArray(matrix)) return;

    tbody.innerHTML = matrix.map(row => {
      const id = row.requirementId || row.id || 'REQ';
      const text = row.description || row.text || row.requirementText || '';
      const files = row.targetFile ? [row.targetFile] : (row.implementationFiles || []);
      const testFiles = row.testId ? [row.testId] : (row.testedIn ? [row.testedIn] : (row.testFiles || []));
      const check = row.acceptanceCriteria || row.browserAssertion || row.browserCheckId || 'Verified';
      const status = row.status || row.acceptanceStatus || 'VERIFIED';
      const isPass = status === 'VERIFIED' || status === 'PASSED';
      const isBlocked = status === 'BLOCKED';
      const isPending = status === 'PENDING';
      const pillClass = isPass ? 'pill-pass' : (isBlocked ? 'pill-blocked' : (isPending ? 'pill-idle' : 'pill-fail'));

      return `
        <tr>
          <td><strong>${escapeHtml(id)}</strong></td>
          <td>${escapeHtml(text)}</td>
          <td><code>${files.map(f => escapeHtml(f)).join(', ') || 'N/A'}</code></td>
          <td><code>${testFiles.map(f => escapeHtml(f)).join(', ') || 'tests/api.test.js'}</code></td>
          <td style="font-size:12px;">${escapeHtml(check)}</td>
          <td><span class="v-pill ${pillClass}">${escapeHtml(status)}</span></td>
        </tr>
      `;
    }).join('');
  }

  function renderAuditModalContent(report) {
    const rawContent = document.getElementById('modal-audit-raw-content');
    if (rawContent) {
      rawContent.textContent = JSON.stringify(report, null, 2);
    }

    const summaryContent = document.getElementById('modal-audit-summary-content');
    if (!summaryContent) return;

    const modalStatus = document.getElementById('modal-audit-status');
    const modalRunId = document.getElementById('modal-audit-run-id');

    if (modalRunId) {
      modalRunId.textContent = report.runId || report.projectId || 'latest';
    }

    // Check if report is a Requirement Coverage Report (from CoverageTracker)
    if (report.summary && Array.isArray(report.requirements)) {
      const s = report.summary;
      const isVerified = s.isFullyVerified || (s.verified === s.total && s.total > 0);
      if (modalStatus) {
        modalStatus.textContent = isVerified ? `VERIFIED (${s.coveragePercentage}%)` : (s.failed > 0 ? 'FAILURES DETECTED' : 'IN PROGRESS');
        modalStatus.className = `audit-scope-pill ${isVerified ? 'status-verified' : 'status-failed'}`;
      }

      summaryContent.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:16px;">
          <!-- Prompt Banner -->
          <div style="background:rgba(15,23,42,0.85); padding:14px; border-radius:10px; border:1px solid rgba(56,189,248,0.25);">
            <div style="font-size:11px; font-weight:700; color:#38bdf8; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:4px;">Original User Instruction</div>
            <p style="font-size:13px; color:#f8fafc; margin:0; line-height:1.5; font-style:italic;">"${escapeHtml(report.originalPrompt || report.instruction || 'None')}"</p>
          </div>

          <!-- Coverage Metrics KPI Row -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(110px, 1fr)); gap:10px;">
            <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px; text-align:center;">
              <div style="font-size:10px; color:#94a3b8; font-weight:700;">TOTAL REQS</div>
              <div style="font-size:22px; font-weight:800; color:#f8fafc;">${s.total || 0}</div>
            </div>
            <div style="background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); border-radius:8px; padding:10px; text-align:center;">
              <div style="font-size:10px; color:#34d399; font-weight:700;">VERIFIED</div>
              <div style="font-size:22px; font-weight:800; color:#10b981;">${s.verified || 0}</div>
            </div>
            <div style="background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px; text-align:center;">
              <div style="font-size:10px; color:#f87171; font-weight:700;">FAILED</div>
              <div style="font-size:22px; font-weight:800; color:#ef4444;">${s.failed || 0}</div>
            </div>
            <div style="background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.3); border-radius:8px; padding:10px; text-align:center;">
              <div style="font-size:10px; color:#fbbf24; font-weight:700;">BLOCKED</div>
              <div style="font-size:22px; font-weight:800; color:#f59e0b;">${s.blocked || 0}</div>
            </div>
            <div style="background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.3); border-radius:8px; padding:10px; text-align:center;">
              <div style="font-size:10px; color:#38bdf8; font-weight:700;">COVERAGE</div>
              <div style="font-size:22px; font-weight:800; color:#38bdf8;">${s.coveragePercentage || 0}%</div>
            </div>
          </div>

          <!-- Requirements Matrix Table -->
          <div style="background:rgba(0,0,0,0.35); border-radius:10px; border:1px solid var(--border-subtle); overflow:hidden;">
            <div style="padding:10px 14px; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:12px; font-weight:700; color:#f1f5f9;">REQUIREMENTS TRACEABILITY & VERIFICATION MATRIX</span>
              <span style="font-size:11px; color:#94a3b8;">${report.title || 'Project Specification'}</span>
            </div>
            <div style="overflow-x:auto;">
              <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:left;">
                <thead>
                  <tr style="border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(0,0,0,0.2); color:#94a3b8;">
                    <th style="padding:8px 12px;">ID</th>
                    <th style="padding:8px 12px;">Category</th>
                    <th style="padding:8px 12px;">Requirement Description</th>
                    <th style="padding:8px 12px;">Target File</th>
                    <th style="padding:8px 12px;">Status</th>
                    <th style="padding:8px 12px;">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  ${report.requirements.map(req => {
                    const isPass = req.status === 'VERIFIED';
                    const isBlock = req.status === 'BLOCKED';
                    const isFail = req.status === 'FAILED';
                    const pillColor = isPass ? 'background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.4);' : (isBlock ? 'background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);' : 'background:rgba(239,68,68,0.15);color:#fca5a5;border:1px solid rgba(239,68,68,0.4);');
                    return `
                      <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                        <td style="padding:8px 12px; font-family:var(--font-mono); font-weight:700; color:#38bdf8;">${escapeHtml(req.id)}</td>
                        <td style="padding:8px 12px;"><span style="font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px; background:rgba(255,255,255,0.06); color:#cbd5e1;">${escapeHtml(req.category || 'FUNCTIONAL')}</span></td>
                        <td style="padding:8px 12px; color:#f8fafc;">${escapeHtml(req.text || req.description || '')}</td>
                        <td style="padding:8px 12px; font-family:var(--font-mono); font-size:11px; color:#94a3b8;"><code>${escapeHtml(req.targetFile || req.implementedIn || 'src/api.js')}</code></td>
                        <td style="padding:8px 12px;"><span style="display:inline-block; font-size:10px; font-weight:700; padding:3px 8px; border-radius:999px; ${pillColor}">${escapeHtml(req.status || 'PENDING')}</span></td>
                        <td style="padding:8px 12px; font-size:11px; color:#cbd5e1;">${escapeHtml(req.evidence || 'Awaiting test execution')}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
      return;
    }

    if (modalStatus) {
      modalStatus.textContent = report.status || (report.success ? 'VERIFIED' : 'FAILED');
    }

    summaryContent.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:16px;">
        <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; border:1px solid var(--border-subtle);">
          <h4 style="margin:0 0 6px 0; color:#38bdf8;">Original User Instruction</h4>
          <p style="font-size:13px; font-style:italic; color:#f8fafc; margin:0;">"${escapeHtml(report.instruction || 'None')}"</p>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div style="background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.25); border-radius:8px; padding:12px;">
            <h5 style="color:#10b981; margin:0 0 8px 0;">Locked Feature Scope</h5>
            <div><strong>Feature:</strong> ${escapeHtml(report.featureName || 'N/A')}</div>
            <div><strong>Domain:</strong> ${escapeHtml(report.domain || 'N/A')}</div>
            <div><strong>Iteration Count:</strong> ${report.iterationCount || 1}</div>
          </div>
          <div style="background:rgba(56,189,248,0.06); border:1px solid rgba(56,189,248,0.25); border-radius:8px; padding:12px;">
            <h5 style="color:#38bdf8; margin:0 0 8px 0;">Preview Health & Verification</h5>
            <div><strong>Preview URL:</strong> <code>${escapeHtml(report.previewUrl || '')}</code></div>
            <div><strong>Browser Test:</strong> ${report.browserTest?.passed ? '<span style="color:#10b981;font-weight:700">PASSED</span>' : '<span style="color:#ef4444;font-weight:700">FAILED</span>'}</div>
            <div><strong>Errors Detected:</strong> ${(report.errorHistory || []).length}</div>
          </div>
        </div>

        <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; border:1px solid var(--border-subtle);">
          <h4 style="margin:0 0 8px 0; color:#f1f5f9;">Commands Executed</h4>
          <ul style="margin:0; padding-left:18px; font-family:var(--font-mono); font-size:11px; color:#cbd5e1;">
            ${(report.commandsExecuted || []).map(c => `<li>${escapeHtml(c.command || c)} (Exit: ${c.exitCode ?? 0})</li>`).join('') || '<li>None</li>'}
          </ul>
        </div>
      </div>
    `;
  }

  // --- TASK BOARD CONTROLLER -----------------------------------------------
  function renderTaskBoard() {
    const mockTasks = [
      { id: 't1', title: 'Breakdown User Stories & Acceptance Criteria', role: 'BA', status: 'completed' },
      { id: 't2', title: 'Design Responsive Glassmorphic Layout & Tokens', role: 'DESIGNER', status: 'completed' },
      { id: 't3', title: 'Specify OpenAPI Schema & Architecture Contract', role: 'PM', status: 'completed' },
      { id: 't4', title: 'Implement Express REST APIs & Authentication', role: 'BACKEND', status: 'completed' },
      { id: 't5', title: 'Structure SQLite Tables & WAL Persistence', role: 'DATABASE', status: 'completed' },
      { id: 't6', title: 'Synthesize Interactive Frontend Client State', role: 'FRONTEND', status: 'progress' },
      { id: 't7', title: 'Static Code Analysis & Security Inspection', role: 'CODE_REVIEWER', status: 'review' },
      { id: 't8', title: 'Execute Node.js Automated Test Suites', role: 'QA', status: 'qa' },
      { id: 't9', title: 'Audit Secret Isolation & Boundary Jails', role: 'SECURITY', status: 'assigned' },
      { id: 't10', title: 'Package Container Manifest & Release Gate', role: 'DEVOPS', status: 'backlog' }
    ];

    const columns = {
      backlog: document.getElementById('col-backlog'),
      assigned: document.getElementById('col-assigned'),
      progress: document.getElementById('col-progress'),
      review: document.getElementById('col-review'),
      qa: document.getElementById('col-qa'),
      completed: document.getElementById('col-completed')
    };

    Object.values(columns).forEach(c => { if (c) c.innerHTML = ''; });

    const counts = { backlog: 0, assigned: 0, progress: 0, review: 0, qa: 0, completed: 0 };

    mockTasks.forEach(task => {
      counts[task.status]++;
      const card = document.createElement('div');
      card.className = 'kanban-task-card';
      card.innerHTML = `
        <div class="card-agent-row">
          <span class="card-agent-badge">${task.role}</span>
        </div>
        <div class="card-title">${task.title}</div>
      `;
      card.addEventListener('click', () => {
        const emp = EMPLOYEES.find(e => e.role === task.role);
        if (emp) {
          switchView('office');
          selectEmployee(emp);
          state.camera.targetX = emp.x;
          state.camera.targetY = emp.y;
          state.camera.targetZoom = 1.4;
          showCanvasToast(`Focused on ${emp.name} working on: ${task.title}`);
        }
      });
      columns[task.status]?.appendChild(card);
    });

    Object.keys(counts).forEach(k => {
      const el = document.getElementById(`count-${k}`);
      if (el) el.textContent = counts[k];
    });
  }

  // --- TEAM ROSTER VIEW CONTROLLER -----------------------------------------
  function renderTeamRoster() {
    const grid = document.getElementById('team-roster-grid');
    if (!grid) return;

    grid.innerHTML = EMPLOYEES.map(emp => `
      <div class="roster-card" data-emp-id="${emp.id}">
        <div class="roster-header">
          <div class="roster-avatar" style="background:${emp.avatarColor}">${emp.role}</div>
          <div class="roster-info">
            <h4>${emp.name}</h4>
            <span>${emp.title}</span>
          </div>
        </div>
        <div class="roster-dept">${DEPARTMENTS[emp.dept]?.name || emp.dept}</div>
        <div class="roster-task-row">
          <strong>Task:</strong> ${emp.task} (${emp.completion}%)
        </div>
        <div class="skills-tag-cloud">
          ${emp.skills.map(s => `<span class="skill-tag">${s}</span>`).join('')}
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.roster-card').forEach(card => {
      card.addEventListener('click', () => {
        const emp = EMPLOYEES.find(e => e.id === card.dataset.empId);
        if (emp) {
          switchView('office');
          selectEmployee(emp);
          state.camera.targetX = emp.x;
          state.camera.targetY = emp.y;
          state.camera.targetZoom = 1.4;
        }
      });
    });
  }

  // --- PROJECTS LIST VIEW CONTROLLER ---------------------------------------
  async function renderProjectsList() {
    try {
      const res = await fetch('/api/projects');
      const list = await res.json();
      state.projects = list;

      const tbody = document.getElementById('projects-tbody');
      if (!tbody) return;

      tbody.innerHTML = list.map(p => `
        <tr>
          <td><code style="color:#38bdf8">${p.id}</code></td>
          <td><strong>${p.name}</strong></td>
          <td>${(p.budget_tokens || 100000).toLocaleString()} tokens</td>
          <td><span class="badge badge-primary">ACTIVE JAIL</span></td>
          <td>
            <button class="btn btn-outline btn-xs" onclick="window.switchActiveProject('${p.id}')">Select</button>
          </td>
        </tr>
      `).join('');
    } catch (_) {}
  }

  window.switchActiveProject = (pId) => {
    const p = state.projects.find(x => x.id === pId);
    if (p) {
      state.activeProject = p;
      updateHeaderStats();
      showCanvasToast(`Switched active project to: ${p.name}`);
      switchView('office');
    }
  };

  // --- APPROVALS VIEW & MODAL ----------------------------------------------
  function renderApprovals() {
    const list = document.getElementById('approvals-list');
    if (!list) return;

    if (state.approvals.length === 0) {
      list.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:20px;">No pending approvals. All security gates clear.</div>`;
      return;
    }

    list.innerHTML = state.approvals.map(app => `
      <div class="approval-card pending">
        <div class="approval-badge-row">
          <span class="badge badge-danger">${app.risk_level || 'CRITICAL'} RISK</span>
          <span class="badge badge-warning">${app.status}</span>
        </div>
        <h3 class="approval-action-title">${app.action_type}</h3>
        <p class="approval-reason-text">${app.reason || 'Explicit human operator authorization required.'}</p>
        <div class="approval-payload-box">
          <pre><code>${escapeHtml(JSON.stringify(typeof app.payload === 'string' ? JSON.parse(app.payload) : app.payload, null, 2))}</code></pre>
        </div>
        <div class="approval-actions-row">
          <button class="btn btn-danger btn-sm" onclick="window.resolveApproval('${app.id}', 'REJECT')">Explicitly Reject</button>
          <button class="btn btn-success btn-sm" onclick="window.resolveApproval('${app.id}', 'APPROVE')">Sign & Authorize Release</button>
        </div>
      </div>
    `).join('');
  }

  window.resolveApproval = async (approvalId, decision) => {
    try {
      const res = await fetch(`/api/approvals/${approvalId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reviewer: 'Chief Architect' })
      });
      const resolved = await res.json();
      showCanvasToast(`Approval ${decision}D: ${resolved.action_type}`);
      sound.playChime();
      fetchStatus();
      renderApprovals();
    } catch (err) {
      alert('Approval resolution failed: ' + err.message);
    }
  };

  document.getElementById('btn-quick-approve')?.addEventListener('click', () => {
    if (state.approvals.length > 0) {
      window.resolveApproval(state.approvals[0].id, 'APPROVE');
    }
  });
  document.getElementById('btn-quick-reject')?.addEventListener('click', () => {
    if (state.approvals.length > 0) {
      window.resolveApproval(state.approvals[0].id, 'REJECT');
    }
  });

  // Modal controls
  document.getElementById('btn-close-approval-modal')?.addEventListener('click', () => {
    document.getElementById('approval-modal')?.classList.remove('active');
  });

  // --- AUTONOMOUS BUILD PROJECT CONTROLLER ----------------------------------
  async function triggerAutonomousBuild({ title, description, appType, budgetTokens, budgetUsd, maxRetries }) {
    const rawTitle = (title || '').trim();
    const rawDesc = (description || '').trim();

    if (!rawTitle && !rawDesc) {
      const alertEl = document.getElementById('build-validation-alert');
      if (alertEl) {
        alertEl.textContent = 'Please enter a project title or description before launching the build.';
        alertEl.style.display = 'block';
      }
      showCanvasToast('⚠️ Please describe the project you want to build before launching.');
      sound.playError?.();
      return;
    }

    const safeTitle = rawTitle || rawDesc.slice(0, 60);
    const safeDesc = rawDesc;
    const safeType = appType || 'Auto-Detect';

    showCanvasToast(`🚀 Mobilizing AI Virtual Software House for "${safeTitle}"...`);
    sound.playClick();

    try {
      const res = await fetch('/api/projects/autonomous', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: safeTitle,
          description: safeDesc,
          appType: safeType,
          budgetTokens: Number(budgetTokens) || 120000,
          budgetUsd: Number(budgetUsd) || 15.0,
          maxRetries: Number(maxRetries) || 3
        })
      });

      const data = await res.json();
      if (!data.success && !data.project) {
        throw new Error(data.error || 'Failed to start autonomous build');
      }

      state.activeProject = data.project;
      const projNameEl = document.getElementById('office-project-name');
      if (projNameEl) projNameEl.textContent = data.project.name;
      const stageTag = document.getElementById('office-stage-tag');
      if (stageTag) {
        stageTag.textContent = data.status === 'QUEUED' ? 'QUEUE: PENDING' : 'STAGE: PLANNING';
      }

      // Immediately point preview iframe and address input to new project
      const iframe = document.getElementById('build-preview-iframe');
      const addressInput = document.getElementById('preview-address-input');
      const newPreviewUrl = `/api/projects/${data.project.id}/preview/`;
      if (iframe) iframe.src = `${newPreviewUrl}?t=${Date.now()}`;
      if (addressInput) addressInput.value = newPreviewUrl;

      // Update stepper to stage 1
      updateStageStepper('STAGE_INTAKE', 'RUNNING');

      // Focus camera on Planning Room
      focusDepartment('meeting_room');

      // Switch to office view so user watches team assemble in real time
      switchView('office');

      // If async background job ID is returned, initiate fallback polling loop
      if (data.jobId) {
        startJobPolling(data.jobId, data.project.id);
        showCanvasToast(`🚀 Project queued for async processing (Job ${data.jobId})...`);
      } else {
        showCanvasToast(`Dynamic team assigned. Sofia Ramos (PM) opening planning meeting...`);
      }
      sound.playChime();

      fetchStatus();
    } catch (err) {
      alert('Error triggering autonomous build: ' + err.message);
    }
  }

  // Build Project Modal Triggers
  document.getElementById('btn-open-build-modal')?.addEventListener('click', () => {
    const alertEl = document.getElementById('build-validation-alert');
    if (alertEl) alertEl.style.display = 'none';
    document.getElementById('modal-build-project')?.classList.add('active');
    document.getElementById('input-build-title')?.focus();
    sound.playClick();
  });
  document.getElementById('btn-close-build-modal')?.addEventListener('click', () => {
    document.getElementById('modal-build-project')?.classList.remove('active');
  });
  document.getElementById('btn-cancel-build-modal')?.addEventListener('click', () => {
    document.getElementById('modal-build-project')?.classList.remove('active');
  });

  // Modal Presets (Clicking populates inspiration into inputs only if user chooses)
  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const alertEl = document.getElementById('build-validation-alert');
      if (alertEl) alertEl.style.display = 'none';
      const titleInput = document.getElementById('input-build-title');
      const descInput = document.getElementById('input-build-desc');
      const typeSelect = document.getElementById('select-build-type');
      if (titleInput && chip.dataset.title) titleInput.value = chip.dataset.title;
      if (descInput && chip.dataset.desc) descInput.value = chip.dataset.desc;
      if (typeSelect && chip.dataset.type) typeSelect.value = chip.dataset.type;
      sound.playClick();
    });
  });

  // Modal Submit
  document.getElementById('btn-submit-build-project')?.addEventListener('click', () => {
    const title = document.getElementById('input-build-title')?.value;
    const desc = document.getElementById('input-build-desc')?.value;
    const type = document.getElementById('select-build-type')?.value;
    const tokens = document.getElementById('input-build-budget-tokens')?.value;
    const usd = document.getElementById('input-build-budget-usd')?.value;
    const retries = document.getElementById('input-build-max-retries')?.value;

    if (!title?.trim() && !desc?.trim()) {
      const alertEl = document.getElementById('build-validation-alert');
      if (alertEl) {
        alertEl.textContent = 'Please enter a project title or description to build.';
        alertEl.style.display = 'block';
      }
      sound.playError?.();
      document.getElementById('input-build-title')?.focus();
      return;
    }

    document.getElementById('modal-build-project')?.classList.remove('active');
    triggerAutonomousBuild({
      title,
      description: desc,
      appType: type,
      budgetTokens: tokens,
      budgetUsd: usd,
      maxRetries: retries
    });
  });

  // Quick Preset Chips on Launcher Bar
  document.querySelectorAll('.quick-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const titleInput = document.getElementById('quick-build-title-input');
      const descInput = document.getElementById('quick-build-desc-input');
      if (titleInput && btn.dataset.title) titleInput.value = btn.dataset.title;
      if (descInput && btn.dataset.desc) descInput.value = btn.dataset.desc;
      sound.playClick();
      titleInput?.focus();
    });
  });

  // Quick Launcher Bar Execute Button
  document.getElementById('btn-quick-build-execute')?.addEventListener('click', () => {
    const title = document.getElementById('quick-build-title-input')?.value;
    const desc = document.getElementById('quick-build-desc-input')?.value;
    if (!title?.trim() && !desc?.trim()) {
      showCanvasToast('⚠️ Please enter a project title or description in the quick build box.');
      sound.playError?.();
      document.getElementById('quick-build-title-input')?.focus();
      return;
    }
    triggerAutonomousBuild({
      title,
      description: desc,
      appType: 'Auto-Detect'
    });
  });

  // Keyboard Submission Shortcuts
  const handleQuickBuildKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-quick-build-execute')?.click();
    }
  };
  document.getElementById('quick-build-title-input')?.addEventListener('keydown', handleQuickBuildKey);
  document.getElementById('quick-build-desc-input')?.addEventListener('keydown', handleQuickBuildKey);

  document.getElementById('input-build-desc')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-submit-build-project')?.click();
    }
  });

  document.getElementById('input-build-title')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('input-build-desc')?.focus();
    }
  });

  // Universal Modal Dismissal (Click Outside Backdrop & Escape Key)
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('active');
        overlay.style.display = 'none';
        sound.playClick();
      }
    });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach(overlay => {
        if (overlay.classList.contains('active') || overlay.style.display === 'flex' || overlay.style.display === 'block') {
          overlay.classList.remove('active');
          overlay.style.display = 'none';
        }
      });
    }
  });

  // Pipeline Live Controls
  document.getElementById('btn-pipeline-pause')?.addEventListener('click', async () => {
    if (!state.activeProject) return;
    try {
      await fetch(`/api/projects/${state.activeProject.id}/pause`, { method: 'POST' });
      document.getElementById('btn-pipeline-pause').style.display = 'none';
      document.getElementById('btn-pipeline-resume').style.display = 'inline-flex';
      showCanvasToast('Workflow execution paused by operator');
      sound.playClick();
    } catch (e) { alert('Pause failed: ' + e.message); }
  });

  document.getElementById('btn-pipeline-resume')?.addEventListener('click', async () => {
    if (!state.activeProject) return;
    try {
      await fetch(`/api/projects/${state.activeProject.id}/resume`, { method: 'POST' });
      document.getElementById('btn-pipeline-resume').style.display = 'none';
      document.getElementById('btn-pipeline-pause').style.display = 'inline-flex';
      showCanvasToast('Workflow execution resumed');
      sound.playClick();
    } catch (e) { alert('Resume failed: ' + e.message); }
  });

  document.getElementById('btn-pipeline-cancel')?.addEventListener('click', async () => {
    if (!state.activeProject) return;
    if (!confirm('Are you sure you want to cancel the current autonomous build?')) return;
    try {
      await fetch(`/api/projects/${state.activeProject.id}/cancel`, { method: 'POST' });
      showCanvasToast('Workflow execution cancelled');
      sound.playAlert();
    } catch (e) { alert('Cancel failed: ' + e.message); }
  });

  document.getElementById('btn-pipeline-retry')?.addEventListener('click', async () => {
    if (!state.activeProject) return;
    showCanvasToast('Restarting autonomous build...');
    try {
      await fetch(`/api/projects/${state.activeProject.id}/retry`, { method: 'POST' });
      updateStageStepper('STAGE_INTAKE', 'RUNNING');
      focusDepartment('meeting_room');
      sound.playClick();
    } catch (e) { alert('Retry failed: ' + e.message); }
  });

  // Open Preview in Build Studio
  const openLivePreview = () => {
    switchView('build');
    refreshBuildStudio();
    sound.playClick();
  };
  document.getElementById('btn-open-live-preview')?.addEventListener('click', openLivePreview);
  document.getElementById('btn-quick-preview-floating')?.addEventListener('click', openLivePreview);

  // Build Studio Re-run Tests
  document.getElementById('btn-build-rerun-tests')?.addEventListener('click', async () => {
    if (!state.activeProject) return;
    showCanvasToast('Running test suite in sandbox jail...');
    const btn = document.getElementById('btn-build-rerun-tests');
    btn.disabled = true;
    btn.textContent = 'Running...';
    try {
      const res = await fetch(`/api/projects/${state.activeProject.id}/run-tests`, { method: 'POST' });
      const data = await res.json();
      const outputEl = document.getElementById('build-test-output');
      const badge = document.getElementById('build-test-status-badge');
      const exitEl = document.getElementById('test-stat-exit');
      if (exitEl) exitEl.textContent = data.exitCode;
      if (outputEl) outputEl.textContent = (data.stdout || '') + '\n' + (data.stderr || '');
      if (data.exitCode === 0) {
        if (badge) {
          badge.className = 'test-status-badge status-pass';
          badge.textContent = 'TESTS PASSING';
        }
        showCanvasToast('All sandboxed tests passed! (Exit 0)');
        sound.playChime();
      } else {
        if (badge) {
          badge.className = 'test-status-badge status-fail';
          badge.textContent = 'TESTS FAILING';
        }
        showCanvasToast('Tests failed in sandbox');
        sound.playAlert();
      }
    } catch (err) {
      alert('Test execution error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🧪 Re-run Tests Now';
    }
  });

  // Office Command Input bar
  document.getElementById('btn-office-command-send')?.addEventListener('click', () => {
    handleOfficeCommand();
  });
  document.getElementById('office-command-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleOfficeCommand();
  });

  function handleOfficeCommand() {
    const input = document.getElementById('office-command-input');
    const val = input?.value?.trim();
    if (!val) return;
    input.value = '';

    showCanvasToast(`Command Dispatched: "${val}"`);
    sound.playClick();

    // Route command
    if (/meeting|gather|planning/i.test(val)) {
      handleSSEEvent('meeting.started', {});
    } else if (/test|qa/i.test(val)) {
      handleSSEEvent('test.started', {});
    } else if (/build|store|ecommerce|create/i.test(val)) {
      document.getElementById('idea-prompt-text').value = val;
      switchView('idea');
      document.getElementById('btn-analyze-idea')?.click();
    } else {
      handleSSEEvent('task.handoff', { fromRole: 'PM', toRole: 'FRONTEND' });
    }
  }

  // --- GUIDED DEMO SIMULATION MODE ----------------------------------------
  document.getElementById('btn-mode-live')?.addEventListener('click', () => {
    setMode('live');
  });
  document.getElementById('btn-mode-demo')?.addEventListener('click', () => {
    setMode('demo');
  });

  function setMode(mode) {
    state.mode = mode;
    document.getElementById('btn-mode-live')?.classList.toggle('active', mode === 'live');
    document.getElementById('btn-mode-demo')?.classList.toggle('active', mode === 'demo');

    if (mode === 'demo') {
      showCanvasToast('🎮 DEMO SIMULATION ACTIVATED: Autonomous Workflow Playback');
      startDemoWorkflow();
    } else {
      clearTimeout(state.demoTimer);
      showCanvasToast('⚡ LIVE MODE ACTIVATED: Connected to Real Backend');
    }
    sound.playClick();
  }

  function startDemoWorkflow() {
    clearTimeout(state.demoTimer);
    state.demoStep = 0;

    const demoSteps = [
      () => {
        showCanvasToast('Step 1: Sofia (PM) & Elena (BA) convene in Planning Room');
        handleSSEEvent('meeting.started', {});
        focusDepartment('meeting_room');
      },
      () => {
        showCanvasToast('Step 2: PM distributes tasks to UI/UX, Frontend & Backend');
        handleSSEEvent('task.handoff', { fromRole: 'PM', toRole: 'BACKEND' });
        handleSSEEvent('task.handoff', { fromRole: 'PM', toRole: 'FRONTEND' });
        focusDepartment('backend');
      },
      () => {
        showCanvasToast('Step 3: David Chen synthesizes APIs; Aria Patel builds UI');
        const be = EMPLOYEES.find(e => e.role === 'BACKEND');
        const fe = EMPLOYEES.find(e => e.role === 'FRONTEND');
        if (be) be.state = 'working';
        if (fe) fe.state = 'working';
        spawnSparks(1010, 195, '#34d399', 15);
      },
      () => {
        showCanvasToast('Step 4: Kaito Tanaka conducts Code Review & QA runs test suite');
        handleSSEEvent('task.handoff', { fromRole: 'BACKEND', toRole: 'CODE_REVIEWER' });
        handleSSEEvent('test.started', {});
        focusDepartment('qa_lab');
      },
      () => {
        showCanvasToast('Step 5: QA verifies 100% tests pass; Devon stages deployment');
        handleSSEEvent('test.passed', {});
        focusDepartment('devops_hub');
      },
      () => {
        showCanvasToast('Step 6: Human Approval Gate triggered for Production Release');
        handleSSEEvent('approval.required', {});
      }
    ];

    function runNextStep() {
      if (state.mode !== 'demo') return;
      if (state.demoStep < demoSteps.length) {
        demoSteps[state.demoStep]();
        state.demoStep++;
        state.demoTimer = setTimeout(runNextStep, 4500);
      } else {
        showCanvasToast('Demo playback complete! Feel free to explore all departments.');
      }
    }

    runNextStep();
  }

  // --- SETTINGS & SOUND CONTROLS ------------------------------------------
  document.getElementById('btn-toggle-sound')?.addEventListener('click', () => {
    sound.enabled = !sound.enabled;
    document.getElementById('icon-sound-on').style.display = sound.enabled ? 'block' : 'none';
    document.getElementById('icon-sound-off').style.display = sound.enabled ? 'none' : 'block';
    const toggle = document.getElementById('setting-sound-effects');
    if (toggle) toggle.checked = sound.enabled;
    showCanvasToast(sound.enabled ? 'Sound Effects Enabled' : 'Sound Effects Muted');
  });

  document.getElementById('setting-reduced-motion')?.addEventListener('change', (e) => {
    state.reducedMotion = e.target.checked;
    document.body.classList.toggle('reduced-motion', state.reducedMotion);
  });

  // --- UTILS --------------------------------------------------------------
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Global ripple listener for Synapse buttons and interactive cards
  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('.btn, .nav-btn, .dept-card, .kanban-task-card, .btn-build-glow, .view-switch-btn');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ui-ripple';
    const size = Math.max(rect.width, rect.height) * 2;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left}px`;
    ripple.style.top = `${e.clientY - rect.top}px`;
    target.style.position = target.style.position || 'relative';
    target.style.overflow = 'hidden';
    target.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  });

  // --- INITIALIZATION -----------------------------------------------------
  fetchStatus().then(() => {
    const initialHash = window.location.hash.replace('#', '') || (new URLSearchParams(window.location.search)).get('view');
    if (initialHash && ['office', 'idea', 'build', 'tasks', 'team', 'projects', 'approvals', 'logs', 'settings'].includes(initialHash)) {
      switchView(initialHash);
    }
  });

  window.addEventListener('hashchange', () => {
    const h = window.location.hash.replace('#', '');
    if (h && state.activeView !== h && ['office', 'idea', 'build', 'tasks', 'team', 'projects', 'approvals', 'logs', 'settings'].includes(h)) {
      switchView(h);
    }
  });

  connectSSE();
  requestAnimationFrame(renderOffice);

  // Poll status periodically to keep budget and git synced
  setInterval(fetchStatus, 6000);

})();
