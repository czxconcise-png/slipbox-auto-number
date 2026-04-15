let obsidian;

try {
  obsidian = require("obsidian");
} catch (error) {
  obsidian = {
    Plugin: class {},
    Notice: class {
      constructor(message) {
        this.message = message;
      }
    },
    Modal: class {
      constructor(app) {
        this.app = app;
        this.contentEl = {
          empty() {},
          createEl() {
            return this;
          },
          createDiv() {
            return this;
          },
          addClass() {},
        };
      }
      open() {}
      close() {}
    },
    PluginSettingTab: class {
      constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = {
          empty() {},
          createEl() {
            return this;
          },
          createDiv() {
            return this;
          },
        };
      }
    },
    MarkdownView: class {},
    Setting: class {
      setName() {
        return this;
      }
      setDesc() {
        return this;
      }
      addText() {
        return this;
      }
      addToggle() {
        return this;
      }
      addDropdown() {
        return this;
      }
      addButton() {
        return this;
      }
    },
    normalizePath(path) {
      return path.replace(/\\/g, "/").replace(/\/+/g, "/");
    },
  };
}

const { Plugin, Notice, Modal, PluginSettingTab, Setting, normalizePath, MarkdownView } = obsidian;

const DEFAULT_SETTINGS = {
  autoDetect: true,
  unresolvedLinkMode: "link-only",
  profiles: [],
};

