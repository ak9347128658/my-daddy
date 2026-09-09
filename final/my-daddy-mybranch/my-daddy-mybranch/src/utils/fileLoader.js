const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');

// URL downloads stay modest (network memory)
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
// Local files can be much larger — we stream-sample instead of loading everything
const MAX_LOCAL_FILE_BYTES = 500 * 1024 * 1024; // 500 MB on disk
// Full in-memory load only for smaller local files
const MAX_FULL_READ_BYTES = 8 * 1024 * 1024; // 8 MB
// What we actually put into the model context
const MAX_CONTEXT_CHARS = 100_000;
const HEAD_CONTEXT_CHARS = 40_000;
const TAIL_CONTEXT_CHARS = 40_000;
const ERROR_SAMPLE_CHARS = 18_000;
// Bytes read from disk when sampling large files
const HEAD_READ_BYTES = 768 * 1024; // 768 KB head
const TAIL_READ_BYTES = 768 * 1024; // 768 KB tail
const ERROR_SCAN_CHUNK_BYTES = 256 * 1024;
const ERROR_SCAN_MAX_CHUNKS = 24; // ~6 MB scanned for ERROR/WARN lines
const MAX_ERROR_LINES = 80;

const LOG_EXTENSIONS = new Set(['.log', '.out', '.err', '.trace', '.debug', '.ndjson', '.jsonl']);
const TEXT_EXTENSIONS = new Set([
    '.txt',
    '.md',
    '.markdown',
    '.csv',
    '.tsv',
    '.json',
    '.jsonl',
    '.xml',
    '.html',
    '.htm',
    '.css',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.py',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.go',
    '.rs',
    '.rb',
    '.php',
    '.sql',
    '.yml',
    '.yaml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.log',
    '.out',
    '.err',
    '.trace',
    '.debug',
    '.rtf',
    '.tex',
    '.r',
    '.swift',
    '.kt',
    '.scala',
    '.sh',
    '.bat',
    '.ps1',
    '.env',
    '.gitignore',
    '.dockerfile',
    '.ipynb',
]);

const ERROR_LINE_RE =
    /\b(error|err|exception|fatal|panic|fail(?:ed|ure)?|critical|traceback|stack\s*trace|uncaught|unhandled|warn(?:ing)?|timeout|timed\s*out|oom|out of memory|segmentation fault|access denied|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/i;

/**
 * Extract filename from the last path segment of a URL.
 * Example: https://cdn.example.com/bank/questions.zip -> questions.zip
 */
function getFileNameFromUrl(fileUrl) {
    const parsed = new URL(fileUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
        throw new Error('URL path must end with a file name (e.g. .../questions.zip)');
    }

    let fileName = decodeURIComponent(segments[segments.length - 1]);
    // Strip query-like junk that sometimes gets stuck on path segments
    fileName = fileName.split('?')[0].split('#')[0];

    if (!fileName || fileName === '.' || fileName === '..') {
        throw new Error('Could not determine file name from URL. Path should end with a file name.');
    }

    return fileName;
}

function getExtension(fileName) {
    return path.extname(fileName || '').toLowerCase();
}

function isLikelyTextContent(buffer, fileName) {
    const ext = getExtension(fileName);
    if (TEXT_EXTENSIONS.has(ext) || ext === '') {
        // Reject if too many null bytes (binary)
        const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
        let nulls = 0;
        for (let i = 0; i < sample.length; i++) {
            if (sample[i] === 0) nulls++;
        }
        return nulls / Math.max(sample.length, 1) < 0.01;
    }
    return false;
}

function bufferToUtf8(buffer) {
    // Strip UTF-8 BOM if present
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return buffer.subarray(3).toString('utf8');
    }
    return buffer.toString('utf8');
}

function normalizeNewlines(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isLikelyLogFile(fileName, sampleText = '') {
    const ext = getExtension(fileName);
    if (LOG_EXTENSIONS.has(ext)) return true;
    if (ext === '.txt' || ext === '.log' || ext === '') {
        const sample = String(sampleText || '').slice(0, 4000);
        // Common log patterns: timestamps, levels, stack-ish lines
        const hits =
            (sample.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\b/g) || []).length +
            (sample.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g) || []).length +
            (sample.match(/\b(Exception|Traceback|at [\w.$]+\([\w.]+:\d+\))/g) || []).length;
        return hits >= 3;
    }
    return false;
}

