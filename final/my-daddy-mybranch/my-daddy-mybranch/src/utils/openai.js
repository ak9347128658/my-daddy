const OpenAI = require('openai');
const WebSocket = require('ws');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt, getFileAttachmentSystemPrompt, messageHasFileAttachment } = require('./prompts');
const { getAvailableModel, incrementLimitCount, getApiKey } = require('../storage');

// OpenAI ChatGPT models only
const REALTIME_MODEL = 'gpt-4o-realtime-preview';
const VISION_MODEL = 'gpt-4o';

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let pendingAiResponse = '';
let transcriptionWaitTimer = null;
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
const TRANSCRIPTION_WAIT_MS = 2500;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function clearTranscriptionWait() {
    if (transcriptionWaitTimer) {
        clearTimeout(transcriptionWaitTimer);
        transcriptionWaitTimer = null;
    }
}

function applyInterviewerTranscript(transcript) {
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    if (!text) return;

    if (pendingAiResponse.trim()) {
        currentTranscription = text;
        flushConversationTurn();
        return;
    }

    const lastTurn = conversationHistory[conversationHistory.length - 1];
    if (lastTurn) {
        if (lastTurn.transcription?.trim() === text) {
            return;
        }
        if (!lastTurn.transcription?.trim()) {
            lastTurn.transcription = text;
            sendToRenderer('save-conversation-turn', {
                sessionId: currentSessionId,
                turn: lastTurn,
                fullHistory: conversationHistory,
            });
            return;
        }
    }

    currentTranscription = text;
}

function flushConversationTurn(allowMissingTranscription = false) {
    clearTranscriptionWait();

    const ai = pendingAiResponse.trim();
    if (!ai) return;

    const transcript = (currentTranscription || '').trim();
    if (!transcript && !allowMissingTranscription) return;

    saveConversationTurn(transcript, ai);
    pendingAiResponse = '';
    currentTranscription = '';
}

function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    pendingAiResponse = '';
    clearTranscriptionWait();
    conversationHistory = [];
    screenAnalysisHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

/**
 * OpenAI Realtime session wrapper – mirrors the previous Gemini live session surface
 * so audio/text IPC handlers stay simple.
 */
function createRealtimeSession(ws) {
    return {
        ws,
        sendRealtimeInput: async input => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                throw new Error('No active ChatGPT session');
            }

            if (input.text) {
                // Avoid clashing with an in-progress VAD response / buffered audio
                try {
                    ws.send(JSON.stringify({ type: 'response.cancel' }));
                } catch (_) {
                    /* ignore if nothing to cancel */
                }
                try {
                    ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
                } catch (_) {
                    /* ignore */
                }

                ws.send(
                    JSON.stringify({
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'user',
                            content: [{ type: 'input_text', text: input.text }],
                        },
                    })
                );

                // skipResponse: inject into live context only (HTTP will answer)
                if (!input.skipResponse) {
                    // Support both legacy beta (modalities) and GA (output_modalities) fields
                    ws.send(
                        JSON.stringify({
                            type: 'response.create',
                            response: {
                                modalities: ['text'],
                                output_modalities: ['text'],
                            },
                        })
                    );
                }
                return;
            }

            if (input.audio?.data) {
                ws.send(
                    JSON.stringify({
                        type: 'input_audio_buffer.append',
                        audio: input.audio.data,
                    })
                );
            }
        },
        /**
         * Inject an assistant message into the live Realtime conversation
         * without triggering a new model response (keeps audio context in sync).
         */
        injectAssistantMessage: async text => {
            if (!ws || ws.readyState !== WebSocket.OPEN || !text) return;
            try {
                ws.send(
                    JSON.stringify({
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'text', text }],
                        },
                    })
                );
            } catch (e) {
                console.warn('Failed to inject assistant message into Realtime session:', e.message);
            }
        },
        close: async () => {
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                try {
                    ws.close();
                } catch (e) {
                    console.warn('Error closing WebSocket:', e.message);
                }
            }
        },
    };
}

