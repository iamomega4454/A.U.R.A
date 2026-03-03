import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Switch,
    ScrollView,
    Alert,
    Image,
    ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { useAuth } from '../../src/context/auth';
import { usePreferences } from '../../src/context/preferences';
import api from '../../src/services/api';
import Header from '../../src/components/Header';
import Screen from '../../src/components/Screen';
import * as Haptics from 'expo-haptics';

type IconName = keyof typeof Ionicons.glyphMap;

interface NotificationSettings {
    enabled: boolean;
    medication_reminders: boolean;
    sos_alerts: boolean;
    geofence_alerts: boolean;
    daily_insights: boolean;
    quiet_hours_enabled: boolean;
    quiet_hours_start?: string;
    quiet_hours_end?: string;
}

interface AppearanceSettings {
    theme: string;
    font_size: 'small' | 'medium' | 'large';
    high_contrast: boolean;
}

interface PrivacySettings {
    location_tracking: boolean;
    share_data_with_caregivers: boolean;
    anonymous_analytics: boolean;
    geofence_alerts: boolean;
}

interface VoiceSettings {
    voice_assistant_enabled: boolean;
    voice_feedback: boolean;
    language: string;
    voice_gender: string;
    voice_speed: number;
    voice_pitch: number;
    wake_word_enabled: boolean;
    auto_listen: boolean;
}

interface AccessibilitySettings {
    screen_reader: boolean;
    large_buttons: boolean;
    reduce_motion: boolean;
}

interface SettingsData {
    notifications: NotificationSettings;
    appearance: AppearanceSettings;
    privacy: PrivacySettings;
    voice: VoiceSettings;
    accessibility: AccessibilitySettings;
}

const DEFAULT_SETTINGS_DATA: SettingsData = {
    notifications: {
        enabled: true,
        medication_reminders: true,
        sos_alerts: true,
        geofence_alerts: true,
        daily_insights: true,
        quiet_hours_enabled: false,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
    },
    appearance: {
        theme: 'dark',
        font_size: 'medium',
        high_contrast: false,
    },
    privacy: {
        location_tracking: true,
        share_data_with_caregivers: true,
        anonymous_analytics: true,
        geofence_alerts: true,
    },
    voice: {
        voice_assistant_enabled: true,
        voice_feedback: true,
        language: 'en',
        voice_gender: 'male',
        voice_speed: 1.0,
        voice_pitch: 1.0,
        wake_word_enabled: false,
        auto_listen: false,
    },
    accessibility: {
        screen_reader: false,
        large_buttons: false,
        reduce_motion: false,
    },
};

//------This Function handles the Section Card---------
function SectionCard({
    title,
    subtitle,
    children,
}: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
}) {
    return (
        <View style={s.sectionWrap}>
            <View style={s.sectionHead}>
                <Text style={s.sectionTitle}>{title}</Text>
                {subtitle ? <Text style={s.sectionSubtitle}>{subtitle}</Text> : null}
            </View>
            <View style={s.sectionCard}>{children}</View>
        </View>
    );
}

//------This Function handles the Toggle Row---------
function ToggleRow({
    icon,
    label,
    subtitle,
    value,
    onToggle,
    fontScale,
    last,
    disabled,
}: {
    icon: IconName;
    label: string;
    subtitle?: string;
    value: boolean;
    onToggle: (nextValue: boolean) => void;
    fontScale: number;
    last?: boolean;
    disabled?: boolean;
}) {
    return (
        <TouchableOpacity
            style={[s.row, last && s.rowLast, disabled && s.rowDisabled]}
            activeOpacity={0.9}
            onPress={() => !disabled && onToggle(!value)}
            disabled={disabled}
        >
            <View style={s.rowLeft}>
                <View style={s.rowIconWrap}>
                    <Ionicons name={icon} size={16} color={colors.textSecondary} />
                </View>
                <View style={s.rowTextWrap}>
                    <Text style={[s.rowLabel, { fontSize: 14 * fontScale }]}>{label}</Text>
                    {subtitle ? <Text style={[s.rowSub, { fontSize: 11 * fontScale }]}>{subtitle}</Text> : null}
                </View>
            </View>
            <Switch
                value={value}
                onValueChange={onToggle}
                disabled={disabled}
                trackColor={{ false: colors.surfaceLight, true: colors.white }}
                thumbColor={value ? colors.bg : colors.textMuted}
            />
        </TouchableOpacity>
    );
}