/**
 * Drop a partial first line (when we seek mid-file for the tail chunk).
 */
function dropPartialLeadingLine(text) {
    const idx = text.indexOf('\n');
    if (idx === -1) return text;
    // If first "line" is very long and we started mid-file, still drop it
    return text.slice(idx + 1);
}

/**
 * Drop a partial trailing line (when head chunk is cut mid-line).
 */
function dropPartialTrailingLine(text) {
    const idx = text.lastIndexOf('\n');
    if (idx === -1) return text;
    return text.slice(0, idx);
}

function takeHeadChars(text, maxChars) {
    if (text.length <= maxChars) return text;
    return dropPartialTrailingLine(text.slice(0, maxChars));
}

function takeTailChars(text, maxChars) {
    if (text.length <= maxChars) return text;
    return dropPartialLeadingLine(text.slice(text.length - maxChars));
}

function extractInterestingLines(text, maxLines = MAX_ERROR_LINES) {
    const lines = normalizeNewlines(text).split('\n');
    const interesting = [];
    for (const line of lines) {
        if (ERROR_LINE_RE.test(line)) {
            interesting.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
            if (interesting.length >= maxLines) break;
        }
    }
    return interesting;
}

/**
 * Scan a large file in spaced chunks for ERROR/WARN-like lines without full load.
 */
function sampleErrorLinesFromFile(filePath, fileSize) {
    if (fileSize <= 0) return [];

    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const interesting = [];
        const seen = new Set();
        const chunks = Math.min(
            ERROR_SCAN_MAX_CHUNKS,
            Math.max(1, Math.ceil(fileSize / ERROR_SCAN_CHUNK_BYTES))
        );

        for (let i = 0; i < chunks; i++) {
            // Evenly space sample windows across the file
            const center = Math.floor(((i + 0.5) / chunks) * fileSize);
            const start = Math.max(0, Math.min(fileSize - 1, center - Math.floor(ERROR_SCAN_CHUNK_BYTES / 2)));
            const len = Math.min(ERROR_SCAN_CHUNK_BYTES, fileSize - start);
            if (len <= 0) continue;

            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, start);
            let text = normalizeNewlines(bufferToUtf8(buf));
            if (start > 0) text = dropPartialLeadingLine(text);
            text = dropPartialTrailingLine(text);

            for (const line of extractInterestingLines(text, MAX_ERROR_LINES)) {
                const key = line.slice(0, 300);
                if (seen.has(key)) continue;
                seen.add(key);
                interesting.push(line);
                if (interesting.length >= MAX_ERROR_LINES) {
                    return interesting;
                }
            }
        }
        return interesting;
    } catch (err) {
        console.warn('sampleErrorLinesFromFile failed:', err.message);
        return [];
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch (_) {
                // ignore
            }
        }
    }
}

/**
 * Build a model-friendly excerpt for large text / log files.
 * Strategy: HEAD + interesting ERROR/WARN samples + TAIL (most recent for logs).
 */