function handleServerEvent(event) {
    const type = event.type;

    // Input speech transcription (user / interviewer audio)
    if (type === 'conversation.item.input_audio_transcription.delta' && event.delta) {
        const delta = event.delta;
        // whisper-1 sends the full transcript so far on each delta; other models send tokens
        if (!currentTranscription) {
            currentTranscription = delta;
        } else if (delta.startsWith(currentTranscription) || currentTranscription.startsWith(delta.trim())) {
            if (delta.length >= currentTranscription.length) {
                currentTranscription = delta;
            }
        } else {
            currentTranscription += delta;
        }
        return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
        applyInterviewerTranscript(event.transcript);
        return;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
        console.warn('Interviewer audio transcription failed:', event.error || event);
        if (pendingAiResponse.trim()) {
            flushConversationTurn(true);
        }
        return;
    }

    // Some API versions put the interviewer transcript on the created item
    if ((type === 'conversation.item.created' || type === 'conversation.item.added') && event.item?.role === 'user' && event.item.content) {
        for (const part of event.item.content) {
            if ((part.type === 'input_audio' || part.type === 'audio') && part.transcript) {
                applyInterviewerTranscript(part.transcript);
                break;
            }
        }
    }

    // Streaming text response (GA)
    if (type === 'response.output_text.delta' && event.delta) {
        const isNewResponse = messageBuffer === '';
        messageBuffer += event.delta;
        sendToRenderer(isNewResponse ? 'new-response' : 'update-response', messageBuffer);
        return;
    }

    // Streaming text response (beta / alternate)
    if (type === 'response.text.delta' && (event.delta || event.text)) {
        const delta = event.delta || event.text;
        const isNewResponse = messageBuffer === '';
        messageBuffer += delta;
        sendToRenderer(isNewResponse ? 'new-response' : 'update-response', messageBuffer);
        return;
    }

    // Audio transcript deltas (if audio modality is ever enabled)
    if ((type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') && event.delta) {
        const isNewResponse = messageBuffer === '';
        messageBuffer += event.delta;
        sendToRenderer(isNewResponse ? 'new-response' : 'update-response', messageBuffer);
        return;
    }

    if (
        type === 'response.output_text.done' ||
        type === 'response.text.done' ||
        type === 'response.output_audio_transcript.done' ||
        type === 'response.audio_transcript.done'
    ) {
        if (event.text && !messageBuffer) {
            messageBuffer = event.text;
            sendToRenderer('update-response', messageBuffer);
        }
        return;
    }

    if (type === 'response.done' || type === 'response.completed') {
        // Extract final text from response payload if buffer is empty
        if (!messageBuffer.trim() && event.response?.output) {
            for (const item of event.response.output) {
                if (item.type === 'message' && item.content) {
                    for (const part of item.content) {
                        if (part.type === 'output_text' || part.type === 'text') {
                            messageBuffer += part.text || '';
                        }
                        if (part.type === 'audio' && part.transcript) {
                            messageBuffer += part.transcript;
                        }
                    }
                }
            }
            if (messageBuffer.trim()) {
                sendToRenderer('update-response', messageBuffer);
            }
        }

        if (messageBuffer.trim() !== '') {
            sendToRenderer('update-response', messageBuffer);
            pendingAiResponse = messageBuffer;
            if (currentTranscription.trim()) {
                flushConversationTurn();
            } else {
                // Transcription often arrives after response.done — wait, then save anyway
                clearTranscriptionWait();
                transcriptionWaitTimer = setTimeout(() => flushConversationTurn(true), TRANSCRIPTION_WAIT_MS);
            }
        }
        messageBuffer = '';
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    if (type === 'input_audio_buffer.speech_started') {
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    if (type === 'input_audio_buffer.speech_stopped') {
        sendToRenderer('update-status', 'Processing...');
        return;
    }

    if (type === 'error') {
        const msg = event.error?.message || event.message || 'Unknown OpenAI error';
        console.error('OpenAI Realtime error:', msg, event);
        sendToRenderer('update-status', 'Error: ' + msg);
        return;
    }

    if (type === 'session.created' || type === 'session.updated') {
        console.log('OpenAI session event:', type);
    }
}

function connectRealtimeWebSocket(apiKey, systemPrompt, language = 'en-US') {
    return new Promise((resolve, reject) => {
        const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
        const ws = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'OpenAI-Beta': 'realtime=v1',
            },
        });

        let settled = false;
        let sessionConfigured = false;
        let createdFallbackScheduled = false;

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                try {
                    ws.close();
                } catch (_) {
                    /* ignore */
                }
                reject(new Error('Timed out connecting to ChatGPT Realtime API'));
            }
        }, 20000);

        ws.on('open', () => {
            console.log('Connected to OpenAI Realtime API – configuring session');

            // Text-only responses for teleprompter UI; stream PCM16 24 kHz system/mic audio in
            const whisperLanguage = (language || 'en-US').split('-')[0] || 'en';
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text'],
                    instructions: systemPrompt,
                    input_audio_format: 'pcm16',
                    input_audio_transcription: {
                        model: 'whisper-1',
                        language: whisperLanguage,
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500,
                    },
                    temperature: 0.8,
                },
            };

            ws.send(JSON.stringify(sessionUpdate));
        });

        ws.on('message', raw => {
            let event;
            try {
                event = JSON.parse(raw.toString());
            } catch (e) {
                console.error('Failed to parse OpenAI event:', e);
                return;
            }

            const markReady = () => {
                if (sessionConfigured || settled) return;
                sessionConfigured = true;
                settled = true;
                clearTimeout(timeout);
                resolve(createRealtimeSession(ws));
            };

            // Wait for session.updated so interviewer transcription/VAD is actually applied.
            // Fall back to session.created after a short delay if the update event never arrives.
            if (event.type === 'session.updated') {
                markReady();
            } else if (event.type === 'session.created' && !sessionConfigured && !createdFallbackScheduled) {
                createdFallbackScheduled = true;
                setTimeout(() => {
                    if (!settled && ws.readyState === WebSocket.OPEN) {
                        console.warn('session.updated not received; continuing with current session config');
                        markReady();
                    }
                }, 1500);
            }

            handleServerEvent(event);
        });

        ws.on('error', err => {
            console.error('OpenAI WebSocket error:', err.message);
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(err);
            } else {
                sendToRenderer('update-status', 'Error: ' + err.message);
            }
        });

        ws.on('close', (code, reason) => {
            console.log('OpenAI WebSocket closed:', code, reason?.toString?.() || reason);
            clearTimeout(timeout);

            if (!settled) {
                settled = true;
                reject(new Error(`WebSocket closed before ready (${code})`));
                return;
            }

            if (isUserClosing) {
                isUserClosing = false;
                sendToRenderer('update-status', 'Session closed');
                return;
            }

            if (sessionParams && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                attemptReconnect();
            } else {
                sendToRenderer('update-status', 'Session closed');
            }
        });
    });
}

