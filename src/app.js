const state = {
  conversations: [],
  selectedConversationId: null,
  identity: '',
  searchTerm: '',
  participantStats: new Map(),
};

const elements = {
  fileInput: document.getElementById('fileInput'),
  identitySelect: document.getElementById('identitySelect'),
  threadSearchInput: document.getElementById('threadSearchInput'),
  threadList: document.getElementById('threadList'),
  conversationTitle: document.getElementById('conversationTitle'),
  conversationParticipants: document.getElementById('conversationParticipants'),
  conversationAvatar: document.getElementById('conversationAvatar'),
  messageList: document.getElementById('messageList'),
  exportButton: document.getElementById('exportButton'),
  clearButton: document.getElementById('clearButton'),
  dropOverlay: document.getElementById('dropOverlay'),
};

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

init();

function init() {
  elements.fileInput.addEventListener('change', handleFileInput);
  elements.identitySelect.addEventListener('change', handleIdentityChange);
  elements.threadSearchInput.addEventListener('input', handleThreadSearch);
  elements.exportButton.addEventListener('click', downloadArchive);
  elements.clearButton.addEventListener('click', clearArchive);

  setupGlobalDropzone();
}

async function handleFileInput(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    return;
  }
  await ingestFiles(files);
  elements.fileInput.value = '';
}

async function ingestFiles(files) {
  const jsonFiles = files.filter((file) => file.name.toLowerCase().endsWith('.json'));
  if (!jsonFiles.length) {
    return;
  }

  const conversationMap = new Map(state.conversations.map((conversation) => [conversation.threadPath, conversation]));
  const errors = [];

  for (const file of jsonFiles) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readFileAsText(file);
    try {
      const data = JSON.parse(content);
      mergeConversationSegment(conversationMap, data, derivePath(file));
    } catch (error) {
      errors.push({ file: file.name, error: error.message });
      console.error(`Failed to parse ${file.name}`, error);
    }
  }

  const conversations = Array.from(conversationMap.values());
  conversations.forEach(finalizeConversation);
  conversations.sort((a, b) => (b.lastTimestampMs || 0) - (a.lastTimestampMs || 0));

  state.conversations = conversations;
  recomputeParticipantStats();
  ensureIdentitySelected();
  updateThreadList();
  selectConversation(state.selectedConversationId || (state.conversations[0] && state.conversations[0].id));
  updateControls();

  if (errors.length) {
    showImportErrors(errors);
  }
}

function mergeConversationSegment(conversationMap, data, sourcePath) {
  if (!data || typeof data !== 'object') {
    return;
  }

  const threadPath = data.thread_path || deriveThreadPathFromSource(sourcePath);
  if (!threadPath) {
    return;
  }

  let conversation = conversationMap.get(threadPath);
  if (!conversation) {
    conversation = createConversation(threadPath);
    conversationMap.set(threadPath, conversation);
  }

  if (data.title && (!conversation.title || conversation.title === conversation.threadPath)) {
    conversation.title = repairText(data.title);
  }

  if (Array.isArray(data.participants)) {
    data.participants.forEach((participant) => {
      const name = repairText(participant?.name || participant);
      if (typeof name === 'string' && !conversation.participantSet.has(name)) {
        conversation.participantSet.add(name);
        conversation.participants.push(name);
      }
    });
  }

  conversation.sources.add(sourcePath);

  if (Array.isArray(data.messages)) {
    data.messages.forEach((message) => {
      const normalized = normalizeMessage(message);
      const key = buildMessageKey(normalized);
      if (!conversation.messageKeySet.has(key)) {
        conversation.messageKeySet.add(key);
        conversation.messages.push(normalized);
      }
    });
  }
}

function finalizeConversation(conversation) {
  conversation.messages.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
  conversation.messageCount = conversation.messages.length;
  conversation.lastTimestampMs =
    conversation.messages.length && conversation.messages[conversation.messages.length - 1].timestampMs;
  conversation.previewText =
    conversation.messages.length > 0 ? buildPreview(conversation.messages[conversation.messages.length - 1]) : '';
}

