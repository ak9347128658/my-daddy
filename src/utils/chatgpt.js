const OpenAI = require('openai');
const { BrowserWindow } = require('electron');
const { getSystemPrompt } = require('./prompts');
const { getApiKey } = require('../storage');

// Default models (override via env if needed)
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

const DEFAULT_SCREEN_PROMPT = `Analyze this screenshot and help the user.
If it is a coding problem, give a short approach then the full solution code.
If it is a multiple-choice question, give the correct answer and a brief reason.
If it is a form, page, or general UI, explain what is shown and what the user should do.
Be direct and complete — no filler.`;

let openaiClient = null;
let currentApiKey = null;
let sessionActive = false;
let currentSessionId = null;
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = 'interview';
let currentCustomPrompt = '';
let currentSystemPrompt = '';
let isInitializingSession = false;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

function getClient(apiKey) {
    const key = apiKey || getApiKey();
    if (!key) {
        throw new Error('No API key configured');
    }

    // Reuse client when key matches
    if (openaiClient && currentApiKey === key) {
        return openaiClient;
    }

    currentApiKey = key;
    openaiClient = new OpenAI({ apiKey: key });
    return openaiClient;
}

function looksLikeOpenAIKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') return false;
    const key = apiKey.trim();
    // OpenAI keys typically start with sk- (including sk-proj-, sk-svcacct-, etc.)
    return key.startsWith('sk-') && key.length > 20;
}

function looksLikeGeminiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') return false;
    const key = apiKey.trim();
    return key.startsWith('AIza') || key.startsWith('AI');
}

function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    conversationHistory = [];
    screenAnalysisHistory = [];
    currentProfile = profile || 'interview';
    currentCustomPrompt = customPrompt || '';
    currentSystemPrompt = getSystemPrompt(currentProfile, currentCustomPrompt, false);
    sessionActive = true;

    console.log('New ChatGPT conversation session:', currentSessionId, 'profile:', currentProfile);

    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }

    return currentSessionId;
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession(currentProfile, currentCustomPrompt);
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: (transcription || '').trim(),
        ai_response: (aiResponse || '').trim(),
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
        initializeNewSession(currentProfile, currentCustomPrompt);
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: (response || '').trim(),
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
        active: sessionActive,
    };
}

function buildChatMessages(userContent) {
    const messages = [];

    if (currentSystemPrompt) {
        messages.push({ role: 'system', content: currentSystemPrompt });
    }

    // Include recent conversation turns for multi-turn context
    const recentTurns = conversationHistory.slice(-12);
    for (const turn of recentTurns) {
        if (turn.transcription) {
            messages.push({ role: 'user', content: turn.transcription });
        }
        if (turn.ai_response) {
            messages.push({ role: 'assistant', content: turn.ai_response });
        }
    }

    messages.push({ role: 'user', content: userContent });
    return messages;
}

/**
 * Validate the API key and start a ChatGPT-backed session (no live websocket required).
 */