const NUMBERED_NAME_PATTERNS = [
  /^(\d+(?:\.\d+)+[a-z0-9]*)(?=\s|$|[（(])/i,
  /^(\d+\.)(?=\s|$|[（(])/i,
  /^(\d+\.[a-z0-9]+)(?=\s|$|[（(])/i,
];

function cloneDefaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function samePath(left, right) {
  const normalizedLeft = normalizeConfiguredPath(left);
  const normalizedRight = normalizeConfiguredPath(right);
  return normalizedLeft === normalizedRight;
}

function normalizeConfiguredPath(path) {
  const normalized = normalizePath(path || "").trim();
  if (!normalized) {
    return "";
  }

  return /\.md$/i.test(normalized) ? normalized : `${normalized}.md`;
}

function splitLines(content) {
  return content.split(/\r?\n/);
}

function measureIndent(indent) {
  let width = 0;
  for (const char of indent) {
    width += char === "\t" ? 4 : 1;
  }
  return width;
}

function parseListLine(line) {
  const match = line.match(/^([ \t]*)-\s+\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
  if (!match) {
    return null;
  }

  return {
    indentText: match[1],
    indent: measureIndent(match[1]),
    linkName: match[2].trim(),
  };
}

function parseNumberedName(name) {
  const trimmed = name.trim();
  for (const pattern of NUMBERED_NAME_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        id: match[1],
        title: trimmed.slice(match[1].length).trim(),
      };
    }
  }
  return null;
}

function hasNumberPrefix(name) {
  return parseNumberedName(name) !== null;
}

function incrementLetters(value) {
  const letters = value.toLowerCase().split("");
  let carry = true;

  for (let index = letters.length - 1; index >= 0; index -= 1) {
    if (!carry) {
      break;
    }

    if (letters[index] === "z") {
      letters[index] = "a";
    } else {
      letters[index] = String.fromCharCode(letters[index].charCodeAt(0) + 1);
      carry = false;
    }
  }

  return carry ? `a${letters.join("")}` : letters.join("");
}

function incrementId(id, isRoot) {
  if (isRoot) {
    const lifeRoot = id.match(/^(\d+)\.(\d+)$/);
    if (lifeRoot) {
      return `${Number(lifeRoot[1]) + 1}.${lifeRoot[2]}`;
    }

    const dottedRoot = id.match(/^(\d+)\.$/);
    if (dottedRoot) {
      return `${Number(dottedRoot[1]) + 1}.`;
    }
  }

  const letterTail = id.match(/[a-z]+$/i);
  if (letterTail) {
    return `${id.slice(0, -letterTail[0].length)}${incrementLetters(letterTail[0])}`;
  }

  const numberTail = id.match(/\d+$/);
  if (numberTail) {
    return `${id.slice(0, -numberTail[0].length)}${Number(numberTail[0]) + 1}`;
  }

  if (id.endsWith(".")) {
    return `${id}1`;
  }

  return `${id}a`;
}

function firstChildId(parentId) {
  if (parentId.endsWith(".")) {
    return `${parentId}1`;
  }

  return /\d$/.test(parentId) ? `${parentId}a` : `${parentId}1`;
}

function inferFirstRootId(nodes) {
  const firstRoot = nodes.find((node) => node.indent === 0);
  if (!firstRoot) {
    return "1.1";
  }

  if (/^\d+\.\d+$/.test(firstRoot.id)) {
    const secondPart = firstRoot.id.split(".")[1];
    return `1.${secondPart}`;
  }

  if (/^\d+\.$/.test(firstRoot.id)) {
    return "1.";
  }

  return "1.1";
}

function collectNumberedNodes(lines, ignoredLineIndex) {
  const nodes = [];
  const nodesByLine = new Map();

  lines.forEach((line, index) => {
    if (index === ignoredLineIndex) {
      return;
    }

    const listItem = parseListLine(line);
    if (!listItem) {
      return;
    }

    const numbered = parseNumberedName(listItem.linkName);
    if (!numbered) {
      return;
    }

    const node = {
      lineIndex: index,
      indent: listItem.indent,
      id: numbered.id,
      title: listItem.linkName,
    };
    nodes.push(node);
    nodesByLine.set(index, node);
  });

  return { nodes, nodesByLine };
}

function findContext(lines, lineIndex, currentIndent, nodesByLine) {
  let parent = null;
  let previousSibling = null;
  let nextSibling = null;

  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const node = nodesByLine.get(index);
    if (!node) {
      continue;
    }

    if (!previousSibling && node.indent === currentIndent) {
      previousSibling = node;
    }

    if (node.indent < currentIndent) {
      parent = node;
      break;
    }
  }

  for (let index = lineIndex + 1; index < lines.length; index += 1) {
    const listItem = parseListLine(lines[index]);
    if (!listItem) {
      continue;
    }

    if (currentIndent > 0 && parent && listItem.indent <= parent.indent) {
      break;
    }

    if (listItem.indent < currentIndent) {
      break;
    }

    const node = nodesByLine.get(index);
    if (node && node.indent === currentIndent) {
      nextSibling = node;
      break;
    }
  }

  return { parent, previousSibling, nextSibling };
}

function buildNumberProposal(lines, lineIndex, profileName) {
  const currentLine = lines[lineIndex] || "";
  const current = parseListLine(currentLine);
  if (!current) {
    return {
      ok: false,
      reason: "当前行不是 Slip Box 列表中的 wikilink。",
    };
  }

  if (hasNumberPrefix(current.linkName)) {
    return {
      ok: false,
      reason: "当前链接已经有编号了。",
    };
  }

  const { nodes, nodesByLine } = collectNumberedNodes(lines, lineIndex);
  const existingIds = new Set(nodes.map((node) => node.id));
  const { parent, previousSibling, nextSibling } = findContext(
    lines,
    lineIndex,
    current.indent,
    nodesByLine
  );

  let newId;

  if (current.indent === 0) {
    newId = previousSibling ? incrementId(previousSibling.id, true) : inferFirstRootId(nodes);
  } else if (previousSibling) {
    newId = incrementId(previousSibling.id, false);
  } else if (parent) {
    newId = firstChildId(parent.id);
  } else {
    return {
      ok: false,
      reason: "这一行有缩进，但上方找不到可作为父卡片的编号行。",
    };
  }

  if (existingIds.has(newId)) {
    return {
      ok: false,
      reason: `建议编号 ${newId} 已经存在。请把新链接放到同级末尾，或增加缩进让它成为子卡片。`,
      linkName: current.linkName,
      newId,
      parent,
      previousSibling,
      nextSibling,
    };
  }

  return {
    ok: true,
    profileName: profileName || "Slip Box",
    linkName: current.linkName,
    lineNumber: lineIndex + 1,
    newId,
    parent,
    previousSibling,
    nextSibling,
  };
}

function linkBasename(linkName) {
  const normalized = normalizePath(linkName);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function displaySlipBoxPath(path, fallback) {
  if (!path) {
    return fallback;
  }

  const basename = linkBasename(path).replace(/\.md$/i, "");
  return basename || path || fallback;
}

function parentPath(path) {
  const normalized = normalizePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : "";
}

function renamedLinkTarget(oldLinkName, newBasename) {
  const normalized = normalizePath(oldLinkName);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? `${normalized.slice(0, slashIndex + 1)}${newBasename}` : newBasename;
}

function replaceWikilinkTargetInLine(line, oldLinkName, newTargetName) {
  return line.replace(/\[\[([^\]|#]+)((?:#[^\]|]+)?(?:\|[^\]]+)?)\]\]/, (full, target, suffix) => {
    return target.trim() === oldLinkName ? `[[${newTargetName}${suffix || ""}]]` : full;
  });
}

function hasUnnumberedLinks(lines) {
  return lines.some((line) => {
    const parsed = parseListLine(line);
    return parsed && !hasNumberPrefix(parsed.linkName);
  });
}

function batchPromptKey(file, lines) {
  const entries = [];
  lines.forEach((line, index) => {
    const parsed = parseListLine(line);
    if (parsed && !hasNumberPrefix(parsed.linkName)) {
      entries.push(`${index}:${line}`);
    }
  });

  return entries.length > 0 ? `${file.path}:batch:${entries.join("\n")}` : null;
}

function buildBatchNumberProposals(lines, profileName) {
  const workingLines = lines.slice();
  const proposals = [];
  const errors = [];

  workingLines.forEach((line, index) => {
    const parsed = parseListLine(line);
    if (!parsed || hasNumberPrefix(parsed.linkName)) {
      return;
    }

    const proposal = buildNumberProposal(workingLines, index, profileName);
    if (!proposal.ok) {
      errors.push({
        lineNumber: index + 1,
        linkName: parsed.linkName,
        reason: proposal.reason,
      });
      return;
    }

    proposals.push(proposal);
    const simulatedBasename = `${proposal.newId} ${linkBasename(proposal.linkName)}`;
    workingLines[index] = replaceWikilinkTargetInLine(workingLines[index], proposal.linkName, simulatedBasename);
  });

  return { proposals, errors, workingLines };
}

function settingProfileId() {
  return `slip-box-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function proposalSafeName(name) {
  return name || "(空链接)";
}

class ConfirmNumberModal extends Modal {
  constructor(app, proposal, targetInfo, newPath) {
    super(app);
    this.proposal = proposal;
    this.targetInfo = targetInfo;
    this.newPath = newPath;
    this.wasResolved = false;
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("slipbox-auto-number-modal");

    contentEl.createEl("h2", { text: "给这张卡片补编号？" });
    contentEl.createEl("p", {
      text: `卡片盒：${this.proposal.profileName}`,
    });

    const details = contentEl.createDiv({ cls: "slipbox-auto-number-details" });
    details.createEl("div", { text: `第 ${this.proposal.lineNumber} 行：[[${this.proposal.linkName}]]` });
    details.createEl("div", { text: `建议编号：${this.proposal.newId}` });
    const actionText =
      this.targetInfo.mode === "rename"
        ? "动作：重命名已有笔记"
        : this.targetInfo.mode === "create"
          ? "动作：创建空笔记"
          : "动作：只修改卡片盒链接，不创建笔记";
    details.createEl("div", { text: actionText });
    if (this.targetInfo.file) {
      details.createEl("div", { text: `当前文件：${this.targetInfo.file.path}` });
    }
    details.createEl("div", { text: `新链接：[[${this.targetInfo.newLinkTarget || linkBasename(this.newPath)}]]` });
    if (this.newPath) {
      details.createEl("div", { text: `新文件路径：${this.newPath}` });
    }

    if (this.proposal.parent) {
      details.createEl("div", { text: `父卡片：${this.proposal.parent.title}` });
    }
    if (this.proposal.previousSibling) {
      details.createEl("div", { text: `上一张同级卡片：${this.proposal.previousSibling.title}` });
    }

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("确认并重命名")
          .setCta()
          .onClick(() => {
            this.wasResolved = true;
            this.resolve(true);
            this.close();
          });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => {
          this.wasResolved = true;
          this.resolve(false);
          this.close();
        });
      });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.wasResolved) {
      this.wasResolved = true;
      this.resolve(false);
    }
  }
}

class ConfirmBatchNumberModal extends Modal {
  constructor(app, slipBoxName, plans, errors) {
    super(app);
    this.slipBoxName = slipBoxName;
    this.plans = plans;
    this.errors = errors;
    this.wasResolved = false;
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("slipbox-auto-number-modal");

    contentEl.createEl("h2", { text: "批量给卡片补编号？" });
    contentEl.createEl("p", {
      text: `卡片盒：${this.slipBoxName}`,
    });

    const details = contentEl.createDiv({ cls: "slipbox-auto-number-batch-list" });
    this.plans.forEach((plan) => {
      const item = details.createDiv({ cls: "slipbox-auto-number-batch-item" });
      item.createEl("div", {
        text: `第 ${plan.proposal.lineNumber} 行`,
        cls: "slipbox-auto-number-batch-line",
      });
      item.createEl("div", {
        text: `[[${plan.proposal.linkName}]] -> [[${plan.newLinkTarget}]]`,
      });
      item.createEl("div", {
        text: plan.actionText,
        cls: "slipbox-auto-number-batch-action",
      });
    });

    if (this.errors.length > 0) {
      const skipped = contentEl.createDiv({ cls: "slipbox-auto-number-batch-errors" });
      skipped.createEl("h3", { text: "未处理条目" });
      this.errors.forEach((error) => {
        skipped.createEl("div", {
          text: `第 ${error.lineNumber} 行：${error.reason}`,
        });
      });
    }

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText(`确认处理 ${this.plans.length} 条`)
          .setCta()
          .onClick(() => {
            this.wasResolved = true;
            this.resolve(true);
            this.close();
          });
      })
      .addButton((button) => {
        button.setButtonText("取消").onClick(() => {
          this.wasResolved = true;
          this.resolve(false);
          this.close();
        });
      });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.wasResolved) {
      this.wasResolved = true;
      this.resolve(false);
    }
  }
}

class SlipBoxSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Slip Box 自动编号" });
    containerEl.createEl("p", {
      text: "在这里配置哪些 Markdown 文件是一棵卡片盒树。插件只会在这些文件中检测无编号链接。",
    });

    const globalSection = containerEl.createDiv({ cls: "slipbox-auto-number-global" });
    globalSection.createEl("h3", { text: "全局行为" });

    new Setting(globalSection).setName("自动检测").addToggle((toggle) => {
      toggle.setValue(Boolean(this.plugin.settings.autoDetect)).onChange(async (value) => {
        this.plugin.settings.autoDetect = value;
        await this.plugin.saveSettings();
      });
    });

    new Setting(globalSection)
      .setName("空链接处理方式")
      .setDesc("当卡片盒里的链接还没有对应笔记时，默认只给链接补编号，不创建 md 文件。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("link-only", "只给链接补编号，不创建笔记")
          .addOption("create-note", "创建空笔记并补编号")
          .setValue(this.plugin.settings.unresolvedLinkMode || "link-only")
          .onChange(async (value) => {
            this.plugin.settings.unresolvedLinkMode = value;
            await this.plugin.saveSettings();
          });
    });

    new Setting(containerEl)
      .setName("新增 Slip Box 位置")
      .setDesc("新增一条 Slip Box 文件路径。")
      .addButton((button) => {
        button
          .setButtonText("新增位置")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.profiles.push({
              id: settingProfileId(),
              slipBoxPath: "",
            });
            await this.plugin.saveSettings();
            this.display();
          });
      });

    this.plugin.settings.profiles.forEach((profile, index) => {
      const section = containerEl.createDiv({ cls: "slipbox-auto-number-profile" });
      section.createEl("h3", {
        text: displaySlipBoxPath(profile.slipBoxPath, `Slip Box 位置 ${index + 1}`),
      });

      new Setting(section)
        .setName("位置")
        .setDesc("使用 vault 相对路径，例如 Slip Box/Life Slip Box.md")
        .addText((text) => {
          text
            .setPlaceholder("Slip Box/Life Slip Box.md")
            .setValue(profile.slipBoxPath)
            .onChange(async (value) => {
              profile.slipBoxPath = normalizeConfiguredPath(value);
              await this.plugin.saveSettings();
            });
        });

      new Setting(section).addButton((button) => {
        button
          .setButtonText("删除这个位置")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.profiles.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          });
      });
    });
  }
}

class SlipBoxAutoNumberPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.prompting = false;
    this.suppressedPromptKeys = new Set();

    this.addCommand({
      id: "number-current-unnumbered-link",
      name: "给当前无编号链接编号",
      editorCallback: async (editor, info) => {
        const file = this.getFileFromInfo(info);
        await this.numberCurrentLine(editor, file, false);
      },
    });

    this.addCommand({
      id: "number-active-unnumbered-link",
      name: "手动触发当前无编号链接编号",
      callback: async () => {
        await this.numberActiveEditorLine();
      },
    });

    this.addCommand({
      id: "scan-current-slipbox",
      name: "扫描当前卡片盒无编号链接",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const profile = this.getProfileForFile(file);
        if (!profile) {
          return false;
        }
        if (!checking) {
          const context = this.getActiveEditorContext();
          const editor = context && context.file && context.file.path === file.path ? context.editor : null;
          this.scanFile(file, profile, editor);
        }
        return true;
      },
    });

    this.addCommand({
      id: "clear-suppressed-prompts",
      name: "清除自动检测忽略记录",
      callback: () => {
        this.suppressedPromptKeys.clear();
        new Notice("已清除自动检测忽略记录。");
      },
    });

    this.addRibbonIcon("list-plus", "扫描当前 Slip Box 无编号链接", async () => {
      await this.numberActiveSlipBoxLinks(false);
    });

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        this.handleEditorChange(editor, info);
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const file = view && view.file ? view.file : this.app.workspace.getActiveFile();
        const profile = this.getProfileForFile(file);
        if (!profile) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("给当前无编号链接编号")
            .setIcon("list-plus")
            .onClick(async () => {
              await this.numberCurrentLine(editor, file, false);
            });
        });

        menu.addItem((item) => {
          item
            .setTitle("扫描当前卡片盒无编号链接")
            .setIcon("search")
            .onClick(async () => {
              await this.scanFile(file, profile, editor);
            });
        });
      })
    );

    this.addSettingTab(new SlipBoxSettingTab(this.app, this));
  }

  onunload() {
    if (this.autoDetectTimer) {
      window.clearTimeout(this.autoDetectTimer);
    }
  }

  async loadSettings() {
    const defaults = cloneDefaultSettings();
    const loaded = (await this.loadData()) || {};
    this.settings = Object.assign(defaults, loaded);
    const loadedProfiles = Array.isArray(loaded.profiles) ? loaded.profiles : defaults.profiles;
    this.settings.profiles = loadedProfiles;

    if (typeof loaded.autoDetect !== "boolean") {
      this.settings.autoDetect = loadedProfiles.some((profile) => profile && profile.autoDetect === false)
        ? false
        : defaults.autoDetect;
    }

    if (loaded.unresolvedLinkMode !== "create-note") {
      const legacyCreateMode = loadedProfiles.some((profile) => profile && profile.unresolvedLinkMode === "create-note");
      this.settings.unresolvedLinkMode = legacyCreateMode ? "create-note" : defaults.unresolvedLinkMode;
    }

    delete this.settings.newNoteFolderPath;

    this.settings.profiles.forEach((profile) => {
      if (!profile.id) {
        profile.id = settingProfileId();
      }
      delete profile.name;
      profile.slipBoxPath = normalizeConfiguredPath(profile.slipBoxPath || "");
      delete profile.autoDetect;
      delete profile.unresolvedLinkMode;
      delete profile.newNoteFolderPath;
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getFileFromInfo(info) {
    return info && info.file ? info.file : this.app.workspace.getActiveFile();
  }

  getProfileForFile(file) {
    if (!file || file.extension !== "md") {
      return null;
    }

    return this.settings.profiles.find((profile) => samePath(profile.slipBoxPath, file.path)) || null;
  }

  getActiveEditorContext() {
    const activeView =
      typeof this.app.workspace.getActiveViewOfType === "function"
        ? this.app.workspace.getActiveViewOfType(MarkdownView)
        : null;

    if (activeView && activeView.editor && activeView.file) {
      return {
        editor: activeView.editor,
        file: activeView.file,
      };
    }

    const activeEditor = this.app.workspace.activeEditor;
    if (activeEditor && activeEditor.editor && activeEditor.file) {
      return {
        editor: activeEditor.editor,
        file: activeEditor.file,
      };
    }

    return null;
  }

  async numberActiveEditorLine() {
    const context = this.getActiveEditorContext();
    if (!context) {
      new Notice("请先打开一个 Slip Box Markdown 编辑器。");
      return false;
    }

    return this.numberCurrentLine(context.editor, context.file, false);
  }

  async numberActiveSlipBoxLinks(fromAutoDetect) {
    const context = this.getActiveEditorContext();
    if (!context) {
      if (!fromAutoDetect) {
        new Notice("请先打开一个 Slip Box Markdown 编辑器。");
      }
      return false;
    }

    return this.numberAllUnnumbered(context.editor, context.file, fromAutoDetect);
  }

  handleEditorChange(editor, info) {
    const file = this.getFileFromInfo(info);
    const profile = this.getProfileForFile(file);
    if (!profile || !this.settings.autoDetect || this.prompting) {
      return;
    }

    const lines = splitLines(editor.getValue());
    if (!hasUnnumberedLinks(lines)) {
      return;
    }

    const promptKey = batchPromptKey(file, lines);
    if (this.suppressedPromptKeys.has(promptKey)) {
      return;
    }

    if (this.autoDetectTimer) {
      window.clearTimeout(this.autoDetectTimer);
    }

    this.autoDetectTimer = window.setTimeout(async () => {
      const currentLines = splitLines(editor.getValue());
      if (!hasUnnumberedLinks(currentLines)) {
        return;
      }

      await this.numberAllUnnumbered(editor, file, true);
    }, 800);
  }

  async numberCurrentLine(editor, file, fromAutoDetect) {
    const profile = this.getProfileForFile(file);
    if (!profile) {
      if (!fromAutoDetect) {
        new Notice("当前文件没有配置为 Slip Box。");
      }
      return false;
    }

    const cursor = editor.getCursor();
    const lines = splitLines(editor.getValue());
    const result = await this.proposeAndApply(lines, cursor.line, file, profile, fromAutoDetect, editor);
    return result === "applied";
  }

  async scanFile(file, profile, editor) {
    return this.numberAllUnnumbered(editor || null, file, false, profile);
  }

  async numberAllUnnumbered(editor, file, fromAutoDetect, knownProfile) {
    const profile = knownProfile || this.getProfileForFile(file);
    if (!profile) {
      if (!fromAutoDetect) {
        new Notice("当前文件没有配置为 Slip Box。");
      }
      return false;
    }

    const lines = editor ? splitLines(editor.getValue()) : splitLines(await this.app.vault.read(file));
    const promptKey = batchPromptKey(file, lines);
    if (!promptKey) {
      if (!fromAutoDetect) {
        new Notice("没有发现无编号链接。");
      }
      return false;
    }

    if (fromAutoDetect && this.suppressedPromptKeys.has(promptKey)) {
      return false;
    }

    const { plans, errors } = this.buildBatchPlans(lines, file, profile);
    if (plans.length === 0) {
      if (!fromAutoDetect) {
        const reason = errors.length > 0 ? `第一条原因：${errors[0].reason}` : "";
        new Notice(reason ? `发现无编号链接，但无法自动编号。${reason}` : "没有发现可自动编号的链接。");
      }
      this.suppressedPromptKeys.add(promptKey);
      return false;
    }

    this.prompting = true;
    try {
      const slipBoxName = displaySlipBoxPath(profile.slipBoxPath, file.basename);
      const confirmed = await this.confirmBatchNumber(slipBoxName, plans, errors);
      if (!confirmed) {
        this.suppressedPromptKeys.add(promptKey);
        return false;
      }

      await this.applyBatchPlans(plans, file, editor);
      const skippedText = errors.length > 0 ? `，跳过 ${errors.length} 条` : "";
      new Notice(`已处理 ${plans.length} 条无编号链接${skippedText}。`);
      return true;
    } finally {
      this.prompting = false;
    }
  }

  buildBatchPlans(lines, sourceFile, profile) {
    const slipBoxName = displaySlipBoxPath(profile.slipBoxPath, sourceFile.basename);
    const workingLines = lines.slice();
    const plans = [];
    const errors = [];
    const batchState = {
      newPaths: new Set(),
      linkTargets: new Set(),
      renamedSourcePaths: new Set(),
    };

    workingLines.forEach((line, lineIndex) => {
      const parsed = parseListLine(line);
      if (!parsed || hasNumberPrefix(parsed.linkName)) {
        return;
      }

      const proposal = buildNumberProposal(workingLines, lineIndex, slipBoxName);
      if (!proposal.ok) {
        errors.push({
          lineNumber: lineIndex + 1,
          linkName: parsed.linkName,
          reason: proposal.reason,
        });
        return;
      }

      const planResult = this.buildPlanForProposal(proposal, sourceFile, batchState);
      if (!planResult.ok) {
        errors.push({
          lineNumber: proposal.lineNumber,
          linkName: proposal.linkName,
          reason: planResult.reason,
        });
        return;
      }

      plans.push(planResult.plan);
      workingLines[lineIndex] = replaceWikilinkTargetInLine(
        workingLines[lineIndex],
        proposal.linkName,
        planResult.plan.newBasename
      );
    });

    return { plans, errors };
  }

  buildPlanForProposal(proposal, sourceFile, batchState) {
    const target = this.resolveTargetFile(proposal.linkName, sourceFile.path);
    if (!target.ok) {
      return { ok: false, reason: target.reason };
    }

    if (target.mode === "missing") {
      target.mode = this.settings.unresolvedLinkMode === "create-note" ? "create" : "link-only";
    }

    if (target.mode === "rename") {
      const sourcePathKey = normalizePath(target.file.path).toLowerCase();
      if (batchState.renamedSourcePaths.has(sourcePathKey)) {
        return {
          ok: false,
          reason: `同一个已有笔记 ${target.file.path} 在本次批量里出现了多次，请分开处理。`,
        };
      }
      batchState.renamedSourcePaths.add(sourcePathKey);
    }

    const newBasename = `${proposal.newId} ${target.basename}`;
    const newLinkTarget =
      target.mode === "create" ? newBasename : renamedLinkTarget(proposal.linkName, newBasename);
    const newPath =
      target.mode === "rename"
        ? normalizePath(`${parentPath(target.file.path)}${newBasename}.md`)
        : target.mode === "create"
          ? normalizePath(`${newBasename}.md`)
          : null;

    if (newPath) {
      const newPathKey = newPath.toLowerCase();
      if (batchState.newPaths.has(newPathKey)) {
        return { ok: false, reason: `本次批量里已经准备使用目标文件：${newPath}` };
      }

      const existingFile = this.app.vault.getAbstractFileByPath(newPath);
      if (existingFile && existingFile !== target.file) {
        return { ok: false, reason: `目标文件已经存在：${newPath}` };
      }
      batchState.newPaths.add(newPathKey);
    } else {
      const linkTargetKey = normalizePath(newLinkTarget).toLowerCase();
      if (batchState.linkTargets.has(linkTargetKey)) {
        return { ok: false, reason: `本次批量里已经准备使用链接：[[${newLinkTarget}]]` };
      }

      const existingNumberedTarget = this.resolvePotentialNumberedTarget(newLinkTarget, sourceFile.path);
      if (existingNumberedTarget) {
        return { ok: false, reason: `编号后的链接已指向现有笔记：${existingNumberedTarget.path}` };
      }
      batchState.linkTargets.add(linkTargetKey);
    }

    const actionText =
      target.mode === "rename"
        ? "动作：重命名已有笔记"
        : target.mode === "create"
          ? "动作：创建空笔记"
          : "动作：只修改卡片盒链接，不创建笔记";

    return {
      ok: true,
      plan: {
        proposal,
        target,
        lineIndex: proposal.lineNumber - 1,
        newBasename,
        newLinkTarget,
        newPath,
        actionText,
      },
    };
  }

  async applyBatchPlans(plans, sourceFile, editor) {
    for (const plan of plans) {
      if (plan.target.mode === "rename") {
        await this.app.fileManager.renameFile(plan.target.file, plan.newPath);
      } else if (plan.target.mode === "create") {
        await this.createEmptyNote(plan.newPath);
      }
    }

    await this.replaceSourceLinksAfterBatch(editor, sourceFile, plans);
  }

  async replaceSourceLinksAfterBatch(editor, sourceFile, plans) {
    if (editor && typeof editor.getLine === "function" && typeof editor.replaceRange === "function") {
      plans.forEach((plan) => {
        const override = plan.target.mode === "rename" ? null : plan.newLinkTarget;
        this.replaceEditorLineAfterRename(
          editor,
          plan.lineIndex,
          plan.proposal.linkName,
          plan.newBasename,
          override
        );
      });
      return;
    }

    const content = await this.app.vault.read(sourceFile);
    const lines = splitLines(content);
    let changed = false;

    plans.forEach((plan) => {
      if (plan.lineIndex < 0 || plan.lineIndex >= lines.length) {
        return;
      }

      const newTargetName =
        plan.target.mode === "rename"
          ? renamedLinkTarget(plan.proposal.linkName, plan.newBasename)
          : plan.newLinkTarget;
      const newLine = replaceWikilinkTargetInLine(lines[plan.lineIndex], plan.proposal.linkName, newTargetName);
      if (newLine !== lines[plan.lineIndex]) {
        lines[plan.lineIndex] = newLine;
        changed = true;
      }
    });

    if (changed) {
      await this.app.vault.modify(sourceFile, lines.join("\n"));
    }
  }

  async proposeAndApply(lines, lineIndex, sourceFile, profile, fromAutoDetect, editor) {
    const proposal = buildNumberProposal(
      lines,
      lineIndex,
      displaySlipBoxPath(profile.slipBoxPath, sourceFile.basename)
    );
    const promptKey = `${sourceFile.path}:${lineIndex}:${lines[lineIndex] || ""}`;

    if (!proposal.ok) {
      if (!fromAutoDetect) {
        new Notice(proposal.reason);
      }
      this.suppressedPromptKeys.add(promptKey);
      return "skipped";
    }

    const target = this.resolveTargetFile(proposal.linkName, sourceFile.path);
    if (!target.ok) {
      new Notice(target.reason);
      this.suppressedPromptKeys.add(promptKey);
      return "skipped";
    }

    if (target.mode === "missing") {
      target.mode = this.settings.unresolvedLinkMode === "create-note" ? "create" : "link-only";
    }

    const newBasename = `${proposal.newId} ${target.basename}`;
    target.newLinkTarget = target.mode === "link-only" ? renamedLinkTarget(proposal.linkName, newBasename) : newBasename;
    const newPath =
      target.mode === "rename"
        ? normalizePath(`${parentPath(target.file.path)}${newBasename}.md`)
        : target.mode === "create"
          ? normalizePath(`${newBasename}.md`)
          : null;

    if (newPath) {
      const existingFile = this.app.vault.getAbstractFileByPath(newPath);
      if (existingFile && existingFile !== target.file) {
        new Notice(`目标文件已经存在：${newPath}`);
        this.suppressedPromptKeys.add(promptKey);
        return "skipped";
      }
    } else {
      const existingNumberedTarget = this.resolvePotentialNumberedTarget(target.newLinkTarget, sourceFile.path);
      if (existingNumberedTarget) {
        new Notice(`编号后的链接已指向现有笔记：${existingNumberedTarget.path}`);
        this.suppressedPromptKeys.add(promptKey);
        return "skipped";
      }
    }

    this.prompting = true;
    try {
      const confirmed = await this.confirmNumber(proposal, target, newPath);
      if (!confirmed) {
        this.suppressedPromptKeys.add(promptKey);
        return "cancelled";
      }

      if (target.mode === "rename") {
        await this.app.fileManager.renameFile(target.file, newPath);
        await this.replaceSourceLinkAfterApply(editor, sourceFile, lineIndex, proposal.linkName, newBasename, null);
        new Notice(`已重命名为：${newBasename}`);
      } else if (target.mode === "create") {
        await this.createEmptyNote(newPath);
        await this.replaceSourceLinkAfterApply(editor, sourceFile, lineIndex, proposal.linkName, newBasename, newBasename);
        new Notice(`已创建：${newBasename}`);
      } else {
        await this.replaceSourceLinkAfterApply(
          editor,
          sourceFile,
          lineIndex,
          proposal.linkName,
          newBasename,
          target.newLinkTarget
        );
        new Notice(`已补编号：${target.newLinkTarget}`);
      }
      return "applied";
    } finally {
      this.prompting = false;
    }
  }

  resolveTargetFile(linkName, sourcePath) {
    const destination = this.app.metadataCache.getFirstLinkpathDest(linkName, sourcePath);
    if (destination && destination.extension === "md") {
      return { ok: true, mode: "rename", file: destination, basename: destination.basename };
    }

    const targetBasename = linkBasename(linkName);
    const normalizedLink = normalizePath(linkName);
    const matches = this.app.vault.getMarkdownFiles().filter((file) => {
      return (
        file.basename === targetBasename ||
        file.path === normalizedLink ||
        file.path === `${normalizedLink}.md`
      );
    });

    if (matches.length === 1) {
      return { ok: true, mode: "rename", file: matches[0], basename: matches[0].basename };
    }

    if (matches.length > 1) {
      return {
        ok: false,
        reason: `找到多个名为 ${targetBasename} 的笔记，请先让链接指向唯一文件。`,
      };
    }

    return {
      ok: true,
      mode: "missing",
      file: null,
      basename: targetBasename || proposalSafeName(linkName),
    };
  }

  resolvePotentialNumberedTarget(linkName, sourcePath) {
    const destination = this.app.metadataCache.getFirstLinkpathDest(linkName, sourcePath);
    if (destination && destination.extension === "md") {
      return destination;
    }

    const targetBasename = linkBasename(linkName);
    const normalizedLink = normalizePath(linkName);
    return (
      this.app.vault.getMarkdownFiles().find((file) => {
        return (
          file.basename === targetBasename ||
          file.path === normalizedLink ||
          file.path === `${normalizedLink}.md`
        );
      }) || null
    );
  }

  async createEmptyNote(path) {
    await this.app.vault.create(path, "");
  }

  async confirmNumber(proposal, targetInfo, newPath) {
    const modal = new ConfirmNumberModal(this.app, proposal, targetInfo, newPath);
    modal.open();
    return modal.result;
  }

  async confirmBatchNumber(slipBoxName, plans, errors) {
    const modal = new ConfirmBatchNumberModal(this.app, slipBoxName, plans, errors);
    modal.open();
    return modal.result;
  }

  async replaceSourceLinkAfterApply(editor, sourceFile, lineIndex, oldLinkName, newBasename, linkTargetOverride) {
    if (this.replaceEditorLineAfterRename(editor, lineIndex, oldLinkName, newBasename, linkTargetOverride)) {
      return;
    }

    const content = await this.app.vault.read(sourceFile);
    const lines = splitLines(content);
    if (lineIndex < 0 || lineIndex >= lines.length) {
      return;
    }

    const newTargetName = linkTargetOverride || renamedLinkTarget(oldLinkName, newBasename);
    const newLine = replaceWikilinkTargetInLine(lines[lineIndex], oldLinkName, newTargetName);
    if (newLine === lines[lineIndex]) {
      return;
    }

    lines[lineIndex] = newLine;
    await this.app.vault.modify(sourceFile, lines.join("\n"));
  }

  replaceEditorLineAfterRename(editor, lineIndex, oldLinkName, newBasename, linkTargetOverride) {
    if (!editor || typeof editor.getLine !== "function" || typeof editor.replaceRange !== "function") {
      return false;
    }

    const line = editor.getLine(lineIndex);
    if (!line || !line.includes(`[[${oldLinkName}`)) {
      return false;
    }

    const newTargetName = linkTargetOverride || renamedLinkTarget(oldLinkName, newBasename);
    const newLine = replaceWikilinkTargetInLine(line, oldLinkName, newTargetName);
    if (newLine === line) {
      return false;
    }

    editor.replaceRange(newLine, { line: lineIndex, ch: 0 }, { line: lineIndex, ch: line.length });
    return true;
  }
}

module.exports = SlipBoxAutoNumberPlugin;
