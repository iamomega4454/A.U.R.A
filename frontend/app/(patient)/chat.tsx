import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    View, Text, TextInput, StyleSheet, TouchableOpacity, FlatList, KeyboardAvoidingView,
    Animated, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync } from 'expo-audio';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../src/services/api';
import {
    sendMessage,
    sendMessageStream,
    resetConversation,
    transcribeAudio,
    detectEmotionFromText,
    initializeOrito,
    getUserContext
} from '../../src/services/orito';
import { incrementConversations, incrementVoiceCommands } from '../../src/services/moduleStats';
import {
    voiceAssistantService,
    detectWakeWord,
    extractCommand,
    WakeWordState,
    isUsingNativeSpeech,
    startRecognition,
    stopRecognition,
} from '../../src/services/voiceAssistant';
import nativeSpeechService from '../../src/services/nativeSpeech';
import OritoOverlay from '../../src/components/OritoOverlay';
import OritoAvatar from '../../src/components/OritoAvatar';
import Header from '../../src/components/Header';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';

interface Msg { id: string; role: 'user' | 'assistant'; text: string }


//------This Function handles the Get Emotion Tts Params---------
function getEmotionTTSParams(text: string): { pitch: number; rate: number } {
    const { primary } = detectEmotionFromText(text);


    switch (primary) {
        case 'happy':
        case 'excited':
            return { pitch: 1.1, rate: 1.1 };
        case 'sad':
        case 'lonely':
            return { pitch: 0.85, rate: 0.9 };
        case 'calm':
            return { pitch: 1.0, rate: 1.0 };
        case 'anxious':
        case 'fearful':
            return { pitch: 1.05, rate: 1.15 };
        case 'angry':
        case 'frustrated':
            return { pitch: 0.9, rate: 1.05 };
        case 'grateful':
        case 'hopeful':
            return { pitch: 0.95, rate: 0.95 };
        case 'confused':
            return { pitch: 1.0, rate: 0.95 };
        default:
            return { pitch: 1.0, rate: 1.0 };
    }
}


//------This Function handles the Speak With Emotion---------
async function speakWithEmotion(text: string) {
    const emotionParams = getEmotionTTSParams(text);

    try {
        // Settings are stored in backend, but user may have voice_feedback cached locally
        const settingsRaw = await AsyncStorage.getItem('user_settings_voice');
        if (settingsRaw) {
            const s = JSON.parse(settingsRaw);
            if (s.voice_feedback === false) return;
            if (s.voice_speed != null) emotionParams.rate = s.voice_speed;
            if (s.voice_pitch != null) emotionParams.pitch = s.voice_pitch;
        }
    } catch {
        // ignore - speak with defaults
    }


    if (isUsingNativeSpeech()) {
        await nativeSpeechService.speak(text, emotionParams);
    } else {
        await new Promise<void>((resolve) => {
            Speech.speak(text, {
                language: 'en',
                pitch: emotionParams.pitch,
                rate: emotionParams.rate,
                onDone: () => resolve(),
                onStopped: () => resolve(),
                onError: () => resolve(),
            });
        });
    }
}

