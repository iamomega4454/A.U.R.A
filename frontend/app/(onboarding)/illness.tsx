import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Platform, KeyboardAvoidingView, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import Screen from '../../src/components/Screen';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const JOY_OPTIONS = [
  { key: 'walks', label: 'Short walks', icon: 'walk-outline' },
  { key: 'music', label: 'Music', icon: 'musical-notes-outline' },
  { key: 'photos', label: 'Old photos', icon: 'images-outline' },
  { key: 'tea', label: 'Tea & coffee', icon: 'cafe-outline' },
  { key: 'prayer', label: 'Prayer & faith', icon: 'heart-outline' },
  { key: 'chat', label: 'Family chats', icon: 'people-outline' },
  { key: 'garden', label: 'Plants & garden', icon: 'leaf-outline' },
  { key: 'stories', label: 'Reading & stories', icon: 'book-outline' },
  { key: 'tv', label: 'Watching TV', icon: 'tv-outline' },
  { key: 'cooking', label: 'Cooking', icon: 'restaurant-outline' },
];

//------This Function handles the Patient Onboarding Welcome Screen---------
export default function PatientOnboardingWelcomeScreen() {
  const router = useRouter();
  const [selectedJoys, setSelectedJoys] = useState<string[]>([]);
  const [preferredName, setPreferredName] = useState('');
  const [importantPeople, setImportantPeople] = useState('');
  const [healthNotes, setHealthNotes] = useState('');

  //------This Function handles the Toggle Joy---------
  function toggleJoy(key: string) {
    setSelectedJoys(prev => prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key]);
  }

  //------This Function handles the Handle Next---------
  async function handleNext() {
    await AsyncStorage.setItem('onboarding_patient_comforts', JSON.stringify(selectedJoys));
    await AsyncStorage.setItem('onboarding_patient_name', preferredName.trim());
    await AsyncStorage.setItem('onboarding_patient_people', importantPeople.trim());
    await AsyncStorage.setItem('onboarding_patient_health_notes', healthNotes.trim());
    router.push('/(onboarding)/medications');
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.flex}>
        <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>

          <View style={s.progressWrap}>
            <View style={s.progressBar}>
              <View style={[s.progressFill, { width: '25%' }]} />
            </View>
            <Text style={s.progressLabel}>1 of 4</Text>
          </View>

          <View style={s.headerBlock}>
            <Text style={s.greeting}>Nice to meet you 👋</Text>
            <Text style={s.title}>Tell us about yourself</Text>
            <Text style={s.subtitle}>This helps Orito feel like a familiar friend, not a stranger.</Text>
          </View>

          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Ionicons name="person-circle-outline" size={20} color={colors.textMuted} />
              <Text style={s.sectionTitle}>What should Orito call you?</Text>
            </View>
            <TextInput
              style={s.input}
              value={preferredName}
              onChangeText={setPreferredName}
              placeholder="Nana, Dad, Maria, John..."
              placeholderTextColor={colors.textMuted}
            />
          </View>

          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Ionicons name="sparkles-outline" size={20} color={colors.textMuted} />
              <Text style={s.sectionTitle}>What brings you joy?</Text>
            </View>
            <Text style={s.hint}>Pick as many as you like — Orito will remember</Text>
            <View style={s.chipGrid}>
              {JOY_OPTIONS.map((item) => {
                const selected = selectedJoys.includes(item.key);
                return (
                  <Pressable
                    key={item.key}
                    style={({ pressed }) => [s.chip, selected && s.chipActive, pressed && s.chipPressed]}
                    onPress={() => toggleJoy(item.key)}
                  >
                    <Ionicons name={item.icon as any} size={15} color={selected ? colors.bg : colors.textSecondary} />
                    <Text style={[s.chipText, selected && s.chipTextActive]}>{item.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Ionicons name="heart-outline" size={20} color={colors.textMuted} />
              <Text style={s.sectionTitle}>Who matters most to you?</Text>
            </View>
            <TextInput
              style={[s.input, s.textArea]}
              value={importantPeople}
              onChangeText={setImportantPeople}
              placeholder="Family, friends, or anyone Orito should know about..."
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Ionicons name="shield-checkmark-outline" size={20} color={colors.textMuted} />
              <Text style={s.sectionTitle}>Anything Orito should keep in mind?</Text>
            </View>
            <Text style={s.hint}>Optional — preferences, sensitivities, or things that help you feel at ease</Text>
            <TextInput
              style={[s.input, s.textArea]}
              value={healthNotes}
              onChangeText={setHealthNotes}
              placeholder="e.g. Prefer quiet mornings, don't like loud sounds..."
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          <Pressable
            style={({ pressed }) => [s.primaryBtn, pressed && s.primaryBtnPressed]}
            onPress={handleNext}
          >
            <Text style={s.primaryBtnText}>Continue</Text>
            <Ionicons name="arrow-forward" size={18} color={colors.bg} />
          </Pressable>

        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  progressWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  progressBar: {
    flex: 1,
    height: 3,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.full,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.white,
    borderRadius: radius.full,
  },
  progressLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  headerBlock: {
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  greeting: {
    color: colors.textSecondary,
    fontSize: fonts.sizes.sm,
    fontWeight: '600',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '700',
    lineHeight: 32,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizes.sm,
    lineHeight: 20,
  },
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
    flex: 1,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fonts.sizes.xs,
    lineHeight: 16,
  },
  input: {
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
    color: colors.textPrimary,
    fontSize: fonts.sizes.md,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: 'top',
    paddingTop: 13,
  },
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 13,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgTertiary,
  },
  chipActive: {
    borderColor: colors.white,
    backgroundColor: colors.white,
  },
  chipPressed: {
    opacity: 0.7,
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.bg,
  },
  primaryBtn: {
    marginTop: spacing.sm,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  primaryBtnPressed: {
    opacity: 0.85,
  },
  primaryBtnText: {
    color: colors.bg,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
  },
});
