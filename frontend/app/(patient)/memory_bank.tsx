import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
    View, Text, StyleSheet, FlatList, TouchableOpacity, Image,
    TextInput, ScrollView, Alert, SectionList,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/context/auth';
import * as Haptics from 'expo-haptics';
import api from '../../src/services/api';
import Screen from '../../src/components/Screen';
import PatientHeader from '../../src/components/PatientHeader';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';

interface Relative {
    id: string;
    name: string;
    relationship: string;
    photos: string[];
}

interface JournalEntry {
    id: string;
    content: string;
    created_at: string;
}

interface Suggestion {
    id: string;
    title: string;
    description: string;
    type: string;
    created_at: string;
}

type FilterType = 'All' | 'People' | 'Journal' | 'AI Insights';

const FILTERS: FilterType[] = ['All', 'People', 'Journal', 'AI Insights'];

const TYPE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
    journal: 'document-text-outline',
    ai: 'sparkles-outline',
    medication: 'medkit-outline',
    activity: 'walk-outline',
};

interface MemoryItem {
    id: string;
    type: 'journal' | 'ai' | 'medication' | 'activity';
    title: string;
    content: string;
    date: Date;
    dateStr: string;
}

//------This Function handles the Get Initials---------
function getInitials(name: string): string {
    return name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
}

//------This Function handles the Group By Date---------
function groupByDate(items: MemoryItem[]): { title: string; data: MemoryItem[] }[] {
    const groups: Record<string, MemoryItem[]> = {};
    for (const item of items) {
        const key = item.date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
    }
    return Object.entries(groups).map(([title, data]) => ({ title, data }));
}