function prepareTextForContext(fullText, fileName, meta = {}) {
    const originalSizeBytes = meta.originalSizeBytes;
    const text = normalizeNewlines(fullText);
    const lineCount = text ? text.split('\n').length : 0;
    const isLog = meta.forceLog === true || isLikelyLogFile(fileName, text);

    if (text.length <= MAX_CONTEXT_CHARS) {
        return {
            content: text,
            charCount: text.length,
            truncated: false,
            isLog,
            lineCount,
            originalSizeBytes,
            strategy: 'full',
            notice: null,
        };
    }

    const head = takeHeadChars(text, HEAD_CONTEXT_CHARS);
    const tail = takeTailChars(text, TAIL_CONTEXT_CHARS);
    let errorLines = extractInterestingLines(text, MAX_ERROR_LINES);

    // Prefer external scan results if provided (from disk streaming)
    if (Array.isArray(meta.errorLines) && meta.errorLines.length > 0) {
        errorLines = meta.errorLines.slice(0, MAX_ERROR_LINES);
    }

    let errorBlock = '';
    if (errorLines.length > 0) {
        let joined = errorLines.join('\n');
        if (joined.length > ERROR_SAMPLE_CHARS) {
            joined = takeHeadChars(joined, ERROR_SAMPLE_CHARS);
        }
        errorBlock = [
            '',
            '--- Sampled ERROR / WARN / exception lines ---',
            joined,
            '--- End sampled issues ---',
            '',
        ].join('\n');
    }

    // Budget remaining for head/tail after error block and notices
    const sizeLabel = originalSizeBytes != null ? formatBytes(originalSizeBytes) : `${lineCount} lines / ${text.length} chars`;
    const notice = [
        `[LARGE FILE — truncated for AI context]`,
        `File: ${fileName}`,
        `Original: ~${sizeLabel}${lineCount ? `, ~${lineCount.toLocaleString()} lines in loaded text` : ''}`,
        `Strategy: ${isLog ? 'log-aware head + issues + tail (most recent)' : 'head + issues + tail'}`,
        `Only a sample is shown below. Ask for a specific section, keyword, or time range if needed.`,
    ].join('\n');

    const budget = Math.max(20_000, MAX_CONTEXT_CHARS - notice.length - errorBlock.length - 200);
    const headBudget = Math.floor(budget * 0.45);
    const tailBudget = budget - headBudget;

    const headPart = takeHeadChars(head, headBudget);
    const tailPart = takeTailChars(tail, tailBudget);

    const content = [
        notice,
        '',
        '===== BEGINNING OF FILE =====',
        headPart,
        '===== … middle omitted … =====',
        errorBlock.trimEnd(),
        '===== END OF FILE (most recent) =====',
        tailPart,
    ]
        .filter((part, idx, arr) => !(part === '' && arr[idx - 1] === ''))
        .join('\n');

    // Hard cap if still over
    let finalContent = content;
    if (finalContent.length > MAX_CONTEXT_CHARS + 5_000) {
        finalContent = takeHeadChars(finalContent, MAX_CONTEXT_CHARS) + '\n\n[Additional truncation applied]';
    }

    return {
        content: finalContent,
        charCount: finalContent.length,
        truncated: true,
        isLog,
        lineCount,
        originalSizeBytes,
        strategy: isLog ? 'log-head-issues-tail' : 'head-issues-tail',
        notice,
        errorLineCount: errorLines.length,
    };
}

/**
 * Stream-sample a large local text file without loading it all into RAM.
 */
