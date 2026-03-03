import { AppState, AppStateStatus, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    addExpoTwoWayAudioEventListener,
    initialize as initializeTwoWayAudio,
    isRecording as isTwoWayAudioRecording,
    playPCMData,
    requestMicrophonePermissionsAsync,
    tearDown as tearDownTwoWayAudio,
    toggleRecording,
} from '@speechmatics/expo-two-way-audio';

export type SpeechRecognitionResult = {
    text: string;
    confidence: number;
    isFinal: boolean;
};

export type SpeechRecognitionError = {
    code: number;
    message: string;
};

export type WakeWordDetectionResult = {
    detected: boolean;
    wakeWord: string | null;
    confidence: number;
};

export type TTSState = 'idle' | 'speaking' | 'paused';

type RecognitionMode = 'single' | 'continuous' | null;

// AssemblyAI Universal Streaming (v3) — format_turns=true uses Turn messages
// Docs: https://www.assemblyai.com/docs/speech-to-text/universal-streaming
// Token auth avoids Authorization header (Android RN WebSocket cannot send custom headers reliably)
const ASSEMBLY_WS_BASE = 'wss://streaming.assemblyai.com/v3/ws';
const ASSEMBLY_WS_PARAMS = 'sample_rate=16000&encoding=pcm_s16le';
const CAMB_TTS_STREAM_URL = 'https://client.camb.ai/apis/tts-stream';
// Camb.ai PCM output is requested at 16kHz to match playback — no resampling needed
const TARGET_PCM_SAMPLE_RATE = 16000;
const DEFAULT_CAMB_SOURCE_PCM_SAMPLE_RATE = TARGET_PCM_SAMPLE_RATE;
// Camb.ai API docs: https://docs.camb.ai/api-reference/endpoint/create-tts-stream
// voice_id must be an integer — use 147320 (default male) or configure via env
const DEFAULT_CAMB_VOICE_ID = Number(process.env.EXPO_PUBLIC_CAMBAI_VOICE_ID || 147320);
const MAX_CONTINUOUS_RESTARTS = 4;
const CONTINUOUS_RESTART_BASE_DELAY_MS = 300;
// AssemblyAI requires chunks between 50ms–1000ms. At 16kHz 16-bit: 50ms=1600B, 100ms=3200B.
const MIN_SEND_BYTES = 3200; // buffer to 100ms before sending

const WAKE_WORDS = [
    'hey orito',
    'hello orito',
    'hi orito',
    'orito',
    'hai orito',
    'hey oriyto',
    'hello oriyto',
    'hero tto',
    'zero tto',
    'orito o rito',
    'hello orita',
    'hey orita',
    'hello oreto',
    'hey oreto',
    'hello areeto',
    'halo orito',
];

let onRecognitionResult: ((result: SpeechRecognitionResult) => void) | null = null;
let onRecognitionError: ((error: SpeechRecognitionError) => void) | null = null;
let onWakeWordDetected: (() => void) | null = null;
let onTTSStart: (() => void) | null = null;
let onTTSComplete: (() => void) | null = null;
let onTTSError: ((error: string) => void) | null = null;

let isInitialized = false;
let isAudioEngineInitialized = false;
let isListening = false;
let isContinuousListeningEnabled = false;
let activeRecognitionMode: RecognitionMode = null;
let autoRestartContinuous = false;
let appState = AppState.currentState;
let appStateSubscription: { remove: () => void } | null = null;
let initializationPromise: Promise<boolean> | null = null;
let micDataSubscription: { remove: () => void } | null = null;
let recognitionSocket: WebSocket | null = null;
let continuousRestartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let connectionGeneration = 0;
let currentTTSRequestId = 0;
let ttsActive = false;
let ttsAbortController: AbortController | null = null;
let micBuffer = new Uint8Array(0);
let latestPartialTranscript = '';

interface ResampleState {
    carry: Int16Array;
    position: number;
}

//------This Function handles the Clamp---------
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

//------This Function handles the Clear Restart Timer---------
function clearRestartTimer() {
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
}

