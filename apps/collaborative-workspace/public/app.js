/**
 * PULSE — Real-Time Collaborative Workspace
 * Reactive Client State · Native EventSource SSE · Optimistic Drag & Drop
 */

// ── Application Reactive State ──────────────────────────────────────────
const state = {
  users: [],
  channels: [],
  activeChannelId: 'c-engineering',
  messages: {},        // channelId -> Array<Message>
  tasks: [],
  stats: {},
  activeUser: null,
  currentView: 'chat',
  sseConnected: false,
  typingTimeout: null,
  soundEnabled: localStorage.getItem('pulse_sound_enabled') !== 'false'
};

// ── DOM Element Cache ───────────────────────────────────────────────────
const DOM = {
  // Telemetry
  sseIndicator: document.getElementById('sse-indicator'),
  sseStatus: document.getElementById('sse-status'),
  statOnlineUsers: document.getElementById('stat-online-users'),
  statTasksDone: document.getElementById('stat-tasks-done'),
  statTotalMessages: document.getElementById('stat-total-messages'),

  // User Selector & Controls
  dropdownBtn: document.getElementById('user-dropdown-btn'),
  dropdownMenu: document.getElementById('user-dropdown-menu'),
  currentUserAvatar: document.getElementById('current-user-avatar'),
  currentUserName: document.getElementById('current-user-name'),
  currentUserStatus: document.getElementById('current-user-status'),
  btnToggleSound: document.getElementById('btn-toggle-sound'),
  soundIcon: document.getElementById('sound-icon'),

  // Navigation
  channelList: document.getElementById('channel-list'),
  teamList: document.getElementById('team-list'),
  teamOnlineCount: document.getElementById('team-online-count'),
  viewNavBtns: document.querySelectorAll('.view-nav-btn'),
  viewPanels: document.querySelectorAll('.view-panel'),
  badgeKanbanCount: document.getElementById('badge-kanban-count'),

  // Chat View
  activeChannelIcon: document.getElementById('active-channel-icon'),
  activeChannelName: document.getElementById('active-channel-name'),
  activeChannelTopic: document.getElementById('active-channel-topic'),
  chatSearch: document.getElementById('chat-search'),
  chatScroll: document.getElementById('chat-messages-scroll'),
  messagesContainer: document.getElementById('messages-container'),
  typingIndicatorBar: document.getElementById('typing-indicator-bar'),
  typingText: document.getElementById('typing-text'),
  messageInput: document.getElementById('message-input'),
  btnSendMessage: document.getElementById('btn-send-message'),
  btnInsertCode: document.getElementById('btn-insert-code'),
  btnInsertRocket: document.getElementById('btn-insert-rocket'),
  btnInsertFire: document.getElementById('btn-insert-fire'),
  btnInsertCheck: document.getElementById('btn-insert-check'),

  // Kanban View
  kanbanDropzones: {
    backlog: document.getElementById('dropzone-backlog'),
    in_progress: document.getElementById('dropzone-in_progress'),
    review: document.getElementById('dropzone-review'),
    done: document.getElementById('dropzone-done')
  },
  kanbanCounts: {
    backlog: document.getElementById('count-backlog'),
    in_progress: document.getElementById('count-in_progress'),
    review: document.getElementById('count-review'),
    done: document.getElementById('count-done')
  },
  btnQuickAddTask: document.getElementById('btn-quick-add-task'),

  // Activity View
  activityTimeline: document.getElementById('activity-timeline'),
  btnRefreshActivity: document.getElementById('btn-refresh-activity'),

  // Modals
  modalTaskBackdrop: document.getElementById('modal-task-backdrop'),
  btnOpenTaskModal: document.getElementById('btn-open-task-modal'),
  btnCloseTaskModal: document.getElementById('btn-close-task-modal'),
  btnCancelTask: document.getElementById('btn-cancel-task'),
  formCreateTask: document.getElementById('form-create-task'),
  taskAssigneeSelect: document.getElementById('task-assignee-select'),

  modalChannelBackdrop: document.getElementById('modal-channel-backdrop'),
  btnAddChannel: document.getElementById('btn-add-channel'),
  btnCloseChannelModal: document.getElementById('btn-close-channel-modal'),
  btnCancelChannel: document.getElementById('btn-cancel-channel'),
  formCreateChannel: document.getElementById('form-create-channel')
};

// ── Initialization & Hydration ──────────────────────────────────────────
async function init() {
  setupEventListeners();
  await loadBootstrapData();
  connectSSE();
}

