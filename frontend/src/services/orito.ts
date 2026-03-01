import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { patientDataService } from './patientData';
import { triggerAuraFaceRecognition } from './aura-discovery';
import { authEvents } from './authEvents';
import { clearAuthToken, getAuthToken, isDevToken } from './authToken';





export class OritoError extends Error {
    constructor(
        message: string,
        public code: string,
        public recoverable: boolean = true,
        public details?: any
    ) {
        super(message);
        this.name = 'OritoError';
    }
}

export const ErrorCodes = {
    NETWORK_ERROR: 'NETWORK_ERROR',
    AURA_OFFLINE: 'AURA_OFFLINE',
    AI_SERVICE_ERROR: 'AI_SERVICE_ERROR',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    TIMEOUT: 'TIMEOUT',
    UNKNOWN: 'UNKNOWN'
} as const;





const RECOVERY_RESPONSES: Record<string, string[]> = {
    [ErrorCodes.NETWORK_ERROR]: [
        "Sorry, I'm having trouble connecting. Let me try again...",
        "My connection seems shaky. One moment please.",
        "I'm having network issues. Let me retry that."
    ],
    [ErrorCodes.AURA_OFFLINE]: [
        "I can't reach the camera module right now. Let me work with text only.",
        "The Aura module appears to be offline, but I'm still here to help!",
        "I'm running in basic mode since the camera isn't available."
    ],
    [ErrorCodes.AI_SERVICE_ERROR]: [
        "I'm having trouble thinking right now. Let me try again.",
        "My AI brain is taking a moment. Please try again.",
        "I'm experiencing some cognitive hiccups. One moment..."
    ],
    [ErrorCodes.TIMEOUT]: [
        "That took longer than expected. Let me try a faster approach.",
        "I timed out waiting for a response. Shall we try again?",
        "That request took too long. Let's try again!"
    ],
    [ErrorCodes.UNKNOWN]: [
        "Something unexpected happened. Let me try again!",
        "That one's got me stumped. Give me another shot!",
        "I glitched a little there. Let's try that again!"
    ]
};

//------This Function handles the Get Recovery Response---------
const getRecoveryResponse = (code: string): string => {
    const responses = RECOVERY_RESPONSES[code] || RECOVERY_RESPONSES[ErrorCodes.UNKNOWN];
    return responses[Math.floor(Math.random() * responses.length)];
};





interface RetryOptions {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    shouldRetry?: (error: any) => boolean;
}

const defaultRetryOptions: RetryOptions = {
    maxRetries: 3,
    initialDelayMs: 500,
    maxDelayMs: 5000,
    shouldRetry: (error: any) => {

        if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return true;
        if (error.status >= 500) return true;
        return false;
    }
};

