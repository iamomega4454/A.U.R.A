import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    KeyboardAvoidingView,
    Animated,
    ActivityIndicator,
    Alert,
    Linking,
    ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../src/services/api';
import {
    sendMessageStream,
    resetConversation,
    initializeOrito,
    getUserContext,
} from '../../src/services/orito';
import { incrementConversations, incrementVoiceCommands } from '../../src/services/moduleStats';
import {
    voiceAssistantService,
    detectWakeWord,
    extractCommand,
    WakeWordState,
    startRecognition,
    stopRecognition,
} from '../../src/services/voiceAssistant';
import nativeSpeechService from '../../src/services/nativeSpeech';
import OritoOverlay from '../../src/components/OritoOverlay';
import OritoAvatar from '../../src/components/OritoAvatar';
import Header from '../../src/components/Header';
import { fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';

type StreamLogType = 'input' | 'output' | 'tool' | 'system';

interface Msg {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    toolCalls?: string[];
}

interface StreamLog {
    id: string;
    type: StreamLogType;
    message: string;
    timestamp: string;
}

function getVoiceStateLabel(state: WakeWordState): string {
    switch (state) {
        case 'listening':
            return 'Listening';
        case 'processing':
            return 'Processing';
        case 'speaking':
            return 'Speaking';
        default:
            return 'Ready';
    }
}

function getVoiceStateColor(state: WakeWordState): string {
    switch (state) {
        case 'listening':
            return '#2dd4bf';
        case 'processing':
            return '#f59e0b';
        case 'speaking':
            return '#60a5fa';
        default:
            return '#94a3b8';
    }
}

function getMicButtonColor(state: WakeWordState): string {
    switch (state) {
        case 'listening':
            return '#ef4444';
        case 'processing':
            return '#1e293b';
        case 'speaking':
            return '#1e293b';
        default:
            return '#0f172a';
    }
}

function getMicIcon(state: WakeWordState): keyof typeof Ionicons.glyphMap {
    switch (state) {
        case 'listening':
            return 'stop';
        case 'processing':
            return 'hourglass-outline';
        case 'speaking':
            return 'volume-high';
        default:
            return 'mic';
    }
}

function getLogTypeColor(type: StreamLogType): string {
    switch (type) {
        case 'input':
            return '#22c55e';
        case 'output':
            return '#60a5fa';
        case 'tool':
            return '#f59e0b';
        default:
            return '#64748b';
    }
}

function formatNowTime(): string {
    return new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

//------This Function handles the Speak Response---------
async function speakResponse(text: string) {
    let rate = 1.0;
    let pitch = 1.0;
    let voiceGender: string | undefined;

    try {
        const settingsRaw = await AsyncStorage.getItem('user_settings_voice');
        if (settingsRaw) {
            const s = JSON.parse(settingsRaw);
            if (s.voice_feedback === false) return;
            if (s.voice_speed != null) rate = s.voice_speed;
            if (s.voice_pitch != null) pitch = s.voice_pitch;
            if (typeof s.voice_gender === 'string') {
                voiceGender = s.voice_gender;
            }
        }
    } catch {
        // ignore and use defaults
    }

    await nativeSpeechService.speak(text, {
        rate,
        pitch,
        language: 'en',
        voiceGender,
    });
}

//------This Function handles the Chat Screen---------
export default function ChatScreen() {
    const router = useRouter();
    const { autoStart } = useLocalSearchParams();

    const [messages, setMessages] = useState<Msg[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [streamingText, setStreamingText] = useState('');
    const [streamingToolCalls, setStreamingToolCalls] = useState<string[]>([]);
    const [streamingInputText, setStreamingInputText] = useState('');
    const [isListening, setIsListening] = useState(false);
    const [overlayState, setOverlayState] = useState<WakeWordState>('idle');
    const [overlayTranscription, setOverlayTranscription] = useState('');
    const [overlayResponse, setOverlayResponse] = useState('');
    const [showOverlay, setShowOverlay] = useState(false);
    const [streamLogs, setStreamLogs] = useState<StreamLog[]>([]);
    const [logsExpanded, setLogsExpanded] = useState(true);
    const [userName, setUserName] = useState<string | null>(null);

    const flatRef = useRef<FlatList>(null);
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const isMountedRef = useRef(true);
    const isProcessingTranscriptRef = useRef(false);
    const autoStartHandledRef = useRef(false);
    const isStartingListeningRef = useRef(false);
    const isStoppingListeningRef = useRef(false);
    const isSendingRef = useRef(false);
    const lastInputLogKeyRef = useRef('');

    const addStreamLog = useCallback((type: StreamLogType, message: string) => {
        const trimmed = message.trim();
        if (!trimmed) {
            return;
        }

        const log: StreamLog = {
            id: `${Date.now()}-${Math.random()}`,
            type,
            message: trimmed,
            timestamp: formatNowTime(),
        };

        setStreamLogs((prev) => [...prev.slice(-39), log]);
    }, []);

    const listeningActive = isListening || overlayState === 'listening';
    const micDisabled = loading || isSendingRef.current || overlayState === 'processing';

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
                setIsListening(true);
                addStreamLog('system', 'Wake word detected');
                playWakeSound();
            });

            voiceAssistantService.setStateChangeCallback((state) => {
                setOverlayState(state);
                setIsListening(state === 'listening');

                if (state === 'listening') {
                    addStreamLog('system', 'Microphone active');
                } else if (state === 'processing') {
                    addStreamLog('system', 'Processing captured speech');
                } else if (state === 'speaking') {
                    addStreamLog('system', 'TTS playback started');
                }
            });

            voiceAssistantService.setTranscriptionCallback((text, isFinal) => {
                setOverlayTranscription(text);
                setStreamingInputText(text);

                const normalized = text.trim();
                if (normalized) {
                    const logKey = `${isFinal ? 'F' : 'P'}:${normalized}`;
                    if (lastInputLogKeyRef.current !== logKey) {
                        lastInputLogKeyRef.current = logKey;
                        addStreamLog('input', `${isFinal ? 'final' : 'partial'}: ${normalized}`);
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
                    setStreamingInputText('');
                    isProcessingTranscriptRef.current = false;
                    return;
                }

                addStreamLog('input', `dispatch: ${commandText}`);
                incrementVoiceCommands().catch(() => { });

                void handleSend(commandText, true).finally(() => {
                    isProcessingTranscriptRef.current = false;
                });
            });

            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 450,
                useNativeDriver: true,
            }).start();

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
            void stopRecognition().catch(() => { });
            voiceAssistantService.cleanup();
            void nativeSpeechService.stopSpeaking().catch(() => { });
        };
    }, [autoStart, addStreamLog, fadeAnim]);

    //------This Function handles the Play Wake Sound---------
    async function playWakeSound() {
        try {
            const { default: Haptics } = await import('expo-haptics');
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } catch {
            // ignore
        }
    }

    //------This Function handles the Start Listening---------
    async function startListening() {
        if (
            loading ||
            overlayState === 'processing' ||
            listeningActive ||
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
            setStreamingInputText('');

            const started = await startRecognition();
            if (!started) {
                Alert.alert(
                    'Microphone Unavailable',
                    'Could not start live speech recognition. Please check microphone permissions.',
                );
                setOverlayState('idle');
                addStreamLog('system', 'Failed to start microphone');
                return;
            }

            setIsListening(true);
            setOverlayState('listening');
            addStreamLog('system', 'Microphone started');
        } catch (error) {
            console.error('[Chat] Failed to start listening:', error);
            setIsListening(false);
            setOverlayState('idle');
            addStreamLog('system', 'Microphone start error');
        } finally {
            isStartingListeningRef.current = false;
        }
    }

    //------This Function handles the Stop Listening---------
    async function stopListening() {
        if ((!listeningActive && overlayState !== 'processing') || isStoppingListeningRef.current) {
            return;
        }

        isStoppingListeningRef.current = true;
        setIsListening(false);

        try {
            await stopRecognition();
            if (!isProcessingTranscriptRef.current) {
                setOverlayState('idle');
            }
            setStreamingInputText('');
            addStreamLog('system', 'Microphone stopped');
        } catch (error) {
            console.error('[Chat] Failed to stop listening:', error);
            setOverlayState('idle');
            addStreamLog('system', 'Microphone stop error');
        } finally {
            isStoppingListeningRef.current = false;
        }
    }

    //------This Function handles the Handle Send---------
    async function handleSend(textOverride?: string, fromOverlay: boolean = false) {
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
        setStreamingText('');
        setStreamingToolCalls([]);
        addStreamLog('system', 'Streaming output started');
        incrementConversations().catch(() => { });

        try {
            let reply = '';
            let lastOutputLogLength = 0;
            const collectedToolCalls: string[] = [];

            reply = await sendMessageStream(
                text,
                (token) => {
                    setStreamingText((prev) => {
                        const next = prev + token;
                        if (next.length - lastOutputLogLength >= 30) {
                            lastOutputLogLength = next.length;
                            addStreamLog('output', `chunk: ${next.slice(-60)}`);
                        }
                        return next;
                    });
                    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 50);
                },
                (toolName) => {
                    const normalized = String(toolName || '').trim();
                    if (!normalized || collectedToolCalls.includes(normalized)) {
                        return;
                    }

                    collectedToolCalls.push(normalized);
                    setStreamingToolCalls([...collectedToolCalls]);
                    addStreamLog('tool', `tool call: ${normalized}`);
                },
            );

            setStreamingText('');
            if (!isMountedRef.current) {
                return;
            }

            let displayReply = reply;
            if (reply.startsWith('CALL_ACTION:')) {
                const parts = reply.replace('CALL_ACTION:', '').split('|');
                const phone = parts[0]?.trim();
                const message = parts[1]?.trim() || `Calling ${phone}`;
                displayReply = message;
                if (phone) {
                    Linking.openURL(`tel:${phone}`).catch(() => {
                        Alert.alert('Call Failed', `Could not initiate call to ${phone}`);
                    });
                }
            }

            const assistantMsg: Msg = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                text: displayReply,
                toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
            };
            setMessages((prev) => [...prev, assistantMsg]);
            setStreamingToolCalls([]);
            setStreamingInputText('');
            addStreamLog('output', `final: ${displayReply.slice(0, 100)}`);

            if (fromOverlay) {
                setOverlayResponse(displayReply);
                setOverlayState('speaking');
            }

            try {
                const conversationContent = `User: ${text}\n\nOrito: ${displayReply}`;
                await api.post('/journal/', {
                    content: conversationContent,
                    source: 'ai_generated',
                    mood: '',
                });
            } catch (error) {
                console.error('[Chat] Failed to save to journal:', error);
            }

            await speakResponse(displayReply);
            if (fromOverlay && isMountedRef.current) {
                setOverlayState('idle');
            }
        } catch (error) {
            if (!isMountedRef.current) {
                return;
            }

            console.error('[Chat] Failed to send message:', error);
            addStreamLog('system', 'Streaming output failed');
            setStreamingToolCalls([]);
            setStreamingText('');

            const fallbackReply = 'I ran into a voice processing issue. Please try again.';
            const assistantMsg: Msg = {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                text: fallbackReply,
            };
            setMessages((prev) => [...prev, assistantMsg]);
            if (fromOverlay) {
                setOverlayResponse(fallbackReply);
                setOverlayState('idle');
            }
        } finally {
            isSendingRef.current = false;
            if (isMountedRef.current) {
                setLoading(false);
                setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
            }
        }
    }

    //------This Function handles the Close Overlay---------
    function closeOverlay() {
        setShowOverlay(false);
        setOverlayState('idle');
        setOverlayTranscription('');
        setOverlayResponse('');
        setStreamingInputText('');
        setIsListening(false);
        isProcessingTranscriptRef.current = false;
        isStartingListeningRef.current = false;
        isStoppingListeningRef.current = false;

        void stopRecognition().catch(() => { });
        void nativeSpeechService.stopSpeaking().catch(() => { });
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
        void nativeSpeechService.stopSpeaking().catch(() => { });
        setOverlayState('idle');
    }

    //------This Function handles the Handle Mic Button---------
    function handleMicButtonPress() {
        if (overlayState === 'processing') {
            return;
        }

        if (listeningActive) {
            void stopListening();
            return;
        }

        void startListening();
    }

    //------This Function handles the Render Tool Calls---------
    const renderToolCalls = useCallback((toolCalls: string[] | undefined) => {
        if (!toolCalls || toolCalls.length === 0) {
            return null;
        }

        return (
            <View style={s.toolRow}>
                {toolCalls.map((toolName, index) => (
                    <View key={`${toolName}-${index}`} style={s.toolChip}>
                        <Ionicons name="construct-outline" size={12} color="#f59e0b" />
                        <Text style={s.toolChipText}>{toolName}</Text>
                    </View>
                ))}
            </View>
        );
    }, []);

    //------This Function handles the Render Message---------
    const renderMessage = useCallback(({ item }: { item: Msg }) => (
        <View style={[s.msgRow, item.role === 'user' ? s.userRow : s.botRow]}>
            <View style={[s.bubble, item.role === 'user' ? s.userBubble : s.botBubble]}>
                {item.role === 'assistant' ? renderToolCalls(item.toolCalls) : null}
                <Text style={[s.msgText, item.role === 'user' ? s.userText : s.botText]}>{item.text}</Text>
            </View>
        </View>
    ), [renderToolCalls]);

    //------This Function handles the Empty Component---------
    const EmptyComponent = useCallback(() => (
        <Animated.View style={[s.emptyWrap, { opacity: fadeAnim }]}> 
            <View style={s.emptyAvatarWrap}>
                <OritoAvatar state={loading ? 'thinking' : 'idle'} size={132} />
            </View>
            <Text style={s.emptyTitle}>Orito</Text>
            <Text style={s.emptySub}>Streaming voice + text assistant</Text>
            {userName ? <Text style={s.emptyHint}>Connected as {userName}</Text> : null}
        </Animated.View>
    ), [fadeAnim, loading, userName]);

    const hasMessages = messages.length > 0;
    const liveTranscript = streamingInputText || overlayTranscription;

    return (
        <KeyboardAvoidingView style={s.container} behavior="padding">
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
                subtitle="Realtime Voice Assistant"
                centered
                showBack
                onBackPress={() => router.back()}
                rightElement={
                    <TouchableOpacity
                        style={s.resetBtn}
                        onPress={() => {
                            resetConversation();
                            setMessages([]);
                            setStreamingText('');
                            setStreamingToolCalls([]);
                            setStreamingInputText('');
                            setStreamLogs([]);
                        }}
                        activeOpacity={0.85}
                    >
                        <Ionicons name="refresh" size={16} color="#cbd5e1" />
                    </TouchableOpacity>
                }
            />

            <View style={s.statusCard}>
                <View style={s.statusLeft}>
                    <View style={s.statusTopRow}>
                        <View style={[s.statusDot, { backgroundColor: getVoiceStateColor(overlayState) }]} />
                        <Text style={s.statusTitle}>{getVoiceStateLabel(overlayState)}</Text>
                    </View>
                    <Text style={s.statusSubtext}>
                        {overlayState === 'listening'
                            ? 'Capturing speech stream…'
                            : overlayState === 'processing'
                                ? 'Transcribing and dispatching command…'
                                : 'Tap mic for streaming input, or type below'}
                    </Text>
                </View>
                <TouchableOpacity
                    style={[s.micButton, { backgroundColor: getMicButtonColor(overlayState) }]}
                    onPress={handleMicButtonPress}
                    disabled={micDisabled}
                    activeOpacity={0.88}
                >
                    <Ionicons name={getMicIcon(overlayState)} size={20} color="#ffffff" />
                </TouchableOpacity>
            </View>

            {liveTranscript ? (
                <View style={s.liveInputCard}>
                    <View style={s.liveInputHeader}>
                        <Ionicons name="mic-outline" size={14} color="#34d399" />
                        <Text style={s.liveInputTitle}>Streaming Input</Text>
                    </View>
                    <Text style={s.liveInputText}>{liveTranscript}</Text>
                </View>
            ) : null}

            <FlatList
                ref={flatRef}
                data={messages}
                keyExtractor={(m) => m.id}
                renderItem={renderMessage}
                contentContainerStyle={[s.chatList, !hasMessages && s.chatListEmpty]}
                ListEmptyComponent={EmptyComponent}
                maxToRenderPerBatch={18}
                updateCellsBatchingPeriod={50}
                initialNumToRender={15}
                windowSize={10}
                removeClippedSubviews={true}
            />

            {(streamingToolCalls.length > 0 || streamingText) ? (
                <View style={[s.msgRow, s.botRow, s.streamingRow]}>
                    <View style={[s.bubble, s.botBubble, s.streamingBubble]}>
                        {renderToolCalls(streamingToolCalls)}
                        {streamingText ? (
                            <Text style={[s.msgText, s.botText]}>{streamingText}</Text>
                        ) : (
                            <Text style={s.streamingHint}>Waiting for streamed output…</Text>
                        )}
                    </View>
                </View>
            ) : loading ? (
                <View style={s.typingWrap}>
                    <ActivityIndicator size="small" color="#38bdf8" />
                    <Text style={s.typingText}>Orito is generating response stream…</Text>
                </View>
            ) : null}

            <View style={s.logsCard}>
                <TouchableOpacity
                    style={s.logsHeader}
                    onPress={() => setLogsExpanded((prev) => !prev)}
                    activeOpacity={0.85}
                >
                    <View style={s.logsHeaderLeft}>
                        <Ionicons name="terminal-outline" size={14} color="#94a3b8" />
                        <Text style={s.logsTitle}>Streaming Logs</Text>
                    </View>
                    <Ionicons name={logsExpanded ? 'chevron-up' : 'chevron-down'} size={16} color="#64748b" />
                </TouchableOpacity>

                {logsExpanded ? (
                    <ScrollView style={s.logsScroll} nestedScrollEnabled>
                        {streamLogs.length === 0 ? (
                            <Text style={s.logsEmpty}>No stream events yet.</Text>
                        ) : streamLogs.map((entry) => (
                            <View key={entry.id} style={s.logRow}>
                                <View style={[s.logTypePill, { borderColor: getLogTypeColor(entry.type) }]}> 
                                    <Text style={[s.logTypeText, { color: getLogTypeColor(entry.type) }]}>{entry.type}</Text>
                                </View>
                                <Text style={s.logTime}>{entry.timestamp}</Text>
                                <Text style={s.logMessage}>{entry.message}</Text>
                            </View>
                        ))}
                    </ScrollView>
                ) : null}
            </View>

            <View style={s.inputRow}>
                <TextInput
                    style={s.chatInput}
                    value={input}
                    onChangeText={setInput}
                    placeholder={listeningActive ? 'Listening…' : 'Send a message to Orito'}
                    placeholderTextColor="#64748b"
                    onSubmitEditing={() => handleSend()}
                    returnKeyType="send"
                    editable={!listeningActive && overlayState !== 'processing'}
                />

                {input.trim() ? (
                    <TouchableOpacity
                        style={s.sendBtn}
                        onPress={() => handleSend()}
                        disabled={loading}
                        activeOpacity={0.9}
                    >
                        <Ionicons name="send" size={18} color="#ffffff" />
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity
                        style={[s.sendBtn, { backgroundColor: getMicButtonColor(overlayState) }]}
                        onPress={handleMicButtonPress}
                        disabled={micDisabled}
                        activeOpacity={0.9}
                    >
                        <Ionicons name={getMicIcon(overlayState)} size={18} color="#ffffff" />
                    </TouchableOpacity>
                )}
            </View>
        </KeyboardAvoidingView>
    );
}