async function loadBootstrapData() {
  try {
    const res = await fetch('/api/bootstrap');
    if (!res.ok) throw new Error('Bootstrap failed');
    const data = await res.json();

    state.users = data.users || [];
    state.channels = data.channels || [];
    state.tasks = data.tasks || [];
    state.stats = data.stats || {};

    // Select default active persona (Sofia or first user)
    state.activeUser = state.users.find(u => u.id === 'usr-sofia') || state.users[0];

    renderHeader();
    renderUserDropdown();
    renderChannels();
    renderTeam();
    renderKanban();
    renderActivity(data.recentActivity || []);

    // Load active channel messages
    await switchChannel(state.activeChannelId);
  } catch (err) {
    console.error('[Init] Error loading workspace data:', err);
  }
}

// ── Real-Time Server-Sent Events (SSE) & Audio ──────────────────────────
let sharedAudioCtx = null;
function getAudioContext() {
  if (!state.soundEnabled) return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function playNotificationChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  } catch (_) {}
}

function playPopSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(160, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch (_) {}
}

function playCelebrationArpeggio() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.065);
      gain.gain.setValueAtTime(0.045, ctx.currentTime + idx * 0.065);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.065 + 0.26);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.065);
      osc.stop(ctx.currentTime + idx * 0.065 + 0.28);
    });
  } catch (_) {}
}

function createSparkleBurst(x, y, emoji = '✨') {
  if (!x || !y) return;
  const count = 4;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'sparkle-particle';
    el.textContent = emoji;
    const tx = (Math.random() - 0.5) * 80;
    const ty = -30 - Math.random() * 50;
    const rot = (Math.random() - 0.5) * 80;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.setProperty('--tx', `${tx}px`);
    el.style.setProperty('--ty', `${ty}px`);
    el.style.setProperty('--rot', `${rot}deg`);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }
}

function createConfettiBurst(x, y) {
  if (!x || !y) return;
  const colors = ['#6366f1', '#38bdf8', '#10b981', '#f59e0b', '#ec4899', '#a855f7', '#ffffff'];
  const count = 22;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = 6 + Math.random() * 6;
    const radius = Math.random() > 0.4 ? '50%' : '2px';
    const tx = (Math.random() - 0.5) * 160;
    const ty = -60 - Math.random() * 90;
    const rot = (Math.random() - 0.5) * 720;

    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.setProperty('--c-color', color);
    p.style.setProperty('--c-size', `${size}px`);
    p.style.setProperty('--c-radius', radius);
    p.style.setProperty('--tx', `${tx}px`);
    p.style.setProperty('--ty', `${ty}px`);
    p.style.setProperty('--rot', `${rot}deg`);

    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1200);
  }
}

