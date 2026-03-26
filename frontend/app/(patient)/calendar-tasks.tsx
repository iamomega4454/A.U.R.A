import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    TextInput,
    Alert,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import Header from '../../src/components/Header';
import Screen from '../../src/components/Screen';
import api from '../../src/services/api';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';
import { notificationService } from '../../src/services/notifications';

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

interface CustomTask {
    id: string;
    title: string;
    type: 'Medication' | 'Activity' | 'Reminder' | 'Custom';
    time: string;
    completed: boolean;
    createdAt: string;
}

type TaskFilter = 'all' | 'pending' | 'completed';
const TASK_TYPES: CustomTask['type'][] = ['Medication', 'Activity', 'Reminder', 'Custom'];

//------This Function handles the Fmt---------
function fmt(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

//------This Function handles the Parse Date Param---------
function parseDateParam(dateParam: string | string[] | undefined): Date {
    const raw = Array.isArray(dateParam) ? dateParam[0] : dateParam;
    if (!raw) {
        return new Date();
    }
    const parsed = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
        return new Date();
    }
    return parsed;
}

//------This Function handles the Clamp---------
function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

//------This Function handles the Pad---------
function pad(value: number): string {
    return String(value).padStart(2, '0');
}

//------This Function handles the To Minutes---------
function toMinutes(time: string): number {
    const [hRaw, mRaw] = time.split(':');
    const h = Number(hRaw);
    const m = Number(mRaw);
    if (Number.isNaN(h) || Number.isNaN(m)) {
        return 0;
    }
    return h * 60 + m;
}

//------This Function handles the Get Task Meta---------
function getTaskMeta(type: CustomTask['type']) {
    if (type === 'Medication') {
        return { icon: 'medkit-outline', label: 'Medication' };
    }
    if (type === 'Activity') {
        return { icon: 'walk-outline', label: 'Activity' };
    }
    if (type === 'Reminder') {
        return { icon: 'notifications-outline', label: 'Reminder' };
    }
    return { icon: 'sparkles-outline', label: 'Custom' };
}