//------This Function handles the Normalize Text For Wake Word---------
function normalizeTextForWakeWord(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

//------This Function handles the Should Restart After End Or Error---------
function shouldRestartAfterEndOrError(): boolean {
    return (
        autoRestartContinuous &&
        isContinuousListeningEnabled &&
        activeRecognitionMode === 'continuous' &&
        appState === 'active'
    );
}

//------This Function handles the Build Ws Auth Options---------
function buildWsAuthOptions(apiKey: string): any {
    return {
        headers: {
            Authorization: apiKey,
        },
    };
}

//------This Function handles the Ensure Audio Engine---------
async function ensureAudioEngine(): Promise<boolean> {
    if (isAudioEngineInitialized) {
        return true;
    }

    try {
        const initialized = await initializeTwoWayAudio();
        isAudioEngineInitialized = initialized;
        return initialized;
    } catch (error) {
        console.error('[NativeSpeech] Failed to initialize two-way audio:', error);
        return false;
    }
}

//------This Function handles the Ensure Microphone Permission---------
async function ensureMicrophonePermission(): Promise<boolean> {
    try {
        const permission = await requestMicrophonePermissionsAsync();
        return !!permission.granted;
    } catch (error) {
        console.error('[NativeSpeech] Failed to request microphone permission:', error);
        return false;
    }
}

//------This Function handles the Stop Mic Tap---------
function stopMicTap() {
    if (micDataSubscription) {
        micDataSubscription.remove();
        micDataSubscription = null;
    }

    if (isTwoWayAudioRecording()) {
        toggleRecording(false);
    }

    isListening = false;
}

//------This Function handles the Close Recognition Socket---------
function closeRecognitionSocket() {
    if (!recognitionSocket) {
        return;
    }

    try {
        if (
            recognitionSocket.readyState === WebSocket.OPEN ||
            recognitionSocket.readyState === WebSocket.CONNECTING
        ) {
            recognitionSocket.close(1000, 'client-stop');
        }
    } catch {
        // ignore
    } finally {
        recognitionSocket = null;
    }
}

//------This Function handles the Handle Assembly Turn---------
function handleAssemblyTurn(payload: any) {
    const transcript = typeof payload?.transcript === 'string' ? payload.transcript.trim() : '';
    console.log('[NativeSpeech][STT] Turn received:', { transcript: transcript.substring(0, 100), end_of_turn: payload?.end_of_turn });
    const isFinal = Boolean(payload?.end_of_turn);

    // Only skip empty partials; empty final Turns must still propagate so
    // single-mode stops cleanly and the transcription callback can reset state.
    if (!transcript && !isFinal) {
        return;
    }

    // Track latest transcript so tap-to-submit can use it (only if non-empty)
    if (transcript) {
        latestPartialTranscript = transcript;
    }

    if (activeRecognitionMode === 'continuous' && isFinal) {
        const wakeWordResult = detectWakeWordInText(transcript);
        if (wakeWordResult.detected) {
            onWakeWordDetected?.();
        }
    }

    onRecognitionResult?.({
        text: transcript,
        confidence: typeof payload?.confidence === 'number' ? payload.confidence : -1,
        isFinal,
    });

    if (activeRecognitionMode === 'single' && isFinal) {
        void stopRecognition();
    }
}

//------This Function handles the Handle Assembly Message---------
function handleAssemblyMessage(rawMessage: string) {
    let payload: any;
    try {
        payload = JSON.parse(rawMessage);
    } catch {
        return;
    }

    // v2 uses "message_type"; v3 uses "type"
    const msgType = (payload?.message_type || payload?.type) as string | undefined;
    console.log('[NativeSpeech][STT] WS message type:', msgType, '| text:', payload?.text?.slice?.(0, 40) ?? '');

    // v2 session_begins = v3 Begin
    if (msgType === 'SessionBegins' || msgType === 'session_begins' || msgType === 'Begin') {
        console.log('[NativeSpeech][STT] Session started, session_id:', payload?.session_id ?? payload?.id);
        return;
    }

    // v2 PartialTranscript — update live transcript but don't submit yet
    if (msgType === 'PartialTranscript') {
        const text = (payload?.text as string) ?? '';
        if (text) {
            latestPartialTranscript = text;
            handleAssemblyTurn({ transcript: text, end_of_turn: false, confidence: payload?.confidence });
        }
        return;
    }

    // v2 FinalTranscript — sentence/phrase complete; submit to AI
    if (msgType === 'FinalTranscript') {
        const text = (payload?.text as string) ?? '';
        console.log('[NativeSpeech][STT] Final transcript:', text);
        handleAssemblyTurn({ transcript: text, end_of_turn: true, confidence: payload?.confidence });
        return;
    }

    // v3 Turn-based format (format_turns=true) — kept for compatibility
    if (msgType === 'Turn') {
        handleAssemblyTurn(payload);
        return;
    }

    if (msgType === 'Error') {
        const message = typeof payload?.error === 'string'
            ? payload.error
            : (typeof payload?.message === 'string' ? payload.message : 'AssemblyAI streaming error');
        console.error('[NativeSpeech][STT] Server error:', message);
        onRecognitionError?.({ code: -1, message });
    }
}

//------This Function handles the Schedule Continuous Restart---------
function scheduleContinuousRestart() {
    if (!shouldRestartAfterEndOrError()) {
        return;
    }

    if (continuousRestartAttempts >= MAX_CONTINUOUS_RESTARTS) {
        return;
    }

    clearRestartTimer();
    const delay = CONTINUOUS_RESTART_BASE_DELAY_MS * Math.pow(2, continuousRestartAttempts);
    continuousRestartAttempts += 1;

    restartTimer = setTimeout(() => {
        restartTimer = null;
        void startSession('continuous');
    }, delay);
}

//------This Function fetches a short-lived AssemblyAI session token---------
// React Native WebSocket on Android does not reliably send custom headers,
// so we use a temporary token obtained via REST and embed it in the URL.
async function getAssemblyAIToken(apiKey: string): Promise<string | null> {
    try {
        console.log('[NativeSpeech][STT] Fetching session token...');
        const res = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=480', {
            method: 'GET',
            headers: {
                Authorization: apiKey,
            },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error('[NativeSpeech][STT] Token request failed:', res.status, body);
            return null;
        }
        const json = await res.json();
        console.log('[NativeSpeech][STT] Session token obtained');
        return (json as { token: string }).token;
    } catch (e) {
        console.error('[NativeSpeech][STT] Token request error:', e);
        return null;
    }
}

