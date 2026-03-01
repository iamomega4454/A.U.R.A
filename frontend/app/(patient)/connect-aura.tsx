import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Alert,
    Animated,
    Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/context/auth';
import { useAura } from '../../src/context/aura';
import { connectToAura, saveAuraAddress, scanForAuraModule, verifyAuraModule } from '../../src/services/aura-discovery';
import api from '../../src/services/api';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';
import Header from '../../src/components/Header';

const { width } = Dimensions.get('window');

//------This Function handles the Connect Aura Screen---------
export default function ConnectAuraScreen() {
    const router = useRouter();
    const { user, token } = useAuth();
    const { setConnection } = useAura();


    const [devices, setDevices] = useState<any[]>([]);
    const [scanning, setScanning] = useState(false);
    const [isManualMode, setIsManualMode] = useState(false);
    const [manualIp, setManualIp] = useState('');
    const [manualPort, setManualPort] = useState('8001');
    const [connecting, setConnecting] = useState(false);


    const pulseAnim = useState(new Animated.Value(1))[0];
    const scanRotateAnim = useState(new Animated.Value(0))[0];

    useEffect(() => {

        const pulse = Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, {
                    toValue: 1.1,
                    duration: 1500,
                    useNativeDriver: true,
                }),
                Animated.timing(pulseAnim, {
                    toValue: 1,
                    duration: 1500,
                    useNativeDriver: true,
                }),
            ])
        );
        pulse.start();


        handleScan();

        return () => pulse.stop();
    }, []);

    useEffect(() => {

        if (scanning) {
            const rotate = Animated.loop(
                Animated.timing(scanRotateAnim, {
                    toValue: 1,
                    duration: 2000,
                    useNativeDriver: true,
                })
            );
            rotate.start();
            return () => rotate.stop();
        } else {
            scanRotateAnim.setValue(0);
        }
    }, [scanning]);

    //------This Function handles the Handle Scan---------
    async function handleScan() {
        if (scanning) return;
        setScanning(true);
        setDevices([]);

        try {
            await scanForAuraModule(
                () => { },
                (device) => {
                    setDevices(prev => {
                        if (prev.find(d => d.ip === device.ip)) return prev;
                        return [...prev, device];
                    });
                }
            );
        } catch (err) {
            console.error('Scan failed:', err);
        } finally {
            setScanning(false);
        }
    }

    //------This Function handles the Handle Connect---------
    async function handleConnect(ip: string, port: number) {
        setConnecting(true);
        const runtimeBackendUrl =
            typeof api.defaults.baseURL === 'string' ? api.defaults.baseURL : '';

        connectToAura(ip, port, user?.firebase_uid || '', token || '', runtimeBackendUrl, (msg) => {
            if (msg.type === 'connected') {
                setConnection(ip, port);
                saveAuraAddress({
                    service: 'AURA_MODULE',
                    hostname: '',
                    ip: ip,
                    ws_port: port,
                    version: '1.0.0',
                });


                api.post('/aura/register', {
                    ip: ip,
                    port: port,
                    patient_uid: user?.firebase_uid || '',
                }).catch(() => { });


                router.back();
            }
        });


        setTimeout(() => {
            if (connecting) {
                setConnecting(false);
                Alert.alert('Connection Timeout', 'Could not connect to Aura module. Please try again.');
            }
        }, 5000);
    }

    //------This Function handles the Handle Manual Connect---------
    async function handleManualConnect() {
        if (!manualIp.trim()) {
            Alert.alert('Error', 'Please enter an IP address');
            return;
        }
        const portNum = parseInt(manualPort) || 8001;
        setConnecting(true);

        const device = await verifyAuraModule(manualIp, portNum);
        if (device) {
            await handleConnect(manualIp, portNum);
        } else {
            Alert.alert('Connection Failed', `Could not reach Aura module at ${manualIp}:${portNum}`);
            setConnecting(false);
        }
    }

    const spin = scanRotateAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
    });

    return (
        <View style={s.container}>
            { }
            <Header title="Connect Module" showBack={true} />

            { }
            {!isManualMode ? (
                <View style={s.scanContent}>
                    { }
                    <Animated.View
                        style={[
                            s.scanCircle,
                            { transform: [{ scale: pulseAnim }] }
                        ]}
                    >
                        <Animated.View style={[s.scanIconWrap, { transform: [{ rotate: spin }] }]}>
                            <Ionicons name="radio-button-on-outline" size={80} color={colors.white} />
                        </Animated.View>
                        <View style={s.scanCenter}>
                            <Ionicons name="cube-outline" size={32} color={colors.bg} />
                        </View>
                    </Animated.View>

                    <Text style={s.scanTitle}>
                        {scanning ? 'Searching...' : devices.length > 0 ? 'Modules Found' : 'No Modules Found'}
                    </Text>
                    <Text style={s.scanSubtitle}>
                        {scanning
                            ? 'Make sure your Aura module is powered on'
                            : devices.length > 0
                                ? 'Tap to connect'
                                : 'Ensure your module is on the same network'}
                    </Text>

                    { }
                    {devices.length > 0 && (
                        <View style={s.deviceList}>
                            {devices.map((device, index) => (
                                <TouchableOpacity
                                    key={`${device.ip}-${index}`}
                                    style={s.deviceCard}
                                    onPress={() => handleConnect(device.ip, device.ws_port)}
                                    disabled={connecting}
                                >
                                    <View style={s.deviceIcon}>
                                        <Ionicons name="cube" size={24} color={colors.bg} />
                                    </View>
                                    <View style={s.deviceInfo}>
                                        <Text style={s.deviceName}>Aura Module</Text>
                                        <Text style={s.deviceIp}>{device.ip}:{device.ws_port}</Text>
                                    </View>
                                    {connecting ? (
                                        <ActivityIndicator color={colors.white} />
                                    ) : (
                                        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                                    )}
                                </TouchableOpacity>
                            ))}
                        </View>
                    )}

                    { }
                    <TouchableOpacity
                        style={[s.scanBtn, scanning && s.scanBtnActive]}
                        onPress={handleScan}
                        disabled={scanning}
                    >
                        {scanning ? (
                            <ActivityIndicator color={colors.bg} />
                        ) : (
                            <>
                                <Ionicons name="refresh" size={20} color={colors.bg} />
                                <Text style={s.scanBtnText}>Scan Again</Text>
                            </>
                        )}
                    </TouchableOpacity>
                </View>
            ) : (

                <View style={s.manualContent}>
                    <View style={s.manualIcon}>
                        <Ionicons name="create-outline" size={32} color={colors.bg} />
                    </View>
                    <Text style={s.manualTitle}>Manual Setup</Text>
                    <Text style={s.manualSubtitle}>
                        Enter your Aura module's IP address
                    </Text>

                    <View style={s.form}>
                        <View style={s.inputGroup}>
                            <Text style={s.inputLabel}>IP ADDRESS</Text>
                            <TextInput
                                style={s.input}
                                value={manualIp}
                                onChangeText={setManualIp}
                                placeholder="192.168.1.100"
                                placeholderTextColor={colors.textMuted}
                                keyboardType="decimal-pad"
                                autoCapitalize="none"
                            />
                        </View>
                        <View style={s.inputGroup}>
                            <Text style={s.inputLabel}>PORT</Text>
                            <TextInput
                                style={s.input}
                                value={manualPort}
                                onChangeText={setManualPort}
                                placeholder="8001"
                                placeholderTextColor={colors.textMuted}
                                keyboardType="number-pad"
                            />
                        </View>

                        <TouchableOpacity
                            style={[s.connectBtn, connecting && s.connectBtnDisabled]}
                            onPress={handleManualConnect}
                            disabled={connecting}
                        >
                            {connecting ? (
                                <ActivityIndicator color={colors.bg} />
                            ) : (
                                <>
                                    <Ionicons name="wifi-outline" size={18} color={colors.bg} />
                                    <Text style={s.connectBtnText}>Connect</Text>
                                </>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            <View style={s.footer}>
                <TouchableOpacity
                    style={s.modeToggle}
                    onPress={() => setIsManualMode(!isManualMode)}
                >
                    <Ionicons
                        name={isManualMode ? "search" : "pencil"}
                        size={18}
                        color={colors.textSecondary}
                    />
                    <Text style={s.modeToggleText}>
                        {isManualMode ? 'Scan for modules' : 'Enter manually'}
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bg,
    },
    scanContent: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
    },
    scanCircle: {
        width: 160,
        height: 160,
        borderRadius: 80,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: spacing.xxl,
        marginBottom: spacing.xl,
    },
    scanIconWrap: {
        position: 'absolute',
    },
    scanCenter: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.white,
        alignItems: 'center',
        justifyContent: 'center',
    },
    scanTitle: {
        color: colors.white,
        fontSize: fonts.sizes.xl,
        fontWeight: '600',
        marginBottom: spacing.xs,
    },
    scanSubtitle: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
        textAlign: 'center',
    },
    deviceList: {
        width: '100%',
        marginTop: spacing.xl,
        gap: spacing.sm,
    },
    deviceCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        padding: spacing.lg,
        borderRadius: radius.xl,
        gap: spacing.md,
        borderWidth: 1,
        borderColor: colors.border,
    },
    deviceIcon: {
        width: 44,
        height: 44,
        borderRadius: radius.md,
        backgroundColor: colors.white,
        alignItems: 'center',
        justifyContent: 'center',
    },
    deviceInfo: {
        flex: 1,
    },
    deviceName: {
        color: colors.white,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
    },
    deviceIp: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
        marginTop: 2,
    },
    scanBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors.white,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xl,
        borderRadius: radius.full,
        marginTop: spacing.xl,
    },
    scanBtnActive: {
        backgroundColor: colors.surfaceLight,
    },
    scanBtnText: {
        color: colors.bg,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
    },
    manualContent: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.xxl,
    },
    manualIcon: {
        width: 64,
        height: 64,
        borderRadius: radius.lg,
        backgroundColor: colors.white,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.lg,
    },
    manualTitle: {
        color: colors.white,
        fontSize: fonts.sizes.xl,
        fontWeight: '600',
        marginBottom: spacing.xs,
    },
    manualSubtitle: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
        marginBottom: spacing.xxl,
    },
    form: {
        width: '100%',
        gap: spacing.lg,
    },
    inputGroup: {
        gap: spacing.xs,
    },
    inputLabel: {
        color: colors.textMuted,
        fontSize: 10,
        fontWeight: '600',
        letterSpacing: 1.5,
    },
    input: {
        backgroundColor: colors.surface,
        color: colors.white,
        padding: spacing.lg,
        fontSize: fonts.sizes.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
    },
    connectBtn: {
        backgroundColor: colors.white,
        height: 56,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: spacing.xs,
        marginTop: spacing.md,
    },
    connectBtnDisabled: {
        backgroundColor: colors.surfaceLight,
    },
    connectBtnText: {
        color: colors.bg,
        fontWeight: '600',
        fontSize: fonts.sizes.md,
    },
    footer: {
        padding: spacing.xl,
        alignItems: 'center',
    },
    modeToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        padding: spacing.md,
    },
    modeToggleText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
    },
});