function normalizeMessage(message) {
  const timestampMs = extractTimestamp(message);
  const type = (message?.type || message?.item_type || '').toLowerCase();

  return {
    id: `${timestampMs || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sender: repairText(message?.sender_name || 'Unknown'),
    timestampMs,
    timestamp: timestampMs ? new Date(timestampMs).toISOString() : null,
    text: typeof message?.content === 'string' ? repairText(message.content) : null,
    share: normalizeShare(message?.share),
    storyShare: normalizeStoryShare(message?.story_share),
    media: normalizeMedia(message),
    reactions: normalizeReactions(message?.reactions),
    call: normalizeCall(message),
    files: normalizeFiles(message?.files),
    isUnsent: Boolean(message?.is_unsent),
    isAction: type.includes('generic_admin') || type.includes('genericadmin'),
    actionText:
      typeof message?.content === 'string' && type.includes('generic') ? repairText(message.content) : null,
    raw: message,
  };
}

function normalizeShare(share) {
  if (!share) {
    return null;
  }
  return {
    link: repairText(share.link || null),
    text: repairText(share.text || null),
  };
}

function normalizeStoryShare(story) {
  if (!story) {
    return null;
  }
  return {
    title: repairText(story.title || 'Shared a story'),
    url: repairText(story.link || null),
    media: story.media || null,
  };
}

function normalizeMedia(message) {
  const format = (items, key) =>
    Array.isArray(items)
      ? items.map((item, index) => ({
          uri: item?.uri || item?.url || null,
          creationTimestamp: item?.creation_timestamp || null,
          index,
          key,
        }))
      : [];

  return {
    photos: format(message?.photos, 'photo'),
    videos: format(message?.videos, 'video'),
    gifs: format(message?.animated_gifs, 'gif'),
    audio: format(message?.audio_files, 'audio'),
    stickers: message?.sticker ? [message.sticker] : [],
  };
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) {
    return [];
  }
  return files.map((file, index) => ({
    uri: file?.uri || null,
    title: repairText(file?.title || file?.name || `File ${index + 1}`),
  }));
}

function normalizeReactions(reactions) {
  if (!Array.isArray(reactions)) {
    return [];
  }
  return reactions.map((reaction) => ({
    emoji: reaction?.reaction || reaction?.emoji || '❤️',
    actor: repairText(reaction?.actor || 'Unknown'),
  }));
}

function normalizeCall(message) {
  const call = message?.call || message?.video_call;
  if (!call) {
    return null;
  }
  return {
    description: repairText(call?.label || call?.description || 'Call'),
    duration: call?.duration || call?.duration_seconds || null,
    missed: Boolean(call?.missed),
  };
}

function createConversation(threadPath) {
  return {
    id: `convo-${Math.random().toString(36).slice(2, 9)}`,
    threadPath,
    title: threadPath,
    participants: [],
    participantSet: new Set(),
    messages: [],
    messageCount: 0,
    lastTimestampMs: null,
    previewText: '',
    sources: new Set(),
    messageKeySet: new Set(),
  };
}

function buildMessageKey(message) {
  const parts = [
    message.sender || '',
    message.timestampMs || '',
    message.text || '',
    message.share?.link || '',
    message.share?.text || '',
    message.storyShare?.title || '',
    message.media.photos.length || '',
    message.media.videos.length || '',
    message.files.length || '',
  ];
  return parts.join('::');
}

function extractTimestamp(message) {
  if (typeof message?.timestamp_ms === 'number') {
    return message.timestamp_ms;
  }
  if (typeof message?.timestamp === 'number') {
    return message.timestamp;
  }
  if (typeof message?.created_at === 'string') {
    const parsed = Date.parse(message.created_at);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

function buildPreview(message) {
  if (message.isUnsent) {
    return 'Message unsent';
  }
  if (message.text) {
    return message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text;
  }
  if (message.share?.link) {
    return message.share.text ? `${message.share.text} · ${message.share.link}` : message.share.link;
  }
  if (message.media.photos.length) {
    return '📷 Photo';
  }
  if (message.media.videos.length) {
    return '📹 Video';
  }
  if (message.media.gifs.length) {
    return 'GIF';
  }
  if (message.files.length) {
    return '📎 File';
  }
  if (message.call) {
    return message.call.description;
  }
  if (message.storyShare) {
    return message.storyShare.title;
  }
  return 'New activity';
}

function recomputeParticipantStats() {
  const stats = new Map();
  state.conversations.forEach((conversation) => {
    conversation.participants.forEach((participant) => {
      if (!stats.has(participant)) {
        stats.set(participant, { name: participant, messages: 0 });
      }
    });
    conversation.messages.forEach((message) => {
      const entry = stats.get(message.sender) || { name: message.sender, messages: 0 };
      entry.messages += 1;
      stats.set(message.sender, entry);
    });
  });
  state.participantStats = stats;
  populateIdentitySelect();
}

function populateIdentitySelect() {
  const options = Array.from(state.participantStats.values()).sort((a, b) => b.messages - a.messages);
  const select = elements.identitySelect;
  const currentValue = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = options.length ? 'Pick your account' : 'Select after import';
  placeholder.disabled = true;
  placeholder.selected = !state.identity;
  placeholder.hidden = true;
  select.append(placeholder);

  options.forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.name;
    option.textContent = `${entry.name}${entry.messages ? ` · ${entry.messages}` : ''}`;
    if (entry.name === state.identity) {
      option.selected = true;
    }
    select.append(option);
  });

  select.disabled = !options.length;
}

function ensureIdentitySelected() {
  if (state.identity && state.participantStats.has(state.identity)) {
    return;
  }
  const topParticipant = Array.from(state.participantStats.values())
    .filter((participant) => participant.messages > 0)
    .sort((a, b) => b.messages - a.messages)[0];
  state.identity = topParticipant?.name || '';
}

function handleIdentityChange(event) {
  state.identity = event.target.value;
  selectConversation(state.selectedConversationId);
}

function handleThreadSearch(event) {
  state.searchTerm = event.target.value.toLowerCase();
  updateThreadList();
}

function updateThreadList() {
  const list = elements.threadList;
  list.innerHTML = '';
  if (!state.conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Import your archive to see conversations.';
    list.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const filtered = state.conversations.filter((conversation) => {
    if (!state.searchTerm) {
      return true;
    }
    const haystack = `${conversation.title} ${conversation.participants.join(' ')}`.toLowerCase();
    return haystack.includes(state.searchTerm);
  });

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No conversations match your search.';
    list.append(empty);
    return;
  }

  filtered.forEach((conversation) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'thread-item';
    if (conversation.id === state.selectedConversationId) {
      item.classList.add('active');
    }

    const avatar = document.createElement('div');
    avatar.className = 'thread-avatar';
    avatar.textContent = generateAvatarLabel(conversation);

    const info = document.createElement('div');
    info.className = 'thread-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'thread-title';
    titleRow.textContent = conversation.title || conversation.participants.join(', ') || 'Untitled';

    if (conversation.lastTimestampMs) {
      const time = document.createElement('span');
      time.className = 'thread-time';
      time.textContent = formatRelativeTime(conversation.lastTimestampMs);
      titleRow.append(time);
    }

    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.textContent = conversation.previewText || 'No messages yet.';

    info.append(titleRow, preview);
    item.append(avatar, info);
    item.addEventListener('click', () => selectConversation(conversation.id));
    fragment.append(item);
  });

  list.append(fragment);
}

function selectConversation(conversationId) {
  const conversation = state.conversations.find((entry) => entry.id === conversationId);
  if (!conversation && state.conversations.length) {
    return selectConversation(state.conversations[0].id);
  }
  state.selectedConversationId = conversation ? conversation.id : null;
  renderConversation(conversation);
}

function renderConversation(conversation) {
  if (!conversation) {
    elements.conversationTitle.textContent = 'No conversation selected';
    elements.conversationParticipants.textContent = '';
    elements.conversationAvatar.textContent = '';
    elements.messageList.innerHTML = '<div class="empty-state">Pick a conversation to view its messages.</div>';
    return;
  }

  const isGroup = conversation.participants.length > 2;
  elements.conversationTitle.textContent =
    conversation.title || (isGroup ? 'Group conversation' : conversation.participants.find((name) => name !== state.identity) || 'Conversation');
  elements.conversationParticipants.textContent = conversation.participants.join(', ');
  elements.conversationAvatar.textContent = generateAvatarLabel(conversation);

  renderMessages(conversation);
}

function renderMessages(conversation) {
  const container = elements.messageList;
  container.innerHTML = '';
  if (!conversation.messages.length) {
    container.innerHTML = '<div class="empty-state">This conversation has no messages yet.</div>';
    return;
  }

  let lastDateKey = '';
  const fragment = document.createDocumentFragment();

  conversation.messages.forEach((message) => {
    const date = message.timestampMs ? new Date(message.timestampMs) : null;
    const dateKey = date ? date.toDateString() : '';
    if (dateKey && dateKey !== lastDateKey) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.textContent = DATE_FORMAT.format(date);
      fragment.append(divider);
      lastDateKey = dateKey;
    }

    if (message.isAction) {
      const action = document.createElement('div');
      action.className = 'date-divider action-message';
      action.textContent = message.actionText || `${message.sender} updated the chat`;
      fragment.append(action);
      return;
    }

    const group = document.createElement('div');
    group.className = 'message-group';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = `${message.sender}${date ? ` • ${TIME_FORMAT.format(date)}` : ''}`;
    group.append(meta);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (message.sender === state.identity) {
      bubble.classList.add('outgoing');
    }

    const bodyFragments = [];

    if (message.isUnsent) {
      bodyFragments.push(`<em>This message was unsent.</em>`);
    } else if (message.text) {
      bodyFragments.push(`<div class="message-text">${linkify(message.text)}</div>`);
    }

    if (message.share) {
      const parts = [];
      if (message.share.text) {
        parts.push(sanitize(message.share.text));
      }
      if (message.share.link) {
        const safeLink = sanitize(message.share.link);
        parts.push(`<a href="${safeLink}" target="_blank" rel="noopener">${safeLink}</a>`);
      }
      bodyFragments.push(`<div class="message-attachment"><strong>Shared link</strong><span>${parts.join('<br>')}</span></div>`);
    }

    if (message.storyShare) {
      const safeTitle = sanitize(message.storyShare.title);
      const safeLink = message.storyShare.url ? sanitize(message.storyShare.url) : null;
      bodyFragments.push(
        `<div class="message-attachment"><strong>Story</strong><span>${safeTitle}${safeLink ? `<br><a href="${safeLink}" target="_blank" rel="noopener">${safeLink}</a>` : ''}</span></div>`,
      );
    }

    const attachments = [];
    if (message.media.photos.length) {
      attachments.push(`📷 ${message.media.photos.length} photo${message.media.photos.length > 1 ? 's' : ''}`);
    }
    if (message.media.videos.length) {
      attachments.push(`📹 ${message.media.videos.length} video${message.media.videos.length > 1 ? 's' : ''}`);
    }
    if (message.media.gifs.length) {
      attachments.push(`GIF (${message.media.gifs.length})`);
    }
    if (message.media.audio.length) {
      attachments.push(`🎧 ${message.media.audio.length} audio`);
    }
    if (message.media.stickers.length) {
      attachments.push(`Sticker`);
    }
    if (message.files.length) {
      attachments.push(`📎 ${message.files.length} file${message.files.length > 1 ? 's' : ''}`);
    }
    if (attachments.length) {
      bodyFragments.push(
        `<div class="message-attachment"><strong>Attachments</strong><span>${attachments
          .map((item) => sanitize(item))
          .join('<br>')}</span></div>`,
      );
    }

    if (message.call) {
      const parts = [sanitize(message.call.description || 'Call')];
      if (message.call.duration) {
        parts.push(`Duration: ${formatDuration(message.call.duration)}`);
      }
      if (message.call.missed) {
        parts.push('Missed');
      }
      bodyFragments.push(
        `<div class="message-attachment"><strong>Call</strong><span>${parts.join('<br>')}</span></div>`,
      );
    }

    if (!bodyFragments.length && !message.reactions.length) {
      bodyFragments.push('<div class="message-text"><em>Unsupported message type</em></div>');
    }

    if (message.reactions.length) {
      const row = document.createElement('div');
      row.className = 'reaction-row';
      message.reactions.forEach((reaction) => {
        const pill = document.createElement('span');
        const actor = reaction.actor === state.identity ? 'You' : reaction.actor;
        pill.textContent = `${reaction.emoji} ${actor}`;
        row.append(pill);
      });
      bubble.append(row);
    }

    bubble.insertAdjacentHTML('afterbegin', bodyFragments.join(''));
    group.append(bubble);
    fragment.append(group);
  });

  container.append(fragment);
  container.scrollTop = container.scrollHeight;
}

function updateControls() {
  const hasData = state.conversations.length > 0;
  elements.clearButton.disabled = !hasData;
  elements.exportButton.disabled = !hasData;
  elements.threadSearchInput.disabled = !hasData;
  elements.threadSearchInput.placeholder = hasData ? 'Search conversations' : 'Import conversations first';
}

function clearArchive() {
  state.conversations = [];
  state.selectedConversationId = null;
  state.identity = '';
  state.searchTerm = '';
  state.participantStats = new Map();

  elements.threadSearchInput.value = '';
  elements.identitySelect.innerHTML = '<option value="" selected disabled>Select after import</option>';
  elements.identitySelect.disabled = true;

  updateThreadList();
  renderConversation(null);
  updateControls();
}

function downloadArchive() {
  if (!state.conversations.length) {
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    identity: state.identity,
    conversationCount: state.conversations.length,
    conversations: state.conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      participants: conversation.participants,
      threadPath: conversation.threadPath,
      messageCount: conversation.messageCount,
      lastTimestampMs: conversation.lastTimestampMs,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        sender: message.sender,
        timestampMs: message.timestampMs,
        text: message.text,
        share: message.share,
        storyShare: message.storyShare,
        media: message.media,
        reactions: message.reactions,
        call: message.call,
        files: message.files,
        isUnsent: message.isUnsent,
        isAction: message.isAction,
        actionText: message.actionText,
        raw: message.raw,
      })),
      sources: Array.from(conversation.sources),
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `igoffline-direct-${Date.now()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setupGlobalDropzone() {
  const overlay = elements.dropOverlay;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    document.addEventListener(
      eventName,
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      false,
    );
  });

  document.addEventListener('dragenter', () => overlay.classList.add('active'));
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) {
      overlay.classList.remove('active');
    }
  });
  document.addEventListener('dragend', () => overlay.classList.remove('active'));
  document.addEventListener('drop', async (event) => {
    overlay.classList.remove('active');
    const items = event.dataTransfer?.items;
    if (!items) {
      return;
    }
    const files = await collectFilesFromItems(items);
    if (files.length) {
      await ingestFiles(files);
    }
  });
}