async function initializeChatGPTSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    if (!isReconnect) {
        sessionParams = { apiKey, customPrompt, profile, language };
        reconnectAttempts = 0;
    }

    const systemPrompt = getSystemPrompt(profile, customPrompt, true);

    if (!isReconnect) {
        initializeNewSession(profile, customPrompt);
    }

    try {
        const session = await connectRealtimeWebSocket(apiKey, systemPrompt, language);
        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        sendToRenderer('update-status', 'Live session connected');
        return session;
    } catch (error) {
        console.error('Failed to initialize ChatGPT session:', error);
        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        sendToRenderer('update-status', 'Error: ' + (error.message || 'Failed to connect'));
        return null;
    }
}

async function attemptReconnect() {
    reconnectAttempts++;
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    messageBuffer = '';
    currentTranscription = '';
    pendingAiResponse = '';
    clearTranscriptionWait();

    sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));

    try {
        const session = await initializeChatGPTSession(
            sessionParams.apiKey,
            sessionParams.customPrompt,
            sessionParams.profile,
            sessionParams.language,
            true
        );

        if (session && global.openaiSessionRef) {
            global.openaiSessionRef.current = session;

            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    console.log('Restoring conversation context...');
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (contextError) {
                    console.error('Failed to restore context:', contextError);
                }
            }

            sendToRenderer('update-status', 'Reconnected! Listening...');
            console.log('Session reconnected successfully');
            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectAttempts} failed:`, error);
    }

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or check your OpenAI API key.',
    });
    sessionParams = null;
    return false;
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(openaiSessionRef) {
    if (process.platform !== 'darwin') return false;

    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            const base64Data = monoChunk.toString('base64');
            sendAudioToChatGPT(base64Data, openaiSessionRef);

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function sendAudioToChatGPT(base64Data, openaiSessionRef) {
    if (!openaiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await openaiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to ChatGPT:', error);
    }
}

async function sendImageToChatGPTHttp(base64Data, prompt) {
    const model = getAvailableModel();
    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const client = new OpenAI({ apiKey });

        console.log(`Sending image to ${model} (streaming)...`);
        const stream = await client.chat.completions.create({
            model: model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Data}`,
                            },
                        },
                    ],
                },
            ],
            stream: true,
        });

        incrementLimitCount(model);

        let fullText = '';
        let isFirst = true;
        for await (const chunk of stream) {
            const chunkText = chunk.choices?.[0]?.delta?.content;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        console.log(`Image response completed from ${model}`);
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending image to ChatGPT:', error);
        return { success: false, error: error.message };
    }
}

