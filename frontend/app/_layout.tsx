import { Stack, useSegments, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { LogBox } from 'react-native';
import { AuthProvider, useAuth } from '../src/context/auth';
import { AuraProvider } from '../src/context/aura';
import { PreferencesProvider } from '../src/context/preferences';
import { colors } from '../src/theme';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ConnectionLost from '../src/components/ConnectionLost';
import SOSAlarmOverlay from '../src/components/SOSAlarmOverlay';
import { notificationService } from '../src/services/notifications';
import { locationService } from '../src/services/location';

LogBox.ignoreLogs([
    'This method is deprecated',
    'React Native Firebase namespaced API',
    'will be removed in the next major release',
    'GoogleSignin not available in Expo Go',
    'Firebase messaging not available in Expo Go',
    'expo-notifications not available in Expo Go',
    'Maximum call stack size exceeded',
    'dnssd-advertise',
    'Request failed with status code 401',
    'THREE.THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.',
    "The screen 'index' was removed natively but didn't get removed from JS state",
]);

//------This Function handles the Root Layout Content---------
function RootLayoutContent() {
    const { connectionError, loading, user, initialLoadDone } = useAuth();
    const segments = useSegments();
    const router = useRouter();

    useEffect(() => {
        if (loading || !initialLoadDone) return;
        if (connectionError) return;

        // Let index.tsx (splash screen) handle its own routing on first load
        if ((segments as string[]).length === 0 || segments[0] === undefined) return;

        const inAuthGroup = segments[0] === '(auth)';
        const inOnboardingGroup = segments[0] === '(onboarding)';
        const needsOnboarding = Boolean(user && !user.is_onboarded && (user.role === 'patient' || user.role === 'caregiver'));

        if (!user && !inAuthGroup) {
            router.replace('/(auth)/login');
        }
        else if (needsOnboarding && !inOnboardingGroup) {
            if (user?.role === 'caregiver') {
                router.replace('/(onboarding)/caregiver');
            } else {
                router.replace('/(onboarding)/illness');
            }
        }
        else if (user && inAuthGroup) {
            if (user.role === 'caregiver') {
                router.replace('/(caregiver)/dashboard');
            } else if (user.role === 'admin') {
                router.replace('/(admin)/dashboard');
            } else {
                router.replace('/(patient)/dashboard');
            }
        }
    }, [user, segments, loading, initialLoadDone, connectionError]);

    useEffect(() => {
        if (user && user.is_onboarded) {
            notificationService.initialize();

            if (user.role === 'patient') {
                locationService.startTracking();
            }
        }
    }, [user]);

    if (!loading && connectionError) {
        return <ConnectionLost />;
    }

    return (
        <AuraProvider>
            <StatusBar style="light" backgroundColor={colors.bg} />
            <Stack
                screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                    animation: 'fade',
                }}
            />
            <SOSAlarmOverlay />
        </AuraProvider>
    );
}

//------This Function handles the Root Layout---------
export default function RootLayout() {
    return (
        <AuthProvider>
            <PreferencesProvider>
                <SafeAreaProvider>
                    <RootLayoutContent />
                </SafeAreaProvider>
            </PreferencesProvider>
        </AuthProvider>
    );
}
