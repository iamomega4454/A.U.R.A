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

const ASSEMBLY_WS_URL = 'wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true';
const CAMB_TTS_STREAM_URL = 'https://client.camb.ai/apis/tts-stream';
const TARGET_PCM_SAMPLE_RATE = 16000;
const DEFAULT_CAMB_SOURCE_PCM_SAMPLE_RATE = Number(process.env.EXPO_PUBLIC_CAMBAI_PCM_SAMPLE_RATE || 22050);
const DEFAULT_CAMB_VOICE_ID = process.env.EXPO_PUBLIC_CAMBAI_VOICE_ID || 'TRFhH8M4';
const MAX_CONTINUOUS_RESTARTS = 4;
const CONTINUOUS_RESTART_BASE_DELAY_MS = 300;

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
    if (!transcript) {
        return;
    }

    const isFinal = Boolean(payload?.end_of_turn);

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

    if (payload?.type === 'Turn') {
        handleAssemblyTurn(payload);
        return;
    }

    if (payload?.type === 'Error') {
        const message = typeof payload?.error === 'string'
            ? payload.error
            : (typeof payload?.message === 'string' ? payload.message : 'AssemblyAI streaming error');
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

//------This Function handles the Start Session---------
async function startSession(mode: Exclude<RecognitionMode, null>): Promise<boolean> {
    const assemblyApiKey = process.env.EXPO_PUBLIC_ASSEMBLYAI_API_KEY || '';
    if (!assemblyApiKey) {
        onRecognitionError?.({
            code: -1,
            message: 'AssemblyAI API key is missing. Add EXPO_PUBLIC_ASSEMBLYAI_API_KEY in .env.',
        });
        return false;
    }

    const audioReady = await ensureAudioEngine();
    if (!audioReady) {
        onRecognitionError?.({ code: -1, message: 'Audio engine could not be initialized.' });
        return false;
    }

    const hasPermissions = await ensureMicrophonePermission();
    if (!hasPermissions) {
        onRecognitionError?.({ code: -1, message: 'Microphone permission is required.' });
        return false;
    }

    clearRestartTimer();
    stopMicTap();
    closeRecognitionSocket();

    activeRecognitionMode = mode;
    autoRestartContinuous = mode === 'continuous';
    connectionGeneration += 1;
    const generation = connectionGeneration;

    micDataSubscription = addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
        if (!recognitionSocket || recognitionSocket.readyState !== WebSocket.OPEN) {
            return;
        }

        const chunk = event.data;
        if (!(chunk instanceof Uint8Array) || chunk.length === 0) {
            return;
        }

        try {
            const payload = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
                ? chunk.buffer
                : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            recognitionSocket.send(payload as ArrayBuffer);
        } catch (error) {
            onRecognitionError?.({
                code: -1,
                message: `Failed to stream microphone audio: ${String(error)}`,
            });
        }
    });

    try {
        const ws = new (WebSocket as any)(
            ASSEMBLY_WS_URL,
            undefined,
            buildWsAuthOptions(assemblyApiKey)
        ) as WebSocket;
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
                    return;
                }
                onRecognitionError?.({ code: -1, message: 'AssemblyAI socket connection timed out.' });
                stopMicTap();
                closeRecognitionSocket();
                settle(false);
            }, 5000);

            ws.onopen = () => {
                if (generation !== connectionGeneration) {
                    return;
                }
                clearTimeout(openTimeout);
                continuousRestartAttempts = 0;
                isListening = toggleRecording(true);
                settle(true);
            };

            ws.onmessage = (event) => {
                if (generation !== connectionGeneration) {
                    return;
                }

                if (typeof event.data === 'string') {
                    handleAssemblyMessage(event.data);
                }
            };

            ws.onerror = () => {
                if (generation !== connectionGeneration) {
                    return;
                }
                clearTimeout(openTimeout);
                onRecognitionError?.({ code: -1, message: 'AssemblyAI socket error.' });
                if (!isListening) {
                    settle(false);
                }
            };

            ws.onclose = () => {
                if (generation !== connectionGeneration) {
                    return;
                }

                clearTimeout(openTimeout);
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

    const rate = clamp(options?.rate ?? 1, 0.6, 1.6);
    const duration = Number((1 / rate).toFixed(2));

    const voiceSettingsRaw = await AsyncStorage.getItem('user_settings_voice').catch(() => null);
    let parsedVoiceSettings: any = null;
    if (voiceSettingsRaw) {
        try {
            parsedVoiceSettings = JSON.parse(voiceSettingsRaw);
        } catch {
            parsedVoiceSettings = null;
        }
    }
    const configuredGender = typeof options?.voiceGender === 'string'
        ? options.voiceGender
        : (typeof parsedVoiceSettings?.voice_gender === 'string' ? parsedVoiceSettings.voice_gender : 'male');

    const body = {
        voice_id: DEFAULT_CAMB_VOICE_ID,
        text: content,
        language: 'english',
        gender: configuredGender === 'female' ? 'female' : 'male',
        age: '<30',
        output_configuration: {
            format: 'pcm_s16le',
            duration,
        },
    };

    const controller = new AbortController();
    ttsAbortController = controller;

    const sourceRate = Number.isFinite(DEFAULT_CAMB_SOURCE_PCM_SAMPLE_RATE)
        ? DEFAULT_CAMB_SOURCE_PCM_SAMPLE_RATE
        : 22050;

    try {
        const response = await fetch(CAMB_TTS_STREAM_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': cambApiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok || !response.body) {
            throw new Error(`Camb.ai streaming request failed with status ${response.status}`);
        }

        const reader = response.body.getReader();
        let byteRemainder: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
        const resampleState: ResampleState = {
            carry: new Int16Array(0),
            position: 0,
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            if (!value || value.length === 0) {
                continue;
            }

            if (requestId !== currentTTSRequestId) {
                break;
            }

            const merged = concatBytes(byteRemainder, value);
            const usableLength = merged.length - (merged.length % 2);
            if (usableLength <= 0) {
                byteRemainder = merged;
                continue;
            }

            const usableBytes = merged.subarray(0, usableLength);
            byteRemainder = merged.subarray(usableLength);

            const pcmSamples = bytesToInt16LE(usableBytes);
            const resampled = resampleInt16Chunk(
                pcmSamples,
                resampleState,
                sourceRate,
                TARGET_PCM_SAMPLE_RATE
            );

            if (resampled.length > 0) {
                playPCMData(int16ToBytesLE(resampled));
            }
        }

        finalizeTtsRequest(requestId);
    } catch (error: any) {
        if (requestId !== currentTTSRequestId) {
            return;
        }

        if (error?.name !== 'AbortError') {
            const message = `Camb.ai streaming failed: ${String(error)}`;
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
    cleanup,
};
