/**
 * Pulse 2.0 — Glassmorphism Enterprise IDE Frontend Application
 */

const ROSTER_13 = [
  { id: 'lead', name: 'Alex Rivera', role: 'TECH_LEAD', squad: 'ENGINEERING', avatar: 'AR', color: '#0ea5e9' },
  { id: 'pm', name: 'Sofia Ramos', role: 'PM', squad: 'PRODUCT', avatar: 'SR', color: '#38bdf8' },
  { id: 'ba', name: 'Elena Rostova', role: 'BA', squad: 'PRODUCT', avatar: 'ER', color: '#818cf8' },
  { id: 'designer', name: 'Maya Lin', role: 'DESIGNER', squad: 'PRODUCT', avatar: 'ML', color: '#f472b6' },
  { id: 'frontend', name: 'Aria Patel', role: 'FRONTEND', squad: 'ENGINEERING', avatar: 'AP', color: '#a78bfa' },
  { id: 'backend', name: 'David Chen', role: 'BACKEND', squad: 'ENGINEERING', avatar: 'DC', color: '#34d399' },
  { id: 'database', name: 'Tariq Al-Mansoor', role: 'DATABASE', squad: 'ENGINEERING', avatar: 'TA', color: '#fbbf24' },
  { id: 'ai', name: 'Dr. Aris Thorne', role: 'AI_ENGINEER', squad: 'ENGINEERING', avatar: 'AT', color: '#c084fc' },
  { id: 'devops', name: 'Devon Kross', role: 'DEVOPS', squad: 'ENGINEERING', avatar: 'DK', color: '#f97316' },
  { id: 'reviewer', name: 'Kaito Tanaka', role: 'CODE_REVIEWER', squad: 'ASSURANCE', avatar: 'KT', color: '#2dd4bf' },
  { id: 'qa', name: 'Quinn Sterling', role: 'QA', squad: 'ASSURANCE', avatar: 'QS', color: '#fb7185' },
  { id: 'security', name: 'Valerie Vance', role: 'SECURITY', squad: 'ASSURANCE', avatar: 'VV', color: '#e879f9' },
  { id: 'performance', name: 'Marcus Bell', role: 'PERFORMANCE', squad: 'ASSURANCE', avatar: 'MB', color: '#4ade80' }
];

const DAG_STAGES = [
  { id: 'PRD', label: 'Requirements & PRD', agent: 'PM / BA' },
  { id: 'ARCH', label: 'Architecture & Schema', agent: 'Tech Lead / Architect' },
  { id: 'DESIGN', label: 'UI/UX Design Tokens', agent: 'Designer' },
  { id: 'CODE', label: 'Code Synthesis', agent: 'Frontend / Backend' },
  { id: 'REVIEW', label: 'Code Review Gate', agent: 'Code Reviewer' },
  { id: 'QA', label: 'Browser QA & Tests', agent: 'QA Automation' },
  { id: 'DEPLOY', label: 'Release Deployment', agent: 'DevOps Lead' }
];

class PulseV2App {
  constructor() {
    this.projectId = 'proj-default';
    this.init();
  }

  init() {
    this.renderSquads();
    this.renderDAG();
    this.bindEvents();
    this.connectTelemetry();
  }

  renderSquads() {
    const productContainer = document.getElementById('squad-product-agents');
    const engContainer = document.getElementById('squad-engineering-agents');
    const assuranceContainer = document.getElementById('squad-assurance-agents');

    ROSTER_13.forEach(agent => {
      const card = document.createElement('div');
      card.className = 'agent-card';
      card.innerHTML = `
        <div class="agent-info">
          <div class="agent-avatar" style="background: ${agent.color}">${agent.avatar}</div>
          <div>
            <div class="agent-name">${agent.name}</div>
            <div class="agent-role-pill">${agent.role}</div>
          </div>
        </div>
        <span class="agent-status-badge">IDLE</span>
      `;

      if (agent.squad === 'PRODUCT' && productContainer) productContainer.appendChild(card);
      else if (agent.squad === 'ENGINEERING' && engContainer) engContainer.appendChild(card);
      else if (agent.squad === 'ASSURANCE' && assuranceContainer) assuranceContainer.appendChild(card);
    });
  }

  renderDAG() {
    const canvas = document.getElementById('dag-canvas');
    if (!canvas) return;
    canvas.innerHTML = '';

    DAG_STAGES.forEach((stage, idx) => {
      const node = document.createElement('div');
      node.className = `dag-node ${idx === 0 ? 'active' : ''}`;
      node.innerHTML = `
        <div class="dag-node-title">${stage.label}</div>
        <div class="dag-node-agent">${stage.agent}</div>
      `;
      canvas.appendChild(node);
    });
  }