//------This Function handles the Start Session---------
// AssemblyAI Streaming v3 docs: https://www.assemblyai.com/docs/getting-started/transcribe-streaming-audio
async function startSession(mode: Exclude<RecognitionMode, null>): Promise<boolean> {
    const assemblyApiKey = process.env.EXPO_PUBLIC_ASSEMBLYAI_API_KEY || '';
    if (!assemblyApiKey) {
        onRecognitionError?.({
            code: -1,
            message: 'AssemblyAI API key is missing. Add EXPO_PUBLIC_ASSEMBLYAI_API_KEY in .env.',
        });
        return false;
    }

    console.log('[NativeSpeech][STT] Starting session, mode:', mode);

    const audioReady = await ensureAudioEngine();
    if (!audioReady) {
        console.error('[NativeSpeech][STT] Audio engine init failed');
        onRecognitionError?.({ code: -1, message: 'Audio engine could not be initialized.' });
        return false;
    }
    console.log('[NativeSpeech][STT] Audio engine ready');

    const hasPermissions = await ensureMicrophonePermission();
    if (!hasPermissions) {
        console.error('[NativeSpeech][STT] Mic permission denied');
        onRecognitionError?.({ code: -1, message: 'Microphone permission is required.' });
        return false;
    }
    console.log('[NativeSpeech][STT] Mic permission granted');

    clearRestartTimer();
    stopMicTap();
    closeRecognitionSocket();

    activeRecognitionMode = mode;
    autoRestartContinuous = mode === 'continuous';
    connectionGeneration += 1;
    const generation = connectionGeneration;

    // Reset per-session state
    micBuffer = new Uint8Array(0);
    latestPartialTranscript = '';

    let micChunkCount = 0;
    let amplitudeCheckDone = false;
    // Silence detection: auto-ForceEndpoint after 3s of quiet audio (rms < threshold)
    const SILENCE_THRESHOLD = 300;       // Int16 amplitude below this = silence
    const SILENCE_FORCE_AFTER_MS = 3000; // ms of continuous silence before auto-submit
    let silenceStart: number | null = null;
    let hasSpeechSample = false;         // only auto-submit if we had real speech first

    micDataSubscription = addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
        if (!recognitionSocket || recognitionSocket.readyState !== WebSocket.OPEN) {
            return;
        }

        const chunk = event.data;
        if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
            console.warn('[NativeSpeech][STT] Bad chunk - not Uint8Array or empty, type:', typeof event.data);
            return;
        }

        // Log amplitude of first chunk to verify real audio is being captured
        if (!amplitudeCheckDone && chunk.length >= 2) {
            amplitudeCheckDone = true;
            const view16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
            let maxAmp = 0;
            for (let i = 0; i < view16.length; i++) {
                const v = Math.abs(view16[i]);
                if (v > maxAmp) maxAmp = v;
            }
            console.log('[NativeSpeech][STT] First chunk amplitude check - max:', maxAmp, '(0=silent, >500=speech)');
        }

        // Silence detection: check RMS of chunk; auto-ForceEndpoint after SILENCE_FORCE_AFTER_MS
        if (chunk.length >= 2) {
            const view16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
            let maxAmp = 0;
            for (let i = 0; i < view16.length; i++) {
                const v = Math.abs(view16[i]);
                if (v > maxAmp) maxAmp = v;
            }
            const isSilent = maxAmp < SILENCE_THRESHOLD;
            if (!isSilent) {
                hasSpeechSample = true;
                silenceStart = null;
            } else if (hasSpeechSample) {
                if (silenceStart === null) silenceStart = Date.now();
                else if (Date.now() - silenceStart > SILENCE_FORCE_AFTER_MS) {
                    console.log('[NativeSpeech][STT] Silence detected after speech, sending ForceEndpoint');
                    silenceStart = null;
                    hasSpeechSample = false;
                    forceEndpoint();
                }
            }
        }

        // Buffer chunks until we meet AssemblyAI's 50–1000ms requirement
        // At 16kHz 16-bit: 1024 bytes = 32ms (too small). Buffer to 3200 bytes = 100ms.
        const newBuf = new Uint8Array(micBuffer.length + chunk.length);
        newBuf.set(micBuffer);
        newBuf.set(chunk, micBuffer.length);
        micBuffer = newBuf;

        if (micBuffer.length < MIN_SEND_BYTES) {
            return;
        }

        const toSend = micBuffer;
        micBuffer = new Uint8Array(0);

        micChunkCount++;
        if (micChunkCount <= 3 || micChunkCount % 20 === 0) {
            console.log('[NativeSpeech][STT] Sending buffered chunk #' + micChunkCount + ', size:', toSend.length, 'ms:', Math.round(toSend.length / 32));
        }

        try {
            const payload = toSend.buffer.slice(toSend.byteOffset, toSend.byteOffset + toSend.byteLength);
            recognitionSocket.send(payload as ArrayBuffer);
        } catch (error) {
            console.error('[NativeSpeech][STT] Send error:', error);
            onRecognitionError?.({
                code: -1,
                message: `Failed to stream microphone audio: ${String(error)}`,
            });
        }
    });

    // Get a short-lived session token (React Native Android cannot send custom WS headers)
    const sessionToken = await getAssemblyAIToken(assemblyApiKey);
    if (!sessionToken) {
        stopMicTap();
        onRecognitionError?.({ code: -1, message: 'Could not obtain AssemblyAI session token. Check API key.' });
        return false;
    }

    try {
        // v3 token URL: ?token=<token>&sample_rate=16000&encoding=pcm_s16le
        const wsUrl = `${ASSEMBLY_WS_BASE}?token=${encodeURIComponent(sessionToken)}&${ASSEMBLY_WS_PARAMS}`;
        console.log('[NativeSpeech][STT] Connecting WebSocket:', ASSEMBLY_WS_BASE + `?token=***&${ASSEMBLY_WS_PARAMS}`);
        const ws = new WebSocket(wsUrl) as WebSocket;
        ws.binaryType = 'arraybuffer';
        recognitionSocket = ws;

        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const settle = (result: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(result);
            };

            const openTimeout = setTimeout(() => {
                if (generation !== connectionGeneration) {
                    settle(false);
                    return;
                }
                onRecognitionError?.({ code: -1, message: 'AssemblyAI socket connection timed out.' });
                stopMicTap();
                closeRecognitionSocket();
                settle(false);
            }, 5000);

            ws.onopen = () => {
                if (generation !== connectionGeneration) {
                    clearTimeout(openTimeout);
                    settle(false);
                    return;
                }
                clearTimeout(openTimeout);
                continuousRestartAttempts = 0;
                console.log('[NativeSpeech][STT] WebSocket OPEN, starting mic recording');
                isListening = toggleRecording(true);
                console.log('[NativeSpeech][STT] toggleRecording result:', isListening);
                settle(true);
            };

            ws.onmessage = (event) => {
                if (generation !== connectionGeneration) {
                    return;
                }

                if (typeof event.data === 'string') {
                    console.log('[NativeSpeech][STT] WS message:', event.data.substring(0, 200));
                    handleAssemblyMessage(event.data);
                }
            };

            ws.onerror = (e: any) => {
                if (generation !== connectionGeneration) {
                    settle(false);
                    return;
                }
                clearTimeout(openTimeout);
                console.error('[NativeSpeech][STT] WebSocket ERROR:', e?.message || e);
                onRecognitionError?.({ code: -1, message: 'AssemblyAI socket error.' });
                if (!isListening) {
                    settle(false);
                }
            };

            ws.onclose = (e: any) => {
                if (generation !== connectionGeneration) {
                    settle(false);
                    return;
                }

                clearTimeout(openTimeout);
                console.log('[NativeSpeech][STT] WebSocket CLOSED, code:', e?.code, 'reason:', e?.reason);
                stopMicTap();
                recognitionSocket = null;
                if (shouldRestartAfterEndOrError()) {
                    scheduleContinuousRestart();
                }
                if (!isListening) {
                    settle(false);
                }
            };
        });
    } catch (error) {
        stopMicTap();
        closeRecognitionSocket();
        onRecognitionError?.({
            code: -1,
            message: `Failed to start streaming recognition: ${String(error)}`,
        });
        return false;
    }
}