function createRipple(e) {
  const target = e.target.closest('.btn, .tool-btn, .view-nav-btn, .reaction-pill, .quick-rx-btn, .channel-item, .user-option-btn, .user-select-box');
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'ui-ripple';
  const size = Math.max(rect.width, rect.height) * 2;
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${e.clientX - rect.left}px`;
  ripple.style.top = `${e.clientY - rect.top}px`;
  target.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
}

function animateNumber(element, targetNum, suffix = '') {
  if (!element) return;
  const currentStr = element.textContent.replace(/[^\d]/g, '');
  const start = parseInt(currentStr, 10) || 0;
  const end = parseInt(targetNum, 10) || 0;
  if (start === end) {
    element.textContent = `${end}${suffix}`;
    return;
  }

  element.classList.remove('counter-animate');
  void element.offsetWidth; // Force CSS reflow
  element.classList.add('counter-animate');

  const duration = 400;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeProgress = 1 - Math.pow(1 - progress, 3); // Ease out cubic
    const value = Math.round(start + (end - start) * easeProgress);
    element.textContent = `${value}${suffix}`;
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.textContent = `${end}${suffix}`;
    }
  }
  requestAnimationFrame(update);
}

// Global mouse tracker for ambient radial spotlight
let globalMouseThrottle = false;
document.addEventListener('mousemove', (e) => {
  if (globalMouseThrottle) return;
  globalMouseThrottle = true;
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--global-mouse-x', `${e.clientX}px`);
    document.documentElement.style.setProperty('--global-mouse-y', `${e.clientY}px`);
    globalMouseThrottle = false;
  });
});

// Global click ripple listener
document.addEventListener('pointerdown', createRipple);

function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  let wasDisconnected = false;

  eventSource.onopen = () => {
    DOM.sseStatus.textContent = 'ONLINE (LIVE)';
    DOM.sseIndicator.querySelector('.pulse-dot').style.background = 'var(--emerald)';
    if (wasDisconnected) {
      // Reconcile and resync any events missed during disconnection
      loadBootstrapData().catch(() => {});
      wasDisconnected = false;
    }
    state.sseConnected = true;
  };

  eventSource.onerror = () => {
    state.sseConnected = false;
    wasDisconnected = true;
    DOM.sseStatus.textContent = 'RECONNECTING...';
    DOM.sseIndicator.querySelector('.pulse-dot').style.background = 'var(--amber)';
  };

  // Event Handlers
  eventSource.addEventListener('MESSAGE_NEW', (e) => {
    const message = JSON.parse(e.data);
    handleIncomingMessage(message);
    if (message.user_id !== state.activeUser?.id) {
      playNotificationChime();
    }
  });

  eventSource.addEventListener('REACTION_UPDATED', (e) => {
    const update = JSON.parse(e.data);
    handleReactionUpdated(update);
  });

  eventSource.addEventListener('TYPING_INDICATOR', (e) => {
    const data = JSON.parse(e.data);
    handleTypingIndicator(data);
  });

  eventSource.addEventListener('TASK_CREATED', (e) => {
    const task = JSON.parse(e.data);
    state.tasks.unshift(task);
    renderKanban();
    updateStatsBar();
  });

  eventSource.addEventListener('TASK_MOVED', (e) => {
    const updated = JSON.parse(e.data);
    const idx = state.tasks.findIndex(t => t.id === updated.id);
    if (idx !== -1) state.tasks[idx] = updated;
    renderKanban();
    updateStatsBar();
  });

  eventSource.addEventListener('TASK_DELETED', (e) => {
    const { id } = JSON.parse(e.data);
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderKanban();
    updateStatsBar();
  });

  eventSource.addEventListener('USER_STATUS_CHANGED', (e) => {
    const updatedUser = JSON.parse(e.data);
    const idx = state.users.findIndex(u => u.id === updatedUser.id);
    if (idx !== -1) state.users[idx] = updatedUser;
    if (state.activeUser?.id === updatedUser.id) {
      state.activeUser = updatedUser;
      renderHeader();
    }
    renderTeam();
  });

  eventSource.addEventListener('CHANNEL_CREATED', (e) => {
    const ch = JSON.parse(e.data);
    if (!state.channels.some(c => c.id === ch.id)) {
      state.channels.push(ch);
      renderChannels();
    }
  });
}

// ── Rendering Functions ─────────────────────────────────────────────────
function renderHeader() {
  if (!state.activeUser) return;
  DOM.currentUserAvatar.textContent = state.activeUser.avatar;
  DOM.currentUserName.textContent = state.activeUser.name;
  DOM.currentUserStatus.textContent = `● ${capitalize(state.activeUser.status)}`;
  DOM.currentUserStatus.className = `user-status-pill status-${state.activeUser.status}`;

  updateStatsBar();
}

function updateStatsBar() {
  const onlineCount = state.users.filter(u => u.status === 'online').length;
  animateNumber(DOM.statOnlineUsers, onlineCount);

  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.stage === 'done').length;
  const rate = total > 0 ? Math.round((done / total) * 100) : 0;
  animateNumber(DOM.statTasksDone, rate, '%');

  let totalMsgs = 0;
  for (const list of Object.values(state.messages)) totalMsgs += list.length;
  animateNumber(DOM.statTotalMessages, totalMsgs || state.stats.totalMessages || 0);
  animateNumber(DOM.badgeKanbanCount, total);
}

function renderUserDropdown() {
  DOM.dropdownMenu.innerHTML = state.users.map(u => `
    <button class="user-option-btn ${u.id === state.activeUser?.id ? 'active' : ''}" data-user-id="${u.id}">
      <span class="user-avatar">${u.avatar}</span>
      <div class="user-option-info">
        <span class="user-option-name">${escapeHtml(u.name)}</span>
        <span class="user-option-role">${escapeHtml(u.role)}</span>
      </div>
    </button>
  `).join('');

  // Assignee options for task modal
  DOM.taskAssigneeSelect.innerHTML = state.users.map(u => `
    <option value="${u.id}">${u.avatar} ${escapeHtml(u.name)} (${escapeHtml(u.role)})</option>
  `).join('');
}

function renderChannels() {
  DOM.channelList.innerHTML = state.channels.map(c => `
    <li class="channel-item ${c.id === state.activeChannelId ? 'active' : ''}" data-channel-id="${c.id}">
      <div class="channel-name-wrap">
        <span class="channel-icon">${c.icon}</span>
        <span class="channel-name">${escapeHtml(c.name)}</span>
      </div>
      <span class="channel-badge">${c.messageCount || 0}</span>
    </li>
  `).join('');
}

function renderTeam() {
  const onlineCount = state.users.filter(u => u.status === 'online').length;
  DOM.teamOnlineCount.textContent = onlineCount;

  DOM.teamList.innerHTML = state.users.map(u => `
    <li class="team-member">
      <div class="member-avatar-wrap">
        <span>${u.avatar}</span>
        <span class="member-status-dot status-${u.status}"></span>
      </div>
      <div class="member-info">
        <span class="member-name">${escapeHtml(u.name)}</span>
        <span class="member-role">${escapeHtml(u.role)}</span>
      </div>
    </li>
  `).join('');
}

async function switchChannel(channelId) {
  state.activeChannelId = channelId;
  const channel = state.channels.find(c => c.id === channelId);
  if (!channel) return;

  DOM.activeChannelIcon.textContent = channel.icon;
  DOM.activeChannelName.textContent = channel.name;
  DOM.activeChannelTopic.textContent = channel.topic;
  DOM.messageInput.placeholder = `Message #${channel.name}... (Press Enter to send)`;

  renderChannels();

  // Load channel messages if not cached
  try {
    const res = await fetch(`/api/channels/${channelId}/messages`);
    const msgs = await res.json();
    state.messages[channelId] = msgs;
    renderMessages(msgs);
    scrollToBottom();
  } catch (err) {
    console.error('Error fetching messages:', err);
  }
}