//------This Function handles the Nav Row---------
function NavRow({
    icon,
    label,
    subtitle,
    fontScale,
    onPress,
    rightText,
    rightTextActive,
    last,
    danger,
}: {
    icon: IconName;
    label: string;
    subtitle?: string;
    fontScale: number;
    onPress: () => void;
    rightText?: string;
    rightTextActive?: boolean;
    last?: boolean;
    danger?: boolean;
}) {
    return (
        <TouchableOpacity style={[s.row, last && s.rowLast]} activeOpacity={0.9} onPress={onPress}>
            <View style={s.rowLeft}>
                <View style={[s.rowIconWrap, danger && s.rowIconWrapDanger]}>
                    <Ionicons name={icon} size={16} color={danger ? colors.red : colors.textSecondary} />
                </View>
                <View style={s.rowTextWrap}>
                    <Text style={[s.rowLabel, { fontSize: 14 * fontScale }, danger && s.rowLabelDanger]}>{label}</Text>
                    {subtitle ? <Text style={[s.rowSub, { fontSize: 11 * fontScale }]}>{subtitle}</Text> : null}
                </View>
            </View>
            <View style={s.rowRight}>
                {rightText ? (
                    <View style={[s.statusPill, rightTextActive && s.statusPillActive]}>
                        <Text style={[s.statusPillText, rightTextActive && s.statusPillTextActive]}>{rightText}</Text>
                    </View>
                ) : null}
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </View>
        </TouchableOpacity>
    );
}

//------This Function handles the Settings Screen---------
export default function SettingsScreen() {
    const router = useRouter();
    const { user, signOut } = useAuth();
    const { fontScale } = usePreferences();

    const [settings, setSettings] = useState<SettingsData>(DEFAULT_SETTINGS_DATA);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    //------This Function handles the Load Settings---------
    async function loadSettings() {
        setLoading(true);
        try {
            const res = await api.get('/settings/');
            const data = res.data || {};
            setSettings({
                notifications: { ...DEFAULT_SETTINGS_DATA.notifications, ...data.notifications },
                appearance: { ...DEFAULT_SETTINGS_DATA.appearance, ...data.appearance },
                privacy: { ...DEFAULT_SETTINGS_DATA.privacy, ...data.privacy },
                voice: { ...DEFAULT_SETTINGS_DATA.voice, ...data.voice },
                accessibility: { ...DEFAULT_SETTINGS_DATA.accessibility, ...data.accessibility },
            });
        } catch (error) {
            console.warn('[Settings] Failed to load settings, using defaults', error);
            setSettings(DEFAULT_SETTINGS_DATA);
        } finally {
            setLoading(false);
        }
    }

    async function updateCategory<K extends keyof SettingsData>(
        category: K,
        updates: Partial<SettingsData[K]>,
        options?: { showError?: boolean }
    ) {
        const previous = settings[category];
        setSettings((prev) => ({ ...prev, [category]: { ...prev[category], ...updates } }));
        try {
            await api.patch(`/settings/${category}`, updates);
        } catch (error) {
            console.error(`[Settings] failed to update ${String(category)}`, error);
            setSettings((prev) => ({ ...prev, [category]: previous }));
            if (options?.showError !== false) {
                Alert.alert('Sync Failed', 'Could not save this setting right now.');
            }
        }
    }

    //------This Function handles the Confirm Sign Out---------
    function confirmSignOut() {
        Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Sign Out',
                style: 'destructive',
                onPress: async () => {
                    await signOut();
                },
            },
        ]);
    }

    if (loading) {
        return (
            <Screen safeArea={false}>
                <Header title="Settings" subtitle="Personalize your app" />
                <View style={s.loadingWrap}>
                    <ActivityIndicator color={colors.textSecondary} />
                </View>
            </Screen>
        );
    }

    return (
        <Screen safeArea={false}>
            <Header title="Settings" subtitle="Personalize your app" />

            <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
                <TouchableOpacity style={s.profileCard} onPress={() => router.push('/(patient)/profile')} activeOpacity={0.9}>
                    {user?.photo_url ? (
                        <Image source={{ uri: user.photo_url }} style={s.avatar} />
                    ) : (
                        <View style={s.avatarPlaceholder}>
                            <Ionicons name="person-outline" size={24} color={colors.textMuted} />
                        </View>
                    )}

                    <View style={s.profileMeta}>
                        <Text style={s.profileKicker}>ACCOUNT</Text>
                        <Text style={[s.profileName, { fontSize: 17 * fontScale }]}>{user?.display_name || 'User'}</Text>
                        <Text style={[s.profileEmail, { fontSize: 12 * fontScale }]}>{user?.email || 'No email'}</Text>
                    </View>
                    <View style={s.profileArrowWrap}>
                        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                    </View>
                </TouchableOpacity>

                <SectionCard title="Notifications" subtitle="Choose what should alert you">
                    <ToggleRow
                        icon="notifications-outline"
                        label="Notifications"
                        subtitle="Master switch for all alerts"
                        value={settings.notifications.enabled}
                        onToggle={(next) => {
                            Haptics.selectionAsync();
                            updateCategory('notifications', { enabled: next });
                        }}
                        fontScale={fontScale}
                    />
                    <ToggleRow
                        icon="medkit-outline"
                        label="Medication Reminders"
                        value={settings.notifications.medication_reminders}
                        onToggle={(next) => {
                            Haptics.selectionAsync();
                            updateCategory('notifications', { medication_reminders: next });
                        }}
                        disabled={!settings.notifications.enabled}
                        fontScale={fontScale}
                    />
                    <ToggleRow
                        icon="warning-outline"
                        label="SOS Alerts"
                        value={settings.notifications.sos_alerts}
                        onToggle={(next) => {
                            Haptics.selectionAsync();
                            updateCategory('notifications', { sos_alerts: next });
                        }}
                        disabled={!settings.notifications.enabled}
                        fontScale={fontScale}
                        last
                    />
                </SectionCard>

                <SectionCard title="My Care" subtitle="Manage medications and caregivers">
                    <NavRow
                        icon="medkit-outline"
                        label="Medications"
                        subtitle="Doses and schedule"
                        onPress={() => router.push('/(patient)/edit-medications')}
                        fontScale={fontScale}
                    />
                    <NavRow
                        icon="heart-outline"
                        label="Caregivers"
                        subtitle="Trusted contacts and support"
                        onPress={() => router.push('/(patient)/edit-caregivers')}
                        fontScale={fontScale}
                        last
                    />
                </SectionCard>

                <SectionCard title="Account">
                    <NavRow
                        icon="person-circle-outline"
                        label="Profile"
                        subtitle="Photo and account details"
                        onPress={() => router.push('/(patient)/profile')}
                        fontScale={fontScale}
                    />
                    <NavRow
                        icon="log-out-outline"
                        label="Sign Out"
                        subtitle="Log out from this device"
                        onPress={confirmSignOut}
                        fontScale={fontScale}
                        danger
                        last
                    />
                </SectionCard>

                <Text style={s.versionText}>Aura v1.0.0 · {user?.id ? user.id.slice(0, 8) : 'unknown'}</Text>
            </ScrollView>
        </Screen>
    );
}