function loadLargeLocalTextFile(filePath, fileName, fileSize) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');

        const headLen = Math.min(HEAD_READ_BYTES, fileSize);
        const headBuf = Buffer.alloc(headLen);
        fs.readSync(fd, headBuf, 0, headLen, 0);

        const tailLen = Math.min(TAIL_READ_BYTES, fileSize);
        const tailBuf = Buffer.alloc(tailLen);
        const tailOffset = Math.max(0, fileSize - tailLen);
        fs.readSync(fd, tailBuf, 0, tailLen, tailOffset);

        // Close before error scan opens again (or reuse fd — close then scan is simpler)
        fs.closeSync(fd);
        fd = undefined;

        if (!isLikelyTextContent(headBuf, fileName) && !isLikelyTextContent(tailBuf, fileName)) {
            return {
                success: false,
                error: 'File does not look like readable text (binary or unsupported type)',
                fileName,
            };
        }

        let headText = normalizeNewlines(bufferToUtf8(headBuf));
        let tailText = normalizeNewlines(bufferToUtf8(tailBuf));

        // Tail often starts mid-line when offset > 0
        if (tailOffset > 0) {
            tailText = dropPartialLeadingLine(tailText);
        }
        // Head may end mid-line
        if (headLen < fileSize) {
            headText = dropPartialTrailingLine(headText);
        }

        // Avoid duplicating content when head and tail overlap (small-but-over-threshold edge)
        let combined;
        if (fileSize <= HEAD_READ_BYTES + TAIL_READ_BYTES && tailOffset < headLen) {
            // Overlap: just use head extended — actually full middle is missing only if size > head
            // When overlapping, prefer full read of union
            const fullBuf = Buffer.alloc(fileSize);
            const fd2 = fs.openSync(filePath, 'r');
            fs.readSync(fd2, fullBuf, 0, fileSize, 0);
            fs.closeSync(fd2);
            combined = normalizeNewlines(bufferToUtf8(fullBuf));
        } else {
            combined = `${headText}\n\n…\n\n${tailText}`;
        }

        const errorLines = sampleErrorLinesFromFile(filePath, fileSize);
        const prepared = prepareTextForContext(combined, fileName, {
            originalSizeBytes: fileSize,
            forceLog: isLikelyLogFile(fileName, headText),
            errorLines,
        });

        // For pure stream sample without full line count, estimate lines from bytes
        const approxLines = Math.max(prepared.lineCount || 0, Math.round(fileSize / 80));

        return {
            success: true,
            fileName,
            content: prepared.content,
            charCount: prepared.charCount,
            truncated: true,
            isLog: prepared.isLog,
            strategy: prepared.strategy || 'stream-head-tail',
            originalSizeBytes: fileSize,
            originalSizeLabel: formatBytes(fileSize),
            approxLineCount: approxLines,
            errorLineCount: errorLines.length,
            notice: prepared.notice,
        };
    } catch (error) {
        console.error('loadLargeLocalTextFile error:', error);
        return { success: false, error: error.message || 'Failed to sample large file', fileName };
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch (_) {
                // ignore
            }
        }
    }
}

function stripXmlTags(xml) {
    return xml
        .replace(/<w:tab\s*\/>/g, '\t')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractFromDocx(buffer) {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) {
        throw new Error('Invalid DOCX: missing word/document.xml');
    }
    return stripXmlTags(entry.getData().toString('utf8'));
}

function extractFromZip(buffer) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const parts = [];

    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const name = entry.entryName.replace(/\\/g, '/');
        // Skip macOS junk and hidden paths
        if (name.includes('__MACOSX/') || name.split('/').some(p => p.startsWith('.'))) {
            continue;
        }

        const data = entry.getData();
        const base = path.basename(name);
        const ext = getExtension(base);

        try {
            if (ext === '.docx') {
                const text = extractFromDocx(data);
                if (text) parts.push(`--- File: ${name} ---\n${text}`);
            } else if (isLikelyTextContent(data, base)) {
                const text = bufferToUtf8(data).trim();
                if (text) parts.push(`--- File: ${name} ---\n${text}`);
            }
        } catch (err) {
            console.warn(`Skipping zip entry ${name}:`, err.message);
        }
    }

    if (parts.length === 0) {
        throw new Error('ZIP contained no readable text files (txt, md, json, code, docx, etc.)');
    }

    return parts.join('\n\n');
}

function extractTextFromBuffer(buffer, fileName) {
    const ext = getExtension(fileName);

    if (ext === '.zip') {
        return extractFromZip(buffer);
    }

    if (ext === '.docx') {
        return extractFromDocx(buffer);
    }

    // Treat .ipynb as JSON and pull source cells
    if (ext === '.ipynb') {
        try {
            const notebook = JSON.parse(bufferToUtf8(buffer));
            const cells = Array.isArray(notebook.cells) ? notebook.cells : [];
            const text = cells
                .map(cell => {
                    const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source || '';
                    return src.trim();
                })
                .filter(Boolean)
                .join('\n\n');
            if (text) return text;
        } catch (_) {
            // fall through to raw text
        }
    }

    if (isLikelyTextContent(buffer, fileName)) {
        return bufferToUtf8(buffer).trim();
    }

    throw new Error(
        `Unsupported or binary file type "${ext || 'unknown'}". Use text files, .docx, or a .zip of text files.`
    );
}

