import React, { useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Modal,
    Animated,
    Dimensions,
    TouchableOpacity,
    Easing,
    ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fonts, spacing, radius } from '../theme';
import { WakeWordState } from '../services/voiceAssistant';
import OritoAvatar, { AvatarState } from './OritoAvatar';

const { width, height } = Dimensions.get('window');

interface OritoOverlayProps {
    visible: boolean;
    state: WakeWordState;
    transcription: string;
    response: string;
    onClose: () => void;
    onStartListening?: () => void;
    onStopListening?: () => void;
    onStopSpeaking?: () => void;
    error?: string | null;
}

//------This Function handles the Orito Overlay---------
export function OritoOverlay({
    visible,
    state,
    transcription,
    response,
    onClose,
    onStartListening,
    onStopListening,
    onStopSpeaking,
    error,
}: OritoOverlayProps) {
    const scaleAnim = useRef(new Animated.Value(0)).current;
    const opacityAnim = useRef(new Animated.Value(0)).current;
    const pulseAnim = useRef(new Animated.Value(1)).current;
    const waveAnim = useRef(new Animated.Value(0)).current;
    const glowAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (visible) {
            Animated.parallel([
                Animated.spring(scaleAnim, {
                    toValue: 1,
                    useNativeDriver: true,
                    tension: 100,
                    friction: 8,
                }),
                Animated.timing(opacityAnim, {
                    toValue: 1,
                    duration: 200,
                    useNativeDriver: true,
                }),
            ]).start();

            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } else {
            Animated.parallel([
                Animated.spring(scaleAnim, {
                    toValue: 0,
                    useNativeDriver: true,
                    tension: 100,
                    friction: 8,
                }),
                Animated.timing(opacityAnim, {
                    toValue: 0,
                    duration: 150,
                    useNativeDriver: true,
                }),
            ]).start();
        }
    }, [visible]);

    useEffect(() => {
        if (state === 'listening') {
            const pulse = Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 1.15,
                        duration: 600,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 600,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                ])
            );
            pulse.start();
            return () => pulse.stop();
        } else {
            pulseAnim.setValue(1);
        }
    }, [state]);

    useEffect(() => {
        if (state === 'processing') {
            const wave = Animated.loop(
                Animated.sequence([
                    Animated.timing(waveAnim, {
                        toValue: 1,
                        duration: 1000,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                    Animated.timing(waveAnim, {
                        toValue: 0,
                        duration: 1000,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                ])
            );
            wave.start();
            return () => wave.stop();
        } else {
            waveAnim.setValue(0);
        }
    }, [state]);

    useEffect(() => {
        if (state === 'speaking') {
            const glow = Animated.loop(
                Animated.sequence([
                    Animated.timing(glowAnim, {
                        toValue: 1,
                        duration: 800,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                    Animated.timing(glowAnim, {
                        toValue: 0.5,
                        duration: 800,
                        easing: Easing.inOut(Easing.ease),
                        useNativeDriver: true,
                    }),
                ])
            );
            glow.start();
            return () => glow.stop();
        } else {
            glowAnim.setValue(0);
        }
    }, [state]);

    const getStateIcon = () => {
        switch (state) {
            case 'listening':
                return 'mic';
            case 'processing':
                return 'sparkles';
            case 'speaking':
                return 'volume-high';
            default:
                return 'chatbubble-ellipses';
        }
    };

    const getAvatarState = (): AvatarState => {
        switch (state) {
            case 'listening': return 'listening';
            case 'processing': return 'thinking';
            case 'speaking': return 'speaking';
            default: return 'idle';
        }
    };

    const getStateText = () => {
        switch (state) {
            case 'listening':
                return 'Listening...';
            case 'processing':
                return 'Thinking...';
            case 'speaking':
                return 'Speaking...';
            default:
                return 'How can I help?';
        }
    };

    const getStateColor = (isError: boolean = false) => {
        if (isError) {
            return '#DC2626';
        }
        switch (state) {
            case 'listening':
                return '#000000';
            case 'processing':
                return '#4B5563';
            case 'speaking':
                return '#1F2937';
            default:
                return '#6B7280';
        }
    };

    const handleMicPress = () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        
        if (state === 'listening') {
            if (onStopListening) {
                onStopListening();
            }
            return;
        }
        
        if (state === 'speaking') {
            if (onStopSpeaking) {
                onStopSpeaking();
            }
            return;
        }
        
        if (state === 'processing') {
            return;
        }

        if (state === 'idle') {
            if (onStartListening) {
                onStartListening();
            }
        }
    };

    const handleStop = () => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        
        if (state === 'speaking') {
            if (onStopSpeaking) {
                onStopSpeaking();
            }
        }
        
        if (state === 'listening') {
            if (onStopListening) {
                onStopListening();
            }
        }
        
        onClose();
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="none"
            statusBarTranslucent
            onRequestClose={handleStop}
        >
            <View style={styles.backdrop}>
                <Animated.View
                    style={[
                        styles.overlay,
                        {
                            transform: [{ scale: scaleAnim }],
                            opacity: opacityAnim,
                        },
                    ]}
                >
                    <TouchableOpacity style={styles.closeBtn} onPress={handleStop}>
                        <Ionicons name="close" size={24} color="#4B5563" />
                    </TouchableOpacity>

                    <View style={styles.content}>
                        <Animated.View
                            style={[
                                styles.avatarContainer,
                                {
                                    transform: [{ scale: state === 'listening' ? pulseAnim : 1 }],
                                    ...(state === 'speaking' ? {
                                        shadowColor: '#00ffff',
                                        shadowOffset: { width: 0, height: 0 },
                                        shadowOpacity: glowAnim,
                                        shadowRadius: 24,
                                        elevation: 12,
                                    } : {}),
                                },
                            ]}
                        >
                            <OritoAvatar
                                state={getAvatarState()}
                                size={160}
                            />
                        </Animated.View>

                        <Text style={[styles.stateText, { color: getStateColor(!!error) }]}>
                            {getStateText()}
                        </Text>

                        {transcription ? (
                            <View style={[styles.transcriptionContainer, { backgroundColor: '#F9FAFB' }]}>
                                <Text style={[styles.transcriptionLabel, { color: '#4B5563' }]}>You said:</Text>
                                <Text style={[styles.transcriptionText, { color: '#111827' }]}>{transcription}</Text>
                            </View>
                        ) : null}

                        {response ? (
                            <ScrollView style={styles.responseScroll} nestedScrollEnabled>
                                <View style={[styles.responseContainer, { backgroundColor: '#F3F4F6', borderLeftColor: '#000000' }]}>
                                    <Text style={[styles.responseText, { color: '#111827' }]}>{response}</Text>
                                </View>
                            </ScrollView>
                        ) : null}

                        {state === 'idle' && !transcription && !response && (
                            <View style={styles.hintContainer}>
                                <Ionicons name="mic-outline" size={20} color="#9CA3AF" />
                                <Text style={[styles.hintText, { color: '#6B7280' }]}>
                                    Tap the microphone to use Orito AI
                                </Text>
                            </View>
                        )}
                    </View>

                    <View style={styles.actionBar}>
                        <TouchableOpacity
                            style={[
                                styles.actionBtn,
                                {
                                    backgroundColor:
                                        state === 'idle'
                                            ? '#000000'
                                            : state === 'listening'
                                                ? '#DC2626'
                                                : '#1F2937',
                                },
                            ]}
                            onPress={handleMicPress}
                            disabled={state === 'processing'}
                        >
                            <Ionicons
                                name={
                                    state === 'listening'
                                        ? 'stop'
                                        : state === 'processing'
                                            ? 'hourglass-outline'
                                            : state === 'speaking'
                                                ? 'volume-high'
                                                : 'mic'
                                }
                                size={28}
                                color="#FFFFFF"
                            />
                        </TouchableOpacity>
                        
                        <View style={styles.quickActions}>
                            {state === 'idle' && (
                                <>
                                    <TouchableOpacity 
                                        style={[styles.quickActionBtn, { backgroundColor: '#F3F4F6' }]}
                                        onPress={() => {
                                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                            if (onStartListening) {
                                                onStartListening();
                                            }
                                        }}
                                        accessibilityLabel="Quick action: What time is it"
                                        accessibilityRole="button"
                                    >
                                        <Ionicons name="time-outline" size={20} color="#4B5563" />
                                    </TouchableOpacity>
                                    <TouchableOpacity 
                                        style={[styles.quickActionBtn, { backgroundColor: '#F3F4F6' }]}
                                        onPress={() => {
                                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                            if (onStartListening) {
                                                onStartListening();
                                            }
                                        }}
                                        accessibilityLabel="Quick action: Medication reminder"
                                        accessibilityRole="button"
                                    >
                                        <Ionicons name="medkit-outline" size={20} color="#4B5563" />
                                    </TouchableOpacity>
                                    <TouchableOpacity 
                                        style={[styles.quickActionBtn, { backgroundColor: '#F3F4F6' }]}
                                        onPress={() => {
                                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                            if (onStartListening) {
                                                onStartListening();
                                            }
                                        }}
                                        accessibilityLabel="Quick action: Call family"
                                        accessibilityRole="button"
                                    >
                                        <Ionicons name="people-outline" size={20} color="#4B5563" />
                                    </TouchableOpacity>
                                </>
                            )}
                        </View>
                    </View>
                </Animated.View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    overlay: {
        width: width * 0.92,
        maxWidth: 420,
        maxHeight: height * 0.75,
        backgroundColor: '#FFFFFF',
        borderRadius: radius.xl,
        overflow: 'hidden',
        ...({
            shadowColor: '#000000',
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: 0.4,
            shadowRadius: 25,
            elevation: 25,
        } as any),
    },
    closeBtn: {
        position: 'absolute',
        top: spacing.md,
        right: spacing.md,
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#F3F4F6',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
    content: {
        padding: spacing.xl,
        paddingTop: spacing.xxl,
        alignItems: 'center',
    },
    avatarContainer: {
        width: 160,
        height: 160,
        borderRadius: 80,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: spacing.lg,
        overflow: 'hidden',
        backgroundColor: '#0d0d1a',
    },
    stateText: {
        fontSize: 22,
        fontFamily: fonts.medium,
        marginBottom: spacing.sm,
    },
    transcriptionContainer: {
        width: '100%',
        padding: spacing.md,
        backgroundColor: '#F9FAFB',
        borderRadius: radius.lg,
        marginBottom: spacing.md,
    },
    transcriptionLabel: {
        fontSize: 12,
        fontFamily: fonts.medium,
        color: '#4B5563',
        marginBottom: spacing.xs,
    },
    transcriptionText: {
        fontSize: 16,
        fontFamily: fonts.regular,
        color: '#111827',
    },
    responseScroll: {
        width: '100%',
        maxHeight: 150,
    },
    responseContainer: {
        width: '100%',
        padding: spacing.md,
        backgroundColor: '#F3F4F6',
        borderRadius: radius.lg,
        borderLeftWidth: 3,
        borderLeftColor: '#000000',
    },
    responseText: {
        fontSize: 16,
        fontFamily: fonts.regular,
        color: '#111827',
        lineHeight: 24,
    },
    hintContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        marginTop: spacing.sm,
    },
    hintText: {
        fontSize: 14,
        fontFamily: fonts.regular,
        color: '#6B7280',
        textAlign: 'center',
    },
    actionBar: {
        padding: spacing.lg,
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: '#E5E7EB',
    },
    actionBtn: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: '#000000',
        justifyContent: 'center',
        alignItems: 'center',
        ...({
            shadowColor: '#000000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 8,
            elevation: 8,
        } as any),
    },
    quickActions: {
        flexDirection: 'row',
        gap: spacing.lg,
        marginTop: spacing.md,
    },
    quickActionBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#F3F4F6',
        justifyContent: 'center',
        alignItems: 'center',
    },
});

export default OritoOverlay;