function renderMessages(messages) {
  DOM.messagesContainer.innerHTML = messages.map(m => renderMessageItem(m)).join('');
}

function renderMessageItem(m) {
  const timeFormatted = formatTime(m.created_at);
  const formattedContent = formatMessageContent(m.content);

  const reactionsHtml = (m.reactions || []).map(r => {
    const reactedByMe = r.users?.includes(state.activeUser?.id);
    return `
      <button class="reaction-pill ${reactedByMe ? 'reacted' : ''}" data-msg-id="${m.id}" data-emoji="${r.emoji}">
        <span>${r.emoji}</span>
        <span class="reaction-count">${r.count}</span>
      </button>
    `;
  }).join('');

  return `
    <div class="message-item" id="msg-el-${m.id}" data-id="${m.id}">
      <div class="msg-avatar" style="border-color: ${m.user_color || 'var(--sky)'}">
        ${m.user_avatar || '👤'}
      </div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-author">${escapeHtml(m.user_name || 'Member')}</span>
          <span class="msg-role-tag">${escapeHtml(m.user_role || 'Developer')}</span>
          <span class="msg-time">${timeFormatted}</span>
        </div>
        <div class="msg-content">${formattedContent}</div>
        <div class="msg-reactions">${reactionsHtml}</div>
      </div>
      <div class="msg-hover-actions">
        <button class="quick-rx-btn" data-msg-id="${m.id}" data-emoji="👍">👍</button>
        <button class="quick-rx-btn" data-msg-id="${m.id}" data-emoji="❤️">❤️</button>
        <button class="quick-rx-btn" data-msg-id="${m.id}" data-emoji="🚀">🚀</button>
        <button class="quick-rx-btn" data-msg-id="${m.id}" data-emoji="🔥">🔥</button>
        <button class="quick-rx-btn" data-msg-id="${m.id}" data-emoji="👀">👀</button>
      </div>
    </div>
  `;
}

function handleIncomingMessage(msg) {
  if (!state.messages[msg.channel_id]) state.messages[msg.channel_id] = [];
  state.messages[msg.channel_id].push(msg);

  if (msg.channel_id === state.activeChannelId) {
    const div = document.createElement('div');
    div.innerHTML = renderMessageItem(msg);
    const item = div.firstElementChild;
    DOM.messagesContainer.appendChild(item);
    scrollToBottom();
  } else {
    // Increment channel badge
    const ch = state.channels.find(c => c.id === msg.channel_id);
    if (ch) ch.messageCount = (ch.messageCount || 0) + 1;
    renderChannels();
  }

  updateStatsBar();
}