function downloadBuffer(fileUrl, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('Too many redirects while downloading file'));
            return;
        }

        let parsed;
        try {
            parsed = new URL(fileUrl);
        } catch {
            reject(new Error('Invalid URL'));
            return;
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            reject(new Error('Only http and https URLs are supported'));
            return;
        }

        const client = parsed.protocol === 'https:' ? https : http;
        const request = client.get(
            fileUrl,
            {
                headers: {
                    'User-Agent': 'cheating-daddy-file-loader/1.0',
                    Accept: '*/*',
                },
                timeout: 60_000,
            },
            res => {
                const status = res.statusCode || 0;

                if (status >= 300 && status < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, fileUrl).toString();
                    res.resume();
                    downloadBuffer(next, redirectCount + 1).then(resolve, reject);
                    return;
                }

                if (status < 200 || status >= 300) {
                    res.resume();
                    reject(new Error(`Download failed with HTTP ${status}`));
                    return;
                }

                const chunks = [];
                let total = 0;

                res.on('data', chunk => {
                    total += chunk.length;
                    if (total > MAX_DOWNLOAD_BYTES) {
                        res.destroy();
                        reject(new Error(`File exceeds maximum size of ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB`));
                        return;
                    }
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    resolve(Buffer.concat(chunks));
                });

                res.on('error', reject);
            }
        );

        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Download timed out'));
        });

        request.on('error', reject);
    });
}

/**
 * Extract and optionally truncate text from a buffer for questions/context.
 * Large text/logs use head + error samples + tail instead of a hard head-only cut.
 *
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {{ maxBytes?: number, originalSizeBytes?: number }} [options]
 * @returns {{ success: boolean, fileName?: string, content?: string, charCount?: number, truncated?: boolean, error?: string }}
 */
function loadQuestionsFromBuffer(buffer, fileName, options = {}) {
    try {
        if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
            return { success: false, error: 'File was empty or could not be read', fileName };
        }

        const maxBytes = options.maxBytes != null ? options.maxBytes : MAX_DOWNLOAD_BYTES;
        if (buffer.length > maxBytes) {
            return {
                success: false,
                error: `File exceeds maximum size of ${formatBytes(maxBytes)}`,
                fileName,
            };
        }

        const safeName = (fileName && String(fileName).trim()) || 'file';
        let content = extractTextFromBuffer(buffer, safeName);

        if (!content || !content.trim()) {
            return { success: false, error: 'File was empty or contained no readable text', fileName: safeName };
        }

        const prepared = prepareTextForContext(content, safeName, {
            originalSizeBytes: options.originalSizeBytes != null ? options.originalSizeBytes : buffer.length,
        });

        return {
            success: true,
            fileName: safeName,
            content: prepared.content,
            charCount: prepared.charCount,
            truncated: prepared.truncated,
            isLog: prepared.isLog,
            strategy: prepared.strategy,
            originalSizeBytes: prepared.originalSizeBytes,
            originalSizeLabel: formatBytes(prepared.originalSizeBytes || buffer.length),
            lineCount: prepared.lineCount,
            errorLineCount: prepared.errorLineCount || 0,
            notice: prepared.notice,
        };
    } catch (error) {
        console.error('loadQuestionsFromBuffer error:', error);
        return { success: false, error: error.message || 'Failed to read file', fileName };
    }
}

/**
 * Load questions/context from a base64-encoded file (used by renderer file picker).
 *
 * @param {string} base64
 * @param {string} fileName
 */
function loadQuestionsFromBase64(base64, fileName) {
    try {
        if (!base64 || typeof base64 !== 'string') {
            return { success: false, error: 'No file data provided' };
        }
        // Strip data-URL prefix if present
        const pure = base64.includes(',') ? base64.split(',').pop() : base64;
        const buffer = Buffer.from(pure, 'base64');
        return loadQuestionsFromBuffer(buffer, fileName);
    } catch (error) {
        console.error('loadQuestionsFromBase64 error:', error);
        return { success: false, error: error.message || 'Failed to decode file' };
    }
}

/**
 * Normalize a user-provided local file path (quotes, ~, Windows separators).
 * @param {string} filePath
 * @returns {string}
 */
