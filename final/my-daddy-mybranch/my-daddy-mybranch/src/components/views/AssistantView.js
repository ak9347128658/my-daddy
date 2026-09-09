import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class AssistantView extends LitElement {
    static styles = css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        * {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            cursor: default;
        }

        .response-container {
            height: calc(100% - 50px);
            overflow-y: auto;
            font-size: var(--response-font-size, 16px);
            line-height: 1.6;
            background: var(--bg-primary);
            padding: 12px;
            scroll-behavior: smooth;
            user-select: text;
            cursor: text;
        }

        .response-container * {
            user-select: text;
            cursor: text;
        }

        .response-container a {
            cursor: pointer;
        }

        /* Word display (no animation) */
        .response-container [data-word] {
            display: inline-block;
        }

        /* Markdown styling */
        .response-container h1,
        .response-container h2,
        .response-container h3,
        .response-container h4,
        .response-container h5,
        .response-container h6 {
            margin: 1em 0 0.5em 0;
            color: var(--text-color);
            font-weight: 600;
        }

        .response-container h1 { font-size: 1.6em; }
        .response-container h2 { font-size: 1.4em; }
        .response-container h3 { font-size: 1.2em; }
        .response-container h4 { font-size: 1.1em; }
        .response-container h5 { font-size: 1em; }
        .response-container h6 { font-size: 0.9em; }

        .response-container p {
            margin: 0.6em 0;
            color: var(--text-color);
        }

        .response-container ul,
        .response-container ol {
            margin: 0.6em 0;
            padding-left: 1.5em;
            color: var(--text-color);
        }

        .response-container li {
            margin: 0.3em 0;
        }

        .response-container blockquote {
            margin: 0.8em 0;
            padding: 0.5em 1em;
            border-left: 2px solid var(--border-default);
            background: var(--bg-secondary);
        }

        .response-container code {
            background: var(--bg-tertiary);
            padding: 0.15em 0.4em;
            border-radius: 3px;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.85em;
        }

        .response-container pre {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 3px;
            padding: 12px;
            overflow-x: auto;
            margin: 0.8em 0;
        }

        .response-container pre code {
            background: none;
            padding: 0;
        }

        .response-container a {
            color: var(--text-color);
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .response-container strong,
        .response-container b {
            font-weight: 600;
        }

        .response-container hr {
            border: none;
            border-top: 1px solid var(--border-color);
            margin: 1.5em 0;
        }

        .response-container table {
            border-collapse: collapse;
            width: 100%;
            margin: 0.8em 0;
        }

        .response-container th,
        .response-container td {
            border: 1px solid var(--border-color);
            padding: 8px;
            text-align: left;
        }

        .response-container th {
            background: var(--bg-secondary);
            font-weight: 600;
        }

        .response-container::-webkit-scrollbar {
            width: 8px;
        }

        .response-container::-webkit-scrollbar-track {
            background: transparent;
        }

        .response-container::-webkit-scrollbar-thumb {
            background: var(--scrollbar-thumb);
            border-radius: 4px;
        }

        .response-container::-webkit-scrollbar-thumb:hover {
            background: var(--scrollbar-thumb-hover);
        }

        .text-input-container {
            display: flex;
            gap: 8px;
            margin-top: 8px;
            align-items: center;
            position: relative;
        }

        .text-input-container input[type='text'] {
            flex: 1;
            min-width: 80px;
            background: transparent;
            color: var(--text-color);
            border: none;
            border-bottom: 1px solid var(--border-color);
            padding: 8px 4px;
            border-radius: 0;
            font-size: 13px;
            cursor: text;
            user-select: text;
            -webkit-user-select: text;
            pointer-events: auto;
        }

        .text-input-container input[type='text']:focus {
            outline: none;
            border-bottom-color: var(--text-color);
        }

        .text-input-container input[type='text']::placeholder {
            color: var(--placeholder-color);
        }

        .text-input-container input[type='text']:disabled {
            opacity: 0.5;
            cursor: default;
        }

        /* Native file picker is fully hidden; opened via attach control / Ctrl+O */
        .hidden-file-input {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border: 0;
            opacity: 0;
            pointer-events: none;
        }

        .attach-button {
            background: transparent;
            color: var(--text-secondary);
            border: none;
            padding: 6px;
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            /* Low visibility so it does not draw attention during sessions */
            opacity: 0.22;
            transition: opacity 0.15s ease, background 0.1s ease, color 0.1s ease;
            flex-shrink: 0;
        }

        .attach-button:hover:not(:disabled),
        .attach-button:focus-visible {
            opacity: 0.85;
            background: var(--hover-background);
            color: var(--text-color);
            outline: none;
        }

        .attach-button:disabled {
            opacity: 0.15;
            cursor: default;
        }

        .attach-button.has-file {
            opacity: 0.55;
            color: var(--text-color);
        }

        .attach-button svg {
            width: 18px;
            height: 18px;
            stroke: currentColor;
        }

        .file-attach-chip {
            display: flex;
            align-items: center;
            gap: 4px;
            max-width: 120px;
            font-size: 10px;
            color: var(--text-muted);
            opacity: 0.55;
            flex-shrink: 1;
            min-width: 0;
        }

        .file-attach-chip .file-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .file-attach-chip .clear-file {
            background: transparent;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: 0 2px;
            font-size: 12px;
            line-height: 1;
            opacity: 0.7;
        }

        .file-attach-chip .clear-file:hover {
            opacity: 1;
            color: var(--text-color);
        }

        .send-button {
            background: var(--btn-primary-bg, #ffffff);
            color: var(--btn-primary-text, #000000);
            border: none;
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
            flex-shrink: 0;
        }

        .send-button:hover:not(:disabled) {
            background: var(--btn-primary-hover, #f0f0f0);
        }

        .send-button:disabled {
            opacity: 0.4;
            cursor: default;
        }

        .nav-button {
            background: transparent;
            color: var(--text-secondary);
            border: none;
            padding: 6px;
            border-radius: 3px;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.1s ease;
        }

        .nav-button:hover {
            background: var(--hover-background);
            color: var(--text-color);
        }

        .nav-button:disabled {
            opacity: 0.3;
        }

        .nav-button svg {
            width: 18px;
            height: 18px;
            stroke: currentColor;
        }

        .response-counter {
            font-size: 11px;
            color: var(--text-muted);
            white-space: nowrap;
            min-width: 50px;
            text-align: center;
            font-family: 'SF Mono', Monaco, monospace;
        }

        .screen-answer-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--btn-primary-bg, #ffffff);
            color: var(--btn-primary-text, #000000);
            border: none;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
        }

        .screen-answer-btn:hover {
            background: var(--btn-primary-hover, #f0f0f0);
        }

        .screen-answer-btn svg {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }

        .screen-answer-btn .usage-count {
            font-size: 11px;
            opacity: 0.7;
            font-family: 'SF Mono', Monaco, monospace;
        }

        .play-pause-btn {
            background: var(--btn-primary-bg);
            color: var(--btn-primary-text);
            border: none;
            border-radius: 8px;
            padding: 8px 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            margin-right: 8px;
        }

        .play-pause-btn:hover {
            background: var(--btn-primary-hover);
            transform: translateY(-1px);
        }

        .play-pause-btn:active {
            transform: translateY(0);
        }

        .play-pause-btn svg {
            width: 16px;
            height: 16px;
        }

        .screen-answer-btn-wrapper {
            position: relative;
        }

        .screen-answer-btn-wrapper .tooltip {
            position: absolute;
            bottom: 100%;
            right: 0;
            margin-bottom: 8px;
            background: var(--tooltip-bg, #1a1a1a);
            color: var(--tooltip-text, #ffffff);
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 11px;
            white-space: nowrap;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.15s ease, visibility 0.15s ease;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 100;
        }

        .screen-answer-btn-wrapper .tooltip::after {
            content: '';
            position: absolute;
            top: 100%;
            right: 16px;
            border: 6px solid transparent;
            border-top-color: var(--tooltip-bg, #1a1a1a);
        }

        .screen-answer-btn-wrapper:hover .tooltip {
            opacity: 1;
            visibility: visible;
        }

        .tooltip-row {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 4px;
        }

        .tooltip-row:last-child {
            margin-bottom: 0;
        }

        .tooltip-label {
            opacity: 0.7;
        }

        .tooltip-value {
            font-family: 'SF Mono', Monaco, monospace;
        }

        .tooltip-note {
            margin-top: 6px;
            padding-top: 6px;
            border-top: 1px solid rgba(255,255,255,0.1);
            opacity: 0.5;
            font-size: 10px;
        }
    `;

    static properties = {
        responses: { type: Array },
        currentResponseIndex: { type: Number },
        selectedProfile: { type: String },
        onSendText: { type: Function },
        shouldAnimateResponse: { type: Boolean },
        flashCount: { type: Number },
        flashLiteCount: { type: Number },
        isConversationPaused: { type: Boolean },
        isSending: { type: Boolean },
        attachedFileName: { type: String },
        isLoadingFile: { type: Boolean },
        fileAttachError: { type: String },
    };

    constructor() {
        super();
        this.responses = [];
        this.currentResponseIndex = -1;
        this.selectedProfile = 'interview';
        this.onSendText = () => {};
        this.flashCount = 0;
        this.flashLiteCount = 0;
        this.isConversationPaused = false;
        this.isSending = false;
        this.attachedFileName = '';
        this.attachedFileContent = null;
        this.attachedFileMeta = null; // { truncated, originalSizeLabel, strategy, isLog, ... }
        this.isLoadingFile = false;
        this.fileAttachError = '';
    }

    getProfileNames() {
        return {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
        };
    }

    getCurrentResponse() {
        const profileNames = this.getProfileNames();
        return this.responses.length > 0 && this.currentResponseIndex >= 0
            ? this.responses[this.currentResponseIndex]
            : `Hey, Im listening to your ${profileNames[this.selectedProfile] || 'session'}?`;
    }

    renderMarkdown(content) {
        // Check if marked is available
        if (typeof window !== 'undefined' && window.marked) {
            try {
                // Configure marked for better security and formatting
                window.marked.setOptions({
                    breaks: true,
                    gfm: true,
                    sanitize: false, // We trust the AI responses
                });
                let rendered = window.marked.parse(content);
                rendered = this.wrapWordsInSpans(rendered);
                return rendered;
            } catch (error) {
                console.warn('Error parsing markdown:', error);
                return content; // Fallback to plain text
            }
        }
        console.log('Marked not available, using plain text');
        return content; // Fallback if marked is not available
    }

    wrapWordsInSpans(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const tagsToSkip = ['PRE'];

        function wrap(node) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() && !tagsToSkip.includes(node.parentNode.tagName)) {
                const words = node.textContent.split(/(\s+)/);
                const frag = document.createDocumentFragment();
                words.forEach(word => {
                    if (word.trim()) {
                        const span = document.createElement('span');
                        span.setAttribute('data-word', '');
                        span.textContent = word;
                        frag.appendChild(span);
                    } else {
                        frag.appendChild(document.createTextNode(word));
                    }
                });
                node.parentNode.replaceChild(frag, node);
            } else if (node.nodeType === Node.ELEMENT_NODE && !tagsToSkip.includes(node.tagName)) {
                Array.from(node.childNodes).forEach(wrap);
            }
        }
        Array.from(doc.body.childNodes).forEach(wrap);
        return doc.body.innerHTML;
    }

    getResponseCounter() {
        return this.responses.length > 0 ? `${this.currentResponseIndex + 1}/${this.responses.length}` : '';
    }

    navigateToPreviousResponse() {
        if (this.currentResponseIndex > 0) {
            this.currentResponseIndex--;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    navigateToNextResponse() {
        if (this.currentResponseIndex < this.responses.length - 1) {
            this.currentResponseIndex++;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    scrollResponseUp() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3; // Scroll 30% of container height
            container.scrollTop = Math.max(0, container.scrollTop - scrollAmount);
        }
    }

    scrollResponseDown() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3; // Scroll 30% of container height
            container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + scrollAmount);
        }
    }

    connectedCallback() {
        super.connectedCallback();

        // Load limits on mount
        this.loadLimits();

        // Set up IPC listeners for keyboard shortcuts
        if (window.require) {
            const { ipcRenderer } = window.require('electron');

            this.handlePreviousResponse = () => {
                console.log('Received navigate-previous-response message');
                this.navigateToPreviousResponse();
            };

            this.handleNextResponse = () => {
                console.log('Received navigate-next-response message');
                this.navigateToNextResponse();
            };

            this.handleScrollUp = () => {
                console.log('Received scroll-response-up message');
                this.scrollResponseUp();
            };

            this.handleScrollDown = () => {
                console.log('Received scroll-response-down message');
                this.scrollResponseDown();
            };

            ipcRenderer.on('navigate-previous-response', this.handlePreviousResponse);
            ipcRenderer.on('navigate-next-response', this.handleNextResponse);
            ipcRenderer.on('scroll-response-up', this.handleScrollUp);
            ipcRenderer.on('scroll-response-down', this.handleScrollDown);
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();

        // Clean up IPC listeners
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            if (this.handlePreviousResponse) {
                ipcRenderer.removeListener('navigate-previous-response', this.handlePreviousResponse);
            }
            if (this.handleNextResponse) {
                ipcRenderer.removeListener('navigate-next-response', this.handleNextResponse);
            }
            if (this.handleScrollUp) {
                ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
            }
            if (this.handleScrollDown) {
                ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
            }
        }
    }

    openFilePicker() {
        if (this.isSending || this.isLoadingFile) return;
        const fileInput = this.shadowRoot?.querySelector('#fileInput');
        if (fileInput) {
            fileInput.value = '';
            fileInput.click();
        }
    }

    clearAttachedFile() {
        this.attachedFileName = '';
        this.attachedFileContent = null;
        this.attachedFileMeta = null;
        this.fileAttachError = '';
        const fileInput = this.shadowRoot?.querySelector('#fileInput');
        if (fileInput) fileInput.value = '';
        this.requestUpdate();
    }

    /**
     * Store attachment + optional size/truncation metadata from the loader.
     */
    setAttachedFileFromResult(result, fallbackName = 'file') {
        this.attachedFileName = result.fileName || fallbackName;
        this.attachedFileContent = result.content;
        this.attachedFileMeta = {
            truncated: !!result.truncated,
            isLog: !!result.isLog,
            strategy: result.strategy || null,
            originalSizeLabel: result.originalSizeLabel || null,
            originalSizeBytes: result.originalSizeBytes || null,
            charCount: result.charCount || (result.content ? result.content.length : 0),
            lineCount: result.lineCount || result.approxLineCount || null,
            errorLineCount: result.errorLineCount || 0,
        };
        this.fileAttachError = '';
    }

    /**
     * Strip surrounding quotes from a path-like string.
     */
    stripPathQuotes(value) {
        const s = String(value || '').trim();
        if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
            return s.slice(1, -1).trim();
        }
        return s;
    }

    /**
     * True if the string looks like a local filesystem path (Windows/Unix/file://).
     */
    looksLikeLocalFilePath(value) {
        const s = this.stripPathQuotes(value);
        if (!s || s.length < 2) return false;
        // Windows drive path: C:\... or C:/...
        if (/^[A-Za-z]:[\\/]/.test(s)) return true;
        // UNC path: \\server\share\...
        if (/^\\\\[^\\/]+[\\/]/.test(s)) return true;
        // file:// URL
        if (/^file:\/\//i.test(s)) return true;
        // Unix absolute path (require at least one more segment)
        if (/^\/[^/\s]+/.test(s)) return true;
        // Home-relative
        if (/^~[\\/]/.test(s) || s === '~') return true;
        return false;
    }

    /**
     * Extract local file path candidates from chat text (quoted first, then unquoted).
     * @returns {string[]} unique path strings as they appear in the text
     */
    extractLocalFilePaths(text) {
        if (!text || typeof text !== 'string') return [];

        const found = [];
        const seen = new Set();
        const add = raw => {
            const cleaned = this.stripPathQuotes(raw);
            if (!cleaned || seen.has(cleaned)) return;
            if (!this.looksLikeLocalFilePath(cleaned)) return;
            seen.add(cleaned);
            found.push(cleaned);
        };

        // Quoted paths: "C:\Users\..." or 'C:\Users\...'
        const quotedRe = /["']([^"'\n\r]+)["']/g;
        let m;
        while ((m = quotedRe.exec(text)) !== null) {
            if (this.looksLikeLocalFilePath(m[1])) {
                add(m[1]);
            }
        }

        // Entire message is a path
        const whole = text.trim();
        if (this.looksLikeLocalFilePath(whole)) {
            add(whole);
        }

        // Unquoted Windows paths (stop at whitespace / common trailing punctuation)
        const winRe = /(?:^|[\s])([A-Za-z]:[\\/][^\s"'<>|*?]+)/g;
        while ((m = winRe.exec(text)) !== null) {
            let p = m[1].replace(/[.,;:!?)]+$/, '');
            add(p);
        }

        // Unquoted UNC
        const uncRe = /(?:^|[\s])(\\\\[^\s"'<>|*?]+)/g;
        while ((m = uncRe.exec(text)) !== null) {
            add(m[1].replace(/[.,;:!?)]+$/, ''));
        }

        // file:// URLs
        const fileUrlRe = /(?:^|[\s])(file:\/\/\/?[^\s"']+)/gi;
        while ((m = fileUrlRe.exec(text)) !== null) {
            add(m[1].replace(/[.,;:!?)]+$/, ''));
        }

        // Unix absolute (avoid matching URLs by requiring no ://)
        const unixRe = /(?:^|[\s])(\/(?:Users|home|tmp|var|opt|etc|mnt|media)\/[^\s"']+)/g;
        while ((m = unixRe.exec(text)) !== null) {
            add(m[1].replace(/[.,;:!?)]+$/, ''));
        }

        return found;
    }

    /**
     * Remove resolved path occurrences from the user message text.
     */
    stripPathsFromText(text, paths) {
        let remaining = text || '';
        for (const p of paths) {
            const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            remaining = remaining.replace(new RegExp(`["']?${escaped}["']?`, 'g'), ' ');
        }
        return remaining.replace(/\s+/g, ' ').trim();
    }

    /**
     * Load file(s) referenced by local path(s) in the message text.
     * Returns { text, pathFiles, error } where pathFiles is an array of loaded results.
     */
    async resolvePathsInMessage(typed) {
        const candidates = this.extractLocalFilePaths(typed);
        if (candidates.length === 0) {
            return { text: typed, pathFiles: [] };
        }

        if (!window.cheatingDaddy?.loadQuestionsFromPath) {
            return { text: typed, pathFiles: [], error: 'File path loading is not available' };
        }

        const pathFiles = [];
        const loadedPaths = [];

        for (const candidate of candidates) {
            const result = await window.cheatingDaddy.loadQuestionsFromPath(candidate);
            if (result?.success && result.content) {
                pathFiles.push(result);
                loadedPaths.push(candidate);
            } else if (candidates.length === 1 && this.looksLikeLocalFilePath(typed.trim())) {
                // Message is only a path and it failed — surface the error
                return {
                    text: typed,
                    pathFiles: [],
                    error: result?.error || `Could not read file: ${candidate}`,
                };
            }
            // If multiple candidates and one fails, skip that one and keep going
        }

        const remaining = this.stripPathsFromText(typed, loadedPaths);
        return { text: remaining, pathFiles };
    }

    async handleFileSelected(e) {
        const file = e.target?.files?.[0];
        if (!file) return;

        this.isLoadingFile = true;
        this.fileAttachError = '';
        this.requestUpdate();

        try {
            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);

            if (!window.cheatingDaddy?.loadQuestionsFromFile) {
                throw new Error('File loading is not available');
            }

            const result = await window.cheatingDaddy.loadQuestionsFromFile(base64, file.name);
            if (!result?.success) {
                this.clearAttachedFile();
                this.fileAttachError = result?.error || 'Failed to read file';
                this.requestUpdate();
                return;
            }

            this.setAttachedFileFromResult(result, file.name);
        } catch (error) {
            console.error('Failed to load selected file:', error);
            this.clearAttachedFile();
            this.fileAttachError = error.message || 'Failed to load file';
        } finally {
            this.isLoadingFile = false;
            this.requestUpdate();
            // Refocus message input after picking
            requestAnimationFrame(() => {
                const input = this.shadowRoot?.querySelector('#textInput');
                if (input) input.focus();
            });
        }
    }

    /**
     * Attach a file loaded from a filesystem path (previews in the chip before send).
     */
    async attachFileFromPath(filePath) {
        if (!filePath || !window.cheatingDaddy?.loadQuestionsFromPath) {
            this.fileAttachError = 'File path loading is not available';
            this.requestUpdate();
            return false;
        }

        this.isLoadingFile = true;
        this.fileAttachError = '';
        this.requestUpdate();

        try {
            const result = await window.cheatingDaddy.loadQuestionsFromPath(filePath);
            if (!result?.success) {
                this.fileAttachError = result?.error || 'Failed to read file path';
                return false;
            }
            this.setAttachedFileFromResult(result, this.stripPathQuotes(filePath));
            return true;
        } catch (error) {
            console.error('Failed to load file from path:', error);
            this.fileAttachError = error.message || 'Failed to load file from path';
            return false;
        } finally {
            this.isLoadingFile = false;
            this.requestUpdate();
        }
    }

    formatFileMetaHeader(meta, fileName) {
        if (!meta) return '';
        const bits = [];
        if (meta.originalSizeLabel) bits.push(`size ${meta.originalSizeLabel}`);
        if (meta.lineCount) bits.push(`~${Number(meta.lineCount).toLocaleString()} lines`);
        if (meta.truncated) bits.push('TRUNCATED sample for AI context');
        if (meta.isLog) bits.push('log-aware sampling');
        if (meta.errorLineCount) bits.push(`${meta.errorLineCount} issue lines sampled`);
        if (meta.strategy) bits.push(`strategy: ${meta.strategy}`);
        if (bits.length === 0) return '';
        return `[File meta: ${fileName} — ${bits.join(' · ')}]\n`;
    }

    buildMessageWithAttachment(text, extraFiles = []) {
        const message = (text || '').trim();
        const blocks = [];

        if (this.attachedFileContent) {
            const fileName = this.attachedFileName || 'file';
            const metaHeader = this.formatFileMetaHeader(this.attachedFileMeta, fileName);
            blocks.push(
                `${metaHeader}=== LOCAL FILE: ${fileName} ===\n${this.attachedFileContent}\n=== END LOCAL FILE ===`
            );
        }

        for (const f of extraFiles) {
            if (!f?.content) continue;
            const fileName = f.fileName || 'file';
            // Skip duplicate content if already attached via picker
            if (this.attachedFileContent && f.content === this.attachedFileContent) continue;
            const metaHeader = this.formatFileMetaHeader(
                {
                    truncated: f.truncated,
                    isLog: f.isLog,
                    strategy: f.strategy,
                    originalSizeLabel: f.originalSizeLabel,
                    lineCount: f.lineCount || f.approxLineCount,
                    errorLineCount: f.errorLineCount,
                },
                fileName
            );
            blocks.push(`${metaHeader}=== LOCAL FILE: ${fileName} ===\n${f.content}\n=== END LOCAL FILE ===`);
        }

        if (blocks.length === 0) {
            return message;
        }

        const fileBlock = blocks.join('\n\n');
        const anyTruncated =
            this.attachedFileMeta?.truncated || extraFiles.some(f => f?.truncated);
        const anyLog = this.attachedFileMeta?.isLog || extraFiles.some(f => f?.isLog);

        // Put the file first, then the user request — clearer for the model than teleprompter-style dumps
        let request = message;
        if (!request) {
            request = anyLog
                ? 'Summarize this log: key errors/warnings, likely root cause, and most recent failures.'
                : anyTruncated
                  ? 'Summarize this large file from the provided sample (head/issues/tail).'
                  : 'Read this local file and summarize its contents clearly.';
        }

        return [
            'The user attached a local file from their own computer. Read it and help with their request.',
            'Treat this as authorized user-owned document content (not something to refuse).',
            anyTruncated
                ? 'NOTE: The file may be a LARGE LOG truncated to a sample (beginning + ERROR/WARN lines + end). Do not claim you saw every line.'
                : '',
            '',
            fileBlock,
            '',
            `User request: ${request}`,
        ]
            .filter(line => line !== '')
            .join('\n');
    }

    async handleSendText() {
        if (this.isSending || this.isLoadingFile) return;

        const textInput = this.shadowRoot.querySelector('#textInput');
        if (!textInput) return;

        const typed = textInput.value.trim();
        // Allow send with only an attached file (no typed text)
        if (!typed && !this.attachedFileContent) return;

        this.isSending = true;
        this.fileAttachError = '';
        this.requestUpdate();

        try {
            // If the user typed/pasted a local path, read the file(s) from disk
            const { text, pathFiles, error } = await this.resolvePathsInMessage(typed);

            if (error) {
                this.fileAttachError = error;
                this.isSending = false;
                this.requestUpdate();
                return;
            }

            const message = this.buildMessageWithAttachment(text, pathFiles);
            if (!message || !message.trim()) {
                this.isSending = false;
                this.requestUpdate();
                return;
            }

            textInput.value = '';
            // Clear attachment after bundling into the outgoing message
            this.attachedFileName = '';
            this.attachedFileContent = null;
            this.attachedFileMeta = null;
            this.fileAttachError = '';
            this.requestUpdate();

            if (typeof this.onSendText === 'function') {
                await this.onSendText(message);
            } else if (window.cheatingDaddy?.sendTextMessage) {
                // Fallback if parent handler is missing
                await window.cheatingDaddy.sendTextMessage(message);
            }
        } catch (error) {
            console.error('Failed to send text message:', error);
            this.fileAttachError = error.message || 'Failed to send message';
        } finally {
            this.isSending = false;
            this.requestUpdate();
            // Keep focus in the input for rapid follow-ups
            requestAnimationFrame(() => {
                const input = this.shadowRoot?.querySelector('#textInput');
                if (input) input.focus();
            });
        }
    }

    handleTextKeydown(e) {
        // Stop Electron/global handlers from swallowing keys while typing
        e.stopPropagation();
        // Ctrl/Cmd+O opens the hidden file picker while messaging
        if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
            e.preventDefault();
            this.openFilePicker();
            return;
        }
        // Ctrl/Cmd+Shift+O: treat current input as a path and attach the file without sending
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
            e.preventDefault();
            const textInput = this.shadowRoot?.querySelector('#textInput');
            const typed = textInput?.value?.trim() || '';
            if (typed && this.looksLikeLocalFilePath(typed)) {
                this.attachFileFromPath(this.stripPathQuotes(typed)).then(ok => {
                    if (ok && textInput) textInput.value = '';
                });
            } else if (typed) {
                // Try extracting a path from mixed text
                const paths = this.extractLocalFilePaths(typed);
                if (paths[0]) {
                    this.attachFileFromPath(paths[0]);
                } else {
                    this.fileAttachError = 'Type or paste a full file path first';
                    this.requestUpdate();
                }
            }
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSendText();
        }
    }

    handleTextInputClick(e) {
        e.stopPropagation();
        e.target?.focus?.();
    }

    /**
     * On paste: if clipboard is only a file path, auto-load it as an attachment (low-friction).
     */
    async handleTextPaste(e) {
        e.stopPropagation();
        const pasted = (e.clipboardData?.getData('text') || '').trim();
        if (!pasted || !this.looksLikeLocalFilePath(pasted)) return;

        // Let the path land in the input; also try to attach in the background so Send has content ready
        // Do not preventDefault — user still sees the path; on Send we read the file.
        // Optionally auto-attach without removing path from input:
        // await this.attachFileFromPath(this.stripPathQuotes(pasted));
    }

    async loadLimits() {
        if (window.cheatingDaddy?.storage?.getTodayLimits) {
            const limits = await window.cheatingDaddy.storage.getTodayLimits();
            this.flashCount = limits.flash?.count || 0;
            this.flashLiteCount = limits.flashLite?.count || 0;
        }
    }

    getTotalUsed() {
        return this.flashCount + this.flashLiteCount;
    }

    getTotalAvailable() {
        return 40; // 20 flash + 20 flash-lite
    }

    async handleScreenAnswer() {
        if (window.captureManualScreenshot) {
            window.captureManualScreenshot();
            // Reload limits after a short delay to catch the update
            setTimeout(() => this.loadLimits(), 1000);
        }
    }

    handlePlayPauseToggle() {
        const app = document.querySelector('cheating-daddy-app');
        if (app && app.toggleConversationPlayback) {
            const newState = app.toggleConversationPlayback();
            this.isConversationPaused = newState;
            this.requestUpdate();
        }
    }

    scrollToBottom() {
        setTimeout(() => {
            const container = this.shadowRoot.querySelector('.response-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 0);
    }

    firstUpdated() {
        super.firstUpdated();
        this.updateResponseContent();
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        if (changedProperties.has('responses') || changedProperties.has('currentResponseIndex')) {
            this.updateResponseContent();
        }
    }

    updateResponseContent() {
        console.log('updateResponseContent called');
        const container = this.shadowRoot.querySelector('#responseContainer');
        if (container) {
            const currentResponse = this.getCurrentResponse();
            console.log('Current response:', currentResponse);
            const renderedResponse = this.renderMarkdown(currentResponse);
            console.log('Rendered response:', renderedResponse);
            container.innerHTML = renderedResponse;
            // Show all words immediately (no animation)
            if (this.shouldAnimateResponse) {
                this.dispatchEvent(new CustomEvent('response-animation-complete', { bubbles: true, composed: true }));
            }
        } else {
            console.log('Response container not found');
        }
    }

    render() {
        const responseCounter = this.getResponseCounter();

        return html`
            <div class="response-container" id="responseContainer"></div>

            <div class="text-input-container">
                <button class="nav-button" @click=${this.navigateToPreviousResponse} ?disabled=${this.currentResponseIndex <= 0}>
                    <svg width="24px" height="24px" stroke-width="1.7" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M15 6L9 12L15 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                </button>

                ${this.responses.length > 0 ? html`<span class="response-counter">${responseCounter}</span>` : ''}

                <button class="nav-button" @click=${this.navigateToNextResponse} ?disabled=${this.currentResponseIndex >= this.responses.length - 1}>
                    <svg width="24px" height="24px" stroke-width="1.7" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9 6L15 12L9 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                </button>

                <!-- Hidden native file input (not visible in UI) -->
                <input
                    type="file"
                    id="fileInput"
                    class="hidden-file-input"
                    tabindex="-1"
                    aria-hidden="true"
                    accept=".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.html,.htm,.css,.js,.ts,.jsx,.tsx,.py,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.rb,.php,.sql,.yml,.yaml,.toml,.ini,.cfg,.conf,.log,.rtf,.tex,.r,.swift,.kt,.scala,.sh,.bat,.ps1,.env,.ipynb,.docx,.zip,text/*"
                    @change=${this.handleFileSelected}
                />

                <button
                    class="attach-button ${this.attachedFileName ? 'has-file' : ''}"
                    type="button"
                    @click=${this.openFilePicker}
                    ?disabled=${this.isSending || this.isLoadingFile}
                    title="Attach file (Ctrl+O) — button stays low-visibility"
                    aria-label="Attach file"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke-width="1.7">
                        <path
                            d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                            stroke="currentColor"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        ></path>
                    </svg>
                </button>

                ${
                    this.attachedFileName
                        ? html`
                              <div
                                  class="file-attach-chip"
                                  title=${[
                                      this.attachedFileName,
                                      this.attachedFileMeta?.originalSizeLabel || '',
                                      this.attachedFileMeta?.truncated ? 'truncated sample' : '',
                                      this.attachedFileMeta?.isLog ? 'log sampling' : '',
                                  ]
                                      .filter(Boolean)
                                      .join(' · ')}
                              >
                                  <span class="file-name"
                                      >${this.attachedFileName}${this.attachedFileMeta?.truncated
                                          ? ' ~'
                                          : ''}${this.attachedFileMeta?.originalSizeLabel
                                          ? ` (${this.attachedFileMeta.originalSizeLabel})`
                                          : ''}</span
                                  >
                                  <button class="clear-file" type="button" @click=${this.clearAttachedFile} title="Remove file" aria-label="Remove file">
                                      ×
                                  </button>
                              </div>
                          `
                        : ''
                }

                <input
                    type="text"
                    id="textInput"
                    placeholder=${this.isLoadingFile
                        ? 'Loading file…'
                        : this.fileAttachError
                          ? this.fileAttachError
                          : this.attachedFileName
                            ? `Message + ${this.attachedFileName}`
                            : 'Message, or paste a file path…'}
                    autocomplete="off"
                    spellcheck="true"
                    ?disabled=${this.isSending || this.isLoadingFile}
                    @keydown=${this.handleTextKeydown}
                    @click=${this.handleTextInputClick}
                    @mousedown=${e => e.stopPropagation()}
                    @paste=${this.handleTextPaste}
                />

                <button
                    class="send-button"
                    @click=${this.handleSendText}
                    ?disabled=${this.isSending || this.isLoadingFile}
                    title="Send message (Enter)"
                >
                    ${this.isSending ? 'Sending…' : this.isLoadingFile ? '…' : 'Send'}
                </button>

                <button class="play-pause-btn" @click=${this.handlePlayPauseToggle} title="${this.isConversationPaused ? 'Resume' : 'Pause'} conversation (Alt+X)">
                    ${this.isConversationPaused 
                        ? html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A1 1 0 0 0 8 6.82Z"/>
                            </svg>`
                        : html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
                            </svg>`
                    }
                    <span>${this.isConversationPaused ? 'Resume' : 'Pause'}</span>
                </button>

                <div class="screen-answer-btn-wrapper">
                    <div class="tooltip">
                        <div class="tooltip-row">
                            <span class="tooltip-label">Flash</span>
                            <span class="tooltip-value">${this.flashCount}/20</span>
                        </div>
                        <div class="tooltip-row">
                            <span class="tooltip-label">Flash Lite</span>
                            <span class="tooltip-value">${this.flashLiteCount}/20</span>
                        </div>
                        <div class="tooltip-note">Resets every 24 hours</div>
                    </div>
                    <button class="screen-answer-btn" @click=${this.handleScreenAnswer}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M15.98 1.804a1 1 0 0 0-1.96 0l-.24 1.192a1 1 0 0 1-.784.785l-1.192.238a1 1 0 0 0 0 1.962l1.192.238a1 1 0 0 1 .785.785l.238 1.192a1 1 0 0 0 1.962 0l.238-1.192a1 1 0 0 1 .785-.785l1.192-.238a1 1 0 0 0 0-1.962l-1.192-.238a1 1 0 0 1-.785-.785l-.238-1.192ZM6.949 5.684a1 1 0 0 0-1.898 0l-.683 2.051a1 1 0 0 1-.633.633l-2.051.683a1 1 0 0 0 0 1.898l2.051.684a1 1 0 0 1 .633.632l.683 2.051a1 1 0 0 0 1.898 0l.683-2.051a1 1 0 0 1 .633-.633l2.051-.683a1 1 0 0 0 0-1.898l-2.051-.683a1 1 0 0 1-.633-.633L6.95 5.684ZM13.949 13.684a1 1 0 0 0-1.898 0l-.184.551a1 1 0 0 1-.632.633l-.551.183a1 1 0 0 0 0 1.898l.551.183a1 1 0 0 1 .633.633l.183.551a1 1 0 0 0 1.898 0l.184-.551a1 1 0 0 1 .632-.633l.551-.183a1 1 0 0 0 0-1.898l-.551-.184a1 1 0 0 1-.633-.632l-.183-.551Z" />
                        </svg>
                        <span>Analyze screen</span>
                        <span class="usage-count">(${this.getTotalUsed()}/${this.getTotalAvailable()})</span>
                    </button>
                </div>
            </div>
        `;
    }
}

customElements.define('assistant-view', AssistantView);