//------This Function handles the Memory Bank Screen---------
export default function MemoryBankScreen() {
    const router = useRouter();
    const { user } = useAuth();

    const [relatives, setRelatives] = useState<Relative[]>([]);
    const [journals, setJournals] = useState<JournalEntry[]>([]);
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [loading, setLoading] = useState(true);

    const [searchText, setSearchText] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [activeFilter, setActiveFilter] = useState<FilterType>('All');
    const [sortNewest, setSortNewest] = useState(true);

    const [expandedPersonId, setExpandedPersonId] = useState<string | null>(null);
    const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);



    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => {
            setDebouncedSearch(searchText);
        }, 300);
        return () => {
            if (searchTimer.current) clearTimeout(searchTimer.current);
        };
    }, [searchText]);

    useEffect(() => {
        loadData();
    }, []);

    //------This Function handles the Load Data---------
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [relsRes, journalRes, suggestionsRes] = await Promise.all([
                api.get('/relatives/'),
                api.get('/journal/'),
                api.get('/suggestions/active').catch(() => ({ data: [] })),
            ]);
            setRelatives(relsRes.data || []);
            setJournals(journalRes.data || []);
            setSuggestions(suggestionsRes.data || []);
        } catch (error: any) {
            if (error?.response?.status === 401) {
                console.error('[MemoryBank] Authentication failed - token may be expired');
            } else {
                console.error('[MemoryBank] Failed to load:', error);
                Alert.alert('Error', 'Failed to load memory bank data');
            }
        } finally {
            setLoading(false);
        }
    }, []);


    //------This Function handles the All Memories---------
    const allMemories = useMemo<MemoryItem[]>(() => {
        const items: MemoryItem[] = [];

        for (const j of journals) {
            items.push({
                id: `j-${j.id}`,
                type: 'journal',
                title: j.content.slice(0, 60) + (j.content.length > 60 ? '…' : ''),
                content: j.content,
                date: new Date(j.created_at),
                dateStr: new Date(j.created_at).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                }),
            });
        }

        for (const s of suggestions) {
            items.push({
                id: `s-${s.id}`,
                type: 'ai',
                title: s.title || s.description.slice(0, 60),
                content: s.description,
                date: new Date(s.created_at),
                dateStr: new Date(s.created_at).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                }),
            });
        }

        items.sort((a, b) => sortNewest
            ? b.date.getTime() - a.date.getTime()
            : a.date.getTime() - b.date.getTime()
        );

        return items;
    }, [journals, suggestions, sortNewest]);


    //------This Function handles the Filtered Relatives---------
    const filteredRelatives = useMemo(() => {
        if (activeFilter !== 'All' && activeFilter !== 'People') return [];
        const q = debouncedSearch.toLowerCase();
        if (!q) return relatives;
        return relatives.filter(
            (r) => r.name.toLowerCase().includes(q) || r.relationship.toLowerCase().includes(q)
        );
    }, [relatives, debouncedSearch, activeFilter]);

    //------This Function handles the Filtered Memories---------
    const filteredMemories = useMemo(() => {
        let items = allMemories;
        if (activeFilter === 'Journal') items = items.filter((m) => m.type === 'journal');
        else if (activeFilter === 'AI Insights') items = items.filter((m) => m.type === 'ai');
        else if (activeFilter === 'People') return [];

        const q = debouncedSearch.toLowerCase();
        if (q) {
            items = items.filter(
                (m) => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)
            );
        }
        return items;
    }, [allMemories, debouncedSearch, activeFilter]);

    //------This Function handles the Grouped Memories---------
    const groupedMemories = useMemo(() => groupByDate(filteredMemories), [filteredMemories]);


    //------This Function handles the Stats---------
    const stats = useMemo(() => {
        const uniqueDays = new Set(
            journals.map((j) => new Date(j.created_at).toDateString())
        );
        return {
            memories: journals.length + suggestions.length,
            people: relatives.length,
            daysActive: uniqueDays.size,
        };
    }, [journals, suggestions, relatives]);

    //------This Function handles the Has No Results---------
    const hasNoResults = useMemo(() => {
        return debouncedSearch.length > 0 && filteredRelatives.length === 0 && filteredMemories.length === 0;
    }, [debouncedSearch, filteredRelatives, filteredMemories]);


    //------This Function handles the Expanded Person---------
    const expandedPerson = useMemo(() => {
        if (!expandedPersonId) return null;
        //------This Function handles the Person---------
        const person = relatives.find((r) => r.id === expandedPersonId);
        if (!person) return null;
        //------This Function handles the Mentioning Entries---------
        const mentioningEntries = journals.filter((j) =>
            j.content.toLowerCase().includes(person.name.toLowerCase())
        );
        return { person, mentioningEntries };
    }, [expandedPersonId, relatives, journals]);



    //------This Function handles the Toggle Sort---------
    const toggleSort = useCallback(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setSortNewest((prev) => !prev);
    }, []);

    //------This Function handles the Render Person Card---------
    const renderPersonCard = useCallback(({ item }: { item: Relative | 'add' }) => {
        if (item === 'add') {
            return (
                <TouchableOpacity
                    style={s.personCard}
                    onPress={() => router.push('/(patient)/relatives')}
                >
                    <View style={[s.personAvatar, s.addPersonAvatar]}>
                        <Ionicons name="add" size={28} color={colors.textSecondary} />
                    </View>
                    <Text style={s.personName} numberOfLines={1}>Add Person</Text>
                </TouchableOpacity>
            );
        }

        const isExpanded = expandedPersonId === item.id;
        return (
            <TouchableOpacity
                style={s.personCard}
                onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setExpandedPersonId(isExpanded ? null : item.id);
                }}
            >
                <View style={[s.personAvatar, isExpanded && s.personAvatarActive]}>
                    {item.photos?.[0] ? (
                        <Image source={{ uri: item.photos[0] }} style={s.personPhoto} />
                    ) : (
                        <Text style={s.personInitials}>{getInitials(item.name)}</Text>
                    )}
                </View>
                <Text style={s.personName} numberOfLines={1}>{item.name}</Text>
                <Text style={s.personRelation} numberOfLines={1}>{item.relationship}</Text>
            </TouchableOpacity>
        );
    }, [expandedPersonId, router]);

    //------This Function handles the Render Memory Item---------
    const renderMemoryItem = useCallback(({ item }: { item: MemoryItem }) => {
        const isExpanded = expandedMemoryId === item.id;
        return (
            <TouchableOpacity
                style={s.memoryCard}
                onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setExpandedMemoryId(isExpanded ? null : item.id);
                }}
                activeOpacity={0.7}
            >
                <View style={s.memoryRow}>
                    <View style={s.memoryIconContainer}>
                        <Ionicons
                            name={(TYPE_ICONS[item.type] || 'document-text-outline') as keyof typeof Ionicons.glyphMap}
                            size={20}
                            color={colors.primary}
                        />
                    </View>
                    <View style={s.memoryContent}>
                        <Text style={s.memoryTitle} numberOfLines={isExpanded ? undefined : 2}>
                            {item.title}
                        </Text>
                        <Text style={s.memoryDate}>{item.dateStr}</Text>
                        {isExpanded && item.content !== item.title && (
                            <Text style={s.memoryFull}>{item.content}</Text>
                        )}
                    </View>
                    <Ionicons
                        name={isExpanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={colors.textMuted}
                    />
                </View>
            </TouchableOpacity>
        );
    }, [expandedMemoryId]);

    //------This Function handles the Render Section Header---------
    const renderSectionHeader = useCallback(({ section }: { section: { title: string } }) => (
        <View style={s.sectionHeader}>
            <View style={s.timelineDot} />
            <Text style={s.sectionHeaderText}>{section.title}</Text>
        </View>
    ), []);

    const peopleData = useMemo(
        () => [...filteredRelatives, 'add' as const],
        [filteredRelatives]
    );

    if (loading) {
        return (
            <Screen>
                <View style={s.loadingContainer}>
                    <Text style={s.loadingText}>Loading memories…</Text>
                </View>
            </Screen>
        );
    }

    return (
        <Screen>
            { }
            <PatientHeader showRightIcon={false} />

            <View style={s.titleContainer}>
                <Text style={s.pageTitle}>Memory Bank</Text>
            </View>

            { }
            <View style={s.searchContainer}>
                <Ionicons name="search" size={18} color={colors.textMuted} style={s.searchIcon} />
                <TextInput
                    style={s.searchInput}
                    placeholder="Search memories, people…"
                    placeholderTextColor={colors.textMuted}
                    value={searchText}
                    onChangeText={setSearchText}
                    returnKeyType="search"
                />
                {searchText.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchText('')}>
                        <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                )}
            </View>

            { }
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterRow} contentContainerStyle={s.filterRowContent}>
                {FILTERS.map((f) => (
                    <TouchableOpacity
                        key={f}
                        style={[s.filterChip, activeFilter === f && s.filterChipActive]}
                        onPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            setActiveFilter(f);
                        }}
                    >
                        <Text style={[s.filterChipText, activeFilter === f && s.filterChipTextActive]}>
                            {f}
                        </Text>
                    </TouchableOpacity>
                ))}
            </ScrollView>

            { }
            <View style={s.statsBar}>
                <Text style={s.statsText}>
                    {stats.memories} Memories • {stats.people} People • {stats.daysActive} Days Active
                </Text>
            </View>

            {hasNoResults ? (
                <View style={s.emptyState}>
                    <Ionicons name="search-outline" size={48} color={colors.textMuted} />
                    <Text style={s.emptyStateText}>No results found</Text>
                    <Text style={s.emptyStateSubtext}>Try a different search term</Text>
                </View>
            ) : (
                <SectionList
                    sections={groupedMemories}
                    keyExtractor={(item) => item.id}
                    renderItem={renderMemoryItem}
                    renderSectionHeader={renderSectionHeader}
                    stickySectionHeadersEnabled={false}
                    contentContainerStyle={s.listContent}
                    ListHeaderComponent={
                        <>
                            { }
                            {(activeFilter === 'All' || activeFilter === 'People') && filteredRelatives.length > 0 && (
                                <View style={s.peopleSection}>
                                    <Text style={s.sectionTitle}>People</Text>
                                    <FlatList
                                        data={peopleData}
                                        renderItem={renderPersonCard as any}
                                        keyExtractor={(item) => (typeof item === 'string' ? 'add' : item.id)}
                                        horizontal
                                        showsHorizontalScrollIndicator={false}
                                        contentContainerStyle={s.peopleList}
                                    />

                                    { }
                                    {expandedPerson && (
                                        <View style={s.expandedPerson}>
                                            <Text style={s.expandedPersonName}>{expandedPerson.person.name}</Text>
                                            <Text style={s.expandedPersonRelation}>{expandedPerson.person.relationship}</Text>

                                            {expandedPerson.person.photos.length > 0 && (
                                                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.photoRow}>
                                                    {expandedPerson.person.photos.map((photo, idx) => (
                                                        <Image key={idx} source={{ uri: photo }} style={s.expandedPhoto} />
                                                    ))}
                                                </ScrollView>
                                            )}

                                            {expandedPerson.mentioningEntries.length > 0 ? (
                                                <View style={s.mentionSection}>
                                                    <Text style={s.mentionTitle}>
                                                        Mentioned in {expandedPerson.mentioningEntries.length} journal{expandedPerson.mentioningEntries.length !== 1 ? 's' : ''}
                                                    </Text>
                                                    {expandedPerson.mentioningEntries.slice(0, 3).map((entry) => (
                                                        <Text key={entry.id} style={s.mentionText} numberOfLines={2}>
                                                            {entry.content}
                                                        </Text>
                                                    ))}
                                                </View>
                                            ) : (
                                                <Text style={s.noMentions}>No journal mentions yet</Text>
                                            )}
                                        </View>
                                    )}
                                </View>
                            )}

                            { }
                            {(activeFilter === 'All' || activeFilter === 'People') && filteredRelatives.length === 0 && !debouncedSearch && (
                                <View style={s.peopleSection}>
                                    <Text style={s.sectionTitle}>People</Text>
                                    <TouchableOpacity
                                        style={s.addPersonBanner}
                                        onPress={() => router.push('/(patient)/relatives')}
                                    >
                                        <Ionicons name="person-add-outline" size={24} color={colors.textSecondary} />
                                        <Text style={s.addPersonBannerText}>Add your first person</Text>
                                    </TouchableOpacity>
                                </View>
                            )}

                            { }
                            {activeFilter !== 'People' && filteredMemories.length > 0 && (
                                <View style={s.timelineHeader}>
                                    <Text style={s.sectionTitle}>Memories</Text>
                                    <TouchableOpacity style={s.sortBtn} onPress={toggleSort}>
                                        <Ionicons name="swap-vertical" size={14} color={colors.textSecondary} />
                                        <Text style={s.sortText}>
                                            {sortNewest ? 'Newest' : 'Oldest'}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </>
                    }
                    ListEmptyComponent={
                        activeFilter !== 'People' && !debouncedSearch ? (
                            <View style={s.emptyState}>
                                <Ionicons name="book-outline" size={48} color={colors.textMuted} />
                                <Text style={s.emptyStateText}>No memories yet</Text>
                                <Text style={s.emptyStateSubtext}>Your journal entries will appear here</Text>
                            </View>
                        ) : null
                    }
                />
            )}


        </Screen>
    );
}

