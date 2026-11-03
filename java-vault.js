"use strict";

(() => {
  const STORAGE_KEY = "java-vault-library-v1";
  const AI_SETTINGS_KEY = "java-vault-ai-settings-v1";
  const CLOUD_SETTINGS_KEY = "java-vault-cloud-settings-v1";
  const BACKUP_EXPORTED_KEY = "java-vault-last-backup-export-v1";
  const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  const MAX_LESSONS = 5000;
  const MAX_FIELD_LENGTH = 200000;
  const STATUS_LABELS = { new: "New", review: "Review later", confident: "Confident" };

  const byId = (id) => document.getElementById(id);
  const state = {
    lessons: [],
    deletedIds: {},
    view: "overview",
    search: "",
    status: "all",
    sort: "newest",
    topic: "",
    selectedLessonId: null,
    aiKey: "",
    cloudClient: null,
    cloudSdkPromise: null,
    storageBlocked: false,
    recoveryKey: null,
    recoveryMode: false,
    recoveryLegacy: false,
    storageMode: "indexeddb",
    reminderCheckRunning: false,
    toastTimer: null
  };

  const elements = {
    lessonGrid: byId("lesson-grid"),
    emptyState: byId("empty-state"),
    settingsView: byId("settings-view"),
    toolbar: byId("library-toolbar"),
    stats: byId("stats-grid"),
    topicFilterRow: byId("topic-filter-row"),
    editorDialog: byId("lesson-dialog"),
    detailDialog: byId("detail-dialog"),
    lessonForm: byId("lesson-form"),
    search: byId("search-input"),
    status: byId("status-filter"),
    sort: byId("sort-filter"),
    importFile: byId("import-file"),
    toast: byId("toast")
  };

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function safeText(value, maxLength = MAX_FIELD_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function validLesson(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100
      && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 120
      && Array.isArray(value.topics) && value.topics.length <= 30
      && value.topics.every((topic) => typeof topic === "string" && topic.trim().length > 0 && topic.length <= 40)
      && typeof value.notes === "string" && value.notes.length <= 5000
      && typeof value.learned === "string" && value.learned.length <= 5000
      && typeof value.code === "string" && value.code.trim().length > 0 && value.code.length <= MAX_FIELD_LENGTH
      && ["new", "review", "confident"].includes(value.status)
      && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
      && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
      && (value.practiceQuestion === undefined || (typeof value.practiceQuestion === "string" && value.practiceQuestion.length <= 1000))
      && (value.reviewLevel === undefined || (Number.isInteger(value.reviewLevel) && value.reviewLevel >= 0 && value.reviewLevel <= 6))
      && (value.nextReviewAt === undefined || value.nextReviewAt === null
        || (typeof value.nextReviewAt === "string" && !Number.isNaN(Date.parse(value.nextReviewAt))))
      && (value.reminderAt === undefined || value.reminderAt === null
        || (typeof value.reminderAt === "string" && !Number.isNaN(Date.parse(value.reminderAt))))
      && (value.reminderNotifiedAt === undefined || value.reminderNotifiedAt === null
        || (typeof value.reminderNotifiedAt === "string" && !Number.isNaN(Date.parse(value.reminderNotifiedAt))))
      && (value.aiReview === null || (value.aiReview && typeof value.aiReview === "object"
        && typeof value.aiReview.text === "string" && value.aiReview.text.length <= 20000
        && typeof value.aiReview.reviewedAt === "string" && !Number.isNaN(Date.parse(value.aiReview.reviewedAt))
        && typeof value.aiReview.model === "string" && value.aiReview.model.length <= 120));
  }

  function normalizeLesson(raw) {
    if (!validLesson(raw)) throw new Error("The backup contains a lesson with an invalid format.");
    const topics = raw.topics
      .filter((topic) => typeof topic === "string")
      .map((topic) => topic.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 30);
    let aiReview = null;
    if (raw.aiReview && typeof raw.aiReview === "object" && typeof raw.aiReview.text === "string") {
      aiReview = {
        text: safeText(raw.aiReview.text, 20000),
        reviewedAt: typeof raw.aiReview.reviewedAt === "string" && !Number.isNaN(Date.parse(raw.aiReview.reviewedAt))
          ? raw.aiReview.reviewedAt : "",
        model: safeText(raw.aiReview.model, 120)
      };
    }
    return {
      id: raw.id,
      title: raw.title.trim().slice(0, 120),
      topics,
      notes: safeText(raw.notes, 5000),
      learned: safeText(raw.learned, 5000),
      code: safeText(raw.code),
      status: raw.status,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      practiceQuestion: safeText(raw.practiceQuestion, 1000),
      reviewLevel: Number.isInteger(raw.reviewLevel) ? Math.min(6, Math.max(0, raw.reviewLevel)) : 0,
      nextReviewAt: typeof raw.nextReviewAt === "string" && !Number.isNaN(Date.parse(raw.nextReviewAt))
        ? raw.nextReviewAt
        : new Date(Date.parse(raw.createdAt) + 86400000).toISOString(),
      reminderAt: raw.reminderAt || null,
      reminderNotifiedAt: raw.reminderNotifiedAt || null,
      aiReview
    };
  }

  function parseLibrary(stored) {
    let parsed;
    try {
      parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.lessons)) {
        throw new Error("The saved library has an unsupported format.");
      }
      if (parsed.lessons.length > MAX_LESSONS) throw new Error("Your saved library contains more lessons than this version supports.");
      const deletedIds = {};
      if (parsed.deletedIds !== undefined) {
        if (!parsed.deletedIds || typeof parsed.deletedIds !== "object" || Array.isArray(parsed.deletedIds)) {
          throw new Error("The saved deletion history has an invalid format.");
        }
        const entries = Object.entries(parsed.deletedIds);
        if (entries.length > MAX_LESSONS) throw new Error("The saved deletion history exceeds this version's limit.");
        entries.forEach(([id, deletedAt]) => {
          if (!id || id.length > 100 || typeof deletedAt !== "string" || Number.isNaN(Date.parse(deletedAt))) {
            throw new Error("The saved deletion history contains an invalid entry.");
          }
          deletedIds[id] = deletedAt;
        });
      }
      return { schemaVersion: 1, lessons: parsed.lessons.map(normalizeLesson), deletedIds };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The saved library could not be read because its data is invalid.");
      throw error;
    }
  }

  async function loadLessons() {
    let stored;
    try {
      stored = await window.VaultStorage.load();
    } catch (error) {
      state.storageMode = "unavailable";
      throw new Error(`Protected browser storage could not be opened: ${error.message}`);
    }

    if (stored) {
      try {
        const library = parseLibrary(stored);
        state.deletedIds = library.deletedIds;
        return library.lessons;
      } catch (error) {
        const snapshots = await window.VaultStorage.snapshots();
        const validSnapshot = snapshots.find((snapshot) => {
          try {
            parseLibrary(snapshot.value);
            return true;
          } catch {
            return false;
          }
        });
        if (validSnapshot) {
          state.recoveryKey = validSnapshot.key;
          state.recoveryMode = true;
          state.storageBlocked = true;
          showToast("The latest library data is unreadable. A previous automatic restore point is available in Settings.", true);
          const library = parseLibrary(validSnapshot.value);
          state.deletedIds = library.deletedIds;
          return library.lessons;
        }
        const legacy = localStorage.getItem(STORAGE_KEY);
        let legacyError = "";
        if (legacy) {
          try {
            const library = parseLibrary(legacy);
            state.recoveryMode = true;
            state.recoveryLegacy = true;
            state.storageBlocked = true;
            showToast("The current library and automatic restore points are unreadable. An older browser copy is available in Settings.", true);
            state.deletedIds = library.deletedIds;
            return library.lessons;
          } catch (fallbackError) {
            legacyError = ` The older browser copy is also invalid: ${fallbackError.message}`;
          }
        }
        throw new Error(`${error.message} No valid automatic restore point was found.${legacyError}`);
      }
    }

    const legacy = localStorage.getItem(STORAGE_KEY);
    if (!legacy) return [];
    const migrated = parseLibrary(legacy);
    state.deletedIds = migrated.deletedIds;
    if (window.VaultStorage.mode === "indexeddb") await window.VaultStorage.save(migrated);
    return migrated.lessons;
  }

  async function persistLessons(lessons, allowRecovery = false, deletedIds = state.deletedIds) {
    if (state.storageBlocked && !allowRecovery) {
      showToast("Saving is paused to protect unreadable library data. Restore a previous save or import a valid backup.", true);
      return false;
    }
    if (lessons.length > MAX_LESSONS) {
      showToast(`This library has reached the ${MAX_LESSONS.toLocaleString()} lesson limit.`, true);
      return false;
    }
    try {
      await window.VaultStorage.save({ schemaVersion: 1, lessons, deletedIds });
      state.lessons = lessons;
      state.deletedIds = deletedIds;
      state.storageBlocked = false;
      state.recoveryMode = false;
      state.recoveryLegacy = false;
      state.recoveryKey = null;
      state.storageMode = window.VaultStorage.mode;
      render();
      refreshStorageStatus();
      refreshRestorePoints();
      return true;
    } catch (error) {
      showToast(`Could not safely save your library: ${error.message || "browser storage is unavailable"}. Your current in-memory lesson list was not changed.`, true);
      return false;
    }
  }

  function loadAiSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || "{}");
      const provider = saved.provider === "compatible" ? "compatible" : "ollama";
      byId("ai-provider").value = provider;
      byId("ai-endpoint").value = safeText(saved.endpoint, 500)
        || (provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com");
      byId("ai-model").value = safeText(saved.model, 120)
        || (provider === "ollama" ? "qwen2.5-coder:7b" : "");
      updateAiFields();
    } catch (error) {
      showToast(`AI settings could not be read: ${error.message}`, true);
    }
  }

  function updateAiFields() {
    const isCompatible = byId("ai-provider").value === "compatible";
    byId("ai-key-label").hidden = !isCompatible;
    byId("ai-endpoint").value = byId("ai-endpoint").value || (isCompatible ? "https://api.openai.com" : "http://localhost:11434");
    byId("ai-model").placeholder = isCompatible ? "e.g. gpt-4o-mini" : "e.g. qwen2.5-coder:7b";
    byId("ai-key").value = state.aiKey;
  }

  function showToast(message, isError = false) {
    clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.classList.add("visible");
    state.toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3600);
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function getTopics() {
    return [...new Set(state.lessons.flatMap((lesson) => lesson.topics))].sort((a, b) => a.localeCompare(b));
  }

  function lessonMatches(lesson) {
    if (state.view === "review" && lesson.status !== "review") return false;
    if (state.view === "study" && Date.parse(lesson.nextReviewAt) > Date.now()) return false;
    if (state.status !== "all" && lesson.status !== state.status) return false;
    if (state.topic && !lesson.topics.includes(state.topic)) return false;
    if (!state.search) return true;
    const searchable = [lesson.title, lesson.topics.join(" "), lesson.notes, lesson.learned, lesson.code].join(" ").toLocaleLowerCase();
    return searchable.includes(state.search.toLocaleLowerCase());
  }

  function getVisibleLessons() {
    const lessons = state.lessons.filter(lessonMatches);
    if (state.view === "study") lessons.sort((a, b) => Date.parse(a.nextReviewAt) - Date.parse(b.nextReviewAt));
    else if (state.sort === "oldest") lessons.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    else if (state.sort === "title") lessons.sort((a, b) => a.title.localeCompare(b.title));
    else lessons.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return state.view === "overview" ? lessons.slice(0, 6) : lessons;
  }

  function renderStats() {
    byId("stat-lessons").textContent = String(state.lessons.length);
    byId("stat-topics").textContent = String(getTopics().length);
    const reviewCount = state.lessons.filter((lesson) => lesson.status === "review").length;
    const dueCount = state.lessons.filter((lesson) => Date.parse(lesson.nextReviewAt) <= Date.now()).length;
    byId("stat-review").textContent = String(reviewCount);
    byId("lesson-nav-count").textContent = String(state.lessons.length);
    byId("review-nav-count").textContent = String(reviewCount);
    byId("due-nav-count").textContent = String(dueCount);
  }

  function renderTopics() {
    const topics = getTopics();
    const row = elements.topicFilterRow;
    row.hidden = topics.length === 0;
    const list = byId("topic-filter-list");
    list.replaceChildren();
    topics.forEach((topic) => {
      const button = createElement("button", `topic-filter-button${state.topic === topic ? " active" : ""}`, topic);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.topic === topic));
      button.addEventListener("click", () => {
        state.topic = state.topic === topic ? "" : topic;
        render();
      });
      list.append(button);
    });
  }

  function renderCard(lesson) {
    const card = createElement("article", "lesson-card");
    const topline = createElement("div", "card-topline");
    topline.append(createElement("span", "card-topic", lesson.topics[0] || "Java lesson"));
    const status = createElement("span", `status-pill ${lesson.status}`, STATUS_LABELS[lesson.status]);
    topline.append(status);

    const title = createElement("h3", "", lesson.title);
    const previewText = lesson.learned || lesson.notes || "Code saved — add a note whenever you’re ready.";
    const preview = createElement("p", "card-preview", previewText);
    const tags = createElement("div", "card-tags");
    lesson.topics.slice(0, 4).forEach((topic) => tags.append(createElement("span", "tag-chip", topic)));
    if (lesson.topics.length > 4) tags.append(createElement("span", "tag-chip", `+${lesson.topics.length - 4}`));

    const footer = createElement("div", "card-footer");
    const codeLabel = createElement("span", "card-code-label");
    codeLabel.append(createElement("span", "", "</>"), document.createTextNode("Java code saved"));
    footer.append(codeLabel, createElement("time", "", formatDate(lesson.updatedAt)));
    if (lesson.reminderAt) {
      const reminderLabel = createElement("span", "card-reminder", `◷ ${formatDateTime(lesson.reminderAt)}`);
      footer.insertBefore(reminderLabel, footer.lastChild);
    }
    const openButton = createElement("button", "card-open");
    openButton.type = "button";
    openButton.setAttribute("aria-label", `Open lesson: ${lesson.title}`);
    openButton.addEventListener("click", () => openLesson(lesson.id));
    card.append(topline, title, preview, tags, footer, openButton);
    return card;
  }

  function render() {
    renderStats();
    renderTopics();
    const isSettings = state.view === "settings";
    elements.settingsView.hidden = !isSettings;
    elements.toolbar.hidden = isSettings;
    elements.stats.hidden = isSettings || state.view !== "overview";
    elements.lessonGrid.hidden = isSettings;
    elements.emptyState.hidden = isSettings;
    byId("breadcrumb-current").textContent = viewName();
    byId("page-title").textContent = isSettings ? "Your library, your settings." : state.view === "review" ? "A little review goes a long way." : state.view === "study" ? "Bring your lessons back to mind." : state.view === "lessons" ? "Every lesson, in one place." : "Welcome to your vault.";
    byId("page-eyebrow").textContent = isSettings ? "YOUR DATA, YOUR CHOICES" : state.view === "review" || state.view === "study" ? "BUILD ON WHAT YOU KNOW" : state.view === "lessons" ? "YOUR PERSONAL JAVA LIBRARY" : "YOUR PROGRESS, IN ONE PLACE";
    byId("page-subtitle").textContent = isSettings ? "Manage your AI connection and keep a safe copy of what you’ve learned." : state.view === "review" ? "Revisit the ideas you marked for another look." : state.view === "study" ? "Try recalling the idea first, then reveal your notes and choose when to review again." : state.view === "lessons" ? "All your saved code, notes, and learning in one searchable space." : "A calm place to keep the code you’ve learned and the ideas behind it.";
    byId("list-title").textContent = state.view === "review" ? "Ready when you are" : state.view === "study" ? "Due for a quick review" : state.view === "overview" ? "Recent lessons" : "Your lessons";
    byId("status-filter").value = state.status;
    byId("sort-filter").value = state.sort;
    document.querySelectorAll(".nav-item[data-view]").forEach((button) => {
      const active = button.dataset.view === state.view
        || (state.view === "overview" && button.dataset.view === "overview");
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });

    if (isSettings) return;
    const visible = getVisibleLessons();
    elements.lessonGrid.replaceChildren(...visible.map(renderCard));
    const total = visible.length;
    byId("result-count").textContent = `${total} ${total === 1 ? "lesson" : "lessons"}`;
    const empty = visible.length === 0;
    elements.lessonGrid.hidden = empty;
    elements.emptyState.hidden = !empty;
    byId("empty-eyebrow").textContent = state.view === "study" && !state.search && !state.topic ? "ALL CAUGHT UP" : state.search || state.topic || state.status !== "all" || state.view === "review" ? "NO MATCHES YET" : "YOUR FIRST ENTRY";
    byId("empty-title").textContent = state.view === "study" && !state.search && !state.topic ? "No lessons are due right now." : state.search || state.topic || state.status !== "all" || state.view === "review" ? "Nothing to see here just yet." : "Make room for what’s next.";
    byId("empty-message").textContent = state.view === "study" && !state.search && !state.topic
      ? "Your next reviews will appear here based on the schedule you choose after each practice."
      : state.search || state.topic || state.status !== "all" || state.view === "review"
        ? "Try another search or filter, or save a lesson to start building your library."
      : "Save your first lesson here. Add the code, a few notes, and what clicked for you.";
    byId("empty-state").querySelector("[data-create]").hidden = Boolean(state.view === "study" || state.search || state.topic || state.status !== "all" || state.view === "review");
  }

  function viewName() {
    return ({ overview: "Overview", lessons: "All lessons", study: "Study due", review: "Review later", settings: "Settings & backup" })[state.view] || "Overview";
  }

  function navigate(view) {
    state.view = view;
    state.topic = "";
    if (view === "overview" || view === "study") state.status = "all";
    if (view === "review") state.status = "all";
    if (view === "lessons") state.status = "all";
    render();
    if (view === "settings") {
      refreshStorageStatus();
      refreshRestorePoints();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openEditor(lesson = null) {
    elements.lessonForm.reset();
    byId("lesson-id").value = lesson ? lesson.id : "";
    byId("lesson-title").value = lesson ? lesson.title : "";
    byId("lesson-topics").value = lesson ? lesson.topics.join(", ") : "";
    byId("lesson-notes").value = lesson ? lesson.notes : "";
    byId("lesson-learned").value = lesson ? lesson.learned : "";
    byId("lesson-practice-question").value = lesson ? lesson.practiceQuestion : "";
    byId("lesson-code").value = lesson ? lesson.code : "";
    byId("lesson-status").value = lesson ? lesson.status : "new";
    byId("lesson-reminder").value = lesson ? toLocalDateTimeInput(lesson.reminderAt) : "";
    byId("editor-title").textContent = lesson ? "Edit your lesson" : "Save a lesson";
    elements.editorDialog.showModal();
    setTimeout(() => byId("lesson-title").focus(), 0);
  }

  function openLesson(id) {
    const lesson = state.lessons.find((item) => item.id === id);
    if (!lesson) {
      showToast("That lesson is no longer in your library.", true);
      return;
    }
    state.selectedLessonId = id;
    renderDetail(lesson);
    if (!elements.detailDialog.open) elements.detailDialog.showModal();
  }

  function addDetailSection(parent, heading, content, className = "") {
    const section = createElement("section", `detail-section${className ? ` ${className}` : ""}`);
    section.append(createElement("h3", "", heading));
    if (content instanceof Node) section.append(content);
    else section.append(createElement("p", "", content || "Nothing added yet."));
    parent.append(section);
    return section;
  }

  function appendHighlightedCode(codeElement, source) {
    const tokenPattern = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|var|record|sealed|permits|yield)\b|\b(?:true|false|null)\b|\b\d+(?:\.\d+)?[fFdDlL]?\b/g;
    const keywords = new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield".split(" "));
    const literals = new Set(["true", "false", "null"]);
    let cursor = 0;
    let match;
    while ((match = tokenPattern.exec(source)) !== null) {
      if (match.index > cursor) codeElement.append(document.createTextNode(source.slice(cursor, match.index)));
      const token = match[0];
      let tokenClass = "code-number";
      if (token.startsWith("//") || token.startsWith("/*")) tokenClass = "code-comment";
      else if (token.startsWith('"') || token.startsWith("'")) tokenClass = "code-string";
      else if (keywords.has(token)) tokenClass = "code-keyword";
      else if (literals.has(token)) tokenClass = "code-literal";
      const span = createElement("span", tokenClass, token);
      codeElement.append(span);
      cursor = match.index + token.length;
    }
    if (cursor < source.length) codeElement.append(document.createTextNode(source.slice(cursor)));
  }

  function createCodePanel(source, label) {
    const panel = createElement("div", "code-panel");
    const header = createElement("div", "code-panel-header");
    header.append(createElement("span", "", label));
    const copyButton = createElement("button", "secondary-button code-copy-button", "Copy code");
    copyButton.type = "button";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(source);
        showToast(`${label} copied.`);
      } catch (error) {
        showToast(`Could not copy code: ${error.message || "clipboard access is unavailable"}`, true);
      }
    });
    header.append(copyButton);
    const pre = createElement("pre", "detail-code");
    const code = document.createElement("code");
    appendHighlightedCode(code, source);
    pre.append(code);
    panel.append(header, pre);
    return panel;
  }

  function schedulePractice(lessonId, rating) {
    const lesson = state.lessons.find((item) => item.id === lessonId);
    if (!lesson) return;
    const intervals = [1, 1, 3, 7, 14, 30, 60];
    const reviewLevel = rating === "again"
      ? Math.max(0, lesson.reviewLevel - 1)
      : Math.min(6, lesson.reviewLevel + (rating === "easy" ? 2 : 1));
    const delay = rating === "again" ? 10 * 60 * 1000 : intervals[reviewLevel] * 86400000;
    const updated = { ...lesson, reviewLevel, nextReviewAt: new Date(Date.now() + delay).toISOString(), updatedAt: new Date().toISOString() };
    const next = state.lessons.map((item) => item.id === lessonId ? updated : item);
    persistLessons(next).then((saved) => {
      if (!saved) return;
      if (elements.detailDialog.open && state.selectedLessonId === lessonId) renderDetail(updated);
      showToast(`Next review ${rating === "again" ? "in 10 minutes" : `in ${intervals[reviewLevel]} day${intervals[reviewLevel] === 1 ? "" : "s"}`}.`);
    });
  }

  function renderDetail(lesson) {
    byId("detail-title").textContent = lesson.title;
    const body = byId("detail-body");
    body.replaceChildren();
    const meta = createElement("div", "detail-meta");
    meta.append(createElement("span", `status-pill ${lesson.status}`, STATUS_LABELS[lesson.status]));
    meta.append(createElement("span", "", `Saved ${formatDate(lesson.createdAt)}`));
    if (lesson.updatedAt !== lesson.createdAt) meta.append(createElement("span", "", `· Updated ${formatDate(lesson.updatedAt)}`));
    body.append(meta);
    if (lesson.reminderAt) {
      const reminderDescription = lesson.reminderNotifiedAt
        ? `Reminder set for ${formatDateTime(lesson.reminderAt)} · notified ${formatDateTime(lesson.reminderNotifiedAt)}`
        : new Date(lesson.reminderAt).getTime() <= Date.now()
          ? `Reminder overdue since ${formatDateTime(lesson.reminderAt)}`
          : `Reminder set for ${formatDateTime(lesson.reminderAt)}`;
      addDetailSection(body, "Reminder", reminderDescription);
    }

    const topics = createElement("div", "detail-topics");
    if (lesson.topics.length) lesson.topics.forEach((topic) => topics.append(createElement("span", "tag-chip", topic)));
    else topics.append(createElement("span", "field-hint", "No topics added"));
    addDetailSection(body, "Topics", topics);
    addDetailSection(body, "Your comments & notes", lesson.notes);
    addDetailSection(body, "What you learned", lesson.learned);
    const practice = createElement("div", "practice-card");
    practice.append(createElement("p", "practice-question", lesson.practiceQuestion || "Before reading your notes, explain this lesson in your own words."));
    const revealButton = createElement("button", "secondary-button", "Reveal my notes");
    revealButton.type = "button";
    const answer = createElement("div", "practice-answer");
    answer.hidden = true;
    answer.append(createElement("p", "", lesson.learned || "You have not added a learning summary yet."));
    if (lesson.notes) answer.append(createElement("p", "practice-notes", lesson.notes));
    const ratingActions = createElement("div", "practice-ratings");
    [
      ["again", "I need another look"],
      ["good", "Got it"],
      ["easy", "Easy"]
    ].forEach(([rating, label]) => {
      const button = createElement("button", "secondary-button", label);
      button.type = "button";
      button.addEventListener("click", () => schedulePractice(lesson.id, rating));
      ratingActions.append(button);
    });
    ratingActions.hidden = true;
    revealButton.addEventListener("click", () => {
      answer.hidden = false;
      ratingActions.hidden = false;
      revealButton.hidden = true;
    });
    practice.append(revealButton, answer, ratingActions);
    if (lesson.nextReviewAt) {
      practice.append(createElement("p", "field-hint", `Next review: ${formatDateTime(lesson.nextReviewAt)}`));
    }
    addDetailSection(body, "Practice & spaced review", practice);
    addDetailSection(body, "Java code", createCodePanel(lesson.code, "Original Java code"));
    if (lesson.aiReview && lesson.aiReview.text) {
      const review = createElement("section", "detail-section ai-review-output");
      review.append(createElement("h3", "", `AI learning coach${lesson.aiReview.model ? ` · ${lesson.aiReview.model}` : ""}`));
      review.append(createElement("p", "", lesson.aiReview.text));
      const suggestions = [...lesson.aiReview.text.matchAll(/```(?:java)?[ \t]*\r?\n([\s\S]*?)```/gi)]
        .map((item) => item[1].replace(/\r?\n$/, ""))
        .filter(Boolean);
      if (suggestions.length) {
        const comparison = createElement("details", "code-comparison");
        comparison.append(createElement("summary", "", "Compare AI code suggestion"));
        const panels = createElement("div", "comparison-panels");
        panels.append(createCodePanel(lesson.code, "Your original"), createCodePanel(suggestions[0], "AI suggestion"));
        comparison.append(panels);
        review.append(comparison);
      }
      if (lesson.aiReview.reviewedAt) review.append(createElement("span", "field-hint", `Reviewed ${formatDate(lesson.aiReview.reviewedAt)}`));
      body.append(review);
    }
    byId("review-ai-button").disabled = isAiBusy;
    byId("review-ai-button").textContent = isAiBusy ? "Reviewing…" : "✳ Review with AI";
  }

  let isAiBusy = false;

  function parseTopics(value) {
    return [...new Set(value.split(",").map((topic) => topic.trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
  }

  function toLocalDateTimeInput(isoDate) {
    if (!isoDate) return "";
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return "";
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
  }

  function formatDateTime(isoDate) {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  async function handleSaveLesson(event) {
    event.preventDefault();
    const id = byId("lesson-id").value;
    const existing = state.lessons.find((lesson) => lesson.id === id);
    const now = new Date().toISOString();
    const reminderInput = byId("lesson-reminder").value;
    const parsedReminder = reminderInput ? new Date(reminderInput) : null;
    if (parsedReminder && Number.isNaN(parsedReminder.getTime())) {
      showToast("Choose a valid date and time for the reminder.", true);
      return;
    }
    const reminderAt = parsedReminder ? parsedReminder.toISOString() : null;
    const reminderChanged = Boolean(reminderAt && (!existing || existing.reminderAt !== reminderAt));
    const title = byId("lesson-title").value.trim();
    const code = byId("lesson-code").value;
    if (!title || !code.trim()) {
      showToast("Add a lesson title and paste your Java code before saving.", true);
      return;
    }
    let reminderNotice = "";
    if (reminderChanged && typeof Notification !== "undefined" && Notification.permission === "default") {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") reminderNotice = " Notifications are off; the app will show overdue reminders the next time it is open.";
      } catch (error) {
        reminderNotice = ` Browser notification permission could not be requested: ${error.message}`;
      }
    } else if (reminderChanged && (typeof Notification === "undefined" || Notification.permission !== "granted")) {
      reminderNotice = " Notifications are unavailable or blocked; the app will show overdue reminders the next time it is open.";
    }
    const lesson = {
      id: existing ? existing.id : makeId(),
      title,
      topics: parseTopics(byId("lesson-topics").value),
      notes: byId("lesson-notes").value.trim(),
      learned: byId("lesson-learned").value.trim(),
      practiceQuestion: byId("lesson-practice-question").value.trim(),
      code,
      status: byId("lesson-status").value,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      reviewLevel: existing ? existing.reviewLevel : 0,
      nextReviewAt: existing ? existing.nextReviewAt : new Date(Date.now() + 86400000).toISOString(),
      reminderAt,
      reminderNotifiedAt: existing && existing.reminderAt === reminderAt ? existing.reminderNotifiedAt : null,
      aiReview: existing ? existing.aiReview : null
    };
    const next = existing
      ? state.lessons.map((item) => item.id === existing.id ? lesson : item)
      : [lesson, ...state.lessons];
    if (!await persistLessons(next)) return;
    elements.editorDialog.close();
    showToast(`${existing ? "Lesson updated." : "Lesson saved to this device."}${reminderNotice}`);
    if (reminderChanged && reminderAt && Date.parse(reminderAt) > Date.now() && !reminderNotice) {
      try {
        await scheduleBackgroundReminder(lesson);
      } catch (error) {
        showToast(`Reminder saved, but background scheduling failed: ${error.message}. It will be checked when the app is open.`, true);
      }
    }
    checkDueReminders();
  }

  async function scheduleBackgroundReminder(lesson) {
    if (typeof window.TimestampTrigger !== "function" || !("serviceWorker" in navigator)) {
      throw new Error("this browser does not support scheduled notifications");
    }
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("Ope' Code Vault reminder", {
      body: `Time to revisit “${lesson.title}”`,
      icon: "./java-vault-icon.svg",
      tag: `java-vault-reminder-${lesson.id}`,
      showTrigger: new window.TimestampTrigger(Date.parse(lesson.reminderAt)),
      data: { lessonId: lesson.id }
    });
  }

  async function checkDueReminders() {
    if (state.reminderCheckRunning) return;
    const now = Date.now();
    const due = state.lessons.filter((lesson) => lesson.reminderAt
      && !lesson.reminderNotifiedAt
      && Date.parse(lesson.reminderAt) <= now);
    if (!due.length) return;

    state.reminderCheckRunning = true;
    let browserNotificationShown = false;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const registration = await navigator.serviceWorker.ready;
        await Promise.all(due.map((lesson) => registration.showNotification("Ope' Code Vault reminder", {
          body: `Time to revisit “${lesson.title}”`,
          icon: "./java-vault-icon.svg",
          tag: `java-vault-reminder-${lesson.id}`,
          data: { lessonId: lesson.id }
        })));
        browserNotificationShown = true;
      } catch (error) {
        showToast(`Browser notification failed: ${error.message}. The reminder is still shown in the app.`, true);
      }
    }
    const titles = due.map((lesson) => `“${lesson.title}”`).join(", ");
    showToast(`Reminder: revisit ${titles}.${browserNotificationShown ? "" : " Open the lesson to review it."}`);
    const notifiedAt = new Date().toISOString();
    const updatedIds = new Set(due.map((lesson) => lesson.id));
    const updatedLessons = state.lessons.map((lesson) => updatedIds.has(lesson.id)
      ? { ...lesson, reminderNotifiedAt: notifiedAt }
      : lesson);
    try {
      await persistLessons(updatedLessons);
    } finally {
      state.reminderCheckRunning = false;
    }
  }

  async function removeLesson() {
    const lesson = state.lessons.find((item) => item.id === state.selectedLessonId);
    if (!lesson) return;
    if (!window.confirm(`Delete “${lesson.title}”? This cannot be undone unless you have a backup.`)) return;
    const deletedIds = { ...state.deletedIds, [lesson.id]: new Date().toISOString() };
    if (!await persistLessons(state.lessons.filter((item) => item.id !== lesson.id), false, deletedIds)) return;
    elements.detailDialog.close();
    showToast("Lesson deleted.");
  }

  function exportBackup() {
    const backup = {
      app: "Ope' Code Vault",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      lessons: state.lessons,
      deletedIds: state.deletedIds
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ope-code-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    try {
      localStorage.setItem(BACKUP_EXPORTED_KEY, new Date().toISOString());
      showToast("Your backup file has been downloaded. Keep it somewhere separate from this device.");
      refreshStorageStatus();
    } catch (error) {
      showToast(`Backup downloaded, but its export date could not be recorded: ${error.message}`, true);
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 bytes";
    const units = ["bytes", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  async function refreshStorageStatus() {
    const target = byId("storage-status");
    if (!target) return;
    try {
      const snapshots = await window.VaultStorage.snapshots();
      const estimate = await window.VaultStorage.estimate();
      const mode = window.VaultStorage.mode === "indexeddb"
        ? "IndexedDB on this device (not encrypted)"
        : window.VaultStorage.mode === "localstorage" ? "Basic browser storage (automatic restore points unavailable)" : "Storage unavailable";
      const usage = estimate && estimate.quota ? ` · ${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)} used` : "";
      const recovery = state.recoveryMode ? " A previous restore point is loaded read-only until you explicitly restore it or import a backup." : "";
      const lastExport = localStorage.getItem(BACKUP_EXPORTED_KEY);
      const exportStatus = lastExport ? ` · Last backup export: ${formatDateTime(lastExport)}` : " · No backup export recorded yet";
      target.textContent = `${mode} · ${snapshots.length} automatic restore point${snapshots.length === 1 ? "" : "s"}${usage}${exportStatus}.${recovery} Export a backup for protection from device loss or browser data clearing.`;
    } catch (error) {
      target.textContent = `Storage status could not be checked: ${error.message}`;
      showToast(`Could not check automatic restore points: ${error.message}`, true);
    }
  }

  async function refreshRestorePoints() {
    const select = byId("snapshot-select");
    const button = byId("restore-snapshot-button");
    byId("restore-legacy-button").hidden = !state.recoveryLegacy;
    if (!select || !button) return;
    try {
      const snapshots = await window.VaultStorage.snapshots();
      select.replaceChildren();
      if (!snapshots.length) {
        select.append(new Option("No automatic restore points yet", ""));
      } else {
        select.append(new Option("Choose a saved point", ""));
        snapshots.forEach((snapshot) => {
          select.append(new Option(formatDateTime(snapshot.savedAt), snapshot.key));
        });
      }
      if (state.recoveryKey) select.value = state.recoveryKey;
      button.disabled = !select.value;
    } catch (error) {
      select.replaceChildren(new Option("Restore points unavailable", ""));
      button.disabled = true;
      showToast(`Could not load automatic restore points: ${error.message}`, true);
    }
  }

  async function restoreSnapshot() {
    const key = byId("snapshot-select").value;
    if (!key) return;
    try {
      const snapshots = await window.VaultStorage.snapshots();
      const snapshot = snapshots.find((item) => item.key === key);
      if (!snapshot) throw new Error("That restore point is no longer available.");
      const restoredLibrary = parseLibrary(snapshot.value);
      const restored = restoredLibrary.lessons;
      if (!window.confirm(`Restore ${restored.length} lesson(s) from ${formatDateTime(snapshot.savedAt)}? This replaces the current library. The current save will be kept as another restore point.`)) return;
      if (!await persistLessons(restored, true, restoredLibrary.deletedIds)) return;
      state.storageBlocked = false;
      state.recoveryMode = false;
      state.recoveryKey = null;
      showToast("The selected restore point is now your active library.");
      refreshStorageStatus();
    } catch (error) {
      showToast(`Could not restore that point: ${error.message}`, true);
    }
  }

  async function restoreLegacyCopy() {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (!text) throw new Error("The older browser copy is no longer available.");
      const library = parseLibrary(text);
      if (!window.confirm(`Restore ${library.lessons.length} lesson(s) from the older browser copy? The current saved data will be kept as a restore point.`)) return;
      if (!await persistLessons(library.lessons, true, library.deletedIds)) return;
      showToast("The older browser copy has been restored.");
    } catch (error) {
      showToast(`Could not restore the older browser copy: ${error.message}`, true);
    }
  }

  async function requestPersistentStorage() {
    try {
      const granted = await window.VaultStorage.requestPersistentStorage();
      showToast(granted
        ? "The browser agreed not to automatically evict this app's data. Keep exporting backups; this does not protect against clearing browser data or device loss."
        : "The browser did not grant persistent storage. Automatic restore points remain on this device; export backups regularly.", !granted);
      refreshStorageStatus();
    } catch (error) {
      showToast(`Could not request storage protection: ${error.message}`, true);
    }
  }

  async function importBackup(file) {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      showToast("This backup is larger than the 5 MB import limit.", true);
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.lessons)) {
        throw new Error("This file is not a supported Java Vault backup.");
      }
      if (parsed.lessons.length > MAX_LESSONS) throw new Error("This backup contains too many lessons.");
      const importedLibrary = parseLibrary(parsed);
      const imported = importedLibrary.lessons;
      if (!window.confirm(`Import ${imported.length} lesson(s)? They will be merged into this library; matching IDs will be replaced.`)) return;
      const merged = new Map(state.lessons.map((lesson) => [lesson.id, lesson]));
      imported.forEach((lesson) => merged.set(lesson.id, lesson));
      const deletedIds = { ...state.deletedIds, ...importedLibrary.deletedIds };
      imported.forEach((lesson) => {
        if (deletedIds[lesson.id] && Date.parse(lesson.updatedAt) > Date.parse(deletedIds[lesson.id])) {
          delete deletedIds[lesson.id];
        }
      });
      if (!await persistLessons([...merged.values()].filter((lesson) => !deletedIds[lesson.id]), true, deletedIds)) return;
      showToast(`${imported.length} lesson(s) imported.`);
    } catch (error) {
      showToast(`Import failed: ${error.message || "the backup could not be read"}`, true);
    } finally {
      elements.importFile.value = "";
    }
  }

  function validateEndpoint(rawEndpoint) {
    let url;
    try {
      url = new URL(rawEndpoint.trim());
    } catch {
      throw new Error("Enter a valid AI endpoint URL.");
    }
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("The AI endpoint must use HTTP or HTTPS.");
    if (url.username || url.password) throw new Error("Do not put credentials in the endpoint URL.");
    if (url.protocol !== "https:" && !localHosts.has(url.hostname)) {
      throw new Error("Use HTTPS for remote AI endpoints. HTTP is allowed only for a local model.");
    }
    return url.toString().replace(/\/+$/, "");
  }

  function makeAiUrl(endpoint, provider) {
    if (provider === "ollama") return /\/api\/chat$/i.test(endpoint) ? endpoint : `${endpoint}/api/chat`;
    if (/\/v1\/chat\/completions$/i.test(endpoint)) return endpoint;
    if (/\/v1$/i.test(endpoint)) return `${endpoint}/chat/completions`;
    return `${endpoint}/v1/chat/completions`;
  }

  async function requestAiReview(lesson) {
    if (isAiBusy) return;
    const provider = byId("ai-provider").value;
    const endpoint = validateEndpoint(byId("ai-endpoint").value);
    const model = byId("ai-model").value.trim();
    const apiKey = state.aiKey;
    if (!model) throw new Error("Add a model name in Settings before requesting a review.");
    if (provider === "compatible" && !apiKey) throw new Error("Enter your API key in Settings. It is kept only for this browser session.");
    if (!window.confirm("This sends the selected lesson’s code, notes, and learning summary to the AI endpoint you configured. Continue?")) return;

    isAiBusy = true;
    byId("review-ai-button").disabled = true;
    byId("review-ai-button").textContent = "Reviewing…";
    const prompt = [
      `Lesson title: ${lesson.title}`,
      `Topics: ${lesson.topics.join(", ") || "not provided"}`,
      `Learner comments: ${lesson.notes || "not provided"}`,
      `Learner's explanation of what they learned: ${lesson.learned || "not provided"}`,
      "Java code:",
      lesson.code
    ].join("\n\n");
    const system = "You are a kind, accurate Java learning coach for a beginner. Review the learner's explanation and code. Correct misunderstandings gently, explain why, identify code issues only when you can support the claim, and end with one short question to check understanding. Use clear headings. If information is insufficient, say so. Do not execute code.";

    try {
      const isOllama = provider === "ollama";
      const headers = { "Content-Type": "application/json" };
      if (!isOllama && apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const payload = isOllama
        ? { model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }
        : { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.2 };
      const response = await fetch(makeAiUrl(endpoint, provider), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90000)
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`AI endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const data = await response.json();
      const reviewText = isOllama ? data.message && data.message.content : data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof reviewText !== "string" || !reviewText.trim()) throw new Error("The AI endpoint returned no review text.");
      const updated = {
        ...lesson,
        aiReview: { text: reviewText.slice(0, 20000), reviewedAt: new Date().toISOString(), model },
        updatedAt: new Date().toISOString()
      };
      const next = state.lessons.map((item) => item.id === lesson.id ? updated : item);
      if (!await persistLessons(next)) return;
      renderDetail(updated);
      showToast("AI review saved with this lesson.");
    } finally {
      isAiBusy = false;
      const current = state.lessons.find((item) => item.id === state.selectedLessonId);
      if (current && elements.detailDialog.open) renderDetail(current);
    }
  }

  function readCloudSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(CLOUD_SETTINGS_KEY) || "{}");
      const projectUrl = typeof saved.projectUrl === "string" ? saved.projectUrl : "";
      const publicKey = typeof saved.publicKey === "string" ? saved.publicKey : "";
      byId("cloud-project-url").value = projectUrl;
      byId("cloud-public-key").value = publicKey;
      updateCloudButtons(Boolean(projectUrl && publicKey));
      byId("cloud-status").textContent = projectUrl && publicKey
        ? "Configured. Sign in with Google to connect."
        : "Not configured. Local storage remains active.";
    } catch (error) {
      byId("cloud-status").textContent = `Cloud settings could not be read: ${error.message}`;
      showToast(`Cloud settings could not be read: ${error.message}`, true);
    }
  }

  function updateCloudButtons(configured, signedIn = false) {
    byId("cloud-sign-in-button").disabled = !configured;
    byId("cloud-sync-button").disabled = !configured || !signedIn;
    byId("cloud-sign-out-button").hidden = !signedIn;
  }

  function validateCloudSettings(projectUrl, publicKey) {
    let url;
    try {
      url = new URL(projectUrl);
    } catch {
      throw new Error("Enter a valid Supabase project URL.");
    }
    if (!["https:", "http:"].includes(url.protocol) || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new Error("Use an HTTPS Supabase project URL.");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("Enter the project URL only, without credentials or extra URL parameters.");
    if (url.pathname !== "/") throw new Error("Enter the Supabase project root URL, without a path.");
    if (publicKey.length < 20 || publicKey.length > 2000) throw new Error("Enter the project's public anon or publishable key.");
    try {
      const jwtParts = publicKey.split(".");
      if (jwtParts.length === 3) {
        const claims = JSON.parse(atob(jwtParts[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (claims.role === "service_role") throw new Error("A service-role key grants admin access and must never be used in a browser.");
      }
    } catch (error) {
      if (error.message.includes("service-role")) throw error;
    }
    return { projectUrl: url.toString().replace(/\/+$/, ""), publicKey };
  }

  async function getCloudClient() {
    const config = validateCloudSettings(byId("cloud-project-url").value.trim(), byId("cloud-public-key").value.trim());
    if (state.cloudClient && state.cloudClientUrl === config.projectUrl && state.cloudClientKey === config.publicKey) return state.cloudClient;
    if (!state.cloudSdkPromise) {
      state.cloudSdkPromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm")
        .then((sdk) => sdk.createClient)
        .catch((error) => {
          state.cloudSdkPromise = null;
          throw new Error(`Could not load the optional Supabase client: ${error.message}`);
        });
    }
    const createClient = await state.cloudSdkPromise;
    state.cloudClient = createClient(config.projectUrl, config.publicKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
    });
    state.cloudClientUrl = config.projectUrl;
    state.cloudClientKey = config.publicKey;
    const { data, error } = await state.cloudClient.auth.getSession();
    if (error) throw new Error(`Could not check Supabase sign-in: ${error.message}`);
    const configured = true;
    const signedIn = Boolean(data.session);
    updateCloudButtons(configured, signedIn);
    byId("cloud-status").textContent = signedIn
      ? `Signed in${data.session.user.email ? ` as ${data.session.user.email}` : ""}. Sync is manual.`
      : "Configured. Sign in with Google to connect.";
    return state.cloudClient;
  }

  function saveCloudSettings(event) {
    event.preventDefault();
    try {
      const settings = validateCloudSettings(
        byId("cloud-project-url").value.trim(),
        byId("cloud-public-key").value.trim()
      );
      localStorage.setItem(CLOUD_SETTINGS_KEY, JSON.stringify(settings));
      state.cloudClient = null;
      state.cloudClientUrl = "";
      byId("cloud-status").textContent = "Settings saved on this device. Choose Continue with Google to sign in.";
      updateCloudButtons(true);
      showToast("Supabase settings saved. The public key is stored locally; never use a service-role key.");
    } catch (error) {
      showToast(error.message || "Could not save cloud settings.", true);
    }
  }

  async function cloudSignIn() {
    const client = await getCloudClient();
    const { data, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw new Error(`Could not check Supabase sign-in: ${sessionError.message}`);
    if (data.session) {
      byId("cloud-status").textContent = `Signed in${data.session.user.email ? ` as ${data.session.user.email}` : ""}. Sync is manual.`;
      updateCloudButtons(true, true);
      showToast("You are already signed in.");
      return;
    }
    const redirectTo = new URL("./java-vault.html", window.location.href).href;
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo, skipBrowserRedirect: false }
    });
    if (error) throw new Error(`Google sign-in failed: ${error.message}`);
    byId("cloud-status").textContent = "Opening Google sign-in…";
  }

  async function cloudSignOut() {
    const client = await getCloudClient();
    const { error } = await client.auth.signOut();
    if (error) throw new Error(`Could not sign out: ${error.message}`);
    updateCloudButtons(true, false);
    byId("cloud-status").textContent = "Signed out. Your lessons are still saved on this device.";
    showToast("Signed out. Your local lesson library is unchanged.");
  }

  async function syncCloud() {
    if (state.storageBlocked || state.recoveryMode) {
      throw new Error("Restore or import a valid local library before syncing to avoid overwriting recoverable data.");
    }
    const client = await getCloudClient();
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError) throw new Error(`Could not verify your account: ${userError.message}`);
    if (!userData.user) throw new Error("Sign in with Google before syncing.");
    byId("cloud-sync-button").disabled = true;
    byId("cloud-status").textContent = "Loading your cloud lessons…";
    try {
      const remoteRows = [];
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await client.from("vault_lessons")
          .select("id,lesson,updated_at,deleted_at")
          .order("id")
          .range(offset, offset + pageSize - 1);
        if (error) throw new Error(`Could not read cloud lessons: ${error.message}`);
        remoteRows.push(...data);
        if (data.length < pageSize) break;
      }

      const merged = new Map();
      state.lessons.forEach((lesson) => merged.set(lesson.id, {
        lesson,
        timestamp: Date.parse(lesson.updatedAt)
      }));
      Object.entries(state.deletedIds).forEach(([id, deletedAt]) => merged.set(id, {
        lesson: null,
        timestamp: Date.parse(deletedAt)
      }));
      remoteRows.forEach((row) => {
        if (!row || typeof row.id !== "string" || row.id.length < 1 || row.id.length > 100) {
          throw new Error("Cloud contains a record with an invalid lesson ID. Nothing was synced.");
        }
        let candidate;
        if (row.deleted_at) {
          const timestamp = Date.parse(row.deleted_at);
          if (Number.isNaN(timestamp) || row.lesson !== null) {
            throw new Error(`Cloud record ${row.id} has an invalid deletion marker. Nothing was synced.`);
          }
          candidate = { lesson: null, timestamp };
        } else {
          try {
            const lesson = normalizeLesson(row.lesson);
            if (lesson.id !== row.id) throw new Error("The lesson ID does not match the row ID.");
            const rowTimestamp = Date.parse(row.updated_at);
            candidate = { lesson, timestamp: Number.isNaN(rowTimestamp) ? Date.parse(lesson.updatedAt) : Math.max(rowTimestamp, Date.parse(lesson.updatedAt)) };
          } catch (error) {
            throw new Error(`Cloud record ${row.id} has invalid lesson data: ${error.message}. Nothing was synced.`);
          }
        }
        const existing = merged.get(row.id);
        if (!existing || candidate.timestamp > existing.timestamp) merged.set(row.id, candidate);
      });

      const lessons = [];
      const deletedIds = {};
      merged.forEach((entry, id) => {
        if (entry.lesson) lessons.push(entry.lesson);
        else deletedIds[id] = new Date(entry.timestamp).toISOString();
      });
      if (lessons.length > MAX_LESSONS || Object.keys(deletedIds).length > MAX_LESSONS) {
        throw new Error("The merged library is larger than this version supports. Export backups and reduce the library before syncing.");
      }
      if (!await persistLessons(lessons, false, deletedIds)) {
        throw new Error("The merged lessons could not be saved locally, so the cloud was not updated.");
      }

      const userId = userData.user.id;
      const rows = [
        ...lessons.map((lesson) => ({
          user_id: userId,
          id: lesson.id,
          lesson,
          updated_at: lesson.updatedAt,
          deleted_at: null
        })),
        ...Object.entries(deletedIds).map(([id, deletedAt]) => ({
          user_id: userId,
          id,
          lesson: null,
          updated_at: deletedAt,
          deleted_at: deletedAt
        }))
      ];
      for (let offset = 0; offset < rows.length; offset += 100) {
        const { error } = await client.from("vault_lessons")
          .upsert(rows.slice(offset, offset + 100), { onConflict: "user_id,id" });
        if (error) throw new Error(`Local merge saved, but cloud sync stopped while uploading: ${error.message}`);
      }
      byId("cloud-status").textContent = `Synced ${lessons.length} lesson${lessons.length === 1 ? "" : "s"} with ${userData.user.email || "your account"}.`;
      showToast(`Cloud sync complete: ${lessons.length} lessons are up to date.`);
      updateCloudButtons(true, true);
    } finally {
      byId("cloud-sync-button").disabled = false;
    }
  }

  function saveAiSettings(event) {
    event.preventDefault();
    const provider = byId("ai-provider").value;
    const endpoint = validateEndpoint(byId("ai-endpoint").value);
    const model = byId("ai-model").value.trim();
    if (!model) {
      showToast("Add a model name to save your AI settings.", true);
      return;
    }
    const settings = { provider, endpoint, model };
    try {
      localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
      state.aiKey = provider === "compatible" ? byId("ai-key").value.trim() : "";
      byId("ai-key").value = state.aiKey;
      byId("ai-settings-feedback").textContent = provider === "compatible" && state.aiKey
        ? "Settings saved. API key is kept in memory only."
        : "Settings saved on this device.";
      showToast("AI settings saved.");
    } catch (error) {
      showToast(`Could not save AI settings: ${error.message}`, true);
    }
  }

  function showCloudError(error, action) {
    const message = error && error.message ? error.message : "unknown error";
    byId("cloud-status").textContent = `${action} failed: ${message}`;
    showToast(`${action} failed: ${message}`, true);
  }

  function bindEvents() {
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
    document.querySelectorAll("[data-create]").forEach((button) => button.addEventListener("click", () => openEditor()));
    byId("new-lesson-button").addEventListener("click", () => openEditor());
    byId("backup-button").addEventListener("click", () => navigate("settings"));
    elements.lessonForm.addEventListener("submit", handleSaveLesson);
    document.querySelectorAll("[data-close-editor]").forEach((button) => button.addEventListener("click", () => elements.editorDialog.close()));
    document.querySelectorAll("[data-close-detail]").forEach((button) => button.addEventListener("click", () => elements.detailDialog.close()));
    byId("edit-lesson-button").addEventListener("click", () => {
      const lesson = state.lessons.find((item) => item.id === state.selectedLessonId);
      if (!lesson) return;
      elements.detailDialog.close();
      openEditor(lesson);
    });
    byId("delete-lesson-button").addEventListener("click", removeLesson);
    byId("review-ai-button").addEventListener("click", async () => {
      const lesson = state.lessons.find((item) => item.id === state.selectedLessonId);
      if (!lesson) return;
      try {
        await requestAiReview(lesson);
      } catch (error) {
        showToast(error.message || "AI review failed.", true);
      }
    });
    byId("export-button").addEventListener("click", exportBackup);
    byId("import-button").addEventListener("click", () => elements.importFile.click());
    elements.importFile.addEventListener("change", () => importBackup(elements.importFile.files[0]));
    byId("restore-snapshot-button").addEventListener("click", restoreSnapshot);
    byId("restore-legacy-button").addEventListener("click", restoreLegacyCopy);
    byId("snapshot-select").addEventListener("change", () => {
      byId("restore-snapshot-button").disabled = !byId("snapshot-select").value;
    });
    byId("protect-storage-button").addEventListener("click", requestPersistentStorage);
    byId("cloud-settings-form").addEventListener("submit", saveCloudSettings);
    byId("cloud-sign-in-button").addEventListener("click", async () => {
      try {
        await cloudSignIn();
      } catch (error) {
        showCloudError(error, "Google sign-in");
      }
    });
    byId("cloud-sync-button").addEventListener("click", async () => {
      try {
        await syncCloud();
      } catch (error) {
        showCloudError(error, "Cloud sync");
        updateCloudButtons(true, true);
      }
    });
    byId("cloud-sign-out-button").addEventListener("click", async () => {
      try {
        await cloudSignOut();
      } catch (error) {
        showCloudError(error, "Sign out");
      }
    });
    elements.search.addEventListener("input", () => {
      state.search = elements.search.value.trim();
      render();
    });
    elements.status.addEventListener("change", () => {
      state.status = elements.status.value;
      render();
    });
    elements.sort.addEventListener("change", () => {
      state.sort = elements.sort.value;
      render();
    });
    byId("ai-provider").addEventListener("change", () => {
      state.aiKey = byId("ai-key").value;
      const provider = byId("ai-provider").value;
      byId("ai-endpoint").value = provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com";
      byId("ai-model").value = provider === "ollama" ? "qwen2.5-coder:7b" : "";
      updateAiFields();
    });
    byId("ai-key").addEventListener("input", () => { state.aiKey = byId("ai-key").value; });
    byId("ai-settings-form").addEventListener("submit", (event) => {
      try {
        saveAiSettings(event);
      } catch (error) {
        event.preventDefault();
        showToast(error.message || "Could not save AI settings.", true);
      }
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        elements.search.focus();
      }
      if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "n"
        && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
        && !elements.editorDialog.open && !elements.detailDialog.open) {
        openEditor();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkDueReminders();
    });
    window.addEventListener("focus", checkDueReminders);
    elements.editorDialog.addEventListener("click", (event) => {
      if (event.target === elements.editorDialog) elements.editorDialog.close();
    });
    elements.detailDialog.addEventListener("click", (event) => {
      if (event.target === elements.detailDialog) elements.detailDialog.close();
    });
  }

  async function initialize() {
    try {
      state.lessons = await loadLessons();
      state.storageMode = window.VaultStorage.mode;
    } catch (error) {
      state.storageBlocked = true;
      showToast(error.message, true);
      state.lessons = [];
    }
    loadAiSettings();
    readCloudSettings();
    bindEvents();
    render();
    registerOfflineApp();
    checkDueReminders();
    refreshStorageStatus();
    refreshRestorePoints();
    window.setInterval(checkDueReminders, 30000);
    window.setInterval(() => {
      const previousDueCount = byId("due-nav-count").textContent;
      renderStats();
      if (state.view === "study" && previousDueCount !== byId("due-nav-count").textContent) render();
    }, 60000);
    const lessonToOpen = new URLSearchParams(location.search).get("lesson");
    if (lessonToOpen) openLesson(lessonToOpen);
  }

  function registerOfflineApp() {
    if (!("serviceWorker" in navigator) || !["http:", "https:"].includes(location.protocol)) return;
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "open-lesson" && typeof event.data.lessonId === "string") {
        openLesson(event.data.lessonId);
      }
    });
    navigator.serviceWorker.register("./service-worker.js")
      .catch((error) => showToast(`Offline app setup could not finish: ${error.message}`, true));
  }

  initialize();
})();
