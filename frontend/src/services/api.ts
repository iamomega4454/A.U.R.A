import axios from 'axios';
import Constants from 'expo-constants';
import { clearAuthToken, getAuthToken, isDevToken } from './authToken';

const manifestExtra =
    (Constants as any)?.manifest2?.extra?.expoClient?.extra ||
    (Constants as any)?.manifest?.extra ||
    Constants.expoConfig?.extra;

const API_BASE = (
    process.env.EXPO_PUBLIC_BACKEND_URL ||
    manifestExtra?.backendUrl ||
    'http://10.0.2.2:8001'
).replace(/\/+$/, '');

const api = axios.create({
    baseURL: API_BASE,
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
});

const DEV_MOCK_RESPONSES: Record<string, any> = {
    '/auth/me': { id: 'dev', display_name: 'Dev User', role: 'patient', is_onboarded: true },
    '/suggestions/active': [],
    '/medications/': [],
    '/journal/': [],
    '/relatives/': [],
    '/reports/daily-summary': { mood: [], events: [], summary: '' },
    '/sos/active': [],
    '/location/latest': null,
    '/notifications/register': { ok: true },
};

api.interceptors.request.use(async (config) => {
    const token = await getAuthToken();
    if (token) {
        if (isDevToken(token) && config.url !== '/health') {
            //------This Function handles the Mock Key---------
            const mockKey = Object.keys(DEV_MOCK_RESPONSES).find(key =>
                config.url?.startsWith(key)
            );
            const mockData = mockKey !== undefined ? DEV_MOCK_RESPONSES[mockKey] : (
                config.method === 'get' ? [] : { ok: true }
            );

            const error: any = new axios.Cancel('dev-mock');
            error.response = { data: mockData, status: 200, headers: {} };
            config.adapter = () => Promise.resolve({
                data: mockData,
                status: 200,
                statusText: 'OK',
                headers: {},
                config,
            });
            return config;
        }

        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

api.interceptors.response.use(
    (res) => res,
    async (err) => {
        if (err.response?.status === 401) {
            const token = await getAuthToken();
            if (token && isDevToken(token)) {
                return Promise.reject(err);
            }
            await clearAuthToken();
            const { authEvents } = require('./authEvents');
            authEvents.emit('unauthorized');
        }
        return Promise.reject(err);
    }
);

export default api;