function handleReactionUpdated({ messageId, emoji, action, userId }) {
  // Update in cached messages
  for (const channelId in state.messages) {
    const msg = state.messages[channelId].find(m => m.id === messageId);
    if (msg) {
      if (!msg.reactions) msg.reactions = [];
      let rx = msg.reactions.find(r => r.emoji === emoji);
      if (action === 'ADDED') {
        if (!rx) {
          rx = { emoji, count: 1, users: [userId] };
          msg.reactions.push(rx);
        } else {
          rx.count++;
          if (!rx.users.includes(userId)) rx.users.push(userId);
        }
      } else if (action === 'REMOVED' && rx) {
        rx.count--;
        rx.users = rx.users.filter(u => u !== userId);
        if (rx.count <= 0) {
          msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
        }
      }
      if (channelId === state.activeChannelId) {
        const msgEl = document.getElementById(`msg-el-${messageId}`);
        if (msgEl) {
          const rxContainer = msgEl.querySelector('.msg-reactions');
          if (rxContainer) {
            rxContainer.innerHTML = msg.reactions.map(r => {
              const reactedByMe = r.users?.includes(state.activeUser?.id);
              return `
                <button class="reaction-pill ${reactedByMe ? 'reacted' : ''}" data-msg-id="${msg.id}" data-emoji="${r.emoji}">
                  <span>${r.emoji}</span>
                  <span class="reaction-count">${r.count}</span>
                </button>
              `;
            }).join('');
          }
        }
      }
      break;
    }
  }
}

function handleTypingIndicator(data) {
  if (data.channelId !== state.activeChannelId || data.userId === state.activeUser?.id) return;

  DOM.typingText.textContent = `${data.userName} is typing...`;
  DOM.typingIndicatorBar.classList.add('active');

  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    DOM.typingIndicatorBar.classList.remove('active');
  }, 2500);
}

// ── Kanban Board Rendering & Drag & Drop ────────────────────────────────
function renderKanban() {
  const stages = ['backlog', 'in_progress', 'review', 'done'];

  stages.forEach(stage => {
    const filtered = state.tasks.filter(t => t.stage === stage);
    DOM.kanbanCounts[stage].textContent = filtered.length;
    DOM.kanbanDropzones[stage].innerHTML = filtered.map(t => renderTaskCard(t)).join('');
  });

  setupKanbanDragAndDrop();
}

function renderTaskCard(t) {
  const stages = ['backlog', 'in_progress', 'review', 'done'];
  const curIdx = stages.indexOf(t.stage);
  const prevStage = curIdx > 0 ? stages[curIdx - 1] : null;
  const nextStage = curIdx < stages.length - 1 ? stages[curIdx + 1] : null;

  const tagsHtml = (t.tags || '').split(',').map(tag => tag.trim()).filter(Boolean)
    .map(tag => `<span class="tag-pill">#${escapeHtml(tag)}</span>`).join('');

  return `
    <div class="task-card" draggable="true" data-task-id="${t.id}" data-stage="${t.stage}">
      <div class="task-card-top">
        <span class="priority-badge priority-${t.priority}">${t.priority}</span>
        <div class="task-stage-nav">
          ${prevStage ? `<button class="stage-move-btn" data-task-id="${t.id}" data-next-stage="${prevStage}" title="Move left">←</button>` : ''}
          ${nextStage ? `<button class="stage-move-btn" data-task-id="${t.id}" data-next-stage="${nextStage}" title="Move right">→</button>` : ''}
          <button class="task-delete-btn" data-task-id="${t.id}" title="Delete task">✕</button>
        </div>
      </div>
      <h4 class="task-title">${escapeHtml(t.title)}</h4>
      ${t.description ? `<p class="task-desc">${escapeHtml(t.description)}</p>` : ''}
      <div class="task-footer">
        <div class="task-tags">${tagsHtml}</div>
        <div class="task-assignee" title="${escapeHtml(t.assignee_name || 'Unassigned')}">
          <span class="assignee-avatar">${t.assignee_avatar || '👤'}</span>
          <span>${escapeHtml(t.assignee_name ? t.assignee_name.split(' ')[0] : 'Open')}</span>
        </div>
      </div>
    </div>
  `;
}

