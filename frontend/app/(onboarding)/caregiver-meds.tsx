import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import api from '../../src/services/api';
import { useAuth } from '../../src/context/auth';
import Screen from '../../src/components/Screen';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface MedEntry {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  times: string;
}

function newMed(): MedEntry {
  return { id: Date.now().toString(), name: '', dosage: '', frequency: '', times: '' };
}

//------This Function handles the Caregiver Medications Setup Screen---------
export default function CaregiverMedicationsScreen() {
  const router = useRouter();
  const { markOnboarded } = useAuth();
  const [medications, setMedications] = useState<MedEntry[]>([newMed()]);
  const [emergencyContact, setEmergencyContact] = useState('');
  const [careNotes, setCareNotes] = useState('');
  const [saving, setSaving] = useState(false);

  //------This Function handles the Update Medication Field---------
  const updateMed = useCallback((id: string, field: keyof MedEntry, value: string) => {
    setMedications(prev => prev.map(m => m.id === id ? { ...m, [field]: value } : m));
  }, []);

  //------This Function handles the Add Medication---------
  function addMed() {
    setMedications(prev => [...prev, newMed()]);
  }

  //------This Function handles the Remove Medication---------
  function removeMed(id: string) {
    setMedications(prev => prev.length > 1 ? prev.filter(m => m.id !== id) : prev);
  }

  //------This Function handles the Parse Times---------
  function parseTimes(input: string): string[] {
    return input
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => {
        const parts = v.split(':');
        if (parts.length !== 2) return v;
        return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
      });
  }

  //------This Function handles the Submit Full Intake---------
  async function handleSubmit() {
    setSaving(true);
    try {
      const draftRaw = await AsyncStorage.getItem('caregiver_intake_draft');
      if (!draftRaw) {
        Alert.alert('Error', 'Patient information not found. Please go back and try again.');
        setSaving(false);
        return;
      }
      const draft = JSON.parse(draftRaw);

      const meds = medications
        .filter(m => m.name.trim())
        .map(m => ({
          name: m.name.trim(),
          dosage: m.dosage.trim(),
          frequency: m.frequency.trim(),
          schedule_times: parseTimes(m.times),
          notes: '',
        }));

      await api.put('/onboarding/caregiver-intake', {
        ...draft,
        medications: meds,
        emergency_contact: emergencyContact.trim() || undefined,
        care_notes: careNotes.trim() || undefined,
      });

      await AsyncStorage.removeItem('caregiver_intake_draft');
      markOnboarded();
      router.replace('/(caregiver)/dashboard');
    } catch (error: any) {
      const msg = error?.response?.data?.detail || 'Could not save care plan. Please try again.';
      Alert.alert('Error', msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>

        <View style={s.progressWrap}>
          <View style={s.progressBar}>
            <View style={[s.progressFill, { width: '100%' }]} />
          </View>
          <Text style={s.progressLabel}>2 of 2</Text>
        </View>

        <View style={s.headerBlock}>
          <View style={s.badge}>
            <Ionicons name="medical-outline" size={14} color={colors.textMuted} />
            <Text style={s.badgeText}>Caregiver Setup</Text>
          </View>
          <Text style={s.title}>Medications & Care Plan</Text>
          <Text style={s.subtitle}>Add their current medications and any ongoing care details. You can always update these later.</Text>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="flask-outline" size={18} color={colors.textMuted} />
            <Text style={s.sectionTitle}>Current medications</Text>
          </View>
          <Text style={s.hint}>Leave the name blank to skip a medication row</Text>

          {medications.map((med, index) => (
            <View key={med.id} style={s.medCard}>
              <View style={s.medCardHeader}>
                <View style={s.medIndexBadge}>
                  <Text style={s.medIndexText}>{index + 1}</Text>
                </View>
                <Text style={s.medCardTitle}>Medication {index + 1}</Text>
                {medications.length > 1 && (
                  <Pressable
                    style={({ pressed }) => [s.removeBtn, pressed && s.pressedDown]}
                    onPress={() => removeMed(med.id)}
                  >
                    <Ionicons name="close" size={16} color={colors.textMuted} />
                  </Pressable>
                )}
              </View>

              <TextInput
                style={s.input}
                value={med.name}
                onChangeText={(v) => updateMed(med.id, 'name', v)}
                placeholder="Medication name"
                placeholderTextColor={colors.textMuted}
              />
              <View style={s.rowInputs}>
                <TextInput
                  style={[s.input, s.halfInput]}
                  value={med.dosage}
                  onChangeText={(v) => updateMed(med.id, 'dosage', v)}
                  placeholder="Dosage (e.g. 10mg)"
                  placeholderTextColor={colors.textMuted}
                />
                <TextInput
                  style={[s.input, s.halfInput]}
                  value={med.frequency}
                  onChangeText={(v) => updateMed(med.id, 'frequency', v)}
                  placeholder="Frequency (e.g. daily)"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
              <TextInput
                style={s.input}
                value={med.times}
                onChangeText={(v) => updateMed(med.id, 'times', v)}
                placeholder="Times, comma-separated (08:00, 20:00)"
                placeholderTextColor={colors.textMuted}
              />
            </View>
          ))}

          <Pressable
            style={({ pressed }) => [s.addMedBtn, pressed && s.pressedDown]}
            onPress={addMed}
          >
            <Ionicons name="add-circle-outline" size={18} color={colors.textSecondary} />
            <Text style={s.addMedText}>Add another medication</Text>
          </Pressable>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="call-outline" size={18} color={colors.textMuted} />
            <Text style={s.sectionTitle}>Emergency contact</Text>
          </View>
          <Text style={s.hint}>Optional — who to call first in an emergency</Text>
          <TextInput
            style={s.input}
            value={emergencyContact}
            onChangeText={setEmergencyContact}
            placeholder="Name & phone number..."
            placeholderTextColor={colors.textMuted}
          />
        </View>

        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="clipboard-outline" size={18} color={colors.textMuted} />
            <Text style={s.sectionTitle}>Ongoing care notes</Text>
          </View>
          <Text style={s.hint}>Optional — routines, therapies, or anything helpful for daily care</Text>
          <TextInput
            style={[s.input, s.notesInput]}
            value={careNotes}
            onChangeText={setCareNotes}
            placeholder="e.g. Physio every Tuesday, speech therapy notes, sleep schedule..."
            placeholderTextColor={colors.textMuted}
            multiline
            textAlignVertical="top"
          />
        </View>

        <Pressable
          style={({ pressed }) => [s.primaryBtn, saving && s.primaryBtnDisabled, pressed && !saving && s.primaryBtnPressed]}
          onPress={handleSubmit}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={colors.bg} size="small" />
          ) : (
            <>
              <Ionicons name="checkmark-circle-outline" size={20} color={colors.bg} />
              <Text style={s.primaryBtnText}>Complete Setup</Text>
            </>
          )}
        </Pressable>

        <Pressable
          style={({ pressed }) => [s.skipBtn, pressed && s.pressedDown]}
          onPress={handleSubmit}
          disabled={saving}
        >
          <Text style={s.skipText}>Skip for now — add medications later</Text>
        </Pressable>

      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
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
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: spacing.xs,
  },
  badgeText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
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
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
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
  notesInput: {
    minHeight: 90,
    paddingTop: 13,
    textAlignVertical: 'top',
  },
  rowInputs: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  halfInput: {
    flex: 1,
  },
  medCard: {
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  medCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  medIndexBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medIndexText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  medCardTitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizes.sm,
    fontWeight: '600',
    flex: 1,
  },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addMedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignSelf: 'flex-start',
  },
  addMedText: {
    color: colors.textSecondary,
    fontSize: fonts.sizes.sm,
    fontWeight: '600',
  },
  pressedDown: {
    opacity: 0.75,
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
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnPressed: {
    opacity: 0.85,
  },
  primaryBtnText: {
    color: colors.bg,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  skipText: {
    color: colors.textMuted,
    fontSize: fonts.sizes.sm,
    fontWeight: '500',
  },
});
