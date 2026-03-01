# AGENTS.md - Developer Guide for A.U.R.A

## Project Overview
A.U.R.A (Assistive User Reminder App) - Healthcare assistance platform with 3 modules:
- **Frontend** (React Native / Expo) - Mobile application for patients and caregivers
- **Backend** (Python FastAPI) - REST API server handling data persistence and business logic
- **Auramodule** (Python - Raspberry Pi) - IoT device module for hardware interaction

## Build Commands

### Frontend
```bash
cd frontend

# Install dependencies (run once after clone or when package.json changes)
npm install

# Development server with Expo (starts Metro bundler and provides QR code)
npm start

# Run on Android device/emulator (requires Android SDK configured)
npm run android

# Run on iOS simulator (requires Xcode and iOS SDK)
npm run ios

# Build release APK for distribution
npm run build:android

# TypeScript type checking only
npx tsc --noEmit

# Run linter on specific files
npx eslint src/components/*.tsx

# Clear Metro bundler cache (use when facing build issues)
npx expo start --clear
```

### Backend
```bash
cd backend

# Create and activate virtual environment (run once)
python -m venv venv && source venv/bin/activate
# On Windows: venv\Scripts\activate

# Install all dependencies from requirements.txt
pip install -r requirements.txt

# Start development server with auto-reload
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload

# Run with specific worker count for production
uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers 4

# Run all tests with verbose output
pytest -v

# Run tests with coverage report
pytest --cov=app --cov-report=html

# Run single test function
pytest tests/test_file.py::test_function_name -v

# Run tests matching a pattern
pytest -k "test_user"

# Linting and formatting checks
flake8 app/
black --check app/
mypy app/
```

### Auramodule
```bash
cd auramodule

# Create and activate virtual environment
python -m venv venv && source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run with default configuration
python -m app.main

# Run with specific patient UID (required for patient-specific operations)
PATIENT_UID=your_uid python -m app.main

# Run with debug logging enabled
DEBUG=1 python -m app.main

# Run tests
pytest tests/ -v
```

## Code Style

### TypeScript (Frontend)
**Imports Order:** React/React Native core → Expo SDK → Third-party → Local component → Theme/constants

**Function Headings:**
```typescript
//------This Function handles the user authentication---------
const authenticateUser = async (credentials: Credentials) => { ... }
```

**Naming Conventions:**
- Components: PascalCase (e.g., `UserProfile`, `ReminderCard`)
- Functions/variables: camelCase (e.g., `fetchReminders`, `isLoading`)
- Files: camelCase (e.g., `userService.ts`, `reminderCard.tsx`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_RETRY_COUNT`)

**Type Definitions:** Always define interfaces for props, API responses, and data models. Avoid `any` - use `unknown` if truly unknown. Use generics when applicable.

**Styling:**
```typescript
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  card: { borderRadius: 12, padding: 16, marginVertical: 8 },
});
// Reference as s.container, s.card
```

**Component Structure:**
```typescript
interface Props { title: string; onSubmit: () => void; }

export const FormComponent: React.FC<Props> = ({ title, onSubmit }) => {
  const [state, setState] = useState<string>('');
  //------This Function handles form submission---------
  const handleSubmit = () => { ... };
  return (<View style={s.container}><Text>{title}</Text></View>);
};
```

### Python (Backend & Auramodule)
**Imports Order:** Standard library → Third-party → Local application

**Function Headings:**
```python
#------This Function handles the user authentication---------
def authenticate_user(credentials: Credentials) -> User: ...
```

**Naming Conventions:**
- Classes: PascalCase (e.g., `UserModel`, `ReminderService`)
- Functions/variables: snake_case (e.g., `get_reminders`, `is_active`)
- Files: snake_case (e.g., `user_service.py`)
- Constants: UPPER_SNAKE_CASE

**Type Hints:** Use `Optional[X]` not `X | None`, `Union[X, Y]` not `X | Y`, use `List[X]`, `Dict[str, X]` from typing

**Pydantic Models (v2):**
```python
from pydantic import BaseModel, Field, field_validator

class ReminderCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    scheduled_at: datetime
    patient_id: str

    @field_validator('scheduled_at')
    @classmethod
    def validate_scheduled_at(cls, v: datetime) -> datetime:
        if v < datetime.now():
            raise ValueError('Scheduled time must be in the future')
        return v
```

## Error Handling

### Frontend
- Wrap async operations in try/catch blocks
- Use Alert.alert() for user-facing error messages
- Log errors to console with context
- Show loading states during async operations

### Backend
- Always log errors with logger module
- Re-raise HTTPException with appropriate status codes
- Use dependency injection for error handling
- Implement global exception handlers in main.py

```python
try:
    result = await service.process_data(data)