//------This Function handles the Handle App State Change---------
function handleAppStateChange(nextAppState: AppStateStatus): void {
    appState = nextAppState;

    if (nextAppState === 'active') {
        if (isContinuousListeningEnabled && activeRecognitionMode === 'continuous' && !isListening) {
            void startSession('continuous');
        }
        return;
    }

    void stopListening();
}

//------This Function handles the Concat Bytes---------
function concatBytes(
    left: Uint8Array<ArrayBufferLike>,
    right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
    if (left.length === 0) {
        return right;
    }
    if (right.length === 0) {
        return left;
    }

    const merged = new Uint8Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
}

//------This Function handles the Bytes To Int16---------
function bytesToInt16LE(bytes: Uint8Array): Int16Array {
    const sampleCount = Math.floor(bytes.length / 2);
    const out = new Int16Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
        const lo = bytes[i * 2] ?? 0;
        const hi = bytes[i * 2 + 1] ?? 0;
        out[i] = ((hi << 8) | lo) << 16 >> 16;
    }

    return out;
}

//------This Function handles the Concat Int16---------
function concatInt16(left: Int16Array, right: Int16Array): Int16Array {
    if (left.length === 0) {
        return right;
    }
    if (right.length === 0) {
        return left;
    }

    const merged = new Int16Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
}

