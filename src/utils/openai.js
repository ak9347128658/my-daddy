const OpenAI = require('openai');
const WebSocket = require('ws');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const { getAvailableModel, incrementLimitCount, getApiKey } = require('../storage');

// OpenAI ChatGPT models only
const REALTIME_MODEL = 'gpt-4o-realtime-preview';
const VISION_MODEL = 'gpt-4o';

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;

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
function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
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
                ws.send(
                    JSON.stringify({
                        type: 'response.create',
                        response: {
                            modalities: ['text'],
                        },
                    })
                );
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
        currentTranscription += event.delta;
        return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
        // Prefer full completed transcript when available
        if (!currentTranscription || currentTranscription.length < event.transcript.length) {
            currentTranscription = event.transcript;
        } else if (event.transcript.trim()) {
            currentTranscription = event.transcript;
        }
        return;
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
            if (currentTranscription) {
                saveConversationTurn(currentTranscription, messageBuffer);
                currentTranscription = '';
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

function connectRealtimeWebSocket(apiKey, systemPrompt) {
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
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    modalities: ['text'],
                    instructions: systemPrompt,
                    input_audio_format: 'pcm16',
                    input_audio_transcription: {
                        model: 'whisper-1',
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

            // Resolve once session is ready (session.created may arrive before our update)
            if (!sessionConfigured && (event.type === 'session.updated' || event.type === 'session.created')) {
                // Prefer session.updated as "fully configured", but accept created to avoid hangs
                if (event.type === 'session.updated' || event.type === 'session.created') {
                    sessionConfigured = true;
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        resolve(createRealtimeSession(ws));
                    }
                }
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
        const session = await connectRealtimeWebSocket(apiKey, systemPrompt);
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
        if (!openaiSessionRef.current) return { success: false, error: 'No active ChatGPT session' };

        try {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return { success: false, error: 'Invalid text message' };
            }

            console.log('Sending text message:', text);
            await openaiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
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
    setupOpenAIIpcHandlers,
    REALTIME_MODEL,
    VISION_MODEL,
};