  bindEvents() {
    // Center Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.getAttribute('data-tab');
        const target = document.getElementById(targetId);
        if (target) target.classList.add('active');
      });
    });

    // Right Pane Tab switching
    document.querySelectorAll('.pane-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pane-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.pane-view').forEach(v => v.classList.remove('active'));

        btn.classList.add('active');
        const paneId = btn.getAttribute('data-pane');
        const target = document.getElementById(`${paneId}-container`);
        if (target) target.classList.add('active');
      });
    });

    // Semantic Memory Search
    const searchBtn = document.getElementById('btn-search-memory');
    if (searchBtn) {
      searchBtn.addEventListener('click', () => this.handleMemorySearch());
    }

    // Browser QA Runner
    const qaBtn = document.getElementById('btn-run-qa-suite');
    if (qaBtn) {
      qaBtn.addEventListener('click', () => this.handleBrowserQA());
    }

    // Tamper Audit Verifier
    const auditBtn = document.getElementById('btn-verify-audit-chain');
    if (auditBtn) {
      auditBtn.addEventListener('click', () => this.handleAuditVerification());
    }
  }

  async handleMemorySearch() {
    const input = document.getElementById('memory-query-input');
    const query = input?.value?.trim();
    if (!query) return;

    const container = document.getElementById('memory-results-container');
    container.innerHTML = '<p class="placeholder-text">Searching organizational knowledge embeddings...</p>';

    try {
      const res = await fetch('/api/v2/memory/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 5 })
      });
      const data = await res.json();
      if (!data.results || data.results.length === 0) {
        container.innerHTML = '<p class="placeholder-text">No matching memories found for this query.</p>';
        return;
      }

      container.innerHTML = data.results.map(m => `
        <div class="chat-bubble" style="margin-bottom: 8px;">
          <strong>[${m.memoryType}] ${m.title}</strong> (Score: ${(m.similarityScore * 100).toFixed(0)}%)
          <p style="margin-top: 4px; font-size: 0.8rem; color: #94a3b8;">${m.content}</p>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p class="placeholder-text" style="color: #f43f5e;">Search error: ${err.message}</p>`;
    }
  }

  async handleBrowserQA() {
    const stepList = document.getElementById('qa-step-items');
    stepList.innerHTML = '<li>Executing autonomous interaction steps in headless sandbox...</li>';

    try {
      const res = await fetch(`/api/v2/projects/${this.projectId}/qa/browser-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: `${window.location.origin}/`,
          steps: [
            { action: 'NAVIGATE' },
            { action: 'ASSERT_ELEMENT', targetSelector: 'body' },
            { action: 'SCREENSHOT' },
            { action: 'A11Y_AUDIT' }
          ]
        })
      });
      const data = await res.json();

      stepList.innerHTML = data.steps.map(s => `
        <li style="color: ${s.status === 'PASSED' ? '#10b981' : '#f43f5e'};">
          ✔ Step #${s.stepIndex} [${s.action}] — ${s.status} (${s.durationMs}ms)
        </li>
      `).join('');

      const gauge = document.getElementById('a11y-score-display');
      if (gauge) gauge.textContent = data.passed ? '100/100 (PASSED)' : 'DEGRADED';
    } catch (err) {
      stepList.innerHTML = `<li style="color: #f43f5e;">Browser QA execution error: ${err.message}</li>`;
    }
  }

  async handleAuditVerification() {
    const badge = document.getElementById('audit-verification-badge');
    badge.className = 'badge-neutral';
    badge.textContent = 'Verifying SHA-256 Hash Chain...';

    try {
      const res = await fetch('/api/v2/security/audit-chain/verify');
      const data = await res.json();
      if (data.valid) {
        badge.className = 'agent-status-badge';
        badge.textContent = `✔ Unbroken Hash Chain (${data.totalEntries} entries verified)`;
      } else {
        badge.className = 'glow-button warning';
        badge.textContent = `✖ Tampering Detected at Sequence #${data.brokenAtSequence}`;
      }
    } catch (err) {
      badge.textContent = `Error: ${err.message}`;
    }
  }

  connectTelemetry() {
    // SSE fallback or live stream
    const evtSource = new EventSource('/api/stream');
    evtSource.onmessage = (event) => {
      // Stream updates into real-time diff or status
    };
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new PulseV2App();
});