//------This Function handles the Resample Int16 Chunk---------
function resampleInt16Chunk(
    incoming: Int16Array,
    state: ResampleState,
    sourceRate: number,
    targetRate: number,
): Int16Array {
    if (incoming.length === 0) {
        return new Int16Array(0);
    }

    if (sourceRate <= 0 || targetRate <= 0 || sourceRate === targetRate) {
        return incoming;
    }

    const ratio = sourceRate / targetRate;
    const merged = concatInt16(state.carry, incoming);
    if (merged.length < 2) {
        state.carry = merged;
        state.position = 0;
        return new Int16Array(0);
    }

    const output: number[] = [];
    let position = state.position;

    while (position + 1 < merged.length) {
        const baseIndex = Math.floor(position);
        const nextIndex = baseIndex + 1;
        if (nextIndex >= merged.length) {
            break;
        }

        const fraction = position - baseIndex;
        const a = merged[baseIndex];
        const b = merged[nextIndex];
        const sample = Math.round(a + (b - a) * fraction);
        output.push(clamp(sample, -32768, 32767));

        position += ratio;
    }

    const startCarryAt = Math.max(0, Math.floor(position));
    state.carry = merged.slice(startCarryAt);
    state.position = position - startCarryAt;

    return Int16Array.from(output);
}

//------This Function handles the Int16 To Bytes---------
function int16ToBytesLE(samples: Int16Array): Uint8Array {
    const bytes = new Uint8Array(samples.length * 2);

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        bytes[i * 2] = sample & 0xff;
        bytes[i * 2 + 1] = (sample >> 8) & 0xff;
    }

    return bytes;
}

//------This Function handles the Finalize Tts Request---------
function finalizeTtsRequest(requestId: number) {
    if (requestId !== currentTTSRequestId) {
        return;
    }

    ttsActive = false;
    onTTSComplete?.();
}