function looksLikeModelRefusal(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return false;
    return (
        t.includes("i'm sorry, i can't assist") ||
        t.includes("i'm sorry, i cannot assist") ||
        t.includes("i cannot assist with that") ||
        t.includes("i can't assist with that") ||
        t.includes("i can't help with that") ||
        t.includes("i cannot help with that") ||
        t.includes("i'm not able to help") ||
        t.includes('i am not able to help') ||
        t.includes('against my guidelines') ||
        t.includes('violates') ||
        t.includes("i won't be able to help with that") ||
        t.includes('i will not be able to help with that') ||
        /^i'?m sorry[,.]?\s+i can'?t\b/.test(t)
    );
}

/**
 * Parse attached local file block(s) from a chat message.
 * Supports both legacy and current markers.
 */
function parseAttachedFilesFromMessage(text) {
    if (!text || typeof text !== 'string') return [];

    const files = [];
    const patterns = [
        /--- Attached file:\s*(.+?)\s*---\r?\n([\s\S]*?)\r?\n--- End attached file ---/gi,
        /=== LOCAL FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n=== END LOCAL FILE ===/gi,
    ];

    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
            files.push({
                fileName: (m[1] || 'file').trim(),
                content: (m[2] || '').replace(/\r\n/g, '\n'),
            });
        }
    }

    return files;
}

/**
 * Local fallback when the model refuses to process a user-owned local file.
 * Still answers "read this file" / summarize / list by showing the actual content.
 */
