import { Platform, AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import nativeSpeechService, {
    initializeNativeSpeech,
    SpeechRecognitionResult,
    detectWakeWordInText,
    extractCommandAfterWakeWord,
} from './nativeSpeech';

export type WakeWordState = 'idle' | 'listening' | 'processing' | 'speaking';

let onWakeWordDetected: (() => void) | null = null;
let onStateChanged: ((state: WakeWordState) => void) | null = null;
let onTranscription: ((text: string, isFinal: boolean) => void) | null = null;

let currentState: WakeWordState = 'idle';
let isAlwaysListeningEnabled = false;
let appStateSubscription: { remove: () => void } | null = null;
let useNativeSpeech = false;
let isInitialized = false;

//------This Function handles the Initialize Voice Assistant---------
export async function initializeVoiceAssistant(): Promise<boolean> {
    if (isInitialized) {
        return useNativeSpeech;
    }

    try {
        const savedPref = await AsyncStorage.getItem('orito_always_listening');
        isAlwaysListeningEnabled = savedPref === 'true';
    } catch {
    }

    useNativeSpeech = await initializeNativeSpeech();
    
    if (useNativeSpeech) {
        nativeSpeechService.setWakeWordCallback(() => {
            handleWakeWordDetected();
        });

        nativeSpeechService.setRecognitionResultCallback((result: SpeechRecognitionResult) => {
            handleRecognitionResult(result);
        });

        nativeSpeechService.setRecognitionErrorCallback((error) => {
            console.error('[VoiceAssistant] Recognition error:', error);
            if (currentState === 'listening' || currentState === 'processing') {
                updateState('idle');
            }
        });

        nativeSpeechService.setTTSCallbacks(
            () => updateState('speaking'),
            () => updateState('idle'),
            () => updateState('idle')
        );
    }

    appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
    isInitialized = true;

    return useNativeSpeech;
}

//------This Function handles the Handle App State Change---------
function handleAppStateChange(nextAppState: AppStateStatus): void {
    if (nextAppState === 'active') {
        if (isAlwaysListeningEnabled && onWakeWordDetected) {
            startWakeWordDetection();
        }
    } else if (nextAppState === 'background') {
        stopWakeWordDetection();
    }
}

//------This Function handles the Handle Wake Word Detected---------
function handleWakeWordDetected(): void {
    updateState('listening');
    
    if (onWakeWordDetected) {
        onWakeWordDetected();
    }
}

//------This Function handles the Handle Recognition Result---------
function handleRecognitionResult(result: SpeechRecognitionResult): void {
    console.log('[VoiceAssistant] Recognition result:', { text: result.text.substring(0, 80), isFinal: result.isFinal });
    if (onTranscription) {
        onTranscription(result.text, result.isFinal);
    }

    if (result.isFinal) {
        const wakeWordResult = detectWakeWordInText(result.text);
        if (wakeWordResult.detected && onWakeWordDetected) {
            handleWakeWordDetected();
        }
    }
}

//------This Function handles the Set Wake Word Callback---------
export function setWakeWordCallback(callback: () => void): void {
    onWakeWordDetected = callback;
}

//------This Function handles the Set State Change Callback---------
export function setStateChangeCallback(callback: (state: WakeWordState) => void): void {
    onStateChanged = callback;
}

//------This Function handles the Set Transcription Callback---------
export function setTranscriptionCallback(callback: (text: string, isFinal: boolean) => void): void {
    onTranscription = callback;
}

//------This Function handles the Get Current State---------
export function getCurrentState(): WakeWordState {
    return currentState;
}

//------This Function handles the Update State---------
function updateState(newState: WakeWordState): void {
    currentState = newState;
    if (onStateChanged) {
        onStateChanged(newState);
    }
}

//------This Function handles the Detect Wake Word---------
export function detectWakeWord(transcribedText: string): { detected: boolean; wakeWord: string | null } {
    const result = detectWakeWordInText(transcribedText);
    return {
        detected: result.detected,
        wakeWord: result.wakeWord,
    };
}

//------This Function handles the Extract Command---------
export function extractCommand(transcribedText: string): string {
    return extractCommandAfterWakeWord(transcribedText);
}

//------This Function handles the Start Wake Word Detection---------
export async function startWakeWordDetection(): Promise<void> {
    if (currentState !== 'idle') return;

    if (useNativeSpeech) {
        const started = await nativeSpeechService.startContinuousListening();
        updateState(started ? 'listening' : 'idle');
        return;
    }

    updateState('listening');
}

//------This Function handles the Stop Wake Word Detection---------
export function stopWakeWordDetection(): void {
    if (currentState === 'listening') {
        updateState('idle');
        
        if (useNativeSpeech) {
            nativeSpeechService.stopContinuousListening();
        }
    }
}

//------This Function handles the Start Recognition---------
export async function startRecognition(): Promise<boolean> {
    console.log('[VoiceAssistant] startRecognition, useNativeSpeech:', useNativeSpeech);
    if (useNativeSpeech) {
        const started = await nativeSpeechService.startRecognition();
        console.log('[VoiceAssistant] nativeSpeech.startRecognition result:', started);
        updateState(started ? 'listening' : 'idle');
        return started;
    }
    return false;
}

//------This Function handles the Stop Recognition---------
export async function stopRecognition(): Promise<void> {
    if (useNativeSpeech) {
        await nativeSpeechService.stopRecognition();
    }
    // Don't override 'processing' or 'speaking' — those states are managed by handleSend/TTS
    if (currentState === 'listening') {
        updateState('idle');
    }
}

//------This Function handles the Set Always Listening Enabled---------
export async function setAlwaysListeningEnabled(enabled: boolean): Promise<void> {
    isAlwaysListeningEnabled = enabled;

    try {
        await AsyncStorage.setItem('orito_always_listening', enabled.toString());
    } catch {
    }

    if (enabled) {
        startWakeWordDetection();
    } else {
        stopWakeWordDetection();
    }
}

//------This Function handles the Is Always Listening Enabled Fn---------
export function isAlwaysListeningEnabledFn(): boolean {
    return isAlwaysListeningEnabled;
}

//------This Function handles the Is Using Native Speech---------
export function isUsingNativeSpeech(): boolean {
    return useNativeSpeech;
}

//------This Function handles the Play Wake Sound---------
export async function playWakeSound(): Promise<void> {
    const { default: Haptics } = await import('expo-haptics');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

//------This Function handles the Speak Response---------
export async function speakResponse(text: string, options?: {
    pitch?: number;
    rate?: number;
}): Promise<void> {
    updateState('speaking');

    const pitch = options?.pitch ?? 1.0;
    const rate = options?.rate ?? 1.0;

    return new Promise((resolve) => {
        nativeSpeechService.setTTSCallbacks(
            () => updateState('speaking'),
            () => {
                updateState('idle');
                resolve();
            },
            () => {
                updateState('idle');
                resolve();
            }
        );
        nativeSpeechService.speak(text, { pitch, rate });
    });
}

//------This Function handles the Stop Speaking---------
export async function stopSpeaking(): Promise<void> {
    await nativeSpeechService.stopSpeaking();
    updateState('idle');
}

//------This Function handles the Can Be Default Assistant---------
export function canBeDefaultAssistant(): boolean {
    return Platform.OS === 'android';
}

//------This Function handles the Get Assistant Setup Instructions---------
export function getAssistantSetupInstructions(): string {
    if (Platform.OS === 'android') {
        return `To set Orito as your default assistant:

1. Open Settings
2. Go to Apps > Default apps
3. Tap "Digital assistant app" or "Device assistant app"
4. Select "Aura" from the list

Once set, you can:
• Long-press the home button to activate Orito
• Say "Hello Orito" when the app is open to start a conversation`;
    }

    return 'Default assistant is only available on Android devices.';
}

//------This Function handles the Cleanup---------
export function cleanup(): void {
    if (appStateSubscription) {
        appStateSubscription.remove();
        appStateSubscription = null;
    }
    stopWakeWordDetection();
    
    if (useNativeSpeech) {
        nativeSpeechService.cleanup();
    }

    onWakeWordDetected = null;
    onStateChanged = null;
    onTranscription = null;
    isInitialized = false;
    useNativeSpeech = false;
    currentState = 'idle';
}

export const voiceAssistantService = {
    initialize: initializeVoiceAssistant,
    setWakeWordCallback,
    setStateChangeCallback,
    setTranscriptionCallback,
    getCurrentState,
    detectWakeWord,
    extractCommand,
    startWakeWordDetection,
    stopWakeWordDetection,
    startRecognition,
    stopRecognition,
    setAlwaysListeningEnabled,
    isAlwaysListeningEnabled: isAlwaysListeningEnabledFn,
    isUsingNativeSpeech,
    playWakeSound,
    speakResponse,
    stopSpeaking,
    canBeDefaultAssistant,
    getAssistantSetupInstructions,
    cleanup,
};

export default voiceAssistantService;
