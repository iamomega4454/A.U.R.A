import React, { useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withTiming,
    withSequence,
    useDerivedValue,
    cancelAnimation,
    Easing,
    interpolate,
    interpolateColor,
} from 'react-native-reanimated';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface OritoAvatarProps {
    state?: AvatarState;
    size?: number;
}

const STATE_IDX: Record<AvatarState, number> = { idle: 0, listening: 1, thinking: 2, speaking: 3 };

// Per-state colour palettes [idle, listening, thinking, speaking]
const GLOW_COLORS  = ['#0a4a7a', '#8a1a5a', '#4a1a8a', '#0a6a3a'];
const EYE_COLORS   = ['#33ccff', '#ff55bb', '#bb55ff', '#33ffbb'];
const HEAD_COLORS  = ['#081424', '#180820', '#0e0820', '#081810'];

//------This Component renders Orito's animated avatar using Reanimated---------
export default function OritoAvatar({ state = 'idle', size = 200 }: OritoAvatarProps) {

    // ── Shared values ─────────────────────────────────────────────────────────
    // stateIdx as shared value so worklets can read it reactively
    const stateIdx = useSharedValue<number>(STATE_IDX[state]);
    const time     = useSharedValue<number>(0);
    const blinkOpen = useSharedValue<number>(1);
    const mouthOpen = useSharedValue<number>(0); // 0=smile closed, 1=open

    const blinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Update stateIdx whenever the prop changes
    useEffect(() => {
        stateIdx.value = STATE_IDX[state];
        // Animate mouth open when speaking
        mouthOpen.value = withTiming(state === 'speaking' ? 1 : 0, { duration: 200 });
    }, [state]);

    // Continuous time driver
    useEffect(() => {
        time.value = withRepeat(
            withTiming(100, { duration: 100_000, easing: Easing.linear }),
            -1, false,
        );
        return () => { cancelAnimation(time); };
    }, []);

    // Blink loop
    useEffect(() => {
        const schedule = () => {
            const delay = 2500 + Math.random() * 2000;
            blinkTimer.current = setTimeout(() => {
                blinkOpen.value = withSequence(
                    withTiming(0.06, { duration: 55 }),
                    withTiming(1, { duration: 75 }),
                );
                schedule();
            }, delay);
        };
        schedule();
        return () => { if (blinkTimer.current) clearTimeout(blinkTimer.current); };
    }, []);

    // ── Dimensions ────────────────────────────────────────────────────────────
    const cx       = size / 2;
    const headR    = size * 0.36;
    const eyeR     = size * 0.07;
    const eyeOffX  = size * 0.11;
    const eyeOffY  = size * 0.045;   // above center
    const mouthW   = size * 0.20;
    const mouthH   = size * 0.07;
    const glowSize = headR * 2 + size * 0.18;

    // ── Derived animated values (all read stateIdx.value in worklet) ──────────
    const glowColor = useDerivedValue(() =>
        interpolateColor(stateIdx.value, [0, 1, 2, 3], GLOW_COLORS)
    );
    const eyeColor = useDerivedValue(() =>
        interpolateColor(stateIdx.value, [0, 1, 2, 3], EYE_COLORS)
    );
    const headColor = useDerivedValue(() =>
        interpolateColor(stateIdx.value, [0, 1, 2, 3], HEAD_COLORS)
    );

    // Breathing scale — faster when speaking
    const breathScale = useDerivedValue(() => {
        'worklet';
        const t = time.value;
        const si = stateIdx.value;
        if (si === 3) return 1 + Math.abs(Math.sin(t * 5.5)) * 0.022; // speaking: quick pulse
        if (si === 1) return 1 + Math.abs(Math.sin(t * 2.5)) * 0.018; // listening: medium
        return 1 + Math.sin(t * 0.8) * 0.016; // idle/thinking: slow breathe
    });

    // Vertical float
    const floatY = useDerivedValue(() => {
        'worklet';
        const t = time.value;
        const si = stateIdx.value;
        if (si === 2) return Math.sin(t * 2.2) * size * 0.025; // thinking: faster bob
        return Math.sin(t * 0.55) * size * 0.028;
    });

    // Horizontal tilt
    const tiltZ = useDerivedValue(() => {
        'worklet';
        const t = time.value;
        const si = stateIdx.value;
        if (si === 1) return Math.sin(t * 1.1) * 0.12; // listening: nod
        if (si === 2) return Math.sin(t * 0.4) * 0.10; // thinking: slow tilt
        if (si === 3) return Math.sin(t * 1.4) * 0.07; // speaking: waggle
        return Math.sin(t * 0.35) * 0.07 + Math.sin(t * 0.13) * 0.03; // idle: lazy
    });

    // Glow pulse opacity
    const glowOpacity = useDerivedValue(() => {
        'worklet';
        const t = time.value;
        const si = stateIdx.value;
        const base = si === 0 ? 0.28 : 0.5;
        const speed = si === 1 ? 2.2 : si === 3 ? 4.0 : 0.9;
        return base + Math.abs(Math.sin(t * speed)) * 0.35;
    });

    // Thinking dot bounce offsets
    const dot1Y = useDerivedValue(() => {
        'worklet';
        if (stateIdx.value !== 2) return 0;
        return Math.sin(time.value * 4.0) * size * 0.045;
    });
    const dot2Y = useDerivedValue(() => {
        'worklet';
        if (stateIdx.value !== 2) return 0;
        return Math.sin(time.value * 4.0 + 1.05) * size * 0.045;
    });
    const dot3Y = useDerivedValue(() => {
        'worklet';
        if (stateIdx.value !== 2) return 0;
        return Math.sin(time.value * 4.0 + 2.1) * size * 0.045;
    });

    // Listening pulse ring scale
    const listeningRingScale = useDerivedValue(() => {
        'worklet';
        if (stateIdx.value !== 1) return 1;
        return 1 + Math.abs(Math.sin(time.value * 2.5)) * 0.08;
    });
    const listeningRingOpacity = useDerivedValue(() => {
        'worklet';
        if (stateIdx.value !== 1) return 0;
        return 0.3 + Math.abs(Math.sin(time.value * 2.5)) * 0.5;
    });

    // ── Animated styles ───────────────────────────────────────────────────────
    const headStyle = useAnimatedStyle(() => ({
        backgroundColor: headColor.value,
        transform: [
            { translateY: floatY.value },
            { rotateZ: `${tiltZ.value}rad` },
            { scale: breathScale.value },
        ],
    }));

    const glowStyle = useAnimatedStyle(() => ({
        borderColor: glowColor.value,
        shadowColor: glowColor.value,
        opacity: glowOpacity.value,
        transform: [
            { translateY: floatY.value },
            { scale: breathScale.value },
        ],
    }));

    const leftEyeStyle = useAnimatedStyle(() => ({
        backgroundColor: eyeColor.value,
        shadowColor: eyeColor.value,
        transform: [{ scaleY: blinkOpen.value }],
    }));

    const rightEyeStyle = useAnimatedStyle(() => ({
        backgroundColor: eyeColor.value,
        shadowColor: eyeColor.value,
        transform: [{ scaleY: blinkOpen.value }],
    }));

    const mouthStyle = useAnimatedStyle(() => {
        const open = mouthOpen.value;
        const h = interpolate(open, [0, 1], [mouthH * 0.55, mouthH]);
        const radius = interpolate(open, [0, 1], [mouthH * 0.5, mouthH * 0.3]);
        return {
            width: mouthW,
            height: h,
            borderRadius: radius,
            borderTopLeftRadius: interpolate(open, [0, 1], [mouthH * 0.5, mouthH * 0.15]),
            borderTopRightRadius: interpolate(open, [0, 1], [mouthH * 0.5, mouthH * 0.15]),
        };
    });

    const dot1Style = useAnimatedStyle(() => ({ transform: [{ translateY: dot1Y.value }], opacity: stateIdx.value === 2 ? 1 : 0 }));
    const dot2Style = useAnimatedStyle(() => ({ transform: [{ translateY: dot2Y.value }], opacity: stateIdx.value === 2 ? 1 : 0 }));
    const dot3Style = useAnimatedStyle(() => ({ transform: [{ translateY: dot3Y.value }], opacity: stateIdx.value === 2 ? 1 : 0 }));

    const listeningRingStyle = useAnimatedStyle(() => ({
        opacity: listeningRingOpacity.value,
        transform: [
            { translateY: floatY.value },
            { scale: listeningRingScale.value * breathScale.value },
        ],
    }));

    const dotSize = size * 0.07;

    return (
        <View style={[s.root, { width: size, height: size }]}>

            {/* Outer glow ring */}
            <Animated.View
                style={[
                    s.glow,
                    glowStyle,
                    {
                        width: glowSize,
                        height: glowSize,
                        borderRadius: glowSize / 2,
                        left: cx - glowSize / 2,
                        top: cx - glowSize / 2,
                    },
                ]}
            />

            {/* Listening pulse ring */}
            <Animated.View
                style={[
                    s.listeningRing,
                    listeningRingStyle,
                    {
                        width: headR * 2 + size * 0.08,
                        height: headR * 2 + size * 0.08,
                        borderRadius: headR + size * 0.04,
                        left: cx - headR - size * 0.04,
                        top: cx - headR - size * 0.04,
                        borderColor: EYE_COLORS[1],
                    },
                ]}
            />

            {/* Head */}
            <Animated.View
                style={[
                    s.head,
                    headStyle,
                    {
                        width: headR * 2,
                        height: headR * 2,
                        borderRadius: headR,
                        left: cx - headR,
                        top: cx - headR,
                    },
                ]}
            >
                {/* Left eye */}
                <Animated.View
                    style={[
                        s.eye,
                        leftEyeStyle,
                        {
                            width: eyeR * 2,
                            height: eyeR * 2,
                            borderRadius: eyeR,
                            left: headR - eyeOffX - eyeR,
                            top: headR - eyeOffY - eyeR,
                        },
                    ]}
                />

                {/* Right eye */}
                <Animated.View
                    style={[
                        s.eye,
                        rightEyeStyle,
                        {
                            width: eyeR * 2,
                            height: eyeR * 2,
                            borderRadius: eyeR,
                            left: headR + eyeOffX - eyeR,
                            top: headR - eyeOffY - eyeR,
                        },
                    ]}
                />

                {/* Mouth */}
                <Animated.View
                    style={[
                        s.mouth,
                        mouthStyle,
                        {
                            left: headR - mouthW / 2,
                            top: headR + eyeOffY + eyeR * 2 + size * 0.03,
                        },
                    ]}
                />

                {/* Thinking dots — replace mouth area when thinking */}
                <View
                    style={[
                        s.thinkRow,
                        {
                            left: 0, right: 0,
                            bottom: headR * 0.22,
                        },
                    ]}
                >
                    <Animated.View style={[s.thinkDot, dot1Style, { width: dotSize, height: dotSize, borderRadius: dotSize / 2 }]} />
                    <Animated.View style={[s.thinkDot, dot2Style, { width: dotSize, height: dotSize, borderRadius: dotSize / 2 }]} />
                    <Animated.View style={[s.thinkDot, dot3Style, { width: dotSize, height: dotSize, borderRadius: dotSize / 2 }]} />
                </View>
            </Animated.View>
        </View>
    );
}

const s = StyleSheet.create({
    root: {
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'visible',
    },
    glow: {
        position: 'absolute',
        borderWidth: 1.5,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 22,
        elevation: 0,
    },
    listeningRing: {
        position: 'absolute',
        borderWidth: 2,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.8,
        shadowRadius: 10,
        elevation: 0,
    },
    head: {
        position: 'absolute',
        borderWidth: 0,
        shadowColor: '#0a2a4a',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.6,
        shadowRadius: 12,
        elevation: 8,
    },
    eye: {
        position: 'absolute',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 8,
        elevation: 4,
    },
    mouth: {
        position: 'absolute',
        backgroundColor: '#1a3a5a',
        overflow: 'hidden',
    },
    thinkRow: {
        position: 'absolute',
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'flex-end',
        gap: 5,
    },
    thinkDot: {
        backgroundColor: '#bb55ff',
        shadowColor: '#bb55ff',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9,
        shadowRadius: 5,
        elevation: 3,
    },
});