const s = StyleSheet.create({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: spacing.md,
    },
    loadingText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
    },


    titleContainer: {
        paddingHorizontal: spacing.md,
        marginBottom: spacing.md,
    },
    pageTitle: {
        color: colors.white,
        fontSize: fonts.sizes.xxl,
        fontWeight: '600',
    },


    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        marginHorizontal: spacing.md,
        paddingHorizontal: spacing.md,
        height: 44,
    },
    searchIcon: {
        marginRight: spacing.sm,
    },
    searchInput: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fonts.sizes.md,
        height: '100%',
    },


    filterRow: {
        maxHeight: 44,
        marginTop: spacing.sm,
    },
    filterRowContent: {
        paddingHorizontal: spacing.md,
        gap: spacing.sm,
    },
    filterChip: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bg,
    },
    filterChipActive: {
        backgroundColor: colors.white,
        borderColor: colors.white,
    },
    filterChipText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
        fontWeight: '600',
    },
    filterChipTextActive: {
        color: colors.bg,
    },


    statsBar: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        marginTop: spacing.xs,
    },
    statsText: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        textAlign: 'center',
    },


    peopleSection: {
        marginBottom: spacing.md,
    },
    sectionTitle: {
        color: colors.white,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
        paddingHorizontal: spacing.md,
        marginBottom: spacing.sm,
    },
    peopleList: {
        paddingHorizontal: spacing.md,
        gap: spacing.md,
    },
    personCard: {
        alignItems: 'center',
        width: 72,
    },
    personAvatar: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.borderLight,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
    },
    personAvatarActive: {
        borderColor: colors.white,
        borderWidth: 2,
    },
    addPersonAvatar: {
        borderStyle: 'dashed',
    },
    personPhoto: {
        width: '100%',
        height: '100%',
    },
    personInitials: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
    },
    personName: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.xs,
        marginTop: spacing.xs,
        textAlign: 'center',
    },
    personRelation: {
        color: colors.textMuted,
        fontSize: 10,
        textAlign: 'center',
    },


    expandedPerson: {
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        marginHorizontal: spacing.md,
        marginTop: spacing.sm,
        padding: spacing.md,
        borderWidth: 1,
        borderColor: colors.border,
    },
    expandedPersonName: {
        color: colors.white,
        fontSize: fonts.sizes.lg,
        fontWeight: '600',
    },
    expandedPersonRelation: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
        marginBottom: spacing.sm,
    },
    photoRow: {
        marginBottom: spacing.sm,
    },
    expandedPhoto: {
        width: 80,
        height: 80,
        borderRadius: radius.sm,
        marginRight: spacing.sm,
    },
    mentionSection: {
        marginTop: spacing.xs,
    },
    mentionTitle: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.xs,
        fontWeight: '600',
        marginBottom: spacing.xs,
    },
    mentionText: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.sm,
        marginBottom: spacing.xs,
        paddingLeft: spacing.sm,
        borderLeftWidth: 2,
        borderLeftColor: colors.borderLight,
    },
    noMentions: {
        color: colors.textMuted,
        fontSize: fonts.sizes.sm,
        fontStyle: 'italic',
    },

    addPersonBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        borderStyle: 'dashed',
        marginHorizontal: spacing.md,
        padding: spacing.md,
    },
    addPersonBannerText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
    },


    timelineHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingRight: spacing.md,
        marginBottom: spacing.xs,
    },
    sortBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.sm,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    sortText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.xs,
        fontWeight: '600',
    },

    listContent: {
        paddingBottom: 100,
    },

    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
    },
    timelineDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.white,
    },
    sectionHeaderText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.xs,
        fontWeight: '600',
        letterSpacing: 0.5,
    },

    memoryCard: {
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        marginHorizontal: spacing.md,
        marginBottom: spacing.sm,
        padding: spacing.md,
        borderWidth: 1,
        borderColor: colors.border,
    },
    memoryRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm,
    },
    memoryIconContainer: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surfaceLight,
        borderRadius: radius.full,
    },
    memoryContent: {
        flex: 1,
    },
    memoryTitle: {
        color: colors.textPrimary,
        fontSize: fonts.sizes.sm,
        lineHeight: 20,
    },
    memoryDate: {
        color: colors.textMuted,
        fontSize: fonts.sizes.xs,
        marginTop: 2,
    },
    memoryFull: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.sm,
        marginTop: spacing.sm,
        lineHeight: 20,
    },


    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.xxl,
        gap: spacing.sm,
    },
    emptyStateText: {
        color: colors.textSecondary,
        fontSize: fonts.sizes.md,
        fontWeight: '600',
    },
    emptyStateSubtext: {
        color: colors.textMuted,
        fontSize: fonts.sizes.sm,
    },
});