const s = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#020617',
        paddingBottom: 92,
    },
    resetBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: '#334155',
        backgroundColor: '#0f172a',
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusCard: {
        marginHorizontal: spacing.md,
        marginBottom: spacing.sm,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: '#1e293b',
        backgroundColor: '#0b1220',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    statusLeft: {
        flex: 1,
        paddingRight: spacing.sm,
    },
    statusTopRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    statusDot: {
        width: 9,
        height: 9,
        borderRadius: 99,
    },
    statusTitle: {
        color: '#e2e8f0',
        fontSize: fonts.sizes.md,
        fontWeight: '700',
    },
    statusSubtext: {
        color: '#94a3b8',
        fontSize: fonts.sizes.xs,
        marginTop: 4,
    },
    micButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    liveInputCard: {
        marginHorizontal: spacing.md,
        marginBottom: spacing.sm,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#0f3f36',
        backgroundColor: '#052e2b',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    liveInputHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        marginBottom: 6,
    },
    liveInputTitle: {
        color: '#6ee7b7',
        fontSize: fonts.sizes.xs,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    liveInputText: {
        color: '#d1fae5',
        fontSize: fonts.sizes.sm,
        lineHeight: 20,
    },
    chatList: {
        paddingHorizontal: spacing.md,
        paddingTop: spacing.xs,
        paddingBottom: spacing.md,
        flexGrow: 1,
    },
    chatListEmpty: {
        justifyContent: 'center',
    },
    msgRow: {
        marginBottom: spacing.sm,
    },
    userRow: {
        alignItems: 'flex-end',
    },
    botRow: {
        alignItems: 'flex-start',
    },
    bubble: {
        maxWidth: '86%',
        borderRadius: radius.lg,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderWidth: 1,
    },
    userBubble: {
        backgroundColor: '#e2e8f0',
        borderColor: '#cbd5e1',
    },
    botBubble: {
        backgroundColor: '#0f172a',
        borderColor: '#1e293b',
    },
    msgText: {
        fontSize: fonts.sizes.md,
        lineHeight: 22,
    },
    userText: {
        color: '#0f172a',
        fontWeight: '600',
    },
    botText: {
        color: '#e2e8f0',
    },
    toolRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
        marginBottom: 8,
    },
    toolChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderWidth: 1,
        borderColor: '#713f12',
        backgroundColor: '#1c1917',
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    toolChipText: {
        color: '#fbbf24',
        fontSize: 11,
        fontWeight: '700',
    },
    streamingRow: {
        marginHorizontal: spacing.md,
        marginBottom: spacing.xs,
    },
    streamingBubble: {
        borderColor: '#155e75',
        backgroundColor: '#082f49',
    },
    streamingHint: {
        color: '#bae6fd',
        fontSize: fonts.sizes.sm,
    },
    typingWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
    },
    typingText: {
        color: '#7dd3fc',
        fontSize: fonts.sizes.sm,
    },
    logsCard: {
        marginHorizontal: spacing.md,
        marginBottom: spacing.sm,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#1e293b',
        backgroundColor: '#070f1f',
        overflow: 'hidden',
    },
    logsHeader: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: '#0f172a',
    },
    logsHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    logsTitle: {
        color: '#cbd5e1',
        fontSize: fonts.sizes.sm,
        fontWeight: '700',
    },
    logsScroll: {
        maxHeight: 140,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
    },
    logsEmpty: {
        color: '#64748b',
        fontSize: fonts.sizes.xs,
    },
    logRow: {
        marginBottom: spacing.xs,
    },
    logTypePill: {
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 6,
        paddingVertical: 2,
        marginBottom: 4,
    },
    logTypeText: {
        fontSize: 10,
        fontWeight: '700',
        textTransform: 'uppercase',
    },
    logTime: {
        color: '#64748b',
        fontSize: 10,
        marginBottom: 2,
    },
    logMessage: {
        color: '#cbd5e1',
        fontSize: fonts.sizes.xs,
        lineHeight: 16,
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        borderTopWidth: 1,
        borderTopColor: '#1e293b',
        backgroundColor: '#030712',
        gap: spacing.sm,
    },
    chatInput: {
        flex: 1,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: '#1e293b',
        backgroundColor: '#0f172a',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        color: '#e2e8f0',
        fontSize: fonts.sizes.md,
    },
    sendBtn: {
        width: 40,
        height: 40,
        borderRadius: radius.full,
        backgroundColor: '#0f172a',
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyWrap: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.xl,
    },
    emptyAvatarWrap: {
        width: 132,
        height: 132,
        borderRadius: 66,
        overflow: 'hidden',
        backgroundColor: '#0d0d1a',
        borderWidth: 1,
        borderColor: '#1f2937',
    },
    emptyTitle: {
        color: '#e2e8f0',
        fontSize: 26,
        fontWeight: '700',
        marginTop: spacing.md,
    },
    emptySub: {
        color: '#94a3b8',
        fontSize: fonts.sizes.md,
        marginTop: 6,
    },
    emptyHint: {
        color: '#64748b',
        fontSize: fonts.sizes.sm,
        marginTop: spacing.xs,
    },
});