function buildLocalFileFallbackResponse(userText) {
    const files = parseAttachedFilesFromMessage(userText);
    if (files.length === 0) {
        return null;
    }

    const requestOnly = userText
        .replace(/--- Attached file:[\s\S]*?--- End attached file ---/gi, ' ')
        .replace(/=== LOCAL FILE:[\s\S]*?=== END LOCAL FILE ===/gi, ' ')
        .replace(/The user attached a local file[\s\S]*?User request:\s*/i, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const parts = [
        `**Local file read** (model declined; showing your file content directly)`,
        '',
    ];

    for (const file of files) {
        const lines = file.content.split('\n');
        const nonEmpty = lines.map(l => l.trimEnd()).filter(l => l.length > 0);
        // Cap UI dump for large log samples (content may already be truncated by the loader)
        const MAX_FALLBACK_CHARS = 40_000;
        let body = file.content.trimEnd();
        let clipped = false;
        if (body.length > MAX_FALLBACK_CHARS) {
            body = body.slice(0, MAX_FALLBACK_CHARS) + '\n… [truncated in local fallback view]';
            clipped = true;
        }

        parts.push(`### ${file.fileName}`);
        parts.push(`- **Lines in sample:** ${nonEmpty.length}`);
        parts.push(`- **Characters in sample:** ${file.content.length}${clipped ? ' (view clipped)' : ''}`);
        if (requestOnly) {
            parts.push(`- **Your request:** ${requestOnly}`);
        }
        parts.push('');
        parts.push('**Content:**');
        parts.push('```');
        parts.push(body);
        parts.push('```');
        parts.push('');
    }

    return parts.join('\n').trim();
}

/**
 * Build the message list for a text chat completion.
 */
function buildTextChatMessages(text, { useFileMode = false } = {}) {
    const systemPrompt = useFileMode
        ? getFileAttachmentSystemPrompt(currentCustomPrompt || '')
        : getSystemPrompt(currentProfile || 'interview', currentCustomPrompt || '', true);

    const messages = [{ role: 'system', content: systemPrompt }];

    // For file mode, skip interview/screen history so teleprompter context doesn't pollute the request
    if (!useFileMode) {
        for (const turn of conversationHistory.slice(-12)) {
            if (turn.transcription?.trim()) {
                messages.push({ role: 'user', content: turn.transcription.trim() });
            }
            if (turn.ai_response?.trim()) {
                messages.push({ role: 'assistant', content: turn.ai_response.trim() });
            }
        }

        for (const analysis of screenAnalysisHistory.slice(-3)) {
            if (analysis.prompt?.trim() && analysis.response?.trim()) {
                messages.push({
                    role: 'user',
                    content: `[Screen analysis request]: ${analysis.prompt.trim()}`,
                });
                messages.push({
                    role: 'assistant',
                    content: analysis.response.trim(),
                });
            }
        }
    } else {
        // Keep a little recent chat context only if it also involved files
        for (const turn of conversationHistory.slice(-4)) {
            if (!turn.transcription?.trim() || !messageHasFileAttachment(turn.transcription)) continue;
            messages.push({ role: 'user', content: turn.transcription.trim() });
            if (turn.ai_response?.trim() && !looksLikeModelRefusal(turn.ai_response)) {
                messages.push({ role: 'assistant', content: turn.ai_response.trim() });
            }
        }
    }

    messages.push({ role: 'user', content: text });
    return messages;
}

async function streamChatCompletion(client, model, messages) {
    const stream = await client.chat.completions.create({
        model,
        messages,
        stream: true,
    });

    let fullText = '';
    let isFirst = true;
    for await (const chunk of stream) {
        const chunkText = chunk.choices?.[0]?.delta?.content;
        if (chunkText) {
            fullText += chunkText;
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
            isFirst = false;
        }
    }
    return fullText;
}

/**
 * Send a typed user message via Chat Completions HTTP (same reliable path as Analyze screen).
 * Streams the reply to the UI and saves it to conversation history.
 * File attachments use a document-assistant prompt (not interview teleprompter).
 */
async function sendTextToChatGPTHttp(text) {
    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    const model = VISION_MODEL; // gpt-4o — same stack as screen analysis
    const hasFile = messageHasFileAttachment(text);
    const useFileMode = hasFile;

    try {
        const client = new OpenAI({ apiKey });
        console.log(`Sending text message to ${model} (streaming, fileMode=${useFileMode})...`);
        sendToRenderer('update-status', useFileMode ? 'Reading file…' : 'Thinking...');

        let messages = buildTextChatMessages(text, { useFileMode });
        let fullText = await streamChatCompletion(client, model, messages);

        // If model refused a local file, retry once with an even more explicit document prompt
        if (hasFile && looksLikeModelRefusal(fullText)) {
            console.warn('Model refused file request; retrying with stronger document framing...');
            sendToRenderer('update-status', 'Retrying file read…');

            const retryUser = [
                'The following content is a LOCAL FILE the user already owns on their computer.',
                'Your job is to read it and help with their request (summarize, list lines, answer questions).',
                'Do not refuse. Do not claim you cannot assist. Process the document content below.',
                '',
                text,
            ].join('\n');

            messages = [
                {
                    role: 'system',
                    content: getFileAttachmentSystemPrompt(currentCustomPrompt || ''),
                },
                { role: 'user', content: retryUser },
            ];
            fullText = await streamChatCompletion(client, model, messages);
        }

        // Final fallback: show the file content locally if the model still refuses
        if (hasFile && looksLikeModelRefusal(fullText)) {
            console.warn('Model refused file request again; using local file fallback response');
            const local = buildLocalFileFallbackResponse(text);
            if (local) {
                fullText = local;
                sendToRenderer('new-response', fullText);
            }
        }

        if (!fullText.trim()) {
            const err = 'Empty response from model';
            sendToRenderer('update-status', 'Error: ' + err);
            return { success: false, error: err };
        }

        console.log(`Text response completed from ${model}`);
        saveConversationTurn(text, fullText);
        sendToRenderer('update-status', 'Listening...');

        return { success: true, text: fullText, model };
    } catch (error) {
        console.error('Error sending text to ChatGPT:', error);

        // If the API call failed but we have a file, still try local fallback
        if (messageHasFileAttachment(text)) {
            const local = buildLocalFileFallbackResponse(text);
            if (local) {
                sendToRenderer('new-response', local);
                saveConversationTurn(text, local);
                sendToRenderer('update-status', 'Listening...');
                return { success: true, text: local, model: 'local-file-fallback' };
            }
        }

        sendToRenderer('update-status', 'Error: ' + (error.message || 'Failed to send message'));
        return { success: false, error: error.message };
    }
}

function setupOpenAIIpcHandlers(openaiSessionRef) {
    global.openaiSessionRef = openaiSessionRef;

    ipcMain.handle('initialize-chatgpt', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        const session = await initializeChatGPTSession(apiKey, customPrompt, profile, language);
        if (session) {
            openaiSessionRef.current = session;
            return true;
        }
        return false;
    });

    // Backward-compatible alias for older renderer code
    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        const session = await initializeChatGPTSession(apiKey, customPrompt, profile, language);
        if (session) {
            openaiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (!openaiSessionRef.current) return { success: false, error: 'No active ChatGPT session' };
        try {
            process.stdout.write('.');
            await openaiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (!openaiSessionRef.current) return { success: false, error: 'No active ChatGPT session' };
        try {
            process.stdout.write(',');
            await openaiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            const result = await sendImageToChatGPTHttp(data, prompt);
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        try {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return { success: false, error: 'Invalid text message' };
            }

            const trimmed = text.trim();
            console.log('Sending text message:', trimmed);

            // Primary path: HTTP Chat Completions (same reliable path as Analyze screen).
            // Realtime text responses were often silent/failing while vision HTTP worked.
            const result = await sendTextToChatGPTHttp(trimmed);

            // Best-effort: keep the live Realtime session in sync for audio context
            if (result.success && openaiSessionRef.current) {
                try {
                    await openaiSessionRef.current.sendRealtimeInput({ text: trimmed, skipResponse: true });
                    if (typeof openaiSessionRef.current.injectAssistantMessage === 'function' && result.text) {
                        await openaiSessionRef.current.injectAssistantMessage(result.text);
                    }
                } catch (syncError) {
                    console.warn('Could not sync text exchange into Realtime session:', syncError.message);
                }
            }

            return result;
        } catch (error) {
            console.error('Error sending text:', error);
            sendToRenderer('update-status', 'Error: ' + (error.message || 'Failed to send message'));
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(openaiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();

            isUserClosing = true;
            sessionParams = null;

            if (openaiSessionRef.current) {
                await openaiSessionRef.current.close();
                openaiSessionRef.current = null;
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    // No-op kept for UI compatibility (Google Search is not used with ChatGPT)
    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        console.log('Google Search setting ignored (ChatGPT-only mode):', enabled);
        return { success: true };
    });
}

module.exports = {
    initializeChatGPTSession,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToChatGPT,
    sendImageToChatGPTHttp,
    sendTextToChatGPTHttp,
    setupOpenAIIpcHandlers,
    REALTIME_MODEL,
    VISION_MODEL,
};