//------This Function handles the Calendar Tasks Screen---------
export default function CalendarTasksScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ date?: string | string[] }>();
    //------This Function handles the Selected Date---------
    const selectedDate = useMemo(() => parseDateParam(params.date), [params.date]);
    //------This Function handles the Date Key---------
    const dateKey = useMemo(() => fmt(selectedDate), [selectedDate]);

    const [tasks, setTasks] = useState<CustomTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [showComposer, setShowComposer] = useState(false);
    const [filter, setFilter] = useState<TaskFilter>('all');
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [newTaskType, setNewTaskType] = useState<CustomTask['type']>('Custom');
    const [newTaskHour, setNewTaskHour] = useState('09');
    const [newTaskMinute, setNewTaskMinute] = useState('00');

    //------This Function maps reminder type from source---------
    function mapTaskType(source: string): CustomTask['type'] {
        if (source === 'ai_generated') return 'Reminder';
        return 'Custom';
    }

    //------This Function converts Reminder to CustomTask---------
    function reminderToTask(r: Reminder): CustomTask {
        const dt = new Date(r.datetime);
        const time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
        return {
            id: r.id,
            title: r.title,
            type: mapTaskType(r.source),
            time,
            completed: r.status === 'completed',
            createdAt: r.created_at,
        };
    }

    //------This Function filters reminders for selected date---------
    function isReminderForDate(r: Reminder, targetDateKey: string): boolean {
        const dt = new Date(r.datetime);
        const reminderDateKey = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        return reminderDateKey === targetDateKey;
    }

    //------This Function handles the Load Tasks---------
    const loadTasks = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get('/reminders/', { params: { status: 'all', limit: 200, _t: Date.now() } });
            const reminders: Reminder[] = res.data || [];
            const dayReminders = reminders.filter((r) => isReminderForDate(r, dateKey));
            const mapped = dayReminders.map(reminderToTask);
            mapped.sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
            setTasks(mapped);
        } catch (error) {
            console.error('[CalendarTasks] load failed', error);
            Alert.alert('Error', 'Could not load tasks from server');
            setTasks([]);
        } finally {
            setLoading(false);
        }
    }, [dateKey]);

    useFocusEffect(
        useCallback(() => {
            loadTasks();
        }, [loadTasks])
    );

    //------This Function handles the Save Task---------
    async function saveTask() {
        if (!newTaskTitle.trim()) {
            Alert.alert('Required', 'Enter a task title');
            return;
        }

        const parsedHour = clamp(parseInt(newTaskHour || '0', 10) || 0, 0, 23);
        const parsedMinute = clamp(parseInt(newTaskMinute || '0', 10) || 0, 0, 59);
        const normalizedTime = `${pad(parsedHour)}:${pad(parsedMinute)}`;

        const reminderDatetime = new Date(
            selectedDate.getFullYear(),
            selectedDate.getMonth(),
            selectedDate.getDate(),
            parsedHour,
            parsedMinute,
            0,
            0,
        );

        try {
            const res = await api.post('/reminders/', {
                title: newTaskTitle.trim(),
                description: '',
                datetime: reminderDatetime.toISOString(),
                repeat_pattern: null,
                created_by: 'user',
                source: 'manual',
            });

            const createdTask = reminderToTask(res.data);
            setTasks((prev) => {
                const next = [...prev, createdTask];
                next.sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
                return next;
            });

            setNewTaskTitle('');
            setNewTaskType('Custom');
            setNewTaskHour('09');
            setNewTaskMinute('00');
            setShowComposer(false);

            await notificationService.scheduleTaskNotification(createdTask, dateKey);

            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (error) {
            console.error('[CalendarTasks] save failed', error);
            Alert.alert('Error', 'Could not save task');
        }
    }

    //------This Function handles the Toggle Task---------
    async function toggleTask(id: string) {
        const task = tasks.find((t) => t.id === id);
        if (!task) return;

        try {
            if (task.completed) {
                await api.put(`/reminders/${id}`, { status: 'active' });
            } else {
                await api.post(`/reminders/${id}/complete`);
            }

            setTasks((prev) =>
                prev.map((t) =>
                    t.id === id ? { ...t, completed: !t.completed } : t,
                ),
            );

            if (!task.completed) {
                await notificationService.cancelTaskNotification(id);
            } else {
                const restored = { ...task, completed: false };
                await notificationService.scheduleTaskNotification(restored, dateKey);
            }

            Haptics.selectionAsync();
        } catch (error) {
            console.error('[CalendarTasks] toggle failed', error);
            Alert.alert('Error', 'Could not update task');
        }
    }

    //------This Function handles the Delete Task---------
    async function deleteTask(id: string) {
        try {
            await api.delete(`/reminders/${id}`);
            setTasks((prev) => prev.filter((t) => t.id !== id));
            await notificationService.cancelTaskNotification(id);
            Haptics.selectionAsync();
        } catch (error) {
            console.error('[CalendarTasks] delete failed', error);
            Alert.alert('Error', 'Could not remove task');
        }
    }

    //------This Function handles the Counts---------
    const counts = useMemo(() => {
        //------This Function handles the Completed---------
        const completed = tasks.filter((task) => task.completed).length;
        const pending = tasks.length - completed;
        return { completed, pending };
    }, [tasks]);

    const completionPct = tasks.length > 0 ? Math.round((counts.completed / tasks.length) * 100) : 0;

    //------This Function handles the Visible Tasks---------
    const visibleTasks = useMemo(() => {
        if (filter === 'all') {
            return tasks;
        }
        if (filter === 'completed') {
            return tasks.filter((task) => task.completed);
        }
        return tasks.filter((task) => !task.completed);
    }, [tasks, filter]);

    return (
        <Screen safeArea={false}>
            <Header
                title="Tasks"
                subtitle={selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                showBack
                centered
                onBackPress={() => router.back()}
                rightElement={
                    <TouchableOpacity style={s.headerAction} onPress={() => setShowComposer((prev) => !prev)}>
                        <Ionicons name={showComposer ? 'close-outline' : 'add-outline'} size={18} color={colors.textPrimary} />
                    </TouchableOpacity>
                }
            />

            {loading ? (
                <View style={s.loadingWrap}>
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
            ) : (
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.flex}>
                    <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
                        <View style={s.heroCard}>
                            <View style={s.heroTop}>
                                <View>
                                    <Text style={s.heroLabel}>Task Progress</Text>
                                    <Text style={s.heroValue}>{tasks.length > 0 ? `${counts.completed}/${tasks.length}` : '0'}</Text>
                                    <Text style={s.heroSub}>tasks completed</Text>
                                </View>
                                <View style={s.heroBadge}>
                                    <Text style={s.heroBadgeText}>{completionPct}%</Text>
                                </View>
                            </View>

                            <View style={s.progressTrack}>
                                <View style={[s.progressFill, { width: `${completionPct}%` }]} />
                            </View>

                            <View style={s.statsRow}>
                                <View style={s.statItem}>
                                    <Text style={s.statValue}>{counts.pending}</Text>
                                    <Text style={s.statLabel}>Pending</Text>
                                </View>
                                <View style={s.statDivider} />
                                <View style={s.statItem}>
                                    <Text style={s.statValue}>{counts.completed}</Text>
                                    <Text style={s.statLabel}>Done</Text>
                                </View>
                                <View style={s.statDivider} />
                                <View style={s.statItem}>
                                    <Text style={s.statValue}>{tasks.length}</Text>
                                    <Text style={s.statLabel}>Total</Text>
                                </View>
                            </View>
                        </View>

                        {tasks.length > 0 && (
                            <View style={s.filtersRow}>
                                {([
                                    { key: 'all', label: 'All', count: tasks.length },
                                    { key: 'pending', label: 'Pending', count: counts.pending },
                                    { key: 'completed', label: 'Done', count: counts.completed },
                                ] as Array<{ key: TaskFilter; label: string; count: number }>).map((item) => (
                                    <TouchableOpacity
                                        key={item.key}
                                        style={[s.filterChip, filter === item.key && s.filterChipActive]}
                                        onPress={() => setFilter(item.key)}
                                        activeOpacity={0.85}
                                    >
                                        <Text style={[s.filterChipText, filter === item.key && s.filterChipTextActive]}>{item.label}</Text>
                                        <View style={[s.filterCount, filter === item.key && s.filterCountActive]}>
                                            <Text style={[s.filterCountText, filter === item.key && s.filterCountTextActive]}>{item.count}</Text>
                                        </View>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}

                        {showComposer && (
                            <View style={s.composerCard}>
                                <Text style={s.composerTitle}>Quick Add</Text>
                                <View style={s.inputWrap}>
                                    <Ionicons name="create-outline" size={16} color={colors.textMuted} />
                                    <TextInput
                                        style={s.input}
                                        value={newTaskTitle}
                                        onChangeText={setNewTaskTitle}
                                        placeholder="What needs to be done?"
                                        placeholderTextColor={colors.textMuted}
                                    />
                                </View>

                                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.typeRow}>
                                    {TASK_TYPES.map((type) => {
                                        const isActive = newTaskType === type;
                                        const meta = getTaskMeta(type);
                                        return (
                                            <TouchableOpacity
                                                key={type}
                                                style={[s.typeChip, isActive && s.typeChipActive]}
                                                onPress={() => setNewTaskType(type)}
                                                activeOpacity={0.9}
                                            >
                                                <Ionicons
                                                    name={meta.icon as any}
                                                    size={14}
                                                    color={isActive ? colors.textPrimary : colors.textMuted}
                                                />
                                                <Text style={[s.typeChipText, isActive && s.typeChipTextActive]}>{type}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>

                                <View style={s.timeRow}>
                                    <Text style={s.timeLabel}>Time</Text>
                                    <TextInput
                                        style={s.timeInput}
                                        value={newTaskHour}
                                        onChangeText={(value) => setNewTaskHour(value.replace(/[^0-9]/g, '').slice(0, 2))}
                                        keyboardType="number-pad"
                                        placeholder="09"
                                        placeholderTextColor={colors.textMuted}
                                    />
                                    <Text style={s.timeSep}>:</Text>
                                    <TextInput
                                        style={s.timeInput}
                                        value={newTaskMinute}
                                        onChangeText={(value) => setNewTaskMinute(value.replace(/[^0-9]/g, '').slice(0, 2))}
                                        keyboardType="number-pad"
                                        placeholder="00"
                                        placeholderTextColor={colors.textMuted}
                                    />
                                </View>

                                <TouchableOpacity style={s.saveBtn} onPress={saveTask} activeOpacity={0.9}>
                                    <Ionicons name="save-outline" size={16} color={colors.bg} />
                                    <Text style={s.saveBtnText}>Save Task</Text>
                                </TouchableOpacity>
                            </View>
                        )}

                        {tasks.length === 0 ? (
                            <View style={s.emptyCard}>
                                <Ionicons name="checkmark-circle-outline" size={30} color={colors.textMuted} />
                                <Text style={s.emptyTitle}>No Tasks Yet</Text>
                                <Text style={s.emptySub}>Create simple reminders to keep your day organized.</Text>
                                <TouchableOpacity style={s.emptyAction} onPress={() => setShowComposer(true)} activeOpacity={0.9}>
                                    <Ionicons name="add-circle-outline" size={16} color={colors.bg} />
                                    <Text style={s.emptyActionText}>Add First Task</Text>
                                </TouchableOpacity>
                            </View>
                        ) : visibleTasks.length === 0 ? (
                            <View style={s.emptyCard}>
                                <Ionicons name="filter-outline" size={28} color={colors.textMuted} />
                                <Text style={s.emptyTitle}>Nothing Here</Text>
                                <Text style={s.emptySub}>No tasks match this filter.</Text>
                            </View>
                        ) : (
                            <View style={s.listWrap}>
                                {visibleTasks.map((task) => {
                                    const meta = getTaskMeta(task.type);
                                    const isDone = task.completed;
                                    return (
                                        <View key={task.id} style={[s.taskCard, isDone && s.taskCardDone]}>
                                            <View style={s.taskTop}>
                                                <View style={[s.taskIconWrap, isDone && s.taskIconWrapDone]}>
                                                    <Ionicons
                                                        name={meta.icon as any}
                                                        size={16}
                                                        color={isDone ? colors.bg : colors.textSecondary}
                                                    />
                                                </View>
                                                <View style={s.taskBody}>
                                                    <Text style={[s.taskTitle, isDone && s.taskTitleDone]}>{task.title}</Text>
                                                    <View style={s.metaRow}>
                                                        <View style={s.metaChip}>
                                                            <Ionicons name="time-outline" size={13} color={colors.textMuted} />
                                                            <Text style={s.metaText}>{task.time}</Text>
                                                        </View>
                                                        <View style={s.metaChip}>
                                                            <Ionicons name="pricetag-outline" size={13} color={colors.textMuted} />
                                                            <Text style={s.metaText}>{meta.label}</Text>
                                                        </View>
                                                    </View>
                                                </View>
                                                <View style={[s.statusPill, isDone ? s.statusPillDone : s.statusPillPending]}>
                                                    <Ionicons
                                                        name={isDone ? 'checkmark-done-outline' : 'hourglass-outline'}
                                                        size={12}
                                                        color={isDone ? colors.bg : colors.textSecondary}
                                                    />
                                                    <Text style={[s.statusText, isDone ? s.statusTextDone : s.statusTextPending]}>
                                                        {isDone ? 'Done' : 'Pending'}
                                                    </Text>
                                                </View>
                                            </View>

                                            <View style={s.actionsRow}>
                                                <TouchableOpacity
                                                    style={[s.toggleBtn, isDone && s.toggleBtnDone]}
                                                    onPress={() => toggleTask(task.id)}
                                                    activeOpacity={0.9}
                                                >
                                                    <Ionicons
                                                        name={isDone ? 'arrow-undo-outline' : 'checkmark-outline'}
                                                        size={15}
                                                        color={isDone ? colors.textPrimary : colors.bg}
                                                    />
                                                    <Text style={[s.toggleBtnText, isDone && s.toggleBtnTextDone]}>
                                                        {isDone ? 'Mark Pending' : 'Mark Done'}
                                                    </Text>
                                                </TouchableOpacity>

                                                <TouchableOpacity
                                                    style={s.deleteBtn}
                                                    onPress={() => deleteTask(task.id)}
                                                    activeOpacity={0.85}
                                                >
                                                    <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                                                </TouchableOpacity>
                                            </View>
                                        </View>
                                    );
                                })}
                            </View>
                        )}
                    </ScrollView>
                </KeyboardAvoidingView>
            )}
        </Screen>
    );
}

const s = StyleSheet.create({
    flex: {
        flex: 1,
    },
    headerAction: {
        width: 34,
        height: 34,
        borderRadius: 17,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadingWrap: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: spacing.xxl,
        gap: spacing.md,
    },
    heroCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.lg,
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
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.full,
    },
    heroBadgeText: {
        color: colors.primary,
        fontSize: fonts.sizes.sm,
        fontWeight: '600',
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
        borderRadius: radius.full,
        backgroundColor: colors.primary,
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
        marginTop: 2,
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
    },
    filtersRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
    },
    filterChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        backgroundColor: colors.bgSecondary,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.full,
        paddingVertical: 7,
        paddingHorizontal: spacing.md,
    },
    filterChipActive: {
        borderColor: colors.primary,
        backgroundColor: colors.surface,
    },
    filterChipText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.xs,
        fontWeight: '500',
    },
    filterChipTextActive: {
        color: colors.textPrimary,
        fontWeight: '600',
    },
    filterCount: {
        minWidth: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    filterCountActive: {
        backgroundColor: colors.primary,
    },
    filterCountText: {
        color: colors.textMuted,
        fontSize: 10,
        fontWeight: '600',
    },
    filterCountTextActive: {
        color: colors.bg,
    },
    composerCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.md,
        gap: spacing.md,
    },
    composerTitle: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
    },
    inputWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.md,
        backgroundColor: colors.surface,
        paddingHorizontal: spacing.md,
    },
    input: {
        flex: 1,
        color: colors.textPrimary,
        paddingVertical: 12,
        fontSize: fonts.sizes.md,
    },
    typeRow: {
        flexDirection: 'row',
        gap: spacing.xs,
    },
    typeChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.full,
        backgroundColor: colors.surface,
        paddingHorizontal: spacing.md,
        paddingVertical: 8,
    },
    typeChipActive: {
        borderColor: colors.primary,
        backgroundColor: colors.bg,
    },
    typeChipText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.xs,
        fontWeight: '500',
    },
    typeChipTextActive: {
        color: colors.primary,
        fontWeight: '600',
    },
    timeRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    timeLabel: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        marginRight: spacing.sm,
    },
    timeInput: {
        width: 50,
        height: 42,
        borderRadius: radius.md,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        color: colors.textPrimary,
        textAlign: 'center',
        fontSize: fonts.sizes.md,
    },
    timeSep: {
        color: colors.textMuted,
        marginHorizontal: spacing.sm,
        fontSize: fonts.sizes.lg,
    },
    saveBtn: {
        marginTop: spacing.xs,
        backgroundColor: colors.white,
        borderRadius: radius.full,
        paddingVertical: spacing.md,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: spacing.xs,
    },
    saveBtnText: {
        color: colors.bg,
        fontSize: fonts.sizes.sm,
        fontWeight: '600',
    },
    emptyCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.xl,
        alignItems: 'center',
    },
    emptyTitle: {
        marginTop: spacing.md,
        color: colors.textPrimary,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
    },
    emptySub: {
        marginTop: spacing.xs,
        color: colors.textMuted,
        fontSize: fonts.sizes.sm,
        textAlign: 'center',
        lineHeight: 20,
    },
    emptyAction: {
        marginTop: spacing.lg,
        backgroundColor: colors.white,
        borderRadius: radius.full,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    emptyActionText: {
        color: colors.bg,
        fontSize: fonts.sizes.sm,
        fontWeight: '600',
    },
    listWrap: {
        gap: spacing.sm,
    },
    taskCard: {
        backgroundColor: colors.bgSecondary,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.md,
    },
    taskCardDone: {
        borderColor: colors.borderLight,
    },
    taskTop: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm,
    },
    taskIconWrap: {
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    taskIconWrapDone: {
        backgroundColor: colors.primary,
        borderColor: colors.primary,
    },
    taskBody: {
        flex: 1,
    },
    taskTitle: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
    },
    taskTitleDone: {
        color: colors.textSecondary,
        textDecorationLine: 'line-through',
    },
    metaRow: {
        marginTop: spacing.xs,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.xs,
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
    metaText: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
    },
    statusPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: radius.full,
        paddingHorizontal: spacing.sm,
        paddingVertical: 6,
    },
    statusPillPending: {
        backgroundColor: colors.surface,
    },
    statusPillDone: {
        backgroundColor: colors.primary,
    },
    statusText: {
        fontSize: 10,
        fontWeight: '600',
    },
    statusTextPending: {
        color: colors.textSecondary,
    },
    statusTextDone: {
        color: colors.bg,
    },
    actionsRow: {
        marginTop: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
    },
    toggleBtn: {
        flex: 1,
        backgroundColor: colors.white,
        borderRadius: radius.full,
        paddingVertical: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: spacing.xs,
    },
    toggleBtnDone: {
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
    },
    toggleBtnText: {
        color: colors.bg,
        fontSize: fonts.sizes.xs,
        fontWeight: '600',
    },
    toggleBtnTextDone: {
        color: colors.textPrimary,
    },
    deleteBtn: {
        width: 38,
        height: 38,
        borderRadius: 19,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