function setupKanbanDragAndDrop() {
  const cards = document.querySelectorAll('.task-card');
  const dropzones = document.querySelectorAll('.kanban-dropzone');

  cards.forEach(card => {
    // 3D Perspective Tilt on Mouse Movement
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -6;
      const rotateY = ((x - centerX) / centerX) * 6;
      card.style.setProperty('--tilt-x', `${rotateX.toFixed(2)}deg`);
      card.style.setProperty('--tilt-y', `${rotateY.toFixed(2)}deg`);
      card.style.setProperty('--card-mouse-x', `${x}px`);
      card.style.setProperty('--card-mouse-y', `${y}px`);
    });

    card.addEventListener('mouseleave', () => {
      card.style.setProperty('--tilt-x', '0deg');
      card.style.setProperty('--tilt-y', '0deg');
    });

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.taskId);
      card.classList.add('is-dragging');
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      card.style.setProperty('--tilt-x', '0deg');
      card.style.setProperty('--tilt-y', '0deg');
    });
  });

  dropzones.forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/plain');
      const targetStage = zone.closest('.kanban-column').dataset.stage;

      if (taskId && targetStage) {
        await moveTask(taskId, targetStage);
      }
    });
  });
}

async function moveTask(taskId, nextStage) {
  // Optimistic UI update
  const task = state.tasks.find(t => t.id === taskId);
  if (task) {
    task.stage = nextStage;
    renderKanban();

    if (nextStage === 'done') {
      const cardEl = document.querySelector(`[data-task-id="${taskId}"]`);
      if (cardEl) {
        cardEl.classList.add('task-celebration-flash');
        const rect = cardEl.getBoundingClientRect();
        createSparkleBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, '🎉');
        createSparkleBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, '✨');
        createConfettiBurst(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
      playCelebrationArpeggio();
    } else {
      playNotificationChime();
    }
  }

  try {
    const res = await fetch(`/api/tasks/${taskId}/stage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: nextStage, userId: state.activeUser?.id })
    });
    if (!res.ok) throw new Error('Failed to update stage');
  } catch (err) {
    console.error('Error moving task:', err);
    loadBootstrapData(); // Rollback to server state
  }
}

// ── Activity Timeline ──────────────────────────────────────────────────
function renderActivity(logs) {
  DOM.activityTimeline.innerHTML = logs.map(log => `
    <div class="activity-item">
      <span class="act-badge act-type-${log.type}">${log.type}</span>
      <span class="act-desc">${escapeHtml(log.description)}</span>
      <span class="act-time">${formatTime(log.created_at)}</span>
    </div>
  `).join('');
}

async function refreshActivity() {
  try {
    const res = await fetch('/api/activity');
    const logs = await res.json();
    renderActivity(logs);
  } catch (err) {
    console.error('Error loading activity logs:', err);
  }
}

// ── Event Handlers & User Actions ───────────────────────────────────────
function setupEventListeners() {
  // User switcher
  DOM.dropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    DOM.dropdownMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', () => {
    DOM.dropdownMenu.classList.add('hidden');
  });

  DOM.dropdownMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('.user-option-btn');
    if (!btn) return;
    const userId = btn.dataset.userId;
    state.activeUser = state.users.find(u => u.id === userId);
    renderHeader();
    renderUserDropdown();
  });

  // Channel switching
  DOM.channelList.addEventListener('click', (e) => {
    const item = e.target.closest('.channel-item');
    if (!item) return;
    switchChannel(item.dataset.channelId);
  });

  // View Navigation
  DOM.viewNavBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      DOM.viewNavBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      DOM.viewPanels.forEach(p => p.classList.remove('active'));
      document.getElementById(`view-${view}`).classList.add('active');
      state.currentView = view;

      if (view === 'activity') refreshActivity();
    });
  });

  // User presence status cycling (online -> busy -> away -> offline -> online)
  if (DOM.currentUserStatus) {
    DOM.currentUserStatus.style.cursor = 'pointer';
    DOM.currentUserStatus.title = 'Click to toggle status (Online, Busy, Away, Offline)';
    DOM.currentUserStatus.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!state.activeUser) return;
      const statusCycle = ['online', 'busy', 'away', 'offline'];
      const curIdx = statusCycle.indexOf(state.activeUser.status);
      const nextStatus = statusCycle[(curIdx + 1) % statusCycle.length];

      state.activeUser.status = nextStatus;
      renderHeader();
      renderTeam();

      try {
        await fetch(`/api/users/${state.activeUser.id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus })
        });
      } catch (err) {
        console.warn('Failed to update user status:', err);
      }
    });
  }

  // Chat message send
  DOM.btnSendMessage.addEventListener('click', sendMessage);
  DOM.messageInput.addEventListener('input', () => notifyTyping());
  DOM.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else {
      notifyTyping();
    }
  });

  // Helper buttons
  DOM.btnInsertCode.addEventListener('click', (e) => {
    insertTextAtCursor('```javascript\n// write code here\n```\n');
    playPopSound();
  });
  DOM.btnInsertRocket.addEventListener('click', (e) => {
    insertTextAtCursor(' 🚀 ');
    playPopSound();
    const rect = DOM.btnInsertRocket.getBoundingClientRect();
    createSparkleBurst(rect.left + rect.width / 2, rect.top, '🚀');
  });
  DOM.btnInsertFire.addEventListener('click', (e) => {
    insertTextAtCursor(' 🔥 ');
    playPopSound();
    const rect = DOM.btnInsertFire.getBoundingClientRect();
    createSparkleBurst(rect.left + rect.width / 2, rect.top, '🔥');
  });
  DOM.btnInsertCheck.addEventListener('click', (e) => {
    insertTextAtCursor(' ✅ ');
    playPopSound();
    const rect = DOM.btnInsertCheck.getBoundingClientRect();
    createSparkleBurst(rect.left + rect.width / 2, rect.top, '✅');
  });

  // Sound Toggle Control
  if (DOM.btnToggleSound) {
    const updateSoundIcon = () => {
      DOM.soundIcon.textContent = state.soundEnabled ? '🔊' : '🔇';
      DOM.btnToggleSound.classList.toggle('muted', !state.soundEnabled);
      DOM.btnToggleSound.title = state.soundEnabled ? 'Audio enabled (click to mute)' : 'Audio muted (click to unmute)';
    };
    updateSoundIcon();
    DOM.btnToggleSound.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      localStorage.setItem('pulse_sound_enabled', state.soundEnabled ? 'true' : 'false');
      updateSoundIcon();
      if (state.soundEnabled) playPopSound();
    });
  }

  // Search filter across chat and Kanban tasks
  DOM.chatSearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const msgItems = DOM.messagesContainer.querySelectorAll('.message-item');
    msgItems.forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(query) ? 'flex' : 'none';
    });

    const taskCards = document.querySelectorAll('.task-card');
    taskCards.forEach(card => {
      const text = card.textContent.toLowerCase();
      card.style.display = text.includes(query) ? 'block' : 'none';
    });
  });

  // Message Reactions, Stage Moves, and Task Deletion (delegated)
  document.addEventListener('click', async (e) => {
    // Reaction pill
    const rxBtn = e.target.closest('.reaction-pill') || e.target.closest('.quick-rx-btn');
    if (rxBtn) {
      const msgId = rxBtn.dataset.msgId;
      const emoji = rxBtn.dataset.emoji;

      rxBtn.classList.add('just-clicked');
      setTimeout(() => rxBtn.classList.remove('just-clicked'), 400);

      const rect = rxBtn.getBoundingClientRect();
      createSparkleBurst(rect.left + rect.width / 2, rect.top, emoji);
      playPopSound();

      await toggleReaction(msgId, emoji);
      return;
    }

    // Stage move button in Kanban
    const moveBtn = e.target.closest('.stage-move-btn');
    if (moveBtn) {
      const taskId = moveBtn.dataset.taskId;
      const nextStage = moveBtn.dataset.nextStage;
      await moveTask(taskId, nextStage);
      return;
    }

    // Task delete button
    const delBtn = e.target.closest('.task-delete-btn');
    if (delBtn) {
      const taskId = delBtn.dataset.taskId;
      if (confirm('Delete this task?')) {
        await deleteTask(taskId);
      }
      return;
    }
  });

  // Keyboard accessibility: Escape key closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTaskModal();
      closeChannelModal();
    }
  });

  // Backdrop click to close modals
  DOM.modalTaskBackdrop.addEventListener('click', (e) => {
    if (e.target === DOM.modalTaskBackdrop) closeTaskModal();
  });
  DOM.modalChannelBackdrop.addEventListener('click', (e) => {
    if (e.target === DOM.modalChannelBackdrop) closeChannelModal();
  });

  // Task Modal Handlers
  const openTaskModal = () => DOM.modalTaskBackdrop.classList.remove('hidden');
  const closeTaskModal = () => DOM.modalTaskBackdrop.classList.add('hidden');

  DOM.btnOpenTaskModal.addEventListener('click', openTaskModal);
  DOM.btnQuickAddTask.addEventListener('click', openTaskModal);
  DOM.btnCloseTaskModal.addEventListener('click', closeTaskModal);
  DOM.btnCancelTask.addEventListener('click', closeTaskModal);

  DOM.formCreateTask.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('task-title-input').value;
    const description = document.getElementById('task-desc-input').value;
    const stage = document.getElementById('task-stage-select').value;
    const priority = document.getElementById('task-priority-select').value;
    const assignedTo = DOM.taskAssigneeSelect.value;
    const tags = document.getElementById('task-tags-input').value;

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, stage, priority, assignedTo, tags, creatorId: state.activeUser?.id })
      });
      if (!res.ok) throw new Error('Create task failed');
      DOM.formCreateTask.reset();
      closeTaskModal();
    } catch (err) {
      alert('Error creating task: ' + err.message);
    }
  });

  // Channel Modal Handlers
  const openChannelModal = () => DOM.modalChannelBackdrop.classList.remove('hidden');
  const closeChannelModal = () => DOM.modalChannelBackdrop.classList.add('hidden');

  DOM.btnAddChannel.addEventListener('click', openChannelModal);
  DOM.btnCloseChannelModal.addEventListener('click', closeChannelModal);
  DOM.btnCancelChannel.addEventListener('click', closeChannelModal);

  DOM.formCreateChannel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('channel-name-input').value;
    const topic = document.getElementById('channel-topic-input').value;
    const icon = document.getElementById('channel-icon-select').value;

    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, topic, icon, creatorId: state.activeUser?.id })
      });
      if (!res.ok) throw new Error('Create channel failed');
      const ch = await res.json();
      DOM.formCreateChannel.reset();
      closeChannelModal();
      switchChannel(ch.id);
    } catch (err) {
      alert('Error creating channel: ' + err.message);
    }
  });

  DOM.btnRefreshActivity.addEventListener('click', refreshActivity);
}