async function collectFilesFromItems(items) {
  const files = [];
  const candidates = Array.from(items);
  for (const item of candidates) {
    if (item.kind !== 'file') {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        // eslint-disable-next-line no-await-in-loop
        await walkFileSystemEntry(entry, files);
        continue;
      }
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

async function walkFileSystemEntry(entry, bucket) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    if (file) {
      Object.defineProperty(file, 'relativePath', {
        value: entry.fullPath ? entry.fullPath.replace(/^\//, '') : file.name,
        configurable: true,
      });
      bucket.push(file);
    }
    return;
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const readEntries = () =>
      new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await readEntries();
      if (!batch.length) {
        break;
      }
      for (const child of batch) {
        // eslint-disable-next-line no-await-in-loop
        await walkFileSystemEntry(child, bucket);
      }
    }
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function derivePath(file) {
  return file.relativePath || file.webkitRelativePath || file.name;
}

function deriveThreadPathFromSource(path) {
  if (!path) {
    return null;
  }
  const normalized = path.replace(/\\+/g, '/');
  const messagesIndex = normalized.toLowerCase().indexOf('messages/');
  if (messagesIndex > -1) {
    return normalized.slice(messagesIndex);
  }
  return normalized;
}

function formatRelativeTime(timestampMs) {
  if (!timestampMs) {
    return '';
  }
  const now = Date.now();
  const diff = now - timestampMs;
  const dayInMs = 86400000;
  if (diff < dayInMs) {
    return TIME_FORMAT.format(new Date(timestampMs));
  }
  if (diff < 7 * dayInMs) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(timestampMs));
  }
  return DATE_FORMAT.format(new Date(timestampMs));
}

