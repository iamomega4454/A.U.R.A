import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import api from '../../src/services/api';
import Screen from '../../src/components/Screen';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SEVERITY_OPTIONS = [
  { key: 'Mild', label: 'Mild', desc: 'Mostly independent', icon: 'sunny-outline' },
  { key: 'Moderate', label: 'Moderate', desc: 'Some daily support', icon: 'partly-sunny-outline' },
  { key: 'High Support', label: 'High Support', desc: 'Continuous care', icon: 'cloudy-outline' },
];

//------This Function handles the Caregiver Onboarding Intake Screen---------
export default function CaregiverOnboardingIntakeScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [patientUid, setPatientUid] = useState<string>('');
  const [linkedPatients, setLinkedPatients] = useState<{ uid: string; name?: string }[]>([]);

  const [condition, setCondition] = useState('');
  const [severity, setSeverity] = useState('Moderate');
  const [diagnosisDate, setDiagnosisDate] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    loadLinkedPatients();
  }, []);

  const canContinue = useMemo(() => {
    return Boolean(patientUid && condition.trim() && severity.trim());
  }, [patientUid, condition, severity]);

  //------This Function handles the Load Linked Patients---------
  async function loadLinkedPatients() {
    try {
      const res = await api.get('/auth/me');
      const me = res.data;
      const linked = Array.isArray(me.linked_patients) ? me.linked_patients : [];
      const patients = linked.map((uid: string) => ({ uid, name: undefined }));
      setLinkedPatients(patients);
      setPatientUid(linked[0] || '');
    } catch {
      setLinkedPatients([]);
      setPatientUid('');
    } finally {
      setLoading(false);
    }
  }

  //------This Function handles the Continue To Medications---------
  async function handleContinue() {
    if (!canContinue) {
      Alert.alert('Required', 'Please select a patient and enter their condition.');
      return;
    }
    await AsyncStorage.setItem('caregiver_intake_draft', JSON.stringify({
      patient_uid: patientUid,
      condition: condition.trim(),
      severity,
      diagnosis_date: diagnosisDate.trim() || null,
      notes: notes.trim(),
    }));
    router.push('/(onboarding)/caregiver-meds');
  }

  if (loading) {
    return (
      <Screen>
        <View style={s.loadingWrap}>
          <ActivityIndicator size="large" color={colors.white} />
        </View>
      </Screen>
    );
  }

  if (!linkedPatients.length) {
    return (
      <Screen>
        <View style={s.emptyWrap}>
          <View style={s.emptyIconWrap}>
            <Ionicons name="warning-outline" size={36} color={colors.red} />
          </View>
          <Text style={s.emptyTitle}>No patient linked yet</Text>
          <Text style={s.emptySub}>Link a patient to your account first, then come back to complete your setup.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>

        <View style={s.progressWrap}>
          <View style={s.progressBar}>
            <View style={[s.progressFill, { width: '50%' }]} />
          </View>
          <Text style={s.progressLabel}>1 of 2</Text>
        </View>

        <View style={s.headerBlock}>
          <View style={s.badge}>
            <Ionicons name="medical-outline" size={14} color={colors.textMuted} />
            <Text style={s.badgeText}>Caregiver Setup</Text>
          </View>
          <Text style={s.title}>Patient Information</Text>
          <Text style={s.subtitle}>This helps Orito support your patient safely and effectively.</Text>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="person-outline" size={18} color={colors.textMuted} />
            <Text style={s.sectionTitle}>Who are you caring for?</Text>
          </View>
          <View style={s.patientGrid}>
            {linkedPatients.map((p) => (
              <Pressable
                key={p.uid}
                style={({ pressed }) => [s.patientCard, patientUid === p.uid && s.patientCardActive, pressed && s.pressedDown]}
                onPress={() => setPatientUid(p.uid)}
              >
                <View style={[s.patientAvatar, patientUid === p.uid && s.patientAvatarActive]}>
                  <Ionicons name="person" size={20} color={patientUid === p.uid ? colors.bg : colors.textSecondary} />
                </View>
                <Text style={[s.patientUidText, patientUid === p.uid && s.patientUidTextActive]} numberOfLines={1}>
                  {p.name ?? `Patient ${p.uid.slice(0, 8)}...`}
                </Text>
                {patientUid === p.uid && (
                  <View style={s.selectedDot} />
                )}
              </Pressable>
            ))}
          </View>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="document-text-outline" size={18} color={colors.textMuted} />
            <Text style={s.sectionTitle}>Medical background</Text>
          </View>

          <Text style={s.fieldLabel}>CONDITION</Text>
          <TextInput
            style={s.input}
            value={condition}
            onChangeText={setCondition}
            placeholder="e.g. Alzheimer's disease, Dementia, Parkinson's..."
            placeholderTextColor={colors.textMuted}
          />

          <Text style={s.fieldLabel}>LEVEL OF SUPPORT NEEDED</Text>
          <View style={s.severityGrid}>
            {SEVERITY_OPTIONS.map((item) => {
              const active = severity === item.key;
              return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [s.severityCard, active && s.severityCardActive, pressed && s.pressedDown]}
                  onPress={() => setSeverity(item.key)}
                >
                  <Ionicons name={item.icon as any} size={18} color={active ? colors.bg : colors.textSecondary} />
                  <Text style={[s.severityLabel, active && s.severityLabelActive]}>{item.label}</Text>
                  <Text style={[s.severityDesc, active && s.severityDescActive]}>{item.desc}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={s.fieldLabel}>DIAGNOSIS DATE (OPTIONAL)</Text>
          <TextInput
            style={s.input}
            value={diagnosisDate}
            onChangeText={setDiagnosisDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="alert-circle-outline" size={18} color={colors.textMuted} />
            <Text style={s.sectionTitle}>Critical care notes</Text>
          </View>
          <Text style={s.hint}>Allergies, triggers, emergency considerations — anything Orito must know</Text>
          <TextInput
            style={[s.input, s.notesInput]}
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. Allergic to penicillin, falls risk, call daughter first in emergencies..."
            placeholderTextColor={colors.textMuted}
            multiline
            textAlignVertical="top"
          />
        </View>

        <Pressable
          style={({ pressed }) => [s.primaryBtn, !canContinue && s.primaryBtnDisabled, pressed && canContinue && s.primaryBtnPressed]}
          onPress={handleContinue}
          disabled={!canContinue}
        >
          <Text style={s.primaryBtnText}>Continue to Medications</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.bg} />
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
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: spacing.xs,
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
    minHeight: 100,
    paddingTop: 13,
    textAlignVertical: 'top',
  },
  patientGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  patientCard: {
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgTertiary,
    minWidth: 100,
    position: 'relative',
  },
  patientCardActive: {
    borderColor: colors.white,
  },
  patientAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  patientAvatarActive: {
    backgroundColor: colors.white,
    borderColor: colors.white,
  },
  patientUidText: {
    color: colors.textSecondary,
    fontSize: fonts.sizes.xs,
    fontWeight: '600',
    maxWidth: 90,
    textAlign: 'center',
  },
  patientUidTextActive: {
    color: colors.textPrimary,
  },
  selectedDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.white,
  },
  severityGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  severityCard: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgTertiary,
  },
  severityCardActive: {
    borderColor: colors.white,
    backgroundColor: colors.white,
  },
  severityLabel: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  severityLabelActive: {
    color: colors.bg,
  },
  severityDesc: {
    color: colors.textMuted,
    fontSize: 10,
    textAlign: 'center',
  },
  severityDescActive: {
    color: colors.bgTertiary,
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
    opacity: 0.45,
  },
  primaryBtnPressed: {
    opacity: 0.85,
  },
  primaryBtnText: {
    color: colors.bg,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.redLight,
    borderWidth: 1,
    borderColor: colors.redGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizes.lg,
    fontWeight: '700',
  },
  emptySub: {
    color: colors.textSecondary,
    fontSize: fonts.sizes.md,
    textAlign: 'center',
    lineHeight: 22,
  },
});
