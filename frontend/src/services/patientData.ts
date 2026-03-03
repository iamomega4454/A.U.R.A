import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pedometerService, StepData } from './pedometer';

export interface PatientProfile {
    condition: string;
    severity: string;
    diagnosis_date?: string;
    notes?: string;
}

export interface Medication {
    id?: string;
    name: string;
    dosage: string;
    frequency: string;
    schedule_times: string[];
    is_active?: boolean;
}

export interface Caregiver {
    id?: string;
    name?: string;
    email: string;
    relationship?: string;
}

export interface RelativeSummary {
    id?: string;
    name: string;
    relationship?: string;
    phone?: string;
    notes?: string;
    has_embeddings?: boolean;
    photo_count?: number;
}

export interface UserProfileData {
    user: {
        id: string;
        email: string;
        name?: string;
        display_name?: string;
        role: string;
        age?: number;
        preferences?: Record<string, any>;
    };
    patient_profile?: PatientProfile;
    medications: Medication[];
    caregivers: Caregiver[];
    relatives?: RelativeSummary[];
    steps?: StepData;
}

class PatientDataService {
    //------This Function handles the Load Profile---------
    async loadProfile(): Promise<UserProfileData | null> {
        try {
            const response = await api.get('/user/profile');
            const data = response.data;

            if (data.patient_profile) {
                await AsyncStorage.setItem('patient_info', JSON.stringify(data.patient_profile));
            }
            if (data.medications) {
                await AsyncStorage.setItem('medications', JSON.stringify(data.medications));
            }
            if (data.caregivers) {
                await AsyncStorage.setItem('caregivers', JSON.stringify(data.caregivers));
            }

            return data;
        } catch (error) {
            console.error('Failed to load patient profile:', error);
            return this.loadFromCache();
        }
    }

    //------This Function handles the Load From Cache---------
    async loadFromCache(): Promise<UserProfileData | null> {
        try {
            const patientInfo = await AsyncStorage.getItem('patient_info');
            const medications = await AsyncStorage.getItem('medications');
            const caregivers = await AsyncStorage.getItem('caregivers');

            return {
                user: { id: '', email: '', role: 'patient' },
                patient_profile: patientInfo ? JSON.parse(patientInfo) : undefined,
                medications: medications ? JSON.parse(medications) : [],
                caregivers: caregivers ? JSON.parse(caregivers) : [],
            };
        } catch (error) {
            console.error('Failed to load from cache:', error);
            return null;
        }
    }

    //------This Function handles the Update Patient Info---------
    async updatePatientInfo(data: Partial<PatientProfile>): Promise<void> {
        try {
            await api.patch('/user/profile', data);
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to update patient info:', error);
            throw error;
        }
    }

    //------This Function handles the Save Medication---------
    async saveMedication(medication: Medication): Promise<void> {
        try {
            if (medication.id) {
                await api.put(`/medications/${medication.id}`, medication);
            } else {
                await api.post('/medications/', medication);
            }
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to save medication:', error);
            throw error;
        }
    }

    //------This Function handles the Delete Medication---------
    async deleteMedication(id: string): Promise<void> {
        try {
            await api.delete(`/medications/${id}`);
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to delete medication:', error);
            throw error;
        }
    }

    //------This Function handles the Add Caregiver---------
    async addCaregiver(email: string, relationship?: string): Promise<void> {
        try {
            await api.post('/user/caregivers', { email, relationship });
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to add caregiver:', error);
            throw error;
        }
    }

    //------This Function handles the Remove Caregiver---------
    async removeCaregiver(email: string): Promise<void> {
        try {
            await api.delete(`/user/caregivers/${encodeURIComponent(email)}`);
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to remove caregiver:', error);
            throw error;
        }
    }

    //------This Function handles the Get Patient Context---------
    async getPatientContext(): Promise<string> {
        try {
            const info = await AsyncStorage.getItem('patient_info');
            const meds = await AsyncStorage.getItem('medications');
            const caregivers = await AsyncStorage.getItem('caregivers');
            const prefsRaw = await AsyncStorage.getItem('patient_preferences');
            const prefs = prefsRaw ? JSON.parse(prefsRaw) : null;

            const stepData = await pedometerService.getStepData();
            const stepSummary = await pedometerService.getStepSummary();

            const context = {
                condition: info ? JSON.parse(info) : null,
                medications: meds ? JSON.parse(meds).map((m: Medication) => ({
                    name: m.name,
                    dosage: m.dosage,
                    times: m.schedule_times,
                })) : [],
                caregivers: caregivers ? JSON.parse(caregivers).map((c: Caregiver) => ({
                    name: c.name || c.email,
                    relationship: c.relationship,
                })) : [],
                steps: {
                    today: stepData.steps,
                    goal: stepData.goal,
                    summary: stepSummary,
                },
                preferences: prefs ? {
                    preferred_name: prefs.communication_style || null,
                    joys: prefs.hobbies || [],
                    important_people: prefs.important_people || null,
                    time_of_day: prefs.time_preference || null,
                    favorite_food: prefs.favorite_food || null,
                    daily_routine: prefs.daily_routine || null,
                    health_notes: prefs.health_notes || null,
                    dietary_notes: prefs.dietary_notes || null,
                    wellness_habits: prefs.wellness_habits || null,
                } : null,
            };

            return JSON.stringify(context, null, 2);
        } catch (error) {
            console.error('Failed to get patient context:', error);
            return 'Could not access patient information.';
        }
    }

    //------This Function handles the Get Profile---------
    async getProfile(): Promise<UserProfileData | null> {
        return this.loadProfile();
    }
    
    //------This Function handles the Get Step Data---------
    async getStepData(): Promise<StepData> {
        return pedometerService.getStepData();
    }
    
    //------This Function handles the Get Step Summary---------
    async getStepSummary(): Promise<string> {
        return pedometerService.getStepSummary();
    }
}

export const patientDataService = new PatientDataService();
