import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';

const AURA_KEY = 'aura_module_address';
const AURA_PORT = 8001;
const SCAN_TIMEOUT_MS = 2000;

interface AuraDevice {
    service: string;
    hostname: string;
    ip: string;
    ws_port: number;
    port?: number;
    version: string;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

let ws: WebSocket | null = null;
let messageHandler: ((data: any) => void) | null = null;
let stateChangeHandler: ((state: ConnectionState) => void) | null = null;
let connectionState: ConnectionState = 'disconnected';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]; 


let storedIp: string = '';
let storedPort: number = 8001;
let storedPatientUid: string = '';
let storedAuthToken: string = '';
let storedBackendUrl: string = '';

//------This Function handles the Normalize Backend Url---------
function normalizeBackendUrl(url: string): string {
    const trimmed = (url || '').trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return '';
    }
    return trimmed.replace(/\/+$/, '');
}

//------This Function handles the Get Saved Module---------
export async function getSavedModule(): Promise<AuraDevice | null> {
    const saved = await AsyncStorage.getItem(AURA_KEY);
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch { }
    }
    return null;
}

//------This Function handles the Probe Ip---------
async function probeIp(ip: string, port: number): Promise<AuraDevice | null> {
    const controller = new AbortController();
    //------This Function handles the Timeout---------
    const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    try {
        const resp = await fetch(`http://${ip}:${port}/health`, {
            signal: controller.signal,
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.service === 'AURA_MODULE') {
                return {
                    service: data.service,
                    hostname: data.hostname || '',
                    ip: data.ip || ip,
                    ws_port: data.ws_port || port,
                    version: data.version || '1.0.0',
                };
            }
        }
    } catch {
    } finally {
        clearTimeout(timeout);
    }
    return null;
}

//------This Function handles the Get Subnet Prefix---------
async function getSubnetPrefix(): Promise<string | null> {
    try {
        const networkState = await Network.getIpAddressAsync();
        if (networkState) {
            const parts = networkState.split('.');
            if (parts.length === 4) {
                return `${parts[0]}.${parts[1]}.${parts[2]}`;
            }
        }
    } catch { }
    return null;
}

//------This Function handles the Scan For Aura Module---------
export async function scanForAuraModule(
    onProgress?: (percent: number) => void,
    onDeviceFound?: (device: AuraDevice) => void,
): Promise<void> {

    const saved = await getSavedModule();
    if (saved) {
        const verified = await probeIp(saved.ip, saved.ws_port);
        if (verified) {
            onDeviceFound?.(verified);
        }
    }

    const subnet = await getSubnetPrefix();
    if (!subnet) {
        onProgress?.(100);
        return;
    }

    const priorityEndings = [1, 2, 100, 101, 102, 103, 104, 105, 50, 51, 200, 150];

    for (const ending of priorityEndings) {
        const ip = `${subnet}.${ending}`;
        const found = await probeIp(ip, AURA_PORT);
        if (found) {
            onDeviceFound?.(found);
        }
    }
    onProgress?.(10);

    const BATCH_SIZE = 20;
    const allIps: string[] = [];
    for (let i = 2; i <= 254; i++) {
        if (!priorityEndings.includes(i)) {
            allIps.push(`${subnet}.${i}`);
        }
    }

    for (let batchStart = 0; batchStart < allIps.length; batchStart += BATCH_SIZE) {
        const batch = allIps.slice(batchStart, batchStart + BATCH_SIZE);
        //------This Function handles the Results---------
        const results = await Promise.all(batch.map((ip) => probeIp(ip, AURA_PORT)));

        for (const result of results) {
            if (result) {
                onDeviceFound?.(result);
            }
        }

        const percent = Math.min(10 + Math.round(((batchStart + BATCH_SIZE) / allIps.length) * 90), 99);
        onProgress?.(percent);
    }

    onProgress?.(100);
}

//------This Function handles the Verify Aura Module---------
export async function verifyAuraModule(ip: string, port: number = AURA_PORT): Promise<AuraDevice | null> {
    return probeIp(ip, port);
}

//------This Function handles the Save Aura Address---------
export async function saveAuraAddress(device: AuraDevice) {
    await AsyncStorage.setItem(AURA_KEY, JSON.stringify(device));
}