// ── Action Functions ────────────────────────────────────────────────────
async function sendMessage() {
  const content = DOM.messageInput.value.trim();
  if (!content) return;

  DOM.messageInput.value = '';
  playPopSound();

  if (content.includes('🚀')) {
    const rect = DOM.btnSendMessage.getBoundingClientRect();
    createSparkleBurst(rect.left + rect.width / 2, rect.top, '🚀');
  } else if (content.includes('🔥')) {
    const rect = DOM.btnSendMessage.getBoundingClientRect();
    createSparkleBurst(rect.left + rect.width / 2, rect.top, '🔥');
  } else if (content.includes('🎉') || content.includes('✨')) {
    const rect = DOM.btnSendMessage.getBoundingClientRect();
    createConfettiBurst(rect.left + rect.width / 2, rect.top);
  }

  try {
    const res = await fetch(`/api/channels/${state.activeChannelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.activeUser?.id || 'usr-sofia',
        content
      })
    });
    if (!res.ok) throw new Error('Send failed');
  } catch (err) {
    console.error('Error sending message:', err);
  }
}

async function toggleReaction(messageId, emoji) {
  try {
    await fetch(`/api/messages/${messageId}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.activeUser?.id || 'usr-sofia',
        emoji
      })
    });
  } catch (err) {
    console.error('Error toggling reaction:', err);
  }
}