function generateAvatarLabel(conversation) {
  const participants = conversation.participants.filter((name) => name !== state.identity);
  if (!participants.length) {
    return conversation.title?.slice(0, 2).toUpperCase() || 'DM';
  }
  if (participants.length === 1) {
    return initials(participants[0]);
  }
  return initials(participants[0]).slice(0, 1) + initials(participants[1]).slice(0, 1);
}

function initials(name) {
  if (!name) {
    return 'DM';
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return name.slice(0, 2).toUpperCase();
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function repairText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  if (typeof TextDecoder === 'undefined') {
    return value;
  }
  const buffer = new Uint8Array(value.length);
  let requiresDecode = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 255) {
      return value;
    }
    buffer[i] = code;
    if (code >= 0xc2) {
      requiresDecode = true;
    }
  }
  if (!requiresDecode) {
    return value;
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (!decoded || decoded.includes('\uFFFD')) {
      return value;
    }
    return decoded;
  } catch (error) {
    console.warn('Failed to repair text encoding', error);
    return value;
  }
}

function sanitize(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function linkify(text) {
  const escaped = sanitize(text).replace(/\n/g, '<br>');
  const urlRegex =
    /((?:https?:\/\/|www\.)[\w.-]+(?:\.[\w\.-]+)+(?:[^\s<]*)?)/gi;
  return escaped.replace(urlRegex, (match) => {
    const href = match.startsWith('http') ? match : `https://${match}`;
    return `<a href="${href}" target="_blank" rel="noopener">${match}</a>`;
  });
}

function formatDuration(seconds) {
  if (typeof seconds === 'string' && seconds.includes(':')) {
    const parts = seconds.split(':').map((part) => Number(part));
    if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) {
      return `${parts[0]}m ${parts[1].toString().padStart(2, '0')}s`;
    }
  }
  const totalSeconds = Number(seconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '—';
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0) {
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

function showImportErrors(errors) {
  const container = document.createElement('div');
  container.className = 'empty-state';
  container.style.background = 'rgba(255,255,255,0.05)';
  container.style.borderRadius = '12px';
  container.style.margin = '12px 20px';
  container.innerHTML = `<strong>${errors.length} file${errors.length > 1 ? 's' : ''} failed to import:</strong><br>${errors
    .map((error) => `${sanitize(error.file)} — ${sanitize(error.error)}`)
    .join('<br>')}`;
  elements.threadList.prepend(container);
  setTimeout(() => container.remove(), 8000);
}