//------This Function handles the Initialize Native Speech---------
export async function initializeNativeSpeech(): Promise<boolean> {
    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = new Promise<boolean>(async (resolve) => {
        try {
            if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
                resolve(false);
                return;
            }

            if (isInitialized) {
                resolve(true);
                return;
            }

            const audioReady = await ensureAudioEngine();
            if (!audioReady) {
                resolve(false);
                return;
            }

            try {
                const savedPref = await AsyncStorage.getItem('orito_continuous_listening');
                isContinuousListeningEnabled = savedPref === 'true';
            } catch {
                isContinuousListeningEnabled = false;
            }

            appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
            isInitialized = true;
            resolve(true);
        } catch (error) {
            console.error('[NativeSpeech] Initialization failed:', error);
            resolve(false);
        }
    });

    return initializationPromise;
}

//------This Function handles the Is Native Speech Available---------
export function isNativeSpeechAvailable(): boolean {
    return (Platform.OS === 'android' || Platform.OS === 'ios') && isInitialized;
}

//------This Function handles the Start Recognition---------
export async function startRecognition(): Promise<boolean> {
    return startSession('single');
}

//------This Function handles the Stop Recognition---------
export async function stopRecognition(): Promise<void> {
    clearRestartTimer();
    autoRestartContinuous = false;
    activeRecognitionMode = null;

    connectionGeneration += 1;
    stopMicTap();
    closeRecognitionSocket();
    micBuffer = new Uint8Array(0);
}

//------This Function returns the latest partial transcript for tap-to-submit---------
export function getLatestPartialTranscript(): string {
    return latestPartialTranscript;
}

//------This Function clears the latest partial transcript---------
export function clearLatestPartialTranscript(): void {
    latestPartialTranscript = '';
}

//------This Function sends ForceEndpoint to AssemblyAI to flush the current turn---------
export function forceEndpoint(): boolean {
    if (recognitionSocket && recognitionSocket.readyState === WebSocket.OPEN) {
        try {
            recognitionSocket.send(JSON.stringify({ type: 'ForceEndpoint' }));
            console.log('[NativeSpeech][STT] ForceEndpoint sent');
            return true;
        } catch (e) {
            console.error('[NativeSpeech][STT] ForceEndpoint send failed:', e);
        }
    }
    return false;
}

//------This Function handles the Start Continuous Listening---------
export async function startContinuousListening(): Promise<boolean> {
    isContinuousListeningEnabled = true;
    return startSession('continuous');
}

//------This Function handles the Stop Continuous Listening---------
export async function stopContinuousListening(): Promise<void> {
    isContinuousListeningEnabled = false;
    clearRestartTimer();
    autoRestartContinuous = false;
    activeRecognitionMode = null;

    connectionGeneration += 1;
    stopMicTap();
    closeRecognitionSocket();
}

//------This Function handles the Stop Listening---------
export async function stopListening(): Promise<void> {
    clearRestartTimer();
    autoRestartContinuous = false;
    activeRecognitionMode = null;

    connectionGeneration += 1;
    stopMicTap();
    closeRecognitionSocket();
}

//------This Function handles the Is Currently Listening---------
export function isCurrentlyListening(): boolean {
    return isListening;
}

//------This Function handles the Set Continuous Listening Enabled---------
export async function setContinuousListeningEnabled(enabled: boolean): Promise<void> {
    isContinuousListeningEnabled = enabled;

    try {
        await AsyncStorage.setItem('orito_continuous_listening', enabled.toString());
    } catch {
        // ignore
    }

    if (enabled && isInitialized) {
        await startContinuousListening();
        return;
    }

    await stopContinuousListening();
}

//------This Function handles the Is Continuous Listening Enabled Fn---------
export function isContinuousListeningEnabledFn(): boolean {
    return isContinuousListeningEnabled;
}

//------This Function parses a WAV binary and finds the 'data' chunk offset and sample rate---------
// React Native / Hermes does NOT support ReadableStream (response.body is null on Android).
// Camb.ai also emits LIST/INFO chunks before 'data', so the payload offset is NOT a fixed 44 bytes.
// This helper scans RIFF chunks from offset 12 to find 'data', and reads sampleRate from 'fmt '.
function findWavDataChunk(bytes: Uint8Array): { dataOffset: number; sampleRate: number } | null {
    if (bytes.length < 12) return null;
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const wave  = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (magic !== 'RIFF' || wave !== 'WAVE') return null;

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let sampleRate = DEFAULT_CAMB_SOURCE_PCM_SAMPLE_RATE;
    let pos = 12;

    while (pos + 8 <= bytes.length) {
        const id   = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
        const size = dv.getUint32(pos + 4, true);

        if (id === 'fmt ') {
            // fmt chunk: offset +8 = audio format, +12 = sampleRate
            if (pos + 12 <= bytes.length) {
                sampleRate = dv.getUint32(pos + 12, true);
            }
        } else if (id === 'data') {
            return { dataOffset: pos + 8, sampleRate };
        }

        // RIFF chunks are word-aligned (each chunk padded to even byte boundary)
        pos += 8 + size + (size % 2 !== 0 ? 1 : 0);
    }

    return null;
}

