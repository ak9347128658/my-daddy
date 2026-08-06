<img width="1299" height="424" alt="cd (1)" src="https://github.com/user-attachments/assets/b25fff4d-043d-4f38-9985-f832ae0d0f6e" />

## Recall.ai - API for desktop recording

If you’re looking for a hosted desktop recording API, consider checking out [Recall.ai](https://www.recall.ai/product/desktop-recording-sdk/?utm_source=github&utm_medium=sponsorship&utm_campaign=sohzm-cheating-daddy), an API that records Zoom, Google Meet, Microsoft Teams, in-person meetings, and more.

This project is sponsored by Recall.ai.

---

> [!NOTE]  
> Use latest MacOS and Windows version, older versions have limited support

A real-time AI assistant that provides contextual help during video calls, interviews, presentations, and meetings using screen capture and text chat.

## Features

- **ChatGPT (OpenAI) support**: Text chat and screen analysis via the OpenAI API (`gpt-4o-mini` by default)
- **Gemini Live support**: Optional live audio sessions when using a Google Gemini API key
- **Screen capture**: Analyze screenshots on demand for coding questions, MCQs, and more
- **Text input**: Type questions directly — replies stream into the assistant panel
- **Multiple Profiles**: Interview, Sales Call, Business Meeting, Presentation, Negotiation
- **Transparent Overlay**: Always-on-top window that can be positioned anywhere
- **Click-through Mode**: Make window transparent to clicks when needed
- **Cross-platform**: Works on macOS, Windows, and Linux (Linux is limited / for testing)

## Setup

1. **Get an OpenAI API Key**: Visit [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. **Install Dependencies**: `npm install`
3. **Run the App**: `npm start`

Optional env overrides: `OPENAI_CHAT_MODEL`, `OPENAI_VISION_MODEL` (default both: `gpt-4o-mini`).

## Usage

1. Enter your ChatGPT / OpenAI API key (`sk-...`) in the main window
2. Choose your profile and language in settings
3. Click "Start Session" to begin
4. Position the window using keyboard shortcuts
5. Type a message or capture the screen for AI assistance

## Keyboard Shortcuts

- **Window Movement**: `Ctrl/Cmd + Arrow Keys` - Move window
- **Click-through**: `Ctrl/Cmd + M` - Toggle mouse events
- **Close/Back**: `Ctrl/Cmd + \` - Close window or go back
- **Send Message**: `Enter` - Send text to AI

## Audio Capture

- **macOS**: [SystemAudioDump](https://github.com/Mohammed-Yasin-Mulla/Sound) for system audio
- **Windows**: Loopback audio capture
- **Linux**: Microphone input

## Requirements

- Electron-compatible OS (macOS, Windows, Linux)
- OpenAI API key (ChatGPT) — or a Gemini API key for live audio mode
- Screen recording permissions (for screen analysis)
- Microphone/audio permissions (optional; live audio is Gemini-only)
