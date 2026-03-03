import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useAuth } from '../../src/context/auth';

let Notifications: any = null;

try {
  Notifications = require('expo-notifications');
} catch {
}

import Screen from '../../src/components/Screen';
import { colors, fonts, spacing, radius } from '../../src/theme';
import { Ionicons } from '@expo/vector-icons';
import api from '../../src/services/api';

//------This Function handles the Permissions Screen---------
export default function PermissionsScreen() {
  const router = useRouter();
  const { user, refreshUser, markOnboarded } = useAuth();
  const [locationGranted, setLocationGranted] = useState(false);
  const [micGranted, setMicGranted] = useState(false);
  const [notifGranted, setNotifGranted] = useState(false);
  const [cameraGranted, setCameraGranted] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);

  //------This Function handles the Request Location---------
  async function requestLocation() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        setLocationGranted(true);
        if (Platform.OS === 'android') {
          await Location.requestBackgroundPermissionsAsync();
        }
      } else {
        Alert.alert('Permission Needed', 'Location helps with safety, SOS, and caregiver support.');
      }
    } catch {
      Alert.alert('Error', 'Failed to request location permission.');
    }
  }

  //------This Function handles the Request Mic---------
  async function requestMic() {
    try {
      const { status } = await requestRecordingPermissionsAsync();
      if (status === 'granted') {
        setMicGranted(true);
      } else {
        Alert.alert('Permission Needed', 'Microphone enables natural voice help with Orito.');
      }
    } catch {
      Alert.alert('Error', 'Failed to request microphone permission.');
    }
  }

  //------This Function handles the Request Notifications---------
  async function requestNotifications() {
    if (!Notifications) {
      setNotifGranted(true);
      return;
    }

    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus === 'granted') {
        setNotifGranted(true);
        try {
          const projectId = Constants.expoConfig?.extra?.projectId;
          if (projectId) {
            const token = await Notifications.getExpoPushTokenAsync({ projectId });
            await api.post('/notifications/register', { token: token.data });
          }
        } catch {
        }
      } else {
        Alert.alert('Permission Needed', 'Notifications keep reminders and alerts visible.');
      }
    } catch {
      Alert.alert('Error', 'Failed to request notification permission.');
    }
  }

  //------This Function handles the Request Camera---------
  async function requestCamera() {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status === 'granted') {
        setCameraGranted(true);
      } else {
        Alert.alert('Permission Needed', 'Camera supports memory photos and recognition features.');
      }
    } catch {
      Alert.alert('Error', 'Failed to request camera permission.');
    }
  }

  //------This Function handles the Handle Finish---------
  async function handleFinish() {
    setIsCompleting(true);
    try {
      await api.put('/onboarding/complete');
      await refreshUser();
      markOnboarded();
    } catch {
      markOnboarded();
    } finally {
      setIsCompleting(false);
      if (user?.role === 'caregiver') {
        router.replace('/(caregiver)/dashboard');
      } else {
        router.replace('/(patient)/dashboard');
      }
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.headerBlock}>
          <Text style={s.step}>Step 4 of 4</Text>
          <Text style={s.title}>Permissions</Text>
          <Text style={s.subtitle}>Enable what you want now. You can change everything later in settings.</Text>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>Essential</Text>
          <PermissionItem icon="location" title="Location" desc="SOS support and safety tracking" granted={locationGranted} onPress={requestLocation} />
          <PermissionItem icon="mic" title="Microphone" desc="Voice conversations with Orito" granted={micGranted} onPress={requestMic} />
          <PermissionItem icon="notifications" title="Notifications" desc="Reminders and urgent alerts" granted={notifGranted} onPress={requestNotifications} />
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>Optional</Text>
          <PermissionItem icon="camera" title="Camera" desc="Memory and photo features" granted={cameraGranted} onPress={requestCamera} />
        </View>

        <TouchableOpacity style={s.primaryBtn} onPress={handleFinish} disabled={isCompleting} activeOpacity={0.9}>
          {isCompleting ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <>
              <Text style={s.primaryBtnText}>Finish Setup</Text>
              <Ionicons name="checkmark" size={18} color={colors.bg} />
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </Screen>
  );
}

interface PermissionItemProps {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  desc: string;
  granted: boolean;
  onPress: () => void;
}

//------This Function handles the Permission Item---------
function PermissionItem({ icon, title, desc, granted, onPress }: PermissionItemProps) {
  return (
    <TouchableOpacity style={[s.item, granted && s.itemDone]} onPress={onPress} activeOpacity={0.8}>
      <View style={[s.iconBox, granted && s.iconBoxDone]}>
        <Ionicons name={granted ? 'checkmark' : icon} size={20} color={granted ? colors.bg : colors.textPrimary} />
      </View>
      <View style={s.itemText}>
        <Text style={s.itemTitle}>{title}</Text>
        <Text style={s.itemDesc}>{desc}</Text>
      </View>
      {!granted && <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  headerBlock: {
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  step: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 25,
    fontWeight: '700',
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
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  itemDone: {
    borderColor: colors.white,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  iconBoxDone: {
    backgroundColor: colors.white,
  },
  itemText: {
    flex: 1,
    gap: 1,
  },
  itemTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
  },
  itemDesc: {
    color: colors.textSecondary,
    fontSize: fonts.sizes.xs,
  },
  primaryBtn: {
    marginTop: spacing.md,
    height: 54,
    borderRadius: radius.full,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  primaryBtnText: {
    color: colors.bg,
    fontSize: fonts.sizes.md,
    fontWeight: '700',
  },
});