async function withRetry<T>(
    fn: () => Promise<T>,
    options: Partial<RetryOptions> = {}
): Promise<T> {
    const opts = { ...defaultRetryOptions, ...options };
    let lastError: any;

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;


            if (attempt === opts.maxRetries ||
                (opts.shouldRetry && !opts.shouldRetry(error))) {
                throw error;
            }


            const delay = Math.min(
                opts.initialDelayMs * Math.pow(2, attempt),
                opts.maxDelayMs
            );

            console.log(`[ORITO] Retry attempt ${attempt + 1}/${opts.maxRetries} after ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}






//------This Function handles the Classify Error---------
function classifyError(error: any): { code: string; recoverable: boolean; message: string } {
    const details = error?.details || {};
    const statusCode = typeof details.status === 'number'
        ? details.status
        : (typeof error?.status === 'number' ? error.status : undefined);
    const errorCode = error?.code || statusCode || '';
    const errorMessage = typeof error?.message === 'string' ? error.message : String(error);
    const errorStr = errorMessage.toLowerCase();

    if (error instanceof OritoError) {
        if (statusCode === 401 || statusCode === 403) {
            return {
                code: ErrorCodes.PERMISSION_DENIED,
                recoverable: false,
                message: 'Permission denied'
            };
        }
        return {
            code: error.code,
            recoverable: error.recoverable,
            message: error.message
        };
    }


    if (errorStr.includes('network') ||
        errorStr.includes('fetch') ||
        errorStr.includes('connection') ||
        errorCode === 'ECONNREFUSED' ||
        errorCode === 'ENOTFOUND') {
        return {
            code: ErrorCodes.NETWORK_ERROR,
            recoverable: true,
            message: 'Network connection failed'
        };
    }


    if (errorStr.includes('timeout') || errorStr.includes('timed out')) {
        return {
            code: ErrorCodes.TIMEOUT,
            recoverable: true,
            message: 'Request timed out'
        };
    }


    if (errorStr.includes('groq') ||
        errorStr.includes('openai') ||
        statusCode === 503 ||
        errorCode === 'AI_SERVICE_ERROR') {
        return {
            code: ErrorCodes.AI_SERVICE_ERROR,
            recoverable: true,
            message: 'AI service temporarily unavailable'
        };
    }


    if (errorStr.includes('permission') ||
        errorStr.includes('unauthorized') ||
        statusCode === 401 ||
        statusCode === 403) {
        return {
            code: ErrorCodes.PERMISSION_DENIED,
            recoverable: false,
            message: 'Permission denied'
        };
    }


    if (errorStr.includes('aura') || errorStr.includes('camera')) {
        return {
            code: ErrorCodes.AURA_OFFLINE,
            recoverable: true,
            message: 'Aura module unavailable'
        };
    }


    return {
        code: ErrorCodes.UNKNOWN,
        recoverable: true,
        message: String(error)
    };
}


interface AuraStatusSnapshot {
    connected: boolean;
    message: string;
    ip?: string;
    lastSeen?: string;
    features: string[];
    checkedAt: number;
}

const DEFAULT_AURA_OFFLINE_MESSAGE = 'Aura module is NOT connected. Please check that the Aura device is powered on and connected to the same network.';
const AURA_STATUS_CHECK_TIMEOUT_MS = 5000;
const AURA_CONTEXT_LOOKBACK = 8;

//------This Function handles the To Aura Status Snapshot---------
function toAuraStatusSnapshot(rawStatus: any): AuraStatusSnapshot {
    const connected = rawStatus?.connected === true;
    const message = connected
        ? 'Aura module is CONNECTED.'
        : (typeof rawStatus?.message === 'string' && rawStatus.message.trim()
            ? rawStatus.message.trim()
            : DEFAULT_AURA_OFFLINE_MESSAGE);

    const features = Array.isArray(rawStatus?.features)
        ? rawStatus.features.filter((feature: any) => typeof feature === 'string')
        : [];

    return {
        connected,
        message,
        ip: typeof rawStatus?.ip === 'string' && rawStatus.ip.trim() ? rawStatus.ip.trim() : undefined,
        lastSeen: typeof rawStatus?.last_seen === 'string' && rawStatus.last_seen.trim() ? rawStatus.last_seen.trim() : undefined,
        features,
        checkedAt: Date.now(),
    };
}

//------This Function handles the Format Aura Status For Tool---------
function formatAuraStatusForTool(snapshot: AuraStatusSnapshot): string {
    if (!snapshot.connected) {
        return snapshot.message || DEFAULT_AURA_OFFLINE_MESSAGE;
    }

    return `Aura module is CONNECTED\nIP Address: ${snapshot.ip || 'Unavailable'}\nLast seen: ${snapshot.lastSeen || 'Unavailable'}\nFeatures: ${snapshot.features?.join(', ') || 'camera, microphone, face_recognition'}`;
}

//------This Function handles the Fetch Aura Status Snapshot---------
async function fetchAuraStatusSnapshot(): Promise<AuraStatusSnapshot> {
    try {
        const response = await api.get('/aura/status', { timeout: AURA_STATUS_CHECK_TIMEOUT_MS });
        const snapshot = toAuraStatusSnapshot(response.data);
        lastAuraStatusSnapshot = snapshot;
        return snapshot;
    } catch (error: any) {
        console.log('[ORITO] Aura status check failed:', error);
        const snapshot: AuraStatusSnapshot = {
            connected: false,
            message: DEFAULT_AURA_OFFLINE_MESSAGE,
            features: [],
            checkedAt: Date.now(),
        };
        lastAuraStatusSnapshot = snapshot;
        return snapshot;
    }
}

//------This Function handles the Check Aura Status---------
async function checkAuraStatus(): Promise<{ connected: boolean; message?: string }> {
    const snapshot = await fetchAuraStatusSnapshot();
    return {
        connected: snapshot.connected,
        message: snapshot.connected ? undefined : snapshot.message,
    };
}

const NEWS_API_KEY = Constants.expoConfig?.extra?.newsApiKey || '';


const STORAGE_KEYS = {
    CONVERSATION_HISTORY: 'orito_conversation_history',
    USER_CONTEXT: 'orito_user_context',
    EMOTION_HISTORY: 'orito_emotion_history',
    LAST_SYNC: 'orito_last_sync',
};

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}


interface UserContext {
    userName?: string;
    userAge?: number;
    medicalCondition?: string;
    severity?: string;
    medications?: string[];
    relatives?: Array<{ name: string; relationship: string }>;
    detectedEmotions: string[];
    topicsDiscussed: string[];
    lastInteractionTime?: Date;
    recentJournalEntries?: string[];
    preferences?: Record<string, any>;
}





interface Relative {
    id: string;
    name: string;
    relationship: string;
    phone?: string;
    photos?: string[];
    photo_count?: number;
    face_embeddings?: number[][];
    has_embeddings: boolean;
    notes?: string;
    image_url?: string;
}

interface RelativesCache {
    data: Relative[];
    timestamp: number;
}


const RELATIVES_CACHE_DURATION = 5 * 60 * 1000;
let relativesCache: RelativesCache | null = null;


//------This Function handles the Get Relatives With Cache---------
async function getRelativesWithCache(forceRefresh: boolean = false): Promise<Relative[]> {
    const now = Date.now();


    if (!forceRefresh && relativesCache &&
        (now - relativesCache.timestamp) < RELATIVES_CACHE_DURATION) {
        console.log('[ORITO] Returning cached relatives data');
        return relativesCache.data;
    }


    try {
        const response = await api.get('/relatives/');
        //------This Function handles the Relatives---------
        const relatives: Relative[] = (response.data || []).map((relative: any) => ({
            id: relative.id,
            name: relative.name,
            relationship: relative.relationship || '',
            phone: relative.phone || '',
            photos: Array.isArray(relative.photos) ? relative.photos : [],
            photo_count: typeof relative.photo_count === 'number' ? relative.photo_count : (relative.photos?.length || 0),
            face_embeddings: Array.isArray(relative.face_embeddings) ? relative.face_embeddings : [],
            has_embeddings: !!relative.has_embeddings,
            notes: relative.notes || '',
            image_url: relative.image_url || undefined,
        }));


        relativesCache = {
            data: relatives,
            timestamp: now
        };

        console.log('[ORITO] Fetched and cached new relatives data');
        return relatives;
    } catch (error) {
        console.log('[ORITO] Failed to fetch relatives:', error);

        if (relativesCache) {
            console.log('[ORITO] Using expired cache as fallback');
            return relativesCache.data;
        }
        return [];
    }
}


//------This Function handles the Clear Relatives Cache---------
export function clearRelativesCache(): void {
    relativesCache = null;
    console.log('[ORITO] Relatives cache cleared');
}


//------This Function handles the Get Relatives Cache Status---------
export function getRelativesCacheStatus(): { cached: boolean; count: number; age?: number } {
    if (!relativesCache) {
        return { cached: false, count: 0 };
    }
    return {
        cached: true,
        count: relativesCache.data.length,
        age: Date.now() - relativesCache.timestamp
    };
}





interface IdentifiedPerson {
    name: string;
    relationship: string;
    confidence: number;
    id: string;
}

interface RecognitionResult {
    success: boolean;
    person?: IdentifiedPerson;
    message: string;
    identifiedFaces?: Array<{
        person_id: string;
        person_name: string;
        confidence: number;
        relationship?: string;
    }>;
}


const CONFIDENCE_THRESHOLD = 0.6;


//------This Function handles the Validate Aura Response---------
function validateAuraResponse(response: any): { valid: boolean; error?: string } {

    if (!response) {
        return { valid: false, error: 'No response from Aura module' };
    }


    if (typeof response.success !== 'boolean') {
        return { valid: false, error: 'Invalid response format: missing success field' };
    }


    if (response.success === false) {
        return { valid: true };
    }


    if (response.success === true && !Array.isArray(response.identified_faces)) {
        return { valid: false, error: 'Invalid response format: missing identified_faces array' };
    }

    return { valid: true };
}


//------This Function handles the Find Matching Relative---------
function findMatchingRelative(
    relatives: Relative[],
    personId?: string,
    personName?: string
): Relative | null {

    if (personId) {
        //------This Function handles the By Id---------
        const byId = relatives.find(r => r.id === personId);
        if (byId) return byId;
    }


    if (personName) {
        //------This Function handles the By Name---------
        const byName = relatives.find(r =>
            r.name.toLowerCase() === personName.toLowerCase()
        );
        if (byName) return byName;
    }


    if (personName) {
        //------This Function handles the Partial Match---------
        const partialMatch = relatives.find(r =>
            r.name.toLowerCase().includes(personName.toLowerCase()) ||
            personName.toLowerCase().includes(r.name.toLowerCase())
        );
        if (partialMatch) return partialMatch;
    }

    return null;
}


//------This Function handles the Identify Person From Relatives---------
async function identifyPersonFromRelatives(): Promise<RecognitionResult> {

    const auraStatus = await checkAuraStatus();

    if (!auraStatus.connected) {
        return {
            success: false,
            message: auraStatus.message || getRecoveryResponse(ErrorCodes.AURA_OFFLINE)
        };
    }


    const relatives = await getRelativesWithCache();

    if (!relatives || relatives.length === 0) {
        return {
            success: false,
            message: 'No relatives found in database. Need to add family photos first.'
        };
    }


    //------This Function handles the Relatives With Photos---------
    const relativesWithPhotos = relatives.filter(r => r.has_embeddings);

    if (relativesWithPhotos.length === 0) {
        return {
            success: false,
            message: 'No relatives with face recognition data. Need to upload photos with embeddings.'
        };
    }


    const result = await triggerAuraFaceRecognition(relativesWithPhotos);


    const validation = validateAuraResponse(result);
    if (!validation.valid) {
        console.log('[ORITO] Aura response validation failed:', validation.error);
        return {
            success: false,
            message: `Face recognition error: ${validation.error}`
        };
    }


    if (!result.success) {
        return {
            success: false,
            message: result.error || 'Face recognition failed. Please try again.'
        };
    }


    if (result.identifiedFaces && result.identifiedFaces.length > 0) {

        //------This Function handles the Valid Faces---------
        const validFaces = result.identifiedFaces.filter(face =>
            face.confidence >= CONFIDENCE_THRESHOLD
        );

        if (validFaces.length === 0) {
            return {
                success: false,
                message: 'Face detected but confidence too low for reliable identification. Please try again with better lighting.'
            };
        }


        const bestMatch = validFaces[0];


        const matchedRelative = findMatchingRelative(
            relatives,
            bestMatch.person_id,
            bestMatch.person_name
        );

        if (!matchedRelative) {
            return {
                success: false,
                message: `Detected ${bestMatch.person_name} but they are not in your relatives list. Would you like to add them?`
            };
        }


        return {
            success: true,
            message: `IDENTIFIED: ${matchedRelative.name}, their ${matchedRelative.relationship}`,
            identifiedFaces: result.identifiedFaces,
            person: {
                id: matchedRelative.id,
                name: matchedRelative.name,
                relationship: matchedRelative.relationship,
                confidence: bestMatch.confidence
            }
        };
    }


    return {
        success: false,
        message: 'Face detected but could not identify the person. They may not be in your relatives list.'
    };
}


let conversationHistory: ChatMessage[] = [];
let userContext: UserContext = {
    detectedEmotions: [],
    topicsDiscussed: [],
};
let isInitialized = false;
let lastAuraStatusSnapshot: AuraStatusSnapshot | null = null;


let lastRecognizedPerson: IdentifiedPerson | null = null;


//------This Function handles the Get Last Recognized Person---------
export function getLastRecognizedPerson(): IdentifiedPerson | null {
    return lastRecognizedPerson;
}


//------This Function handles the Clear Last Recognized Person---------
export function clearLastRecognizedPerson(): void {
    lastRecognizedPerson = null;
}


//------This Function handles the Initialize Orito---------
export async function initializeOrito(): Promise<void> {
    if (isInitialized) return;

    try {

        await loadConversationHistory();


        await loadUserContext();


        await refreshUserProfile();


        await loadRecentInteractions();

        isInitialized = true;
        console.log('[ORITO] Initialized with context');
    } catch (err) {
        console.log('[ORITO] Initialization error:', err);
    }
}


//------This Function handles the Load Conversation History---------
async function loadConversationHistory(): Promise<void> {
    try {
        const stored = await AsyncStorage.getItem(STORAGE_KEYS.CONVERSATION_HISTORY);
        if (stored) {
            const parsed = JSON.parse(stored);

            if (Array.isArray(parsed) && parsed.length > 0) {
                conversationHistory = [];

                //------This Function handles the Recent Messages---------
                const recentMessages = parsed.filter((m: ChatMessage) => m.role !== 'system').slice(-20);
                conversationHistory.push(...recentMessages);
                console.log('[ORITO] Loaded', recentMessages.length, 'messages from storage');
            }
        }
    } catch (err) {
        console.log('[ORITO] Failed to load conversation history:', err);
    }
}


//------This Function handles the Save Conversation History---------
async function saveConversationHistory(): Promise<void> {
    try {

        //------This Function handles the To Save---------
        const toSave = conversationHistory.filter(m => m.role !== 'tool');
        await AsyncStorage.setItem(STORAGE_KEYS.CONVERSATION_HISTORY, JSON.stringify(toSave));
    } catch (err) {
        console.log('[ORITO] Failed to save conversation history:', err);
    }
}


//------This Function handles the Load User Context---------
async function loadUserContext(): Promise<void> {
    try {
        const stored = await AsyncStorage.getItem(STORAGE_KEYS.USER_CONTEXT);
        if (stored) {
            userContext = JSON.parse(stored);
            console.log('[ORITO] Loaded user context:', userContext.userName);
        }
    } catch (err) {
        console.log('[ORITO] Failed to load user context:', err);
    }
}


//------This Function handles the Save User Context---------
async function saveUserContext(): Promise<void> {
    try {
        await AsyncStorage.setItem(STORAGE_KEYS.USER_CONTEXT, JSON.stringify(userContext));
    } catch (err) {
        console.log('[ORITO] Failed to save user context:', err);
    }
}


//------This Function handles the Refresh User Profile---------
async function refreshUserProfile(): Promise<void> {
    try {
        const profileData = await patientDataService.getProfile();
        if (profileData) {
            const extendedProfile = profileData as any;
            userContext.userName = profileData.user?.display_name || profileData.user?.name;
            userContext.userAge = profileData.user?.age;
            userContext.medicalCondition = profileData.patient_profile?.condition;
            userContext.severity = profileData.patient_profile?.severity;
            userContext.preferences = profileData.user?.preferences || {};
            userContext.medications = (profileData.medications || []).map((med: any) => med.name).filter(Boolean);
            userContext.relatives = (extendedProfile.relatives || []).map((relative: any) => ({
                name: relative.name,
                relationship: relative.relationship || '',
            }));

            await saveUserContext();
            console.log('[ORITO] Refreshed user profile');
        }
    } catch (err) {
        console.log('[ORITO] Failed to refresh user profile:', err);
    }
}


//------This Function handles the Load Recent Interactions---------
async function loadRecentInteractions(): Promise<void> {
    try {
        const response = await api.get('/orito/interactions/recent', {
            params: { hours: 24, limit: 10 },
        });

        if (response.data && response.data.length > 0) {
            userContext.recentJournalEntries = response.data.map((i: any) =>
                `User: ${i.user_message}\nOrito: ${i.bot_response}`
            );


            const recentEmotions = response.data
                .flatMap((i: any) => i.emotions_detected || [])
                .slice(-10);
            userContext.detectedEmotions = recentEmotions;

            console.log('[ORITO] Loaded', response.data.length, 'recent interactions');
        }
    } catch (err) {
        console.log('[ORITO] Failed to load recent interactions:', err);
    }
}

//------This Function handles the Reset Conversation---------
export function resetConversation() {
    conversationHistory = [];
    userContext = {
        detectedEmotions: [],
        topicsDiscussed: [],
    };
    lastAuraStatusSnapshot = null;


    AsyncStorage.multiRemove([
        STORAGE_KEYS.CONVERSATION_HISTORY,
        STORAGE_KEYS.USER_CONTEXT,
    ]).catch(() => { });
}


export type EmotionIntensity = 'mild' | 'moderate' | 'strong';
export interface EmotionResult {
    emotions: string[];
    primary: string;
    intensity: EmotionIntensity;
}


const emotionHistory: string[] = [];

const EMOTION_KEYWORDS: Record<string, string[]> = {
    happy: ['happy', 'glad', 'great', 'wonderful', 'excited', 'good', 'nice', 'love', 'thank', 'thanks', 'amazing', 'awesome', 'fantastic', 'joy', 'joyful', 'delighted', 'pleased', 'cheerful', 'blessed', 'grateful', 'yay', 'woohoo'],
    sad: ['sad', 'depressed', 'lonely', 'alone', 'miss', 'hurt', 'cry', 'crying', 'upset', 'unhappy', 'miserable', 'heartbroken', 'grief', 'grieving', 'mourning', 'sorrow', 'gloomy', 'down', 'blue', 'tearful', 'devastated'],
    confused: ['confused', 'lost', "don't know", 'where am i', 'who are you', 'what is', "help me understand", "don't remember", "can't recall", 'bewildered', 'puzzled', 'disoriented', 'unsure', 'uncertain', "what's happening", 'huh', 'what do you mean'],
    anxious: ['scared', 'afraid', 'worried', 'anxious', 'nervous', 'panic', 'fear', 'terrified', 'uneasy', 'tense', 'dread', 'apprehensive', 'restless', 'on edge', 'overwhelmed', 'stress', 'stressed'],
    frustrated: ['frustrated', 'annoyed', 'irritated', 'fed up', 'sick of', 'tired of', 'ugh', 'argh', 'bothered', 'exasperated', 'impatient'],
    angry: ['angry', 'mad', 'furious', 'rage', 'hate', 'stupid', 'pissed', 'livid', 'outraged', 'infuriated', 'enraged'],
    grateful: ['grateful', 'thankful', 'appreciate', 'blessed', 'thank you so much', 'means a lot', 'kind of you', 'so sweet'],
    lonely: ['lonely', 'alone', 'no one', 'nobody', 'isolated', 'abandoned', 'forgotten', 'left out', 'by myself', 'miss someone', 'wish someone'],
    hopeful: ['hopeful', 'hope', 'looking forward', 'optimistic', 'better soon', 'getting better', 'positive', 'bright side', 'maybe things will', 'one day'],
    fearful: ['terrified', 'petrified', 'horror', 'nightmare', 'dread', 'phobia', 'frightened', 'shaking', 'trembling'],
    calm: ['calm', 'peaceful', 'relaxed', 'serene', 'content', 'at ease', 'comfortable', 'fine', 'okay', 'alright', 'chill', 'mellow'],
    excited: ['excited', 'thrilled', 'pumped', 'hyped', 'can\'t wait', 'stoked', 'ecstatic', 'elated', 'fired up', 'buzzing'],
    distressed: ['lost', "can't find", 'where am i', 'help', 'emergency', 'fall', 'fell', 'hurt bad', 'bleeding', 'pain', 'sos', 'danger', 'dying', 'chest pain', 'can\'t breathe'],
};


//------This Function handles the Detect Emotion---------
function detectEmotion(message: string): EmotionResult {
    const lowerMsg = message.toLowerCase();
    const emotionScores: Record<string, number> = {};

    for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
        let score = 0;
        for (const keyword of keywords) {
            if (lowerMsg.includes(keyword)) {
                score++;
            }
        }
        if (score > 0) {
            emotionScores[emotion] = score;
        }
    }


    const exclamationCount = (message.match(/!/g) || []).length;
    const capsRatio = (message.replace(/[^A-Z]/g, '').length) / Math.max(message.replace(/[^a-zA-Z]/g, '').length, 1);

    //------This Function handles the Emotions---------
    const emotions = Object.keys(emotionScores).sort((a, b) => emotionScores[b] - emotionScores[a]);
    const primary = emotions[0] || 'neutral';
    const topScore = emotionScores[primary] || 0;


    let intensity: EmotionIntensity = 'mild';
    const intensityScore = topScore + exclamationCount * 0.5 + (capsRatio > 0.5 ? 2 : 0);
    if (intensityScore >= 4) {
        intensity = 'strong';
    } else if (intensityScore >= 2) {
        intensity = 'moderate';
    }


    if (primary !== 'neutral') {
        emotionHistory.push(primary);
        if (emotionHistory.length > 5) {
            emotionHistory.shift();
        }
    }

    return { emotions, primary, intensity };
}


//------This Function handles the Detect Emotion From Text---------
export function detectEmotionFromText(text: string): EmotionResult {
    return detectEmotion(text);
}


//------This Function handles the Get Emotion Trend---------
export function getEmotionTrend(): string[] {
    return [...emotionHistory];
}

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_user_profile',
            description: 'Get the users full profile: name, age, medical condition, diagnosis date, severity, notes. Use this early in conversations to personalize interactions.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_user_context',
            description: 'Get comprehensive user context including profile, medications, relatives, and recent interactions. Use this to get a complete picture of the user.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_user_profile',
            description: 'Update core medical profile fields like condition, severity, diagnosis date, and notes.',
            parameters: {
                type: 'object',
                properties: {
                    condition: { type: 'string', description: 'Medical condition name' },
                    severity: { type: 'string', description: 'Condition severity' },
                    diagnosis_date: { type: 'string', description: 'Diagnosis date in YYYY-MM-DD or readable format' },
                    notes: { type: 'string', description: 'Additional medical notes' }
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_account_profile',
            description: 'Update account details such as display name or profile photo URL.',
            parameters: {
                type: 'object',
                properties: {
                    display_name: { type: 'string', description: 'Updated display name for the user account' },
                    photo_url: { type: 'string', description: 'Updated profile photo URL' }
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_journal_entries',
            description: 'Get recent journal entries and conversations to understand context and remember what theyve been up to. Use this to maintain conversation continuity.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Number of recent entries to fetch (default 10)' }
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_journal',
            description: 'Search the users journal entries for specific past events, conversations, and memories using keywords',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'What to search for' } },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_memory_entry',
            description: 'Create a new memory or journal entry for the user.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'Memory text to save' },
                    mood: { type: 'string', description: 'Optional mood label' }
                },
                required: ['content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_memory_entry',
            description: 'Update an existing memory/journal entry.',
            parameters: {
                type: 'object',
                properties: {
                    entry_id: { type: 'string', description: 'Journal entry ID' },
                    content: { type: 'string', description: 'Updated memory text' },
                    mood: { type: 'string', description: 'Optional updated mood' }
                },
                required: ['entry_id', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_memory_entry',
            description: 'Delete a memory/journal entry by ID.',
            parameters: {
                type: 'object',
                properties: {
                    entry_id: { type: 'string', description: 'Journal entry ID to delete' }
                },
                required: ['entry_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_medications',
            description: 'Get the users current medications and schedule',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_reminder',
            description: 'Create a reminder or task for the user. Creates a reminder that appears in their app.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title of the reminder (e.g., "Take medication", "Doctor appointment")' },
                    description: { type: 'string', description: 'Detailed description' },
                    datetime: { type: 'string', description: 'When to remind - ISO format or natural like "tomorrow at 9am"' },
                    repeat: { type: 'string', description: 'Optional repeat: "daily", "weekly", "monthly"' }
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'identify_person_from_relatives',
            description: 'Use face recognition to identify a person from the camera. Triggers the Aura module camera, captures a face, and matches against the relatives database. Use this when the user asks "who is this?" or wants to identify someone in front of the camera. Requires Aura module to be connected.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'call_relative',
            description: 'Initiate a phone call to a relative or family member. Use this when the user wants to call someone.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Name of the relative to call' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_internet',
            description: 'Search the internet for current information, news, facts, or answer questions. Use this when you need up-to-date real-world information.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to search for on the internet' }
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'analyze_news_with_opinion',
            description: 'Get recent news headlines AND provide your genuine opinion/analysis as a 16-year-old. Share hot takes and perspectives.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'Optional topic to filter news (e.g., technology, health, sports)' }
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'trigger_sos',
            description: 'Send emergency SOS alert to caregivers. Only use in genuine emergencies when user is in danger, very confused about location, or needs immediate help.',
            parameters: {
                type: 'object',
                properties: {
                    level: { type: 'number', description: '1-5 severity (5=critical emergency)' },
                    trigger: { type: 'string', description: 'Optional trigger source: voice, auto, or button' },
                    message: { type: 'string' },
                },
                required: ['level', 'message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_active_sos',
            description: 'Get active unresolved SOS alerts for the current account.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'resolve_sos_alert',
            description: 'Resolve an SOS alert by ID (typically used by caregivers).',
            parameters: {
                type: 'object',
                properties: {
                    sos_id: { type: 'string', description: 'SOS alert ID to resolve' }
                },
                required: ['sos_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_steps',
            description: 'Get the users step count for today. Shows how many steps they have walked and progress toward their daily goal. Use this when they ask about their activity or exercise.',
            parameters: { type: 'object', properties: {} },
        },
    },

    {
        type: 'function',
        function: {
            name: 'get_reminders',
            description: 'Get all reminders for the user. Can filter by status: active, completed, or all. Use this to check what reminders exist and what is due.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['active', 'completed', 'all'], description: 'Filter by status (default: active)' }
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_reminder',
            description: 'Update an existing reminder. Can modify title, description, datetime, or repeat pattern.',
            parameters: {
                type: 'object',
                properties: {
                    reminder_id: { type: 'string', description: 'ID of the reminder to update' },
                    title: { type: 'string', description: 'New title' },
                    description: { type: 'string', description: 'New description' },
                    datetime: { type: 'string', description: 'New datetime' },
                    repeat: { type: 'string', description: 'New repeat pattern (daily, weekly, monthly)' }
                },
                required: ['reminder_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_reminder',
            description: 'Delete a reminder by ID. Use this to remove reminders that are no longer needed.',
            parameters: {
                type: 'object',
                properties: {
                    reminder_id: { type: 'string', description: 'ID of the reminder to delete' }
                },
                required: ['reminder_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'complete_reminder',
            description: 'Mark a reminder as completed by ID.',
            parameters: {
                type: 'object',
                properties: {
                    reminder_id: { type: 'string', description: 'ID of the reminder to mark completed' }
                },
                required: ['reminder_id'],
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'add_medication',
            description: 'Add a new medication to the users medication list. Include name, dosage, frequency, and schedule times.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Medication name' },
                    dosage: { type: 'string', description: 'Dosage (e.g., 10mg, 1 tablet)' },
                    frequency: { type: 'string', description: 'Frequency (e.g., once daily, twice daily)' },
                    schedule_times: { type: 'array', items: { type: 'string' }, description: 'Times to take (e.g., ["08:00", "20:00"])' },
                    notes: { type: 'string', description: 'Any additional notes' }
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_medication',
            description: 'Update an existing medication. Can modify any field including name, dosage, frequency, schedule times, or notes.',
            parameters: {
                type: 'object',
                properties: {
                    medication_id: { type: 'string', description: 'ID of the medication to update' },
                    name: { type: 'string', description: 'New medication name' },
                    dosage: { type: 'string', description: 'New dosage' },
                    frequency: { type: 'string', description: 'New frequency' },
                    schedule_times: { type: 'array', items: { type: 'string' }, description: 'New schedule times' },
                    notes: { type: 'string', description: 'New notes' },
                    is_active: { type: 'boolean', description: 'Whether medication is active' }
                },
                required: ['medication_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_medication',
            description: 'Delete a medication from the users list. Use with caution as this affects their medication tracking.',
            parameters: {
                type: 'object',
                properties: {
                    medication_id: { type: 'string', description: 'ID of the medication to delete' }
                },
                required: ['medication_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mark_medication_taken',
            description: 'Mark a medication as taken right now by medication ID.',
            parameters: {
                type: 'object',
                properties: {
                    medication_id: { type: 'string', description: 'ID of medication to mark as taken' }
                },
                required: ['medication_id'],
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'get_relatives',
            description: 'Get all relatives/family members in the database. Returns name, relationship, phone number, and other details.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_relative',
            description: 'Add a new relative to the database. Capture photo via Aura camera first, then ask for name, relationship, and phone number.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Name of the relative' },
                    relationship: { type: 'string', description: 'Relationship (e.g., daughter, son, wife, brother)' },
                    phone: { type: 'string', description: 'Phone number for calling' },
                    notes: { type: 'string', description: 'Any additional notes' }
                },
                required: ['name', 'relationship'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_relative',
            description: 'Update an existing relatives information including name, relationship, phone, or notes.',
            parameters: {
                type: 'object',
                properties: {
                    relative_id: { type: 'string', description: 'ID of the relative to update' },
                    name: { type: 'string', description: 'New name' },
                    relationship: { type: 'string', description: 'New relationship' },
                    phone: { type: 'string', description: 'New phone number' },
                    notes: { type: 'string', description: 'New notes' }
                },
                required: ['relative_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_relative',
            description: 'Remove a relative from the family list by ID.',
            parameters: {
                type: 'object',
                properties: {
                    relative_id: { type: 'string', description: 'ID of the relative to delete' }
                },
                required: ['relative_id'],
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'get_caregivers',
            description: 'Get all caregivers assigned to help this user. Returns their names, emails, relationships, and contact info.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_caregiver',
            description: 'Add a new caregiver by their email address. The caregiver will receive access to the app.',
            parameters: {
                type: 'object',
                properties: {
                    email: { type: 'string', description: 'Caregivers email address' },
                    relationship: { type: 'string', description: 'Relationship to user (e.g., daughter, son, nurse)' }
                },
                required: ['email'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'remove_caregiver',
            description: 'Remove a caregiver by email address.',
            parameters: {
                type: 'object',
                properties: {
                    email: { type: 'string', description: 'Caregiver email to remove' }
                },
                required: ['email'],
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'get_aura_status',
            description: 'Check if Aura module is connected and get its status. Returns connection state, IP address, and last seen time. CRITICAL: Always check this before using camera or microphone features.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_aura_live_context',
            description: 'Get live Aura context including latest transcript text, live snapshot URL, and live video feed URL for patient safety monitoring.',
            parameters: {
                type: 'object',
                properties: {
                    patient_uid: { type: 'string', description: 'Optional patient UID if caregiver needs a specific patient context' }
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_current_location',
            description: 'Get latest known location for current patient (or linked patient if caregiver).',
            parameters: {
                type: 'object',
                properties: {
                    patient_uid: { type: 'string', description: 'Optional patient UID override for caregiver/admin context' }
                },
            },
        },
    },

    {
        type: 'function',
        function: {
            name: 'search_wikipedia',
            description: 'Search Wikipedia for information on any topic. Use this for factual information, definitions, and summaries.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Topic to search on Wikipedia' }
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'calculate',
            description: 'Perform mathematical calculations. Use this for any math problems, conversions, or numerical computations.',
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'Mathematical expression to calculate (e.g., "15 * 7 + 32")' }
                },
                required: ['expression'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_suggestions',
            description: 'Get daily activity and wellness suggestions for the user. Returns suggestions for medications, activities, routines, and general wellness.',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['medication', 'activity', 'wellness', 'routine', 'all'], description: 'Type of suggestions to fetch' }
                },
            },
        },
    },
];

//------This Function handles the Execute Tool Call---------
export async function executeToolCall(name: string, args: any): Promise<string> {
    try {
        switch (name) {
            case 'get_user_profile': {
                const profileData = await patientDataService.getProfile();
                if (!profileData) return 'Could not load user profile';

                const userName = profileData.user?.display_name || profileData.user?.name || 'Unknown';
                const patientProfile = profileData.patient_profile;
                const condition = patientProfile?.condition || 'Unknown';
                const severity = patientProfile?.severity || 'Unknown';
                const diagnosisDate = patientProfile?.diagnosis_date || 'Unknown';
                const notes = patientProfile?.notes || 'None';
                const preferences = profileData.user?.preferences || {};


                userContext.userName = userName;
                userContext.medicalCondition = condition;
                userContext.severity = severity;
                const profileLines = [
                    'User Profile:',
                    `Name: ${userName}`,
                    `Medical Condition: ${condition}`,
                    `Severity: ${severity}`,
                    `Diagnosed: ${diagnosisDate}`,
                    `Notes: ${notes}`,
                ];

                if (Object.keys(preferences).length > 0) {
                    profileLines.push(`Preferences: ${JSON.stringify(preferences)}`);
                }

                return profileLines.join('\n');
            }

            case 'get_user_context': {

                await refreshUserProfile();

                let context = `User Context:\n`;
                if (userContext.userName) context += `Name: ${userContext.userName}\n`;
                if (userContext.userAge) context += `Age: ${userContext.userAge}\n`;
                if (userContext.medicalCondition) context += `Condition: ${userContext.medicalCondition}\n`;
                if (userContext.severity) context += `Severity: ${userContext.severity}\n`;
                if (userContext.medications?.length) context += `Medications: ${userContext.medications.join(', ')}\n`;
                if (userContext.relatives?.length) {
                    context += `Relatives: ${userContext.relatives.map(r => `${r.name} (${r.relationship})`).join(', ')}\n`;
                }
                if (userContext.detectedEmotions?.length) {
                    context += `Recent emotions: ${userContext.detectedEmotions.slice(-5).join(', ')}\n`;
                }

                return context || 'No user context available';
            }

            case 'update_user_profile': {
                try {
                    const updates: Record<string, any> = {};
                    if (typeof args.condition === 'string' && args.condition.trim()) {
                        updates.condition = args.condition.trim();
                    }
                    if (typeof args.severity === 'string' && args.severity.trim()) {
                        updates.severity = args.severity.trim();
                    }
                    if (typeof args.diagnosis_date === 'string' && args.diagnosis_date.trim()) {
                        updates.diagnosis_date = args.diagnosis_date.trim();
                    }
                    if (typeof args.notes === 'string') {
                        updates.notes = args.notes.trim();
                    }

                    if (Object.keys(updates).length === 0) {
                        return 'No profile fields provided to update.';
                    }

                    await api.patch('/user/profile', updates);
                    await refreshUserProfile();
                    return 'Medical profile updated successfully.';
                } catch (err) {
                    return `Could not update medical profile: ${err}`;
                }
            }

            case 'update_account_profile': {
                try {
                    const updates: Record<string, any> = {};
                    if (typeof args.display_name === 'string' && args.display_name.trim()) {
                        updates.display_name = args.display_name.trim();
                    }
                    if (typeof args.photo_url === 'string' && args.photo_url.trim()) {
                        updates.photo_url = args.photo_url.trim();
                    }
                    if (Object.keys(updates).length === 0) {
                        return 'No account fields provided to update.';
                    }

                    await api.put('/auth/me', updates);
                    await refreshUserProfile();
                    return 'Account profile updated successfully.';
                } catch (err) {
                    return `Could not update account profile: ${err}`;
                }
            }

            case 'get_journal_entries': {
                const limit = args.limit || 10;
                const res = await api.get('/journal/', { params: { limit, offset: 0 } });
                const entries = res.data.slice(0, limit);

                if (entries.length === 0) return 'No recent journal entries found';

                return entries.map((e: any) => {
                    const date = new Date(e.created_at).toLocaleDateString();
                    const content = e.content.substring(0, 200);
                    return `[${date}] ${content}`;
                }).join('\n\n');
            }

            case 'search_journal': {
                const res = await api.get('/journal/search', { params: { q: args.query } });
                const entries = res.data.slice(0, 5);
                return entries.length > 0
                    ? entries.map((e: any) => `[${e.created_at}] ${e.content}`).join('\n')
                    : 'nothing found in journal';
            }

            case 'add_memory_entry': {
                try {
                    const payload = {
                        content: args.content,
                        mood: typeof args.mood === 'string' ? args.mood : '',
                        source: 'ai_generated',
                    };
                    await api.post('/journal/', payload);
                    return 'Memory saved successfully.';
                } catch (err) {
                    return `Could not save memory: ${err}`;
                }
            }

            case 'update_memory_entry': {
                try {
                    const payload = {
                        content: args.content,
                        mood: typeof args.mood === 'string' ? args.mood : '',
                    };
                    await api.put(`/journal/${args.entry_id}`, payload);
                    return 'Memory updated successfully.';
                } catch (err) {
                    return `Could not update memory: ${err}`;
                }
            }

            case 'delete_memory_entry': {
                try {
                    await api.delete(`/journal/${args.entry_id}`);
                    return 'Memory deleted successfully.';
                } catch (err) {
                    return `Could not delete memory: ${err}`;
                }
            }

            case 'get_medications': {
                const res = await api.get('/medications/');
                const meds = Array.isArray(res.data) ? res.data : [];
                if (meds.length === 0) return 'No medications found.';
                return meds.map((m: any) => {
                    const times = m.schedule_times?.join(', ') || 'no schedule';
                    return `• ${m.name} — ${m.dosage || '?'} (${m.frequency || 'as needed'}) at ${times}${m.is_active === false ? ' [INACTIVE]' : ''}`;
                }).join('\n');
            }

            case 'create_reminder': {
                try {

                    await api.post('/reminders/', {
                        title: args.title || args.description || 'Reminder',
                        description: args.description || '',
                        datetime: args.datetime || new Date().toISOString(),
                        repeat_pattern: args.repeat || null,
                        created_by: 'orito',
                        source: 'ai_generated',
                    });
                    return `Reminder created: "${args.title || args.description}" for ${args.datetime || 'now'}${args.repeat ? ' (repeats: ' + args.repeat + ')' : ''}`;
                } catch (err) {

                    await api.post('/journal/', {
                        content: `REMINDER: ${args.description} ${args.datetime || ''}`,
                        source: 'ai_generated',
                        extracted_events: [{ description: args.description, datetime: args.datetime, type: 'reminder' }],
                    });
                    return 'reminder created';
                }
            }

            case 'identify_person_from_relatives': {

                const result = await identifyPersonFromRelatives();

                if (result.success && result.person) {

                    lastRecognizedPerson = result.person;


                    const relationship = result.person.relationship;
                    const confidencePercent = Math.round(result.person.confidence * 100);

                    let greeting = '';
                    switch (relationship.toLowerCase()) {
                        case 'wife':
                        case 'husband':
                            greeting = `Hey love! 💕 It's so great to see you!`;
                            break;
                        case 'mother':
                        case 'mom':
                            greeting = `Hi mom! ❤️ Always great to see you!`;
                            break;
                        case 'father':
                        case 'dad':
                            greeting = `Hey dad! 👋 Good to see you!`;
                            break;
                        case 'son':
                            greeting = `Hey little man! 😄 Great to see you!`;
                            break;
                        case 'daughter':
                            greeting = `Hey sweetie! 😊 Great to see you!`;
                            break;
                        case 'grandmother':
                        case 'grandma':
                            greeting = `Hi grandma! 🌸 So nice to see you!`;
                            break;
                        case 'grandfather':
                        case 'grandpa':
                            greeting = `Hey grandpa! 🌟 Great to see you!`;
                            break;
                        default:
                            greeting = `Hey ${result.person.name}! It's great to see you, ${relationship}!`;
                    }

                    return `${greeting} (${confidencePercent}% confident) ${result.message}`;
                }


                return result.message;
            }

            case 'call_relative': {
                try {

                    const relativesRes = await api.get('/relatives/');
                    //------This Function handles the Relative---------
                    const relative = relativesRes.data.find((r: any) =>
                        r.name.toLowerCase().includes(args.name.toLowerCase())
                    );

                    if (!relative) {
                        return `Could not find ${args.name} in your relatives list.`;
                    }

                    if (!relative.phone) {
                        return `No phone number found for ${relative.name}.`;
                    }


                    await api.post('/calls/initiate', {
                        relative_id: relative.id,
                        phone: relative.phone,
                    });

                    return `Calling ${relative.name} at ${relative.phone}...`;
                } catch (err) {
                    return `Could not initiate call. Please try again.`;
                }
            }

            case 'search_internet': {
                try {

                    const query = encodeURIComponent(args.query);
                    const res = await fetch(`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`);
                    const data = await res.json();

                    let result = '';

                    if (data.AbstractText) {
                        result += `Summary: ${data.AbstractText}\n`;
                    }

                    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
                        result += '\nRelated Info:\n';
                        data.RelatedTopics.slice(0, 3).forEach((topic: any) => {
                            if (topic.Text) {
                                result += `- ${topic.Text}\n`;
                            }
                        });
                    }

                    if (!result) {

                        result = `Searched for "${args.query}" - information available but limited. Try being more specific or check news sources.`;
                    }

                    return result || 'Could not find relevant information';
                } catch (err) {
                    return 'Internet search failed, connection issues';
                }
            }

            case 'analyze_news_with_opinion': {
                try {
                    if (!NEWS_API_KEY || NEWS_API_KEY === 'demo') {
                        return 'News service not configured.';
                    }

                    const topic = args.topic || '';
                    const category = topic ? `&category=${topic}` : '';
                    const res = await fetch(
                        `https://newsapi.org/v2/top-headlines?country=us&pageSize=5${category}&apiKey=${NEWS_API_KEY}`
                    );
                    const data = await res.json();

                    if (!data.articles || data.articles.length === 0) {
                        return 'No news found right now';
                    }


                    //------This Function handles the News Content---------
                    const newsContent = data.articles.map((a: any) =>
                        `${a.title}\n${a.description || ''}`
                    ).join('\n\n');

                    return `RECENT NEWS:\n${newsContent}\n\n[Now provide your genuine teen perspective and opinions on these headlines]`;
                } catch (err) {
                    return 'Could not fetch news right now';
                }
            }

            case 'trigger_sos': {

                try {
                    await withRetry(async () => {
                        await api.post('/sos/trigger', {
                            level: args.level,
                            trigger: typeof args.trigger === 'string' && args.trigger.trim() ? args.trigger : 'voice',
                            message: args.message
                        });
                    }, { maxRetries: 3, initialDelayMs: 1000 });
                    return 'SOS sent to caregivers - help is on the way!';
                } catch (err: any) {
                    console.log('[ORITO] SOS trigger error:', err);

                    return 'I was unable to send the emergency alert. Please try calling your caregiver directly or dial emergency services if needed.';
                }
            }

            case 'get_active_sos': {
                try {
                    const response = await api.get('/sos/active');
                    const activeEvents = Array.isArray(response.data) ? response.data : [];
                    if (activeEvents.length === 0) {
                        return 'No active SOS alerts.';
                    }

                    return activeEvents.map((event: any) =>
                        `SOS ${event.id}\nLevel: ${event.level}\nTrigger: ${event.trigger}\nMessage: ${event.message || 'No message'}\nCreated: ${event.created_at}`
                    ).join('\n\n');
                } catch (err) {
                    return 'Could not fetch active SOS alerts';
                }
            }

            case 'resolve_sos_alert': {
                try {
                    await api.post(`/sos/${args.sos_id}/resolve`);
                    return `SOS alert ${args.sos_id} resolved.`;
                } catch (err) {
                    return `Could not resolve SOS alert: ${err}`;
                }
            }

            case 'get_steps': {
                const { pedometerService } = await import('./pedometer');
                const stepSummary = await pedometerService.getStepSummary();
                return stepSummary;
            }


            case 'get_reminders': {
                try {
                    const status = args.status || 'active';
                    const response = await api.get('/reminders/', { params: { status } });
                    const reminders = response.data;
                    if (!reminders || reminders.length === 0) return 'No reminders found';
                    return reminders.map((r: any) =>
                        `[${r.datetime}] ${r.title}: ${r.description}${r.repeat_pattern ? ' (Repeats: ' + r.repeat_pattern + ')' : ''}`
                    ).join('\n');
                } catch (err) {
                    return 'Could not fetch reminders';
                }
            }

            case 'update_reminder': {
                try {
                    await api.put(`/reminders/${args.reminder_id}`, {
                        title: args.title,
                        description: args.description,
                        datetime: args.datetime,
                        repeat_pattern: args.repeat,
                    });
                    return `Reminder updated successfully`;
                } catch (err) {
                    return 'Could not update reminder';
                }
            }

            case 'delete_reminder': {
                try {
                    await api.delete(`/reminders/${args.reminder_id}`);
                    return `Reminder deleted`;
                } catch (err) {
                    return 'Could not delete reminder';
                }
            }

            case 'complete_reminder': {
                try {
                    await api.post(`/reminders/${args.reminder_id}/complete`);
                    return 'Reminder marked as completed.';
                } catch (err) {
                    return 'Could not complete reminder';
                }
            }

            case 'add_medication': {
                try {
                    const response = await api.post('/medications/', {
                        name: args.name,
                        dosage: args.dosage || '',
                        frequency: args.frequency || '',
                        schedule_times: args.schedule_times || [],
                        notes: args.notes || '',
                    });
                    return `Medication "${args.name}" added successfully.\nDosage: ${args.dosage || 'Not specified'}\nSchedule: ${args.schedule_times?.join(', ') || 'Not specified'}`;
                } catch (err) {
                    return `Could not add medication: ${err}`;
                }
            }

            case 'update_medication': {
                try {
                    const updateData: any = {};
                    if (args.name) updateData.name = args.name;
                    if (args.dosage) updateData.dosage = args.dosage;
                    if (args.frequency) updateData.frequency = args.frequency;
                    if (args.schedule_times) updateData.schedule_times = args.schedule_times;
                    if (args.notes) updateData.notes = args.notes;
                    if (args.is_active !== undefined) updateData.is_active = args.is_active;

                    await api.put(`/medications/${args.medication_id}`, updateData);
                    return `Medication updated successfully`;
                } catch (err) {
                    return `Could not update medication: ${err}`;
                }
            }

            case 'delete_medication': {
                try {
                    await api.delete(`/medications/${args.medication_id}`);
                    return `Medication removed from your list`;
                } catch (err) {
                    return `Could not delete medication: ${err}`;
                }
            }

            case 'mark_medication_taken': {
                try {
                    await api.post(`/medications/${args.medication_id}/take`);
                    return 'Medication marked as taken.';
                } catch (err) {
                    return `Could not mark medication as taken: ${err}`;
                }
            }

            case 'get_relatives': {
                try {
                    const response = await api.get('/relatives/');
                    const relatives = response.data;
                    if (!relatives || relatives.length === 0) return 'No relatives found in your list';
                    return relatives.map((r: any) =>
                        `${r.name} - ${r.relationship}${r.phone ? ' (Phone: ' + r.phone + ')' : ''}`
                    ).join('\n');
                } catch (err) {
                    return 'Could not fetch relatives';
                }
            }

            case 'add_relative': {
                try {

                    let photoResult = null;
                    try {
                        photoResult = await triggerAuraFaceRecognition();
                    } catch (e) {
                        console.log('[ORITO] Could not capture photo:', e);
                    }

                    const response = await api.post('/relatives/', {
                        name: args.name,
                        relationship: args.relationship,
                        phone: args.phone || '',
                        notes: args.notes || '',
                    });
                    clearRelativesCache();
                    return `Added ${args.name} to your family list!\nRelationship: ${args.relationship}\nPhone: ${args.phone || 'Not provided'}\n${photoResult ? 'Photo captured successfully' : 'No photo captured'}`;
                } catch (err) {
                    return `Could not add relative: ${err}`;
                }
            }

            case 'update_relative': {
                try {
                    const updateData: any = {};
                    if (args.name) updateData.name = args.name;
                    if (args.relationship) updateData.relationship = args.relationship;
                    if (args.phone) updateData.phone = args.phone;
                    if (args.notes) updateData.notes = args.notes;

                    await api.put(`/relatives/${args.relative_id}`, updateData);
                    clearRelativesCache();
                    return `Relative updated successfully`;
                } catch (err) {
                    return `Could not update relative: ${err}`;
                }
            }

            case 'delete_relative': {
                try {
                    await api.delete(`/relatives/${args.relative_id}`);
                    clearRelativesCache();
                    return 'Relative removed successfully.';
                } catch (err) {
                    return `Could not delete relative: ${err}`;
                }
            }

            case 'get_caregivers': {
                try {
                    //------This Function handles the Response---------
                    const response = await api.get('/user/caregivers').catch(async () => {
                        const profile = await api.get('/user/profile');
                        return { data: profile.data?.caregivers || [] };
                    });
                    const caregivers = response.data || [];
                    if (!caregivers || caregivers.length === 0) return 'No caregivers assigned yet';
                    return caregivers.map((c: any) =>
                        `${c.name || c.email} - ${c.relationship || 'Caregiver'}\nEmail: ${c.email}`
                    ).join('\n\n');
                } catch (err) {
                    return 'Could not fetch caregivers';
                }
            }

            case 'add_caregiver': {
                try {
                    await api.post('/user/caregivers', {
                        email: args.email,
                        relationship: args.relationship || 'family',
                    });
                    return `Caregiver invitation sent to ${args.email}`;
                } catch (err) {
                    return `Could not add caregiver: ${err}`;
                }
            }

            case 'remove_caregiver': {
                try {
                    await api.delete(`/user/caregivers/${encodeURIComponent(args.email)}`);
                    return `Caregiver ${args.email} removed.`;
                } catch (err) {
                    return `Could not remove caregiver: ${err}`;
                }
            }

            case 'get_aura_status': {
                try {
                    const snapshot = await fetchAuraStatusSnapshot();
                    return formatAuraStatusForTool(snapshot);
                } catch (err: any) {
                    console.log('[ORITO] Aura status error:', err);
                    const { code } = classifyError(err);
                    return getRecoveryResponse(code);
                }
            }

            case 'get_aura_live_context': {
                try {
                    const params: Record<string, string> = {};
                    if (typeof args.patient_uid === 'string' && args.patient_uid.trim()) {
                        params.patient_uid = args.patient_uid.trim();
                    }

                    const response = await api.get('/aura/live_context', {
                        params,
                    });
                    const data = response.data || {};
                    const transcript = data.latest_transcript?.text || '';
                    const rawTimestamp = data.latest_transcript?.timestamp;
                    let transcriptTime = 'Unknown';
                    if (typeof rawTimestamp === 'number') {
                        transcriptTime = new Date(rawTimestamp * 1000).toLocaleString();
                    } else if (typeof rawTimestamp === 'string' && rawTimestamp.trim()) {
                        transcriptTime = new Date(rawTimestamp).toLocaleString();
                    }

                    const lines = [
                        `Aura live context for ${data.patient_uid || 'patient'}:`,
                        `Snapshot URL: ${data.snapshot_url || 'Unavailable'}`,
                        `Video feed URL: ${data.video_feed_url || 'Unavailable'}`,
                    ];

                    if (transcript) {
                        lines.push(`Latest transcript (${transcriptTime}): ${transcript}`);
                    } else {
                        lines.push('Latest transcript: No recent speech captured');
                    }

                    return lines.join('\n');
                } catch (err) {
                    return 'Could not fetch Aura live context';
                }
            }

            case 'get_current_location': {
                try {
                    let targetUid = typeof args.patient_uid === 'string' ? args.patient_uid.trim() : '';
                    if (!targetUid) {
                        const meRes = await api.get('/auth/me');
                        const me = meRes.data || {};
                        if (me.role === 'caregiver' && Array.isArray(me.linked_patients) && me.linked_patients.length > 0) {
                            targetUid = me.linked_patients[0];
                        } else {
                            targetUid = me.firebase_uid || '';
                        }
                    }

                    if (!targetUid) {
                        return 'Could not determine patient for location lookup.';
                    }

                    const response = await api.get(`/location/${targetUid}`);
                    const location = response.data?.location;
                    if (!location) {
                        return 'No recent location data available.';
                    }

                    const updatedAt = new Date(location.timestamp || Date.now()).toLocaleString();
                    return `Current location for ${response.data?.display_name || 'patient'}:\nLatitude: ${location.latitude}\nLongitude: ${location.longitude}\nAccuracy: ${Math.round(location.accuracy || 0)}m\nUpdated: ${updatedAt}`;
                } catch (err) {
                    return 'Could not fetch current location';
                }
            }

            case 'search_wikipedia': {
                try {
                    const query = encodeURIComponent(args.query);
                    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${query}`);
                    if (!response.ok) return `Could not find information about "${args.query}"`;
                    const data = await response.json();
                    return `${data.title}: ${data.extract}`;
                } catch (err) {
                    return `Could not search Wikipedia: ${err}`;
                }
            }

            case 'calculate': {
                try {

                    const expression = args.expression.replace(/[^0-9+\-*/().% ]/g, '');

                    const result = new Function('return ' + expression)();
                    if (isNaN(result)) return 'Invalid calculation';
                    return `${args.expression} = ${result}`;
                } catch (err) {
                    return `Could not calculate: ${err}`;
                }
            }

            case 'get_suggestions': {
                try {
                    const type = args.type || 'all';
                    const response = await api.get(`/suggestions/${type === 'all' ? 'active' : type}`);
                    const suggestions = response.data;
                    if (!suggestions || suggestions.length === 0) return 'No suggestions available right now';
                    return suggestions.map((s: any) =>
                        `[${s.type}] ${s.title}\n${s.description}\n${s.action_label ? 'Action: ' + s.action_label : ''}`
                    ).join('\n\n');
                } catch (err) {
                    return 'Could not fetch suggestions';
                }
            }

            default:
                return 'unknown tool';
        }
    } catch (err: any) {
        console.log('[ORITO] Tool execution error:', err);
        return `error: ${err.message || 'tool failed'}`;
    }
}


//------This Function handles the Build Context Prompt---------
function buildContextPrompt(emotionResult: EmotionResult): string {
    let contextPrompt = '';

    if (userContext.userName) {
        contextPrompt += `[User's name is ${userContext.userName}]\n`;
    }

    if (userContext.medicalCondition) {
        contextPrompt += `[User has ${userContext.medicalCondition}`;
        if (userContext.severity) contextPrompt += ` (${userContext.severity})`;
        contextPrompt += ']\n';
    }

    if (userContext.preferences) {
        const p = userContext.preferences as any;
        const prefParts: string[] = [];
        if (p.hobbies?.length) prefParts.push(`Hobbies: ${p.hobbies.join(', ')}`);
        if (p.important_people) prefParts.push(`Important people: ${p.important_people}`);
        if (p.time_preference) prefParts.push(`Most active: ${p.time_preference}`);
        if (p.music_genres?.length) prefParts.push(`Music: ${p.music_genres.join(', ')}`);
        if (p.favorite_food) prefParts.push(`Favorite food: ${p.favorite_food}`);
        if (p.daily_routine) prefParts.push(`Routine: ${p.daily_routine}`);
        if (prefParts.length > 0) {
            contextPrompt += `[User preferences: ${prefParts.join('. ')}]\n`;
        }
    }

    if (emotionResult.emotions.length > 0) {
        contextPrompt += `[Detected emotions: ${emotionResult.emotions.join(', ')} (primary: ${emotionResult.primary}, intensity: ${emotionResult.intensity}). Respond accordingly.]\n`;
    }

    if (userContext.detectedEmotions?.length > 0) {
        const recentEmotions = userContext.detectedEmotions.slice(-3);
        if (recentEmotions.length > 0) {
            contextPrompt += `[Recent emotional state: ${recentEmotions.join(', ')}]\n`;
        }
    }

    return contextPrompt;
}

//------This Function handles the Parse Tool Arguments---------
function parseToolArguments(rawArgs: string | undefined): any {
    if (!rawArgs || !rawArgs.trim()) {
        return {};
    }
    try {
        return JSON.parse(rawArgs);
    } catch {
        return {};
    }
}

//------This Function handles the Has Recent Aura Context In Conversation---------
function hasRecentAuraContextInConversation(): boolean {
    return conversationHistory
        .filter((message) => message.role !== 'system')
        .slice(-AURA_CONTEXT_LOOKBACK)
        .some((message) => /\b(aura|module|camera|microphone|mic|get_aura_status)\b/i.test(message.content || ''));
}

//------This Function handles the Should Inject Aura Ground Truth For Turn---------
function shouldInjectAuraGroundTruthForTurn(message: string): boolean {
    const normalized = message.toLowerCase().trim();
    const asksAuraStatus = /\b(aura|module|device|camera|microphone|mic)\b/.test(normalized) &&
        /\b(status|running|run|connected|connect|online|offline|available|working|work|up|down)\b/.test(normalized);

    if (asksAuraStatus) {
        return true;
    }

    const disagreementPattern = /\b(it'?s not|its not|not connected|disconnected|offline|wrong|are you sure|not true)\b/;
    if (disagreementPattern.test(normalized) && hasRecentAuraContextInConversation()) {
        return true;
    }

    if (/^(no|nope|nah)\b/.test(normalized) && hasRecentAuraContextInConversation()) {
        return true;
    }

    return false;
}

//------This Function handles the Add Aura Ground Truth System Message---------
function addAuraGroundTruthSystemMessage(source: 'direct' | 'tool'): void {
    if (!lastAuraStatusSnapshot) {
        return;
    }

    const statusLabel = lastAuraStatusSnapshot.connected ? 'CONNECTED' : 'NOT CONNECTED';
    const compactDetails = formatAuraStatusForTool(lastAuraStatusSnapshot).replace(/\n/g, ' | ');

    conversationHistory.push({
        role: 'system',
        content: `[Aura status check (${source}): ${statusLabel}. ${compactDetails}. In your next reply, do not contradict this status. If the user disagrees, politely restate the verified status and offer to re-check.]`,
    });
}

//------This Function handles the Maybe Inject Aura Ground Truth For Turn---------
async function maybeInjectAuraGroundTruthForTurn(message: string, toolsUsed: string[]): Promise<void> {
    if (!shouldInjectAuraGroundTruthForTurn(message)) {
        return;
    }

    await fetchAuraStatusSnapshot();
    toolsUsed.push('get_aura_status');
    addAuraGroundTruthSystemMessage('direct');
}

//------This Function handles the Should Force Tool Usage---------
function shouldForceToolUsage(message: string): boolean {
    const normalized = message.toLowerCase();
    const dataDomainPattern = /\b(medication|medications|meds|medicine|pill|dose|reminder|task|journal|memory|profile|condition|diagnosis|relative|family|caregiver|location|where am i|who is this|identify|sos|emergency|aura)\b/;
    const mutateIntentPattern = /\b(add|create|update|edit|change|delete|remove|mark|complete|call|show|list|get|fetch)\b/;
    const lookupPattern = /\b(what are my|show my|list my|who is|where is)\b/;

    if (lookupPattern.test(normalized)) {
        return true;
    }
    if (dataDomainPattern.test(normalized) && mutateIntentPattern.test(normalized)) {
        return true;
    }
    if (/\b(trigger sos|send sos|need help now|call caregiver)\b/.test(normalized)) {
        return true;
    }
    return false;
}

//------This Function handles the Detect Danger Signal---------
function detectDangerSignal(message: string): { danger: boolean; level: number; reason: string } {
    const normalized = message.toLowerCase();
    const criticalPatterns: Array<{ pattern: RegExp; reason: string; level: number }> = [
        { pattern: /\b(can'?t breathe|unable to breathe|breathing problem|chest pain|heart attack)\b/, reason: 'breathing or cardiac distress', level: 5 },
        { pattern: /\b(bleeding badly|heavy bleeding|blood everywhere|unconscious|passed out|not waking)\b/, reason: 'critical injury signs', level: 5 },
        { pattern: /\b(i fell|i have fallen|fall down|major fall|hit my head)\b/, reason: 'fall detected', level: 4 },
        { pattern: /\b(help me now|emergency|save me|danger|sos|call ambulance)\b/, reason: 'explicit emergency request', level: 5 },
        { pattern: /\b(i am lost|where am i|don'?t know where i am|confused and alone)\b/, reason: 'severe disorientation', level: 4 },
        { pattern: /\b(severe pain|extreme pain|hurting badly)\b/, reason: 'severe pain', level: 4 },
    ];

    for (const rule of criticalPatterns) {
        if (rule.pattern.test(normalized)) {
            return { danger: true, level: rule.level, reason: rule.reason };
        }
    }
    return { danger: false, level: 0, reason: '' };
}

//------This Function handles the Trigger Automatic Sos If Needed---------
async function triggerAutomaticSosIfNeeded(message: string): Promise<string | null> {
    const danger = detectDangerSignal(message);
    if (!danger.danger) {
        return null;
    }

    const excerpt = message.trim().slice(0, 180);
    const sosMessage = `Auto-SOS by Orito (${danger.reason}). User said: "${excerpt}"`;

    const result = await executeToolCall('trigger_sos', {
        level: danger.level,
        trigger: 'auto',
        message: sosMessage,
    });
    return `Automatic SOS check: ${result}`;
}

//------This Function handles the Send Message---------
// ─── Backend streaming helpers ───────────────────────────────────────────────

//------This Function resolves the backend base URL---------
function getBackendBaseUrl(): string {
    const manifestExtra =
        (Constants as any)?.manifest2?.extra?.expoClient?.extra ||
        (Constants as any)?.manifest?.extra ||
        Constants.expoConfig?.extra;
    return (
        process.env.EXPO_PUBLIC_BACKEND_URL ||
        manifestExtra?.backendUrl ||
        'http://10.0.2.2:8001'
    ).replace(/\/+$/, '');
}

//------This Function builds a local fallback response for dev auth sessions---------
function buildDevModeStreamReply(userMessage: string): string {
    const trimmedMessage = userMessage.trim();
    if (!trimmedMessage) {
        return "I'm ready. Ask me anything.";
    }

    return `I heard you: "${trimmedMessage}". Dev sign-in is active, so live backend chat streaming is disabled. Sign in with Google to use the full assistant.`;
}

//------This Function sends a message and streams tokens from backend---------
export async function sendMessageStream(
    userMessage: string,
    onToken: (token: string) => void,
    onToolCall?: (toolName: string) => void,
): Promise<string> {
    if (!isInitialized) {
        await initializeOrito();
    }

    userContext.lastInteractionTime = new Date();

    const token = await getAuthToken();
    const baseUrl = getBackendBaseUrl();

    const historyToSend = conversationHistory.slice(-30);

    let fullReply = '';
    try {
        if (token && isDevToken(token)) {
            const devReply = buildDevModeStreamReply(userMessage);
            const chunks = devReply.split(' ');
            chunks.forEach((chunk, index) => {
                const tokenChunk = `${index > 0 ? ' ' : ''}${chunk}`;
                fullReply += tokenChunk;
                onToken(tokenChunk);
            });
        } else {
            const response = await fetch(`${baseUrl}/orito/chat/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({
                    messages: historyToSend,
                    user_message: userMessage,
                    temperature: 0.85,
                    max_tokens: 1024,
                }),
            });

            if (!response.ok) {
                if ((response.status === 401 || response.status === 403) && token) {
                    await clearAuthToken();
                    authEvents.emit('unauthorized');
                }

                throw new OritoError(
                    `Backend returned ${response.status}`,
                    ErrorCodes.AI_SERVICE_ERROR,
                    true,
                    { status: response.status },
                );
            }

            const reader = response.body?.getReader();
            if (!reader) throw new OritoError('No response body', ErrorCodes.AI_SERVICE_ERROR, true);

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (!payload) continue;
                    try {
                        const data = JSON.parse(payload);
                        if (data.token) {
                            fullReply += data.token;
                            onToken(data.token);
                        }
                        if (data.tool_call && onToolCall) {
                            onToolCall(data.tool_call);
                        }
                    } catch { /* ignore malformed SSE lines */ }
                }
            }
        }
    } catch (err: any) {
        const { code, recoverable } = classifyError(err);
        if (recoverable) return getRecoveryResponse(code);
        return "I'm having some trouble right now. Let's try again in a moment.";
    }

    const reply = fullReply || getRecoveryResponse(ErrorCodes.AI_SERVICE_ERROR);
    conversationHistory.push({ role: 'user', content: userMessage });
    conversationHistory.push({ role: 'assistant', content: reply });
    await saveConversationHistory();
    await saveUserContext();
    logInteractionToBackend('text', userMessage, reply, []).catch(() => { });
    return reply;
}

//------This Function sends a message and returns the full reply---------
export async function sendMessage(userMessage: string): Promise<string> {
    if (!isInitialized) {
        await initializeOrito();
    }

    userContext.lastInteractionTime = new Date();

    return sendMessageStream(userMessage, () => { });
}

//------This Function handles the Send Voice Message---------
export async function sendVoiceMessage(userMessage: string): Promise<string> {
    return sendMessageStream(userMessage, () => { });
}

//------This Function handles the Generate Daily Insights---------
export async function generateDailyInsights(patientInfo: any, meds: any[]): Promise<{ title: string; desc: string } | null> {
    const context = `
    PATIENT CONTEXT:
    Condition: ${patientInfo?.condition || 'Unknown'}
    Severity: ${patientInfo?.severity || 'Unknown'}
    Notes: ${patientInfo?.notes || 'None'}
    Medications: ${meds.map(m => m.name).join(', ') || 'None'}
    `;

    const body = {
        user_message: `You are an empathetic medical AI assistant. Analyze the patient context and generate ONE single daily insight/suggestion.
            It should be specific, actionable, and caring.
            Return ONLY raw JSON (no markdown) in this format: { "title": "Short Title", "desc": "1-2 sentence description" }

${context}`,
        messages: [],
        temperature: 0.7,
        max_tokens: 150,
    };

    try {
        const res = await api.post('/orito/chat', body);
        const data = res.data;
        const content = data.message?.content;
        return content ? JSON.parse(content) : null;
    } catch (e) {
        console.log('Insight gen error', e);
        return null;
    }
}





export interface OritoInteractionPayload {
    interaction_type: 'voice' | 'text';
    user_message: string;
    bot_response: string;
    emotions_detected?: string[];
    tools_used?: string[];
    metadata?: Record<string, any>;
}

export interface OritoInteractionResponse {
    id: string;
    user_uid: string;
    interaction_type: string;
    user_message: string;
    bot_response: string;
    emotions_detected: string[];
    tools_used: string[];
    metadata: Record<string, any>;
    created_at: string;
}


//------This Function handles the Log Interaction To Backend---------
export async function logInteractionToBackend(
    interactionType: 'voice' | 'text',
    userMessage: string,
    botResponse: string,
    toolsUsed: string[] = [],
    metadata: Record<string, any> = {}
): Promise<OritoInteractionResponse | null> {
    try {
        const emotionResult = detectEmotion(userMessage);
        const payload: OritoInteractionPayload = {
            interaction_type: interactionType,
            user_message: userMessage,
            bot_response: botResponse,
            emotions_detected: emotionResult.emotions,
            tools_used: toolsUsed,
            metadata: {
                ...metadata,
                primary_emotion: emotionResult.primary,
                emotion_intensity: emotionResult.intensity,
            },
        };

        const response = await api.post('/orito/interactions', payload);
        console.log('[ORITO] Interaction logged to backend:', response.data.id);
        return response.data;
    } catch (err) {
        console.log('[ORITO] Failed to log interaction to backend:', err);
        return null;
    }
}


//------This Function handles the Load Interaction History---------
export async function loadInteractionHistory(hours: number = 24, limit: number = 20): Promise<OritoInteractionResponse[]> {
    try {
        const response = await api.get('/orito/interactions/recent', {
            params: { hours, limit },
        });
        console.log('[ORITO] Loaded', response.data.length, 'recent interactions from backend');
        return response.data;
    } catch (err) {
        console.log('[ORITO] Failed to load interaction history:', err);
        return [];
    }
}


//------This Function handles the Get Emotion Analytics---------
export async function getEmotionAnalytics(days: number = 7): Promise<{
    period_days: number;
    total_interactions: number;
    emotion_counts: Record<string, number>;
    dominant_emotion: string | null;
} | null> {
    try {
        const response = await api.get('/orito/analytics/emotions', {
            params: { days },
        });
        return response.data;
    } catch (err) {
        console.log('[ORITO] Failed to get emotion analytics:', err);
        return null;
    }
}


//------This Function handles the Initialize Orito Context---------
export async function initializeOritoContext(): Promise<void> {
    await initializeOrito();
}

//------This Function handles the Generate Calendar Insights---------
export async function generateCalendarInsights(
    date: Date,
    meds: any[]
): Promise<{ title: string; desc: string } | null> {
    const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long' });
    //------This Function handles the Meds Today---------
    const medsToday = meds.filter(m => m.is_active !== false);

    const context = `
    Date: ${date.toDateString()} (${dayOfWeek})
    Medications scheduled: ${medsToday.map(m => `${m.name} at ${m.schedule_times?.join(', ')}`).join('; ') || 'None'}
    
    Generate ONE specific wellness suggestion for this day. Consider:
    - Medication timing and - Daily routine optimization potential interactions
   
    - Health tips appropriate for the day of week
    - Activities that complement medication schedule
    `;

    const body = {
        user_message: `You are a helpful wellness AI. Generate practical daily health suggestions.
                Keep suggestions positive, actionable, and specific to the day.
                Return ONLY raw JSON: { "title": "Short Activity Title (2-4 words)", "desc": "1-2 sentence actionable suggestion" }

${context}`,
        messages: [],
        temperature: 0.7,
        max_tokens: 150,
    };

    try {
        const res = await api.post('/orito/chat', body);
        const data = res.data;
        const content = data.message?.content;
        return content ? JSON.parse(content) : null;
    } catch (e) {
        console.log('Calendar insight error', e);
        return null;
    }
}


//------This Function handles the Scan Medical Sheet---------
export async function scanMedicalSheet(imageBase64: string): Promise<{
    name?: string;
    dosage?: string;
    frequency?: string;
    times?: string[];
} | null> {
    const prompt = `Extract medication information from this prescription/medical sheet image. 
Look for:
- Medication name (drug name)
- Dosage (e.g., "500mg", "10mg", "2 tablets")
- Frequency (e.g., "once daily", "twice daily", "3 times a day", "as needed")
- Schedule times (e.g., "8:00 AM", "morning and evening", "every 8 hours")

Return ONLY a JSON object with the extracted information:
{
    "name": "medication name here",
    "dosage": "dosage here",
    "frequency": "frequency here",
    "times": ["8:00 AM", "8:00 PM"]
}

If a field cannot be determined from the image, omit it from the response.
If no medication information is found, return an empty object: {}`;

    const body = {
        user_message: prompt,
        messages: [],
        temperature: 0.1,
        max_tokens: 200,
    };

    try {
        const res = await api.post('/orito/chat', body);
        const data = res.data;
        const content = data.message?.content;
        if (content) {

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
        }
        return null;
    } catch (e) {
        console.log('[scanMedicalSheet] Error:', e);
        return null;
    }
}





export interface ProactiveReminder {
    type: 'medication' | 'reminder';
    title: string;
    description: string;
    datetime: string;
    urgency: 'high' | 'medium' | 'low';
}


//------This Function handles the Check Proactive Reminders---------
export async function checkProactiveReminders(): Promise<ProactiveReminder[]> {
    const reminders: ProactiveReminder[] = [];
    const now = new Date();

    try {

        const medsRes = await api.get('/medications/pending');
        const medications = medsRes.data;

        for (const med of medications) {
            if (med.schedule_times && med.schedule_times.length > 0) {
                for (const time of med.schedule_times) {
                    const [hours, minutes] = time.split(':').map(Number);
                    const scheduledTime = new Date(now);
                    scheduledTime.setHours(hours, minutes, 0, 0);


                    const diffMinutes = (scheduledTime.getTime() - now.getTime()) / (1000 * 60);

                    if (diffMinutes >= -30 && diffMinutes <= 30) {
                        reminders.push({
                            type: 'medication',
                            title: `Time for ${med.name}`,
                            description: `${med.dosage || 'Take your medication'}`,
                            datetime: scheduledTime.toISOString(),
                            urgency: diffMinutes >= 0 ? 'high' : 'low'
                        });
                    }
                }
            }
        }
    } catch (err) {
        console.log('[ORITO] Error checking medications:', err);
    }

    try {

        const remindersRes = await api.get('/reminders/', { params: { status: 'active' } });
        const activeReminders = remindersRes.data;

        for (const reminder of activeReminders) {
            const reminderTime = new Date(reminder.datetime);
            const diffMinutes = (reminderTime.getTime() - now.getTime()) / (1000 * 60);


            if (diffMinutes >= 0 && diffMinutes <= 60) {
                reminders.push({
                    type: 'reminder',
                    title: reminder.title,
                    description: reminder.description || '',
                    datetime: reminder.datetime,
                    urgency: diffMinutes <= 15 ? 'high' : 'medium'
                });
            }
        }
    } catch (err) {
        console.log('[ORITO] Error checking reminders:', err);
    }

    return reminders.sort((a, b) => {
        const urgencyOrder = { high: 0, medium: 1, low: 2 };
        return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    });
}


export { initializeOrito as initialize };


//------This Function handles the Get User Context---------
export function getUserContext(): UserContext {
    return { ...userContext };
}