function normalizeLocalFilePath(filePath) {
    let cleaned = String(filePath || '').trim();
    // Strip surrounding quotes
    if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
        cleaned = cleaned.slice(1, -1).trim();
    }

    // Expand ~
    if (cleaned === '~') {
        cleaned = os.homedir();
    } else if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
        cleaned = path.join(os.homedir(), cleaned.slice(2));
    }

    // file:/// URLs
    if (cleaned.toLowerCase().startsWith('file:')) {
        try {
            cleaned = decodeURIComponent(new URL(cleaned).pathname);
            // Windows file URL path is like /C:/Users/...
            if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(cleaned)) {
                cleaned = cleaned.slice(1);
            }
        } catch (_) {
            // keep original
        }
    }

    return path.normalize(cleaned);
}

/**
 * Load questions/context from a local filesystem path.
 * Example: C:\Users\AsifK\Downloads\github-recovery-codes.txt
 * Large logs (up to 500 MB) are stream-sampled: head + ERROR/WARN lines + tail.
 *
 * @param {string} filePath
 * @returns {{ success: boolean, fileName?: string, content?: string, charCount?: number, truncated?: boolean, path?: string, error?: string }}
 */
function loadQuestionsFromPath(filePath) {
    try {
        if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
            return { success: false, error: 'Please provide a file path' };
        }

        const resolved = normalizeLocalFilePath(filePath);

        if (!fs.existsSync(resolved)) {
            return { success: false, error: `File not found: ${resolved}`, path: resolved };
        }

        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
            return { success: false, error: 'Path is not a file', path: resolved };
        }

        if (stat.size === 0) {
            return { success: false, error: 'File is empty', path: resolved };
        }

        if (stat.size > MAX_LOCAL_FILE_BYTES) {
            return {
                success: false,
                error: `File is too large (${formatBytes(stat.size)}). Maximum is ${formatBytes(MAX_LOCAL_FILE_BYTES)}.`,
                path: resolved,
            };
        }

        const baseName = path.basename(resolved);

        // Large files: stream-sample instead of loading entirely into memory
        if (stat.size > MAX_FULL_READ_BYTES) {
            const result = loadLargeLocalTextFile(resolved, baseName, stat.size);
            if (result.success) {
                result.path = resolved;
            }
            return result;
        }

        const buffer = fs.readFileSync(resolved);
        const result = loadQuestionsFromBuffer(buffer, baseName, {
            maxBytes: MAX_FULL_READ_BYTES,
            originalSizeBytes: stat.size,
        });
        if (result.success) {
            result.path = resolved;
        }
        return result;
    } catch (error) {
        console.error('loadQuestionsFromPath error:', error);
        return { success: false, error: error.message || 'Failed to read file from path' };
    }
}

/**
 * Download a file from a URL and extract text content for questions/context.
 * File name is taken from the last path segment of the URL.
 *
 * @param {string} fileUrl
 * @returns {Promise<{ success: boolean, fileName?: string, content?: string, charCount?: number, truncated?: boolean, error?: string }>}
 */
async function loadQuestionsFromUrl(fileUrl) {
    try {
        if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.trim()) {
            return { success: false, error: 'Please provide a file URL' };
        }

        const trimmed = fileUrl.trim();
        const fileName = getFileNameFromUrl(trimmed);
        const buffer = await downloadBuffer(trimmed);
        return loadQuestionsFromBuffer(buffer, fileName);
    } catch (error) {
        console.error('loadQuestionsFromUrl error:', error);
        return { success: false, error: error.message || 'Failed to load file from URL' };
    }
}

module.exports = {
    loadQuestionsFromUrl,
    loadQuestionsFromBase64,
    loadQuestionsFromBuffer,
    loadQuestionsFromPath,
    loadLargeLocalTextFile,
    prepareTextForContext,
    normalizeLocalFilePath,
    getFileNameFromUrl,
    extractTextFromBuffer,
    formatBytes,
    MAX_CONTEXT_CHARS,
    MAX_LOCAL_FILE_BYTES,
    MAX_FULL_READ_BYTES,
};
