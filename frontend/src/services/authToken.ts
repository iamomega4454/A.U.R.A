import AsyncStorage from '@react-native-async-storage/async-storage';

const FIREBASE_TOKEN_STORAGE_KEY = 'firebase_token';

let firebaseAuthModule: any | null | undefined;

//------This Function resolves Firebase Auth only when the native module is available---------
function getFirebaseAuthModule() {
    if (firebaseAuthModule !== undefined) {
        return firebaseAuthModule;
    }

    try {
        firebaseAuthModule = require('@react-native-firebase/auth').default;
    } catch {
        firebaseAuthModule = null;
    }

    return firebaseAuthModule;
}

//------This Function checks whether the token belongs to dev auth---------
export function isDevToken(token: string): boolean {
    return token.startsWith('dev-token-');
}

//------This Function stores the auth token---------
export async function setAuthToken(token: string): Promise<void> {
    await AsyncStorage.setItem(FIREBASE_TOKEN_STORAGE_KEY, token);
}

//------This Function clears the auth token---------
export async function clearAuthToken(): Promise<void> {
    await AsyncStorage.removeItem(FIREBASE_TOKEN_STORAGE_KEY);
}

//------This Function returns a current auth token and refreshes Firebase tokens when possible---------
export async function getAuthToken(forceRefresh: boolean = false): Promise<string | null> {
    const storedToken = await AsyncStorage.getItem(FIREBASE_TOKEN_STORAGE_KEY);
    if (!storedToken) {
        return null;
    }

    if (isDevToken(storedToken)) {
        return storedToken;
    }

    try {
        const firebaseAuth = getFirebaseAuthModule();
        if (!firebaseAuth) {
            return storedToken;
        }

        const currentUser = firebaseAuth()?.currentUser;
        if (!currentUser) {
            return storedToken;
        }

        const refreshedToken = await currentUser.getIdToken(forceRefresh);
        if (refreshedToken && refreshedToken !== storedToken) {
            await AsyncStorage.setItem(FIREBASE_TOKEN_STORAGE_KEY, refreshedToken);
        }

        return refreshedToken || storedToken;
    } catch {
        return storedToken;
    }
}
