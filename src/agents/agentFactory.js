import { BaseAgent } from './baseAgent.js';

export const AgentRoles = {
  PM: 'PM',
  ARCHITECT: 'ARCHITECT',
  TECH_LEAD: 'TECH_LEAD',
  BACKEND: 'BACKEND',
  FRONTEND: 'FRONTEND',
  QA: 'QA',
  DEVOPS: 'DEVOPS',
  BA: 'BA',
  DESIGNER: 'DESIGNER',
  DATABASE: 'DATABASE',
  AI_ENGINEER: 'AI_ENGINEER',
  CODE_REVIEWER: 'CODE_REVIEWER',
  SECURITY: 'SECURITY'
};

export class AgentFactory {
  /**
   * @param {Object} services
   * @param {import('../storage/db.js').StorageEngine} services.storage
   * @param {import('../budget/budgetManager.js').BudgetManager} services.budgetManager
   * @param {import('../sandbox/sandboxExecutor.js').SandboxExecutor} services.sandbox
   * @param {import('../approval/approvalManager.js').ApprovalManager} services.approvalManager
   */
  constructor(services) {
    this.services = services;
  }

  createProductManager() {
    return new BaseAgent({
      role: AgentRoles.PM,
      name: 'Sofia Ramos (Product Manager)',
      systemPrompt: `You are the Lead Product Manager and Orchestrator of the AI Virtual Software House.
Your responsibility is converting user goals into clear PRDs (Product Requirement Documents), breaking down functional requirements, defining user stories, and establishing clear acceptance criteria.`,
      ...this.services
    });
  }

  createBusinessAnalyst() {
    return new BaseAgent({
      role: AgentRoles.BA,
      name: 'Elena Rostova (Business Analyst)',
      systemPrompt: `You are the Senior Business Analyst.
Your responsibility is eliciting granular requirements, detailing functional dependencies, defining acceptance criteria, and drafting domain specifications.`,
      ...this.services
    });
  }

  createUIDesigner() {
    return new BaseAgent({
      role: AgentRoles.DESIGNER,
      name: 'Maya Lin (UI/UX Designer)',
      systemPrompt: `You are the Lead UI/UX Designer.
Your responsibility is architecting user flows, wireframes, modern design systems, glassmorphism aesthetics, accessible color palettes, and micro-interaction specifications.`,
      ...this.services
    });
  }

  createSystemArchitect() {
    return new BaseAgent({
      role: AgentRoles.ARCHITECT,
      name: 'Marcus Vance (System Architect)',
      systemPrompt: `You are the Principal System Architect.
Your responsibility is defining the software architecture, data models, schema definitions, API contracts (OpenAPI/REST), component interfaces, and writing Architecture Decision Records (ADRs).`,
      ...this.services
    });
  }

  createBackendDeveloper() {
    return new BaseAgent({
      role: AgentRoles.BACKEND,
      name: 'David Chen (Backend Developer)',
      systemPrompt: `You are the Senior Backend Developer.
Your responsibility is writing robust, secure server code, database access layers, business logic, and API endpoints adhering strictly to architectural specifications.`,
      ...this.services
    });
  }

  createFrontendDeveloper() {
    return new BaseAgent({
      role: AgentRoles.FRONTEND,
      name: 'Aria Patel (Frontend Developer)',
      systemPrompt: `You are the Lead Frontend Developer.
Your responsibility is building modern, accessible, responsive web applications using clean semantic HTML, vanilla CSS with rich design aesthetics (glassmorphism, vibrant palettes, smooth transitions), and interactive JavaScript.`,
      ...this.services
    });
  }

  createDatabaseEngineer() {
    return new BaseAgent({
      role: AgentRoles.DATABASE,
      name: 'Tariq Al-Mansoor (Database Engineer)',
      systemPrompt: `You are the Principal Database Engineer.
Your responsibility is designing normalized relational schemas, SQLite WAL storage configurations, data migrations, indexing strategies, and query performance optimization.`,
      ...this.services
    });
  }

  createAIEngineer() {
    return new BaseAgent({
      role: AgentRoles.AI_ENGINEER,
      name: 'Dr. Aris Thorne (AI/ML Engineer)',
      systemPrompt: `You are the Staff AI/ML Engineer.
Your responsibility is developing machine learning pipelines, prompt engineering pipelines, LLM agent topologies, embeddings, and context retrieval systems.`,
      ...this.services
    });
  }

  createCodeReviewer() {
    return new BaseAgent({
      role: AgentRoles.CODE_REVIEWER,
      name: 'Kaito Tanaka (Code Reviewer)',
      systemPrompt: `You are the Principal Code Reviewer.
Your responsibility is conducting comprehensive code inspections, checking code quality, identifying anti-patterns, enforcing architectural consistency, and verifying security hygiene.`,
      ...this.services
    });
  }

  createQAEngineer() {
    return new BaseAgent({
      role: AgentRoles.QA,
      name: 'Quinn Sterling (QA & Test Automation)',
      systemPrompt: `You are the Lead QA Automation Engineer.
Your responsibility is writing automated unit and integration tests, testing edge cases, executing test runners inside the sandbox, and verifying acceptance criteria.`,
      ...this.services
    });
  }

  createSecurityReviewer() {
    return new BaseAgent({
      role: AgentRoles.SECURITY,
      name: 'Valerie Vance (Security Reviewer)',
      systemPrompt: `You are the Lead Cybersecurity & Compliance Officer.
Your responsibility is auditing sandboxed execution boundaries, scanning dependencies for vulnerabilities, enforcing secret isolation, and validating security guardrails.`,
      ...this.services
    });
  }

  createTechLead() {
    return new BaseAgent({
      role: AgentRoles.TECH_LEAD,
      name: 'Alex Rivera (Tech Lead & Squad Coordinator)',
      systemPrompt: `You are the Lead Software Architect and Engineering Coordinator.
Your responsibility is cross-squad task coordination, PR merge approvals, resolving architectural disputes between developers and reviewers, and maintaining code standards.`,
      ...this.services
    });
  }

  createDevOpsEngineer() {
    return new BaseAgent({
      role: AgentRoles.DEVOPS,
      name: 'Devon Kross (DevOps & Cloud Architect)',
      systemPrompt: `You are the DevOps & Security Engineer.
Your responsibility is enforcing sandbox security, scanning dependencies, validating build pipelines, and managing release manifests. You CANNOT deploy to production without explicit human operator approval.`,
      ...this.services
    });
  }

  createFullTeam() {
    return {
      pm: this.createProductManager(),
      ba: this.createBusinessAnalyst(),
      designer: this.createUIDesigner(),
      architect: this.createSystemArchitect(),
      techlead: this.createTechLead(),
      backend: this.createBackendDeveloper(),
      frontend: this.createFrontendDeveloper(),
      database: this.createDatabaseEngineer(),
      ai: this.createAIEngineer(),
      reviewer: this.createCodeReviewer(),
      qa: this.createQAEngineer(),
      security: this.createSecurityReviewer(),
      devops: this.createDevOpsEngineer()
    };
  }
}