async function initializeChatGPTSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US') {
    if (isInitializingSession) {
        console.log('ChatGPT session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    sendToRenderer('session-initializing', true);
    sendToRenderer('update-status', 'Connecting to ChatGPT...');

    try {
        if (!apiKey || !apiKey.trim()) {
            throw new Error('API key is required');
        }

        // Create client (actual auth is checked on first request)
        getClient(apiKey.trim());

        initializeNewSession(profile, customPrompt);
        // language reserved for future speech features
        void language;

        sendToRenderer('update-status', 'ChatGPT ready — type a message or capture screen');
        sendToRenderer('session-initializing', false);
        isInitializingSession = false;
        return true;
    } catch (error) {
        console.error('Failed to initialize ChatGPT session:', error);
        sessionActive = false;
        openaiClient = null;
        currentApiKey = null;
        sendToRenderer('update-status', 'Error: ' + (error.message || 'Failed to connect'));
        sendToRenderer('session-initializing', false);
        isInitializingSession = false;
        return false;
    }
}

/**
 * Stream a text message to ChatGPT and push tokens to the renderer.
 */
async function sendTextMessage(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return { success: false, error: 'Invalid text message' };
    }

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    if (!sessionActive) {
        // Auto-start session so text works even if init was skipped
        initializeNewSession(currentProfile, currentCustomPrompt);
    }

    const userText = text.trim();
    sendToRenderer('update-status', 'Thinking...');

    try {
        const client = getClient(apiKey);
        const messages = buildChatMessages(userText);

        console.log('Sending text message to ChatGPT:', userText.slice(0, 120));

        const stream = await client.chat.completions.create({
            model: CHAT_MODEL,
            messages,
            stream: true,
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
                fullText += delta;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        if (!fullText.trim()) {
            fullText = '(No response from model)';
            sendToRenderer('new-response', fullText);
        }

        saveConversationTurn(userText, fullText);
        sendToRenderer('update-status', 'Ready');

        return { success: true, text: fullText, model: CHAT_MODEL };
    } catch (error) {
        console.error('Error sending text to ChatGPT:', error);
        const message = error.message || 'Failed to send message';
        sendToRenderer('update-status', 'Error: ' + message);
        sendToRenderer('new-response', `**Error:** ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Stream a screenshot + prompt to ChatGPT vision.
 */
async function sendImageMessage(base64Data, prompt) {
    if (!base64Data || typeof base64Data !== 'string') {
        return { success: false, error: 'Invalid image data' };
    }

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length < 1000) {
        return { success: false, error: 'Image buffer too small' };
    }

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    if (!sessionActive) {
        initializeNewSession(currentProfile, currentCustomPrompt);
    }

    const userPrompt = (prompt && String(prompt).trim()) || DEFAULT_SCREEN_PROMPT;
    sendToRenderer('update-status', 'Analyzing screen...');

    try {
        const client = getClient(apiKey);

        // System + recent text context, then the image turn
        const messages = [];
        if (currentSystemPrompt) {
            messages.push({ role: 'system', content: currentSystemPrompt });
        }

        const recentTurns = conversationHistory.slice(-6);
        for (const turn of recentTurns) {
            if (turn.transcription) {
                messages.push({ role: 'user', content: turn.transcription });
            }
            if (turn.ai_response) {
                messages.push({ role: 'assistant', content: turn.ai_response });
            }
        }

        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userPrompt },
                {
                    type: 'image_url',
                    image_url: {
                        url: `data:image/jpeg;base64,${base64Data}`,
                        detail: 'high',
                    },
                },
            ],
        });

        console.log(`Sending image to ${VISION_MODEL}...`);

        const stream = await client.chat.completions.create({
            model: VISION_MODEL,
            messages,
            stream: true,
            max_tokens: 4096,
        });

        let fullText = '';
        let isFirst = true;

        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
                fullText += delta;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
            }
        }

        if (!fullText.trim()) {
            fullText = '(No response from model)';
            sendToRenderer('new-response', fullText);
        }

        saveScreenAnalysis(userPrompt, fullText, VISION_MODEL);
        // Also keep in chat history so follow-up questions have context
        saveConversationTurn(`[Screen analysis] ${userPrompt}`, fullText);
        sendToRenderer('update-status', 'Ready');

        return { success: true, text: fullText, model: VISION_MODEL };
    } catch (error) {
        console.error('Error sending image to ChatGPT:', error);
        const message = error.message || 'Failed to analyze screen';
        sendToRenderer('update-status', 'Error: ' + message);
        sendToRenderer('new-response', `**Error:** ${message}`);
        return { success: false, error: message };
    }
}

async function closeSession() {
    sessionActive = false;
    openaiClient = null;
    currentApiKey = null;
    currentSessionId = null;
    conversationHistory = [];
    screenAnalysisHistory = [];
    sendToRenderer('update-status', 'Session closed');
    return { success: true };
}

function isSessionActive() {
    return sessionActive;
}

module.exports = {
    CHAT_MODEL,
    VISION_MODEL,
    DEFAULT_SCREEN_PROMPT,
    sendToRenderer,
    looksLikeOpenAIKey,
    looksLikeGeminiKey,
    initializeNewSession,
    initializeChatGPTSession,
    sendTextMessage,
    sendImageMessage,
    saveConversationTurn,
    saveScreenAnalysis,
    getCurrentSessionData,
    closeSession,
    isSessionActive,
    getClient,
};