//------This Function handles the Connect To Aura---------
export function connectToAura(
    ip: string,
    port: number,
    patientUid: string,
    authToken: string,
    backendUrl?: string,
    onMessage?: (data: any) => void,
    onStateChange?: (state: ConnectionState) => void,
): WebSocket {
    
    storedIp = ip;
    storedPort = port;
    storedPatientUid = patientUid;
    storedAuthToken = authToken;
    storedBackendUrl = normalizeBackendUrl(backendUrl || storedBackendUrl);
    messageHandler = onMessage || null;
    stateChangeHandler = onStateChange || null;
    
    const url = `ws://${ip}:${port}/ws`;
    ws = new WebSocket(url);
    connectionState = 'connecting';
    stateChangeHandler?.('connecting');

    ws.onopen = () => {
        
        reconnectAttempts = 0;
        connectionState = 'connected';
        stateChangeHandler?.('connected');
        console.log('[AURA] WebSocket connected');
        
        const connectPayload: Record<string, string> = {
            command: 'connect',
            patient_uid: patientUid,
            auth_token: authToken,
        };
        if (storedBackendUrl) {
            connectPayload.backend_url = storedBackendUrl;
        }
        ws?.send(JSON.stringify(connectPayload));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            messageHandler?.(data);
        } catch { }
    };

    ws.onerror = (event) => {
        console.error('[AURA] WebSocket error:', event);
    };

    ws.onclose = (event) => {
        const wasConnected = connectionState === 'connected';
        connectionState = 'disconnected';
        stateChangeHandler?.('disconnected');
        
        console.log('[AURA] WebSocket closed, attempting reconnection...');
        
        
        if (wasConnected || reconnectAttempts > 0) {
            attemptReconnection();
        } else if (reconnectAttempts === 0) {
            
            attemptReconnection();
        }
    };
    
    return ws;
}


//------This Function handles the Attempt Reconnection---------
const attemptReconnection = () => {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[AURA] Max reconnection attempts reached');
        connectionState = 'disconnected';
        stateChangeHandler?.('disconnected');
        return;
    }
    
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    connectionState = 'reconnecting';
    stateChangeHandler?.('reconnecting');
    reconnectAttempts++;
    
    console.log(`[AURA] Attempting reconnection ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);
    
    setTimeout(() => {
        if (storedIp && storedPort) {
            try {
                connectToAura(
                    storedIp,
                    storedPort,
                    storedPatientUid,
                    storedAuthToken,
                    storedBackendUrl,
                    messageHandler ?? undefined,
                    stateChangeHandler ?? undefined
                );
            } catch (err: unknown) {
                console.log('[AURA] Reconnection failed, will retry...');
            }
        }
    }, delay);
};

//------This Function handles the Send Aura Command---------
export function sendAuraCommand(command: string, extra: Record<string, any> = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ command, ...extra }));
    }
}

//------This Function handles the Disconnect Aura---------
export function disconnectAura() {
    
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS; 
    connectionState = 'disconnected';
    stateChangeHandler?.('disconnected');
    
    if (ws) {
        ws.close();
        ws = null;
    }
}

//------This Function handles the Is Aura Connected---------
export function isAuraConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
}

//------This Function handles the Trigger Aura Face Recognition---------
export async function triggerAuraFaceRecognition(
    relatives?: Array<{ id: string; name: string; relationship?: string }>
): Promise<{
    success: boolean;
    identifiedFaces?: Array<{
        person_id: string;
        person_name: string;
        confidence: number;
        relationship?: string;
    }>;
    personId?: string;
    personName?: string;
    confidence?: number;
    error?: string;
}> {
    const api = (await import('./api')).default;

    try {
        
        const payload: { relatives?: Array<{ id: string; name: string; relationship?: string }> } = {};
        
        
        if (relatives && relatives.length > 0) {
            payload.relatives = relatives.map(r => ({
                id: r.id,
                name: r.name,
                relationship: r.relationship || ''
            }));
        }
        
        
        const response = await api.post('/aura/identify_person', payload, {
            timeout: 30000
        });

        const data = response.data;

        if (data.success && data.identified_faces && data.identified_faces.length > 0) {
            const firstFace = data.identified_faces[0];
            return {
                success: true,
                identifiedFaces: data.identified_faces,
                personId: firstFace.person_id,
                personName: firstFace.person_name,
                confidence: firstFace.confidence,
            };
        } else if (data.success === false && data.error === 'no_face_detected') {
            return {
                success: false,
                error: 'No face detected in camera. Please position yourself in front of the camera.',
            };
        } else if (data.success === false && data.error === 'no_camera_frame') {
            return {
                success: false,
                error: 'Aura module camera is not available. Please check the camera connection.',
            };
        } else {
            return {
                success: false,
                error: 'Face recognition completed but no match found.',
            };
        }
    } catch (err: any) {
        if (err.response?.status === 404) {
            return {
                success: false,
                error: 'Aura module not registered. Please ensure the module is connected.',
            };
        } else if (err.response?.status === 503) {
            return {
                success: false,
                error: 'Aura module is offline. Please check the module connection.',
            };
        } else if (err.response?.status === 502) {
            return {
                success: false,
                error: err.response?.data?.detail || 'Aura module request failed. Please try again.',
            };
        } else if (err.response?.status === 504) {
            return {
                success: false,
                error: 'Face recognition timed out. Please try again.',
            };
        } else if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
            return {
                success: false,
                error: 'Backend connection timed out. Please try again.',
            };
        } else {
            return {
                success: false,
                error: 'Failed to connect to backend for face recognition.',
            };
        }
    }
}