const s = StyleSheet.create({
    loadingWrap: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: spacing.xxl + 80,
        gap: spacing.md,
    },
    profileCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    avatar: {
        width: 46,
        height: 46,
        borderRadius: 14,
        backgroundColor: colors.surface,
    },
    avatarPlaceholder: {
        width: 46,
        height: 46,
        borderRadius: 14,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: colors.border,
    },
    profileMeta: {
        flex: 1,
    },
    profileKicker: {
        color: colors.textMuted,
        fontSize: 10,
        fontWeight: '600',
        letterSpacing: 1.2,
        marginBottom: 2,
    },
    profileName: {
        color: colors.textPrimary,
        fontWeight: '600',
        letterSpacing: -0.2,
    },
    profileEmail: {
        marginTop: 2,
        color: colors.textMuted,
    },
    profileArrowWrap: {
        width: 28,
        height: 28,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sectionWrap: {
        gap: spacing.sm,
    },
    sectionHead: {
        paddingHorizontal: spacing.xs,
    },
    sectionTitle: {
        color: colors.textSecondary,
        fontSize: 10,
        fontWeight: '600',
        letterSpacing: 1.5,
        textTransform: 'uppercase',
    },
    sectionSubtitle: {
        marginTop: 3,
        color: colors.textSecondary,
        fontSize: 11,
    },
    sectionCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden',
    },
    row: {
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        gap: spacing.sm,
    },
    rowLast: {
        borderBottomWidth: 0,
    },
    rowDisabled: {
        opacity: 0.45,
    },
    rowLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        flex: 1,
    },
    rowIconWrap: {
        width: 32,
        height: 32,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
    },
    rowIconWrapDanger: {
        backgroundColor: 'rgba(255,59,48,0.12)',
        borderColor: 'rgba(255,59,48,0.24)',
    },
    rowTextWrap: {
        flex: 1,
    },
    rowLabel: {
        color: colors.textPrimary,
        fontWeight: '600',
        letterSpacing: -0.1,
    },
    rowLabelDanger: {
        color: colors.red,
    },
    rowSub: {
        marginTop: 2,
        color: colors.textMuted,
    },
    rowRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    statusPill: {
        height: 24,
        minWidth: 52,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.sm,
    },
    statusPillActive: {
        borderColor: colors.primary,
        backgroundColor: colors.primary,
    },
    statusPillText: {
        color: colors.textSecondary,
        fontSize: 10,
        fontWeight: '600',
    },
    statusPillTextActive: {
        color: colors.bg,
    },
    versionText: {
        marginTop: spacing.md,
        textAlign: 'center',
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        letterSpacing: 0.4,
    },
});
