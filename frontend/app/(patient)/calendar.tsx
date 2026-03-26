import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../../src/context/auth';
import api from '../../src/services/api';
import Screen from '../../src/components/Screen';
import PatientHeader from '../../src/components/PatientHeader';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Med {
    id: string;
    name: string;
    dosage: string;
    frequency: string;
    schedule_times: string[];
    is_active: boolean;
    last_taken: string | null;
}

interface JournalEntry {
    id: string;
    content: string;
    created_at: string;
}

interface Reminder {
    id: string;
    title: string;
    description: string;
    datetime: string;
    repeat_pattern: string | null;
    status: string;
    created_by: string;
    source: string;
    created_at: string;
}

type CalendarRoute = '/(patient)/calendar-medications' | '/(patient)/calendar-tasks' | '/(patient)/calendar-journal';

//------This Function handles the Fmt---------
function fmt(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

//------This Function handles the Is Same Day---------
function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

//------This Function handles the Get Week Start---------
function getWeekStart(d: Date): Date {
    const copy = new Date(d);
    copy.setDate(copy.getDate() - copy.getDay());
    copy.setHours(0, 0, 0, 0);
    return copy;
}

//------This Function handles the Get Month Start---------
function getMonthStart(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STEP_GOAL = 5000;

//------This Function handles the Calendar Screen---------
export default function CalendarScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { user, loading: authLoading } = useAuth();
    //------This Function handles the Today---------
    const today = useMemo(() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }, []);

    const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
    const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
    const [monthStart, setMonthStart] = useState(() => getMonthStart(new Date()));
    const [selectedDate, setSelectedDate] = useState(new Date());

    const [meds, setMeds] = useState<Med[]>([]);
    const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [steps, setSteps] = useState(0);
    const [loading, setLoading] = useState(true);

    const dateKey = fmt(selectedDate);

    //------This Function handles the Week Dates---------
    const weekDates = useMemo(() => {
        return Array.from({ length: 7 }, (_, i) => {
            const d = new Date(weekStart);
            d.setDate(d.getDate() + i);
            return d;
        });
    }, [weekStart]);

    //------This Function handles the Month Grid---------
    const monthGrid = useMemo(() => {
        const year = monthStart.getFullYear();
        const month = monthStart.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const cells: (Date | null)[] = [];

        for (let i = 0; i < firstDay; i++) {
            cells.push(null);
        }
        for (let d = 1; d <= daysInMonth; d++) {
            cells.push(new Date(year, month, d));
        }

        return cells;
    }, [monthStart]);

    //------This Function handles the Navigate Back---------
    function navigateBack() {
        Haptics.selectionAsync();
        if (viewMode === 'week') {
            const prev = new Date(weekStart);
            prev.setDate(prev.getDate() - 7);
            setWeekStart(prev);
            return;
        }
        const prev = new Date(monthStart);
        prev.setMonth(prev.getMonth() - 1);
        setMonthStart(prev);
    }

    //------This Function handles the Navigate Forward---------
    function navigateForward() {
        Haptics.selectionAsync();
        if (viewMode === 'week') {
            const next = new Date(weekStart);
            next.setDate(next.getDate() + 7);
            setWeekStart(next);
            return;
        }
        const next = new Date(monthStart);
        next.setMonth(next.getMonth() + 1);
        setMonthStart(next);
    }

    //------This Function handles the Go Today---------
    function goToday() {
        Haptics.selectionAsync();
        const now = new Date();
        setSelectedDate(now);
        setWeekStart(getWeekStart(now));
        setMonthStart(getMonthStart(now));
    }

    //------This Function handles the Select Date---------
    function selectDate(d: Date) {
        Haptics.selectionAsync();
        setSelectedDate(d);
        if (viewMode === 'month') {
            setWeekStart(getWeekStart(d));
        }
    }

    //------This Function handles the Header Label---------
    const headerLabel = useMemo(() => {
        if (viewMode === 'week') {
            const end = new Date(weekStart);
            end.setDate(end.getDate() + 6);
            if (weekStart.getMonth() === end.getMonth()) {
                return `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getFullYear()}`;
            }
            return `${MONTH_NAMES[weekStart.getMonth()].slice(0, 3)} - ${MONTH_NAMES[end.getMonth()].slice(0, 3)} ${end.getFullYear()}`;
        }
        return `${MONTH_NAMES[monthStart.getMonth()]} ${monthStart.getFullYear()}`;
    }, [viewMode, weekStart, monthStart]);

    //------This Function handles the Load Remote Data---------
    const loadRemoteData = useCallback(async () => {
        if (!user) {
            return;
        }
        setLoading(true);
        try {
            const [medsRes, journalRes, remindersRes] = await Promise.allSettled([
                api.get('/medications/'),
                api.get('/journal/'),
                api.get('/reminders/', { params: { status: 'all', limit: 200 } }),
            ]);
            if (medsRes.status === 'fulfilled') {
                setMeds(medsRes.value.data || []);
            }
            if (journalRes.status === 'fulfilled') {
                setJournalEntries(journalRes.value.data || []);
            }
            if (remindersRes.status === 'fulfilled') {
                setReminders(remindersRes.value.data || []);
            }
        } catch (error) {
            console.error('[Calendar] failed to load overview data', error);
        } finally {
            setLoading(false);
        }
    }, [user]);

    //------This Function handles the Load Local Data---------
    const loadLocalData = useCallback(async () => {
        try {
            const stepsRaw = await AsyncStorage.getItem(`steps_${dateKey}`);
            setSteps(stepsRaw ? parseInt(stepsRaw, 10) : 0);
        } catch (error) {
            console.error('[Calendar] failed to load local overview data', error);
            setSteps(0);
        }
    }, [dateKey]);

    useFocusEffect(
        useCallback(() => {
            if (!authLoading && user) {
                loadRemoteData();
            }
        }, [authLoading, user, loadRemoteData])
    );

    useFocusEffect(
        useCallback(() => {
            loadLocalData();
        }, [loadLocalData])
    );

    //------This Function handles the Active Meds---------
    const activeMeds = useMemo(() => meds.filter((m) => m.is_active), [meds]);

    //------This Function handles the Meds Taken Today---------
    const medsTakenToday = useMemo(() => {
        return activeMeds.filter((m) => {
            if (!m.last_taken) {
                return false;
            }
            return isSameDay(new Date(m.last_taken), selectedDate);
        }).length;
    }, [activeMeds, selectedDate]);

    //------This Function handles the Journal Count---------
    const journalCount = useMemo(() => {
        return journalEntries.filter((entry) => isSameDay(new Date(entry.created_at), selectedDate)).length;
    }, [journalEntries, selectedDate]);

    //------This Function filters reminders for selected date---------
    function isReminderForDate(r: Reminder): boolean {
        const dt = new Date(r.datetime);
        return isSameDay(dt, selectedDate);
    }

    const dayReminders = useMemo(() => reminders.filter(isReminderForDate), [reminders, selectedDate]);
    const totalTasks = dayReminders.length;
    //------This Function handles the Completed Tasks---------
    const completedTasks = dayReminders.filter((r) => r.status === 'completed').length;
    const totalItems = activeMeds.length + totalTasks;
    const completedItems = medsTakenToday + completedTasks;
    const completionPct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;
    const stepsGoalPct = Math.min(100, Math.round((steps / STEP_GOAL) * 100));

    //------This Function handles the Section Cards---------
    const sectionCards = useMemo(() => ([
        {
            key: 'medications',
            title: 'Medications',
            subtitle: activeMeds.length > 0 ? `${medsTakenToday}/${activeMeds.length} taken today` : 'No active medications',
            icon: 'medkit-outline',
            route: '/(patient)/calendar-medications' as CalendarRoute,
            badge: activeMeds.length > 0 ? `${medsTakenToday}/${activeMeds.length}` : '0',
            metaIcon: 'medical-outline',
            metaText: 'Medication Plan',
            active: activeMeds.length > 0,
        },
        {
            key: 'tasks',
            title: 'Tasks & Reminders',
            subtitle: totalTasks > 0 ? `${completedTasks}/${totalTasks} completed` : 'No tasks for this date',
            icon: 'checkmark-done-outline',
            route: '/(patient)/calendar-tasks' as CalendarRoute,
            badge: totalTasks > 0 ? `${completedTasks}/${totalTasks}` : '0',
            metaIcon: 'alarm-outline',
            metaText: 'Daily Task List',
            active: totalTasks > 0,
        },
        {
            key: 'journal',
            title: 'Journal',
            subtitle: journalCount > 0 ? `${journalCount} entries` : 'No entries for this date',
            icon: 'book-outline',
            route: '/(patient)/calendar-journal' as CalendarRoute,
            badge: `${journalCount}`,
            metaIcon: 'time-outline',
            metaText: selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            active: journalCount > 0,
        },
    ]), [activeMeds.length, medsTakenToday, totalTasks, completedTasks, journalCount, selectedDate]);

    //------This Function handles the Open Section---------
    const openSection = (route: CalendarRoute) => {
        Haptics.selectionAsync();
        router.push({
            pathname: route as any,
            params: { date: dateKey },
        } as any);
    };

    if (authLoading) {
        return (
            <Screen>
                <ActivityIndicator size="large" color={colors.primary} style={{ flex: 1 }} />
            </Screen>
        );
    }

    return (
        <Screen>
            <PatientHeader
                rightIcon={viewMode === 'week' ? 'calendar-outline' : 'calendar-clear-outline'}
                onRightPress={() => setViewMode(viewMode === 'week' ? 'month' : 'week')}
            />

            <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 100 }]} showsVerticalScrollIndicator={false}>
                <View style={s.calendarShell}>
                    <View style={s.navRow}>
                        <TouchableOpacity onPress={navigateBack} hitSlop={14} style={s.navIconBtn}>
                            <Ionicons name="chevron-back" size={16} color={colors.textSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={goToday} style={s.navTitleWrap}>
                            <Text style={s.navTitle}>{headerLabel}</Text>
                            <Text style={s.navSubTitle}>
                                {selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={navigateForward} hitSlop={14} style={s.navIconBtn}>
                            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                        </TouchableOpacity>
                    </View>

                    {viewMode === 'week' && (
                        <View style={s.weekRow}>
                            {weekDates.map((d, i) => {
                                const isSelected = isSameDay(d, selectedDate);
                                const isToday = isSameDay(d, today);
                                return (
                                    <TouchableOpacity key={i} style={s.dayCol} onPress={() => selectDate(d)} activeOpacity={0.9}>
                                        <Text style={[s.dayLabel, isSelected && s.dayLabelActive]}>{DAY_LABELS[d.getDay()]}</Text>
                                        <View style={[s.dayNumContainer, isSelected && s.dayNumContainerActive, isToday && !isSelected && s.dayNumContainerToday]}>
                                            <Text style={[s.dayNum, isSelected && s.dayNumActive]}>{d.getDate()}</Text>
                                        </View>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    )}

                    {viewMode === 'month' && (
                        <View style={s.monthContainer}>
                            <View style={s.monthDayLabels}>
                                {DAY_LABELS.map((label, i) => (
                                    <Text key={i} style={s.monthDayLabel}>{label}</Text>
                                ))}
                            </View>
                            <View style={s.monthGrid}>
                                {monthGrid.map((d, i) => {
                                    if (!d) {
                                        return <View key={i} style={s.monthCell} />;
                                    }
                                    const isSelected = isSameDay(d, selectedDate);
                                    const isToday = isSameDay(d, today);
                                    return (
                                        <TouchableOpacity key={i} style={[s.monthCell, isSelected && s.monthCellActive]} onPress={() => selectDate(d)} activeOpacity={0.9}>
                                            <Text
                                                style={[
                                                    s.monthCellText,
                                                    isSelected && s.monthCellTextActive,
                                                    isToday && !isSelected && s.monthCellTextToday,
                                                ]}
                                            >
                                                {d.getDate()}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                    )}
                </View>

                <View style={s.heroCard}>
                    {loading ? (
                        <View style={s.heroLoading}>
                            <ActivityIndicator size="small" color={colors.textSecondary} />
                        </View>
                    ) : (
                        <>
                            <View style={s.heroTop}>
                                <View>
                                    <Text style={s.heroLabel}>Day Overview</Text>
                                    <Text style={s.heroValue}>{totalItems > 0 ? `${completedItems}/${totalItems}` : '0'}</Text>
                                    <Text style={s.heroSub}>items completed</Text>
                                </View>
                                <View style={s.heroBadge}>
                                    <Text style={s.heroBadgeText}>{stepsGoalPct}%</Text>
                                    <Text style={s.heroBadgeLabel}>step goal</Text>
                                </View>
                            </View>

                            <View style={s.progressTrack}>
                                <View style={[s.progressFill, { width: `${completionPct}%` }]} />
                            </View>

                            <View style={s.statsRow}>
                                <View style={s.statItem}>
                                    <Text style={s.statValue}>{activeMeds.length > 0 ? `${medsTakenToday}/${activeMeds.length}` : '0'}</Text>
                                    <Text style={s.statLabel}>Meds</Text>
                                </View>
                                <View style={s.statDivider} />
                                <View style={s.statItem}>
                                    <Text style={s.statValue}>{totalTasks > 0 ? `${completedTasks}/${totalTasks}` : '0'}</Text>
                                    <Text style={s.statLabel}>Tasks</Text>
                                </View>
                                <View style={s.statDivider} />
                                <View style={s.statItem}>
                                    <Text style={s.statValue}>{journalCount}</Text>
                                    <Text style={s.statLabel}>Journal</Text>
                                </View>
                            </View>
                        </>
                    )}
                </View>

                <View style={s.sectionLinks}>
                    {sectionCards.map((card) => (
                        <TouchableOpacity
                            key={card.key}
                            style={s.linkCard}
                            onPress={() => openSection(card.route)}
                            activeOpacity={0.9}
                        >
                            <View style={s.linkTopRow}>
                                <View style={s.linkLeft}>
                                    <View style={[s.linkIconWrap, card.active && s.linkIconWrapActive]}>
                                        <Ionicons name={card.icon as any} size={16} color={card.active ? colors.bg : colors.textSecondary} />
                                    </View>
                                    <View style={s.linkTextWrap}>
                                        <Text style={s.linkTitle}>{card.title}</Text>
                                        <Text style={s.linkSubtitle}>{card.subtitle}</Text>
                                    </View>
                                </View>
                                <View style={[s.linkBadge, card.active && s.linkBadgeActive]}>
                                    <Text style={[s.linkBadgeText, card.active && s.linkBadgeTextActive]}>{card.badge}</Text>
                                </View>
                            </View>

                            <View style={s.linkBottomRow}>
                                <View style={s.metaChip}>
                                    <Ionicons name={card.metaIcon as any} size={13} color={colors.textMuted} />
                                    <Text style={s.metaChipText}>{card.metaText}</Text>
                                </View>
                                <View style={s.openWrap}>
                                    <Text style={s.openText}>Open</Text>
                                    <Ionicons name="chevron-forward-outline" size={14} color={colors.textSecondary} />
                                </View>
                            </View>
                        </TouchableOpacity>
                    ))}
                </View>
            </ScrollView>
        </Screen>
    );
}

const s = StyleSheet.create({
    content: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        gap: spacing.md,
    },
    calendarShell: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.md,
    },
    navRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.lg,
        gap: spacing.xs,
    },
    navIconBtn: {
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
    },
    navTitleWrap: {
        alignItems: 'center',
        flex: 1,
    },
    navTitle: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.lg,
        fontWeight: '600',
        letterSpacing: -0.2,
    },
    navSubTitle: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        marginTop: 2,
        letterSpacing: 0.25,
    },
    weekRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    dayCol: {
        alignItems: 'center',
        gap: 7,
        width: 40,
    },
    dayLabel: {
        color: colors.textMuted,
        fontSize: 10,
        fontWeight: '600',
        letterSpacing: 0.6,
    },
    dayLabelActive: {
        color: colors.textPrimary,
    },
    dayNumContainer: {
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
    },
    dayNumContainerActive: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    dayNumContainerToday: {
        borderColor: colors.borderLight,
    },
    dayNum: {
        color: colors.textSecondary,
        fontSize: 13,
        fontWeight: '500',
    },
    dayNumActive: {
        color: colors.bg,
        fontWeight: '600',
    },
    monthContainer: {
        paddingHorizontal: spacing.xs,
    },
    monthDayLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: spacing.sm,
    },
    monthDayLabel: {
        color: colors.textMuted,
        fontSize: 10,
        fontWeight: '600',
        width: `${100 / 7}%`,
        textAlign: 'center',
        letterSpacing: 0.6,
    },
    monthGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    monthCell: {
        width: `${100 / 7}%`,
        alignItems: 'center',
        paddingVertical: 9,
        minHeight: 44,
        justifyContent: 'center',
    },
    monthCellActive: {
        backgroundColor: colors.primary,
        borderRadius: radius.md,
    },
    monthCellText: {
        color: colors.textSecondary,
        fontSize: 13,
    },
    monthCellTextActive: {
        color: colors.bg,
        fontWeight: '600',
    },
    monthCellTextToday: {
        color: colors.primary,
    },
    heroCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.lg,
    },
    heroLoading: {
        minHeight: 120,
        alignItems: 'center',
        justifyContent: 'center',
    },
    heroTop: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
    },
    heroLabel: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        fontWeight: '600',
        letterSpacing: 1,
    },
    heroValue: {
        marginTop: spacing.xs,
        color: colors.textPrimary,
        fontSize: fonts.sizes.hero,
        fontWeight: '700',
        letterSpacing: -1,
    },
    heroSub: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
    },
    heroBadge: {
        minWidth: 84,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.lg,
        alignItems: 'center',
    },
    heroBadgeText: {
        color: colors.primary,
        fontSize: fonts.sizes.lg,
        fontWeight: '700',
    },
    heroBadgeLabel: {
        color: colors.textMuted,
        fontSize: 10,
        marginTop: 2,
    },
    progressTrack: {
        marginTop: spacing.md,
        height: 6,
        borderRadius: radius.full,
        backgroundColor: colors.surface,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: colors.primary,
        borderRadius: radius.full,
    },
    statsRow: {
        marginTop: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: spacing.md,
    },
    statItem: {
        flex: 1,
        alignItems: 'center',
    },
    statDivider: {
        width: 1,
        height: 24,
        backgroundColor: colors.border,
    },
    statValue: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.lg,
        fontWeight: '600',
    },
    statLabel: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        marginTop: 2,
    },
    sectionLinks: {
        gap: spacing.sm,
    },
    linkCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.md,
    },
    linkTopRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: spacing.sm,
    },
    linkLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        flex: 1,
    },
    linkIconWrap: {
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    linkIconWrapActive: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    linkTextWrap: {
        flex: 1,
    },
    linkTitle: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
        letterSpacing: -0.2,
    },
    linkSubtitle: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        marginTop: 2,
    },
    linkBadge: {
        minWidth: 34,
        height: 26,
        borderRadius: radius.full,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.sm,
    },
    linkBadgeActive: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    linkBadgeText: {
        color: colors.textSecondary,
        fontSize: 11,
        fontWeight: '600',
    },
    linkBadgeTextActive: {
        color: colors.bg,
    },
    linkBottomRow: {
        marginTop: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    metaChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.full,
        paddingHorizontal: spacing.sm,
        paddingVertical: 6,
    },
    metaChipText: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
    },
    openWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    openText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.xs,
        fontWeight: '600',
    },
});