except ValueError as e:
    logger.error(f"Validation error: {e}")
    raise HTTPException(status_code=400, detail=str(e))
except Exception as e:
    logger.exception("Unexpected error occurred")
    raise HTTPException(status_code=500, detail="Internal server error")
```

## Testing

### Frontend Testing
- Use Jest (included with Expo) for unit testing
- Test components with React Native Testing Library
- Mock API calls with jest.mock()

```typescript
import { render, fireEvent } from '@testing-library/react-native';

test('renders reminder card correctly', () => {
  const onPress = jest.fn();
  const { getByText } = render(<ReminderCard title="Take Medicine" onPress={onPress} />);
  expect(getByText('Take Medicine')).toBeTruthy();
  fireEvent.press(getByText('Take Medicine'));
  expect(onPress).toHaveBeenCalled();
});
```

### Backend Testing
- Use pytest with pytest-asyncio for async tests
- Use fixtures for test database setup
- Create test clients with FastAPI TestClient

```python
import pytest
from fastapi.testclient import TestClient
from app.main import app

@pytest.fixture
def client():
    return TestClient(app)

def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
```

### Test Naming
- Use descriptive test names: `test_user_can_create_reminder`
- Group related tests in classes
- One assertion per test when possible

## Skills

The following agent skills are installed in `.agents/skills/` and must be applied for the relevant use cases below.

### `vercel-react-native-skills`
**Always use** for any React Native / Expo work in the `frontend/` module. This includes:
- Building or modifying React Native components
- Optimizing list and scroll performance (FlashList, memoization)
- Implementing animations with Reanimated
- Working with images, media, and native modules
- Navigation (use native stack/tab navigators)
- Structuring the Expo monorepo

Reference rules in `.agents/skills/vercel-react-native-skills/rules/` and the compiled guide in `AGENTS.md` inside that skill.

### `better-auth-best-practices`
**Use** for all authentication and authorization work in the backend (`backend/`):
- Implementing or reviewing auth flows, sessions, tokens, OAuth
- Setting up Better Auth library integrations
- Security hardening of auth-related endpoints

### `fastapi-templates`
**Use** for all FastAPI backend development (`backend/`):
- Creating new API routes, routers, and endpoints
- Structuring request/response models and middleware
- FastAPI project patterns and best practices

### `python-testing-patterns`
**Use** for all Python test writing across `backend/` and `auramodule/`:
- Writing pytest tests, fixtures, and async test cases
- Mocking, patching, and test coverage strategies
- Integration and unit testing patterns for FastAPI

### `iot-engineer`
**Use** for all Raspberry Pi / IoT work in `auramodule/`:
- Hardware GPIO, sensor integration, and device communication
- Edge device deployment and resource-constrained programming
- IoT protocols (MQTT, I2C, SPI) and reliability patterns

### `fhir-developer-skill`
**Use** for healthcare data standards and compliance throughout the project:
- FHIR resource modeling for patient and medication data
- Healthcare interoperability and data exchange
- HIPAA-relevant data handling and privacy patterns

### `api-security-best-practices`
**Use** when writing or reviewing any backend API code in `backend/`:
- Input validation, rate limiting, and injection prevention
- Authentication middleware, CORS, and token security
- OWASP Top 10 compliance for the FastAPI server

### `machine-learning-engineer`
**Use** whenever the task involves ML in the `auramodule/` or any part of the project:
- Deploying ML models to production or to the Raspberry Pi edge device
- Building real-time inference APIs
- Model optimization and compression (quantization, pruning, ONNX)
- Batch prediction systems and ML serving infrastructure
- Auto-scaling, monitoring, and MLOps

### `find-skills`
**Use** when the team needs a new capability not covered by existing skills:
- Run `npx skills find <query>` to discover skills from skills.sh
- Always check the security risk rating before installing (reject High/Critical Risk)
- Only install from trusted publishers (vercel-labs, anthropics, wshobson, 404kidwiz, better-auth)

### `web-design-guidelines`
**Use** when reviewing any web UI code for compliance and best practices:
- Auditing web interface code for accessibility and UX
- Reviewing HTML/CSS/JS against Web Interface Guidelines
- Triggered by: "review my UI", "check accessibility", "audit design", "check my site"

Fetches live guidelines from `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` before each review.

### `frontend-design`
**Use** when creating or redesigning frontend interfaces (web or mobile UI):
- Building new web components, pages, dashboards, or landing pages
- Beautifying or restyling any UI
- Creating production-grade, visually distinctive interfaces

Avoid generic AI aesthetics — commit to a bold, intentional design direction. Never use overused fonts (Inter, Roboto, Arial) or clichéd purple gradients.

## Last Updated
February 2026