//------This Function handles the Chat Screen---------
export default function ChatScreen() {
    const router = useRouter();
    const { autoStart } = useLocalSearchParams();
    const [messages, setMessages] = useState<Msg[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [streamingText, setStreamingText] = useState('');
    const [isListening, setIsListening] = useState(false);
    const flatRef = useRef<FlatList>(null);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);


    const [showOverlay, setShowOverlay] = useState(false);
    const [overlayState, setOverlayState] = useState<WakeWordState>('idle');
    const [overlayTranscription, setOverlayTranscription] = useState('');
    const [overlayResponse, setOverlayResponse] = useState('');


    const [userName, setUserName] = useState<string | null>(null);
    const isMountedRef = useRef(true);
    const isProcessingTranscriptRef = useRef(false);
    const nativeStopFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeStartFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeTranscriptSeenRef = useRef(false);
    const recorderActiveRef = useRef(false);
    const autoStartHandledRef = useRef(false);
    const isStartingListeningRef = useRef(false);
    const isStoppingListeningRef = useRef(false);
    const isSendingRef = useRef(false);

    useEffect(() => {
        let disposed = false;
        isMountedRef.current = true;

        //------This Function handles the Init---------
        const init = async () => {
            await initializeOrito();
            if (disposed) return;

            const context = getUserContext();
            if (context.userName) {
                setUserName(context.userName);
            }

            await voiceAssistantService.initialize();
            if (disposed) return;

            voiceAssistantService.setWakeWordCallback(() => {
                setShowOverlay(true);
                setOverlayState('listening');
                playWakeSound();
            });

            voiceAssistantService.setStateChangeCallback((state) => {
                setOverlayState(state);
                if (state === 'listening') {
                    setIsListening(true);
                    return;
                }
                setIsListening(false);
            });

            voiceAssistantService.setTranscriptionCallback((text, isFinal) => {
                setOverlayTranscription(text);
                if (text.trim()) {
                    nativeTranscriptSeenRef.current = true;
                    if (nativeStartFallbackTimerRef.current) {
                        clearTimeout(nativeStartFallbackTimerRef.current);
                        nativeStartFallbackTimerRef.current = null;
                    }
                }

                const finalText = text.trim();
                if (!isFinal || !finalText) {
                    return;
                }

                if (isProcessingTranscriptRef.current) {
                    return;
                }

                isProcessingTranscriptRef.current = true;
                setIsListening(false);
                setOverlayState('processing');

                const { detected } = detectWakeWord(finalText);
                const commandText = (detected ? extractCommand(finalText) : finalText).trim();
                if (!commandText) {
                    setOverlayState('idle');
                    isProcessingTranscriptRef.current = false;
                    return;
                }

                incrementVoiceCommands().catch(() => { });

                void handleSend(commandText, true).finally(() => {
                    isProcessingTranscriptRef.current = false;
                });
            });

            Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();

            if (autoStart === 'true' && !autoStartHandledRef.current) {
                autoStartHandledRef.current = true;
                setShowOverlay(true);
                await startListening();
            }
        };

        void init();

        return () => {
            disposed = true;
            isMountedRef.current = false;
            isProcessingTranscriptRef.current = false;
            if (nativeStopFallbackTimerRef.current) {
                clearTimeout(nativeStopFallbackTimerRef.current);
                nativeStopFallbackTimerRef.current = null;
            }
            if (nativeStartFallbackTimerRef.current) {
                clearTimeout(nativeStartFallbackTimerRef.current);
                nativeStartFallbackTimerRef.current = null;
            }
            void stopRecorderSafe('cleanup');
            void stopRecognition().catch(() => { });
            voiceAssistantService.cleanup();
            Speech.stop();
            void nativeSpeechService.stopSpeaking().catch(() => { });
        };
    }, [autoStart]);


    //------This Function handles the Play Wake Sound---------
    async function playWakeSound() {
        try {
            const { default: Haptics } = await import('expo-haptics');
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } catch { }
    }

    //------This Function handles the Get Recorder Uri Safe---------
    function getRecorderUriSafe(): string | null {
        try {
            return recorder.uri || null;
        } catch (error) {
            console.warn('[Chat] Recorder URI unavailable:', error);
            return null;
        }
    }

    //------This Function handles the Stop Recorder Safe---------
    async function stopRecorderSafe(context: string): Promise<void> {
        if (!recorderActiveRef.current) {
            return;
        }
        try {
            await recorder.stop();
        } catch (error) {
            console.warn(`[Chat] Failed to stop recorder (${context}):`, error);
        } finally {
            recorderActiveRef.current = false;
        }
    }


    //------This Function handles the Start Listening---------
    async function startListening() {
        if (
            loading ||
            isListening ||
            isProcessingTranscriptRef.current ||
            isStartingListeningRef.current ||
            isStoppingListeningRef.current
        ) {
            return;
        }

        isStartingListeningRef.current = true;

        try {
            if (!showOverlay) {
                setShowOverlay(true);
                void playWakeSound();
            }
            setOverlayResponse('');
            setOverlayTranscription('');
            if (nativeStopFallbackTimerRef.current) {
                clearTimeout(nativeStopFallbackTimerRef.current);
                nativeStopFallbackTimerRef.current = null;
            }
            if (nativeStartFallbackTimerRef.current) {
                clearTimeout(nativeStartFallbackTimerRef.current);
                nativeStartFallbackTimerRef.current = null;
            }
            nativeTranscriptSeenRef.current = false;

            if (isUsingNativeSpeech()) {
                await stopRecognition().catch(() => { });
            }
            await startRecording();
        } catch (error) {
            console.error('[Chat] Failed to start listening:', error);
            setIsListening(false);
            setOverlayState('idle');
        } finally {
            isStartingListeningRef.current = false;
        }
    }


    //------This Function handles the Stop Listening---------
    async function stopListening() {
        if ((!isListening && !recorderActiveRef.current) || isStoppingListeningRef.current) {
            return;
        }

        isStoppingListeningRef.current = true;
        setIsListening(false);
        if (nativeStartFallbackTimerRef.current) {
            clearTimeout(nativeStartFallbackTimerRef.current);
            nativeStartFallbackTimerRef.current = null;
        }
        nativeTranscriptSeenRef.current = false;

        try {
            if (isUsingNativeSpeech()) {
                setOverlayState('processing');
                const STOP_RECOGNITION_TIMEOUT_MS = 1500;
                let stopRecognitionTimeout: ReturnType<typeof setTimeout> | null = null;
                const stopResult = await Promise.race([
                    stopRecognition().then(() => 'stopped' as const),
                    new Promise<'timeout'>((resolve) => {
                        stopRecognitionTimeout = setTimeout(() => resolve('timeout'), STOP_RECOGNITION_TIMEOUT_MS);
                    }),
                ]).finally(() => {
                    if (stopRecognitionTimeout) {
                        clearTimeout(stopRecognitionTimeout);
                        stopRecognitionTimeout = null;
                    }
                });

                if (stopResult === 'timeout') {
                    console.warn('[Chat] stopRecognition timed out; continuing stop flow');
                }
                if (nativeStopFallbackTimerRef.current) {
                    clearTimeout(nativeStopFallbackTimerRef.current);
                }
                nativeStopFallbackTimerRef.current = setTimeout(() => {
                    if (!isMountedRef.current) {
                        return;
                    }
                    setOverlayState((prev) => (prev === 'processing' ? 'idle' : prev));
                }, 2500);
            } else {
                await stopRecording();
            }
        } catch (error) {
            console.error('[Chat] Failed to stop listening:', error);
            setOverlayState('idle');
        } finally {
            isStoppingListeningRef.current = false;
        }
    }

    //------This Function handles the Start Recording---------
    async function startRecording() {
        if (recorderActiveRef.current) {
            return;
        }
        if (nativeStartFallbackTimerRef.current) {
            clearTimeout(nativeStartFallbackTimerRef.current);
            nativeStartFallbackTimerRef.current = null;
        }
        nativeTranscriptSeenRef.current = false;

        try {

            const { granted } = await requestRecordingPermissionsAsync();
            if (!granted) {
                console.error('[Chat] Recording permission not granted');
                Alert.alert(
                    'Microphone Permission Needed',
                    'Orito needs microphone access to listen. Please enable it in device settings and try again.',
                );
                setOverlayState('idle');
                setIsListening(false);

                return;
            }


            await recorder.record();
            recorderActiveRef.current = true;
            setIsListening(true);
            setOverlayState('listening');
        } catch (err) {
            recorderActiveRef.current = false;
            console.error('[Chat] Failed to start recording:', err);
            setOverlayState('idle');
            setIsListening(false);
        }
    }

    //------This Function handles the Stop Recording---------
    async function stopRecording() {
        if (!recorderActiveRef.current || isProcessingTranscriptRef.current) return;
        isProcessingTranscriptRef.current = true;
        setIsListening(false);
        setOverlayState('processing');

        try {
            await stopRecorderSafe('stopRecording');
            const uri = getRecorderUriSafe();

            if (uri) {
                setLoading(true);
                let text = '';
                try {
                    text = await transcribeAudio(uri);
                } finally {
                    setLoading(false);
                }

                const finalText = text.trim();
                if (finalText) {

                    const { detected } = detectWakeWord(finalText);
                    const commandText = (detected ? extractCommand(finalText) : finalText).trim();


                    setOverlayTranscription(finalText);
                    if (!commandText) {
                        setOverlayState('idle');
                        return;
                    }


                    incrementVoiceCommands().catch(() => { });
                    setInput(commandText);
                    await handleSend(commandText, true);
                    return;
                }
            }
            setOverlayState('idle');
        } catch (err) {
            recorderActiveRef.current = false;
            console.error('Failed to stop recording', err);
            setOverlayState('idle');
        } finally {
            isProcessingTranscriptRef.current = false;
        }
    }

    //------This Function handles the Handle Send---------
    async function handleSend(textOverride?: string, fromOverlay = false) {
        const text = (textOverride || input).trim();
        if (!text || loading || isSendingRef.current) {
            if (fromOverlay) {
                setOverlayState('idle');
            }
            return;
        }

        isSendingRef.current = true;
        const userMsg: Msg = { id: Date.now().toString(), role: 'user', text };
        setMessages((prev) => [...prev, userMsg]);
        setInput('');
        setLoading(true);
        incrementConversations().catch(() => { });

        try {
            let reply = '';
            setStreamingText('');
            reply = await sendMessageStream(text, (token) => {
                setStreamingText((prev) => prev + token);
                setTimeout(() => flatRef.current?.scrollToEnd(), 50);
            });
            setStreamingText('');
            if (!isMountedRef.current) {
                return;
            }
            const assistantMsg: Msg = { id: (Date.now() + 1).toString(), role: 'assistant', text: reply };
            setMessages((prev) => [...prev, assistantMsg]);

            if (fromOverlay) {
                setOverlayResponse(reply);
                setOverlayState('speaking');
            }

            try {
                const conversationContent = `User: ${text}\n\nOrito: ${reply}`;
                await api.post('/journal/', {
                    content: conversationContent,
                    source: 'ai_generated',
                    mood: ''
                });
            } catch (error) {
                console.error('[Chat] Failed to save to journal:', error);
            }

            await speakWithEmotion(reply);
            if (fromOverlay && isMountedRef.current) {
                setOverlayState('idle');
            }
        } catch (error) {
            if (!isMountedRef.current) {
                return;
            }
            console.error('[Chat] Failed to send message:', error);
            const fallbackReply = 'I ran into a voice processing issue. Please try again.';
            const assistantMsg: Msg = { id: (Date.now() + 1).toString(), role: 'assistant', text: fallbackReply };
            setMessages((prev) => [...prev, assistantMsg]);
            if (fromOverlay) {
                setOverlayResponse(fallbackReply);
                setOverlayState('idle');
            }
        } finally {
            isSendingRef.current = false;
            if (isMountedRef.current) {
                setLoading(false);
                setTimeout(() => flatRef.current?.scrollToEnd(), 100);
            }
        }
    }


    //------This Function handles the Close Overlay---------
    function closeOverlay() {
        if (nativeStopFallbackTimerRef.current) {
            clearTimeout(nativeStopFallbackTimerRef.current);
            nativeStopFallbackTimerRef.current = null;
        }
        if (nativeStartFallbackTimerRef.current) {
            clearTimeout(nativeStartFallbackTimerRef.current);
            nativeStartFallbackTimerRef.current = null;
        }
        nativeTranscriptSeenRef.current = false;
        setShowOverlay(false);
        setOverlayState('idle');
        setOverlayTranscription('');
        setOverlayResponse('');
        setIsListening(false);
        isProcessingTranscriptRef.current = false;
        isStartingListeningRef.current = false;
        isStoppingListeningRef.current = false;


        if (isUsingNativeSpeech()) {
            void stopRecognition().catch(() => { });
            void nativeSpeechService.stopSpeaking().catch(() => { });
        } else {
            Speech.stop();
        }


        if (recorderActiveRef.current) {
            void stopRecorderSafe('closeOverlay');
        }
    }


    //------This Function handles the Handle Overlay Start Listening---------
    function handleOverlayStartListening() {
        startListening();
    }


    //------This Function handles the Handle Overlay Stop Listening---------
    function handleOverlayStopListening() {
        stopListening();
    }


    //------This Function handles the Handle Overlay Stop Speaking---------
    function handleOverlayStopSpeaking() {
        if (isUsingNativeSpeech()) {
            void nativeSpeechService.stopSpeaking().catch(() => { });
        } else {
            Speech.stop();
        }
        setOverlayState('idle');
    }


    //------This Function handles the Render Message---------
    const renderMessage = useCallback(({ item }: { item: Msg }) => (
        <View style={[s.msgRow, item.role === 'user' ? s.userRow : s.botRow]}>
            <View style={[s.bubble, item.role === 'user' ? s.userBubble : s.botBubble]}>
                <Text style={[s.msgText, item.role === 'user' ? s.userText : s.botText]}>
                    {item.text}
                </Text>
            </View>
        </View>
    ), []);

    //------This Function handles the Empty Component---------
    const EmptyComponent = useCallback(() => (
        <Animated.View style={[s.emptyWrap, { opacity: fadeAnim }]}>
            <View style={s.emptyAvatarWrap}>
                <OritoAvatar state={loading ? 'thinking' : 'idle'} size={140} />
            </View>
            <Text style={s.emptyTitle}>Hey, I'm Orito</Text>
            {userName && <Text style={s.emptyGreeting}>Nice to see you, {userName}!</Text>}
            <Text style={s.emptySub}>Say "Hello Orito" or tap the mic to start.</Text>
        </Animated.View>
    ), [fadeAnim, userName, loading]);

    const hasMessages = messages.length > 0;

    return (
        <KeyboardAvoidingView style={s.container}>
            <OritoOverlay
                visible={showOverlay}
                state={overlayState}
                transcription={overlayTranscription}
                response={overlayResponse}
                onClose={closeOverlay}
                onStartListening={handleOverlayStartListening}
                onStopListening={handleOverlayStopListening}
                onStopSpeaking={handleOverlayStopSpeaking}
            />

            <Header
                title="Orito"
                subtitle="AI Assistant"
                centered
                showBack
                onBackPress={() => router.back()}
                rightElement={
                    <TouchableOpacity
                        style={s.resetBtn}
                        onPress={() => { resetConversation(); setMessages([]); }}
                        activeOpacity={0.8}
                    >
                        <Ionicons name="refresh" size={18} color={colors.textSecondary} />
                    </TouchableOpacity>
                }
            />

            <View style={s.voiceModeRow}>
                <View style={s.voiceModeLeft}>
                    <View style={s.voiceModeTopRow}>
                        <View style={[s.voiceModeDot, isListening ? s.voiceModeDotListening : s.voiceModeDotNative]} />
                        <Text style={s.voiceModeTitle}>{isListening ? 'Listening now' : 'Voice ready'}</Text>
                    </View>
                    <Text style={s.voiceModeText}>Say "Hello Orito" or tap the mic button</Text>
                </View>
                <TouchableOpacity style={s.voiceModeBtn} onPress={isListening ? stopListening : startListening} disabled={loading}>
                    <Ionicons name={isListening ? 'stop' : 'mic'} size={18} color={colors.bg} />
                </TouchableOpacity>
            </View>

            <FlatList
                ref={flatRef}
                data={messages}
                keyExtractor={(m) => m.id}
                renderItem={renderMessage}
                contentContainerStyle={[s.chatList, !hasMessages && s.chatListEmpty]}
                ListEmptyComponent={EmptyComponent}
                maxToRenderPerBatch={15}
                updateCellsBatchingPeriod={50}
                initialNumToRender={15}
                windowSize={10}
                removeClippedSubviews={true}
            />

            {streamingText ? (
                <View style={[s.msgRow, s.botRow]}>
                    <View style={[s.bubble, s.botBubble]}>
                        <Text style={[s.msgText, s.botText]}>{streamingText}</Text>
                    </View>
                </View>
            ) : loading && (
                <View style={s.typingWrap}>
                    <ActivityIndicator size="small" color="#000000" />
                    <Text style={s.typingText}>Orito is thinking...</Text>
                </View>
            )}

            <View style={s.inputRow}>
                <TextInput style={s.chatInput} value={input} onChangeText={setInput}
                    placeholder={isListening ? "Listening..." : "Talk to Orito..."}
                    placeholderTextColor="#9CA3AF"
                    onSubmitEditing={() => handleSend()} returnKeyType="send"
                    editable={!isListening}
                />

                {input.trim() ? (
                    <TouchableOpacity style={[s.sendBtn, { backgroundColor: '#000000' }]} onPress={() => handleSend()} disabled={loading}>
                        <Ionicons name="send" size={20} color="#FFFFFF" />
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity
                        style={[s.sendBtn, isListening && s.listeningBtn, { backgroundColor: isListening ? '#DC2626' : '#000000' }]}
                        onPress={isListening ? stopListening : startListening}
                        disabled={loading}
                    >
                        <Ionicons name={isListening ? "stop" : "mic"} size={20} color="#FFFFFF" />
                    </TouchableOpacity>
                )}
            </View>
        </KeyboardAvoidingView>
    );
}

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, paddingBottom: 90 },
    resetBtn: {
        width: 34,
        height: 34,
        borderRadius: 17,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chatList: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md, flexGrow: 1 },
    chatListEmpty: { justifyContent: 'center' },
    msgRow: { marginBottom: spacing.sm },
    userRow: { alignItems: 'flex-end' },
    botRow: { alignItems: 'flex-start' },
    bubble: { maxWidth: '80%', borderRadius: radius.lg, padding: spacing.md },
    userBubble: { backgroundColor: colors.white, borderBottomRightRadius: 4 },
    botBubble: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4 },
    msgText: { fontSize: fonts.sizes.md, lineHeight: 22 },
    userText: { color: colors.bg },
    botText: { color: colors.textPrimary },
    typingWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
    typingText: { color: '#6B7280', fontSize: fonts.sizes.sm },
    voiceModeRow: {
        marginHorizontal: spacing.md,
        marginBottom: spacing.sm,
        minHeight: 62,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        paddingHorizontal: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    voiceModeLeft: {
        flex: 1,
        gap: 2,
    },
    voiceModeTopRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    voiceModeDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    voiceModeDotNative: {
        backgroundColor: colors.white,
    },
    voiceModeDotListening: {
        backgroundColor: colors.red,
    },
    voiceModeTitle: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.xs,
        fontWeight: '600',
    },
    voiceModeText: {
        color: colors.textMuted,
        fontSize: 10,
        fontWeight: '500',
    },
    voiceModeBtn: {
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: colors.white,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: '#050505',
        gap: spacing.sm,
    },
    chatInput: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.textPrimary, fontSize: fonts.sizes.md },
    sendBtn: { width: 40, height: 40, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
    listeningBtn: { transform: [{ scale: 1.1 }] },
    emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
    emptyAvatarWrap: {
        width: 140,
        height: 140,
        borderRadius: 70,
        overflow: 'hidden',
        backgroundColor: '#0d0d1a',
    },
    emptyTitle: { color: colors.textPrimary, fontSize: fonts.sizes.xl, fontWeight: '600', marginTop: spacing.md },
    emptyGreeting: { color: colors.textSecondary, fontSize: fonts.sizes.md, fontWeight: '600', marginTop: spacing.xs },
    emptySub: { color: colors.textMuted, fontSize: fonts.sizes.md, textAlign: 'center', marginTop: spacing.sm, lineHeight: 22, maxWidth: 300 },
});