let lastTypingSent = 0;
function notifyTyping() {
  const now = Date.now();
  if (now - lastTypingSent > 2000) {
    lastTypingSent = now;
    fetch(`/api/channels/${state.activeChannelId}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.activeUser?.id,
        userName: state.activeUser?.name
      })
    }).catch(() => {});
  }
}

// ── Utilities ───────────────────────────────────────────────────────────
function scrollToBottom() {
  DOM.chatScroll.scrollTop = DOM.chatScroll.scrollHeight;
}

function insertTextAtCursor(text) {
  const input = DOM.messageInput;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.substring(0, start) + text + input.value.substring(end);
  input.focus();
  input.selectionStart = input.selectionEnd = start + text.length;
}

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

async function deleteTask(taskId) {
  // Optimistic UI update
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  renderKanban();
  updateStatsBar();
  playPopSound();

  try {
    const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete task failed');
  } catch (err) {
    console.error('Error deleting task:', err);
    loadBootstrapData(); // Rollback if server rejects
  }
}

function formatMessageContent(content) {
  let escaped = escapeHtml(content);

  // Code blocks: ```language\ncode\n```
  escaped = escaped.replace(/```([\s\S]*?)```/g, (match, p1) => {
    return `<pre><code>${p1.trim()}</code></pre>`;
  });

  // Inline code: `code`
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **text**
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* (avoid matching inside links)
  escaped = escaped.replace(/(^|[^\*])\*([^\*]+)\*([^\*]|$)/g, '$1<em>$2</em>$3');

  // Safe URL Auto-linking (http/https only)
  escaped = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>');

  return escaped;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Bootstrap
document.addEventListener('DOMContentLoaded', init);