//------This Function handles the Speak---------
export async function speak(
    text: string,
    options?: {
        pitch?: number;
        rate?: number;
        language?: string;
        voiceGender?: string;
    }
): Promise<void> {
    const cambApiKey = process.env.EXPO_PUBLIC_CAMBAI_API_KEY || '';
    const content = text.trim();

    if (!content) {
        return;
    }

    if (!cambApiKey) {
        const message = 'Camb.ai API key is missing. Add EXPO_PUBLIC_CAMBAI_API_KEY in .env.';
        onTTSError?.(message);
        return;
    }

    const audioReady = await ensureAudioEngine();
    if (!audioReady) {
        onTTSError?.('Audio engine could not be initialized for playback.');
        return;
    }

    await stopSpeaking();

    const requestId = ++currentTTSRequestId;
    ttsActive = true;
    onTTSStart?.();

    console.log('[NativeSpeech][TTS] Starting speak:', { textLength: content.length, voice_id: DEFAULT_CAMB_VOICE_ID });

    const controller = new AbortController();
    ttsAbortController = controller;

    try {
        // Direct REST API — @camb-ai/sdk is Node.js only (imports stream/fs), not RN compatible
        const response = await fetch('https://client.camb.ai/apis/tts-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': cambApiKey },
            body: JSON.stringify({
                voice_id: DEFAULT_CAMB_VOICE_ID,
                text: content,
                language: 'en-us',
                speech_model: 'mars-flash',
                output_configuration: { format: 'wav' },
            }),
            signal: controller.signal,
        });

        console.log('[NativeSpeech][TTS] Response status:', response.status);
        // NOTE: React Native (Hermes / Android) does NOT support ReadableStream — response.body
        // is always null. Use arrayBuffer() instead of response.body.getReader() streaming.
        if (!response.ok) {
            const err = await response.text().catch(() => '');
            throw new Error(`Camb.ai TTS failed ${response.status}: ${err}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (requestId !== currentTTSRequestId) return;

        const wavBytes = new Uint8Array(arrayBuffer);
        const wavInfo = findWavDataChunk(wavBytes);
        if (!wavInfo) {
            throw new Error('Camb.ai TTS: could not find WAV data chunk in response');
        }

        const { dataOffset, sampleRate: wavSampleRate } = wavInfo;
        console.log('[NativeSpeech][TTS] WAV sample rate:', wavSampleRate, '| data offset:', dataOffset);

        const pcmRaw = wavBytes.subarray(dataOffset);
        // Trim to even byte boundary (each PCM sample is 2 bytes)
        const usableLength = pcmRaw.length - (pcmRaw.length % 2);
        const pcmBytes = pcmRaw.subarray(0, usableLength);

        // Feed PCM to the audio engine in ~100ms chunks (3200 bytes @ 16kHz 16-bit)
        // to keep playback smooth and avoid a single huge playPCMData call.
        const PLAY_CHUNK_BYTES = 3200;
        const resampleState: ResampleState = { carry: new Int16Array(0), position: 0 };
        let offset = 0;

        while (offset < pcmBytes.length) {
            if (requestId !== currentTTSRequestId) break;

            const end   = Math.min(offset + PLAY_CHUNK_BYTES, pcmBytes.length);
            const chunk = pcmBytes.subarray(offset, end);
            offset = end;

            // Align chunk to even byte boundary before converting to Int16
            const alignedEnd = chunk.length - (chunk.length % 2);
            if (alignedEnd <= 0) continue;

            const samples  = bytesToInt16LE(chunk.subarray(0, alignedEnd));
            const resampled = resampleInt16Chunk(samples, resampleState, wavSampleRate, TARGET_PCM_SAMPLE_RATE);

            if (resampled.length > 0) {
                playPCMData(int16ToBytesLE(resampled));
            }
        }

        console.log('[NativeSpeech][TTS] Playback enqueued');
        finalizeTtsRequest(requestId);
    } catch (error: any) {
        if (requestId !== currentTTSRequestId) {
            return;
        }

        if (error?.name !== 'AbortError') {
            const message = `Camb.ai streaming failed: ${String(error)}`;
            console.error('[NativeSpeech][TTS] Error:', message);
            onTTSError?.(message);
        }

        finalizeTtsRequest(requestId);
    } finally {
        if (ttsAbortController === controller) {
            ttsAbortController = null;
        }
    }
}

//------This Function handles the Stop Speaking---------
export async function stopSpeaking(): Promise<void> {
    currentTTSRequestId += 1;

    if (ttsAbortController) {
        ttsAbortController.abort();
        ttsAbortController = null;
    }

    if (ttsActive) {
        ttsActive = false;
        onTTSComplete?.();
    }

    if (isAudioEngineInitialized) {
        // Hard reset to flush queued PCM chunks immediately.
        tearDownTwoWayAudio();
        isAudioEngineInitialized = false;
        await ensureAudioEngine();
    }
}

//------This Function handles the Is Speaking---------
export async function isSpeaking(): Promise<boolean> {
    return ttsActive;
}

//------This Function handles the Set Recognition Result Callback---------
export function setRecognitionResultCallback(callback: (result: SpeechRecognitionResult) => void): void {
    onRecognitionResult = callback;
}

//------This Function handles the Set Recognition Error Callback---------
export function setRecognitionErrorCallback(callback: (error: SpeechRecognitionError) => void): void {
    onRecognitionError = callback;
}

//------This Function handles the Set Wake Word Callback---------
export function setWakeWordCallback(callback: () => void): void {
    onWakeWordDetected = callback;
}

//------This Function handles the Set Tts Callbacks---------
export function setTTSCallbacks(
    onStart?: () => void,
    onComplete?: () => void,
    onError?: (error: string) => void
): void {
    onTTSStart = onStart ?? null;
    onTTSComplete = onComplete ?? null;
    onTTSError = onError ?? null;
}

//------This Function handles the Detect Wake Word In Text---------
export function detectWakeWordInText(text: string): WakeWordDetectionResult {
    const normalized = normalizeTextForWakeWord(text);
    if (!normalized) {
        return { detected: false, wakeWord: null, confidence: 0 };
    }

    for (const wakeWord of WAKE_WORDS) {
        if (normalized.includes(wakeWord)) {
            return {
                detected: true,
                wakeWord,
                confidence: 1.0,
            };
        }
    }

    return {
        detected: false,
        wakeWord: null,
        confidence: 0,
    };
}

//------This Function handles the Extract Command After Wake Word---------
export function extractCommandAfterWakeWord(text: string): string {
    const normalized = normalizeTextForWakeWord(text);

    for (const wakeWord of WAKE_WORDS) {
        const wakeWordIndex = normalized.indexOf(wakeWord);
        if (wakeWordIndex !== -1) {
            const originalLower = text.toLowerCase();
            const rawIndex = originalLower.indexOf(wakeWord);
            if (rawIndex === -1) {
                break;
            }
            const command = text.substring(rawIndex + wakeWord.length).trim();
            return command.replace(/^[^a-zA-Z0-9]+/, '');
        }
    }

    return text.trim();
}

//------This Function handles the Cleanup---------
export function cleanup(): void {
    clearRestartTimer();
    autoRestartContinuous = false;
    activeRecognitionMode = null;

    connectionGeneration += 1;
    stopMicTap();
    closeRecognitionSocket();

    void stopSpeaking();

    if (appStateSubscription) {
        appStateSubscription.remove();
        appStateSubscription = null;
    }

    if (isAudioEngineInitialized) {
        tearDownTwoWayAudio();
        isAudioEngineInitialized = false;
    }

    isInitialized = false;
    initializationPromise = null;
}

export default {
    initialize: initializeNativeSpeech,
    isAvailable: isNativeSpeechAvailable,
    startRecognition,
    stopRecognition,
    startContinuousListening,
    stopContinuousListening,
    stopListening,
    isCurrentlyListening,
    setContinuousListeningEnabled,
    isContinuousListeningEnabled: isContinuousListeningEnabledFn,
    speak,
    stopSpeaking,
    isSpeaking,
    setRecognitionResultCallback,
    setRecognitionErrorCallback,
    setWakeWordCallback,
    setTTSCallbacks,
    detectWakeWordInText,
    extractCommandAfterWakeWord,
    getLatestPartialTranscript,
    clearLatestPartialTranscript,
    forceEndpoint,
    cleanup,
};
