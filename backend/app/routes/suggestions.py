import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from typing import Optional, List
from beanie.operators import In
from app.core.firebase import get_current_user_uid
from app.models.suggestion import (
    Suggestion,
    SuggestionHistory,
    SuggestionType,
    SuggestionStatus,
)
from app.models.medication import Medication
from app.models.journal import JournalEntry
from app.models.user import User
from app.services.suggestion_generator import suggestion_generator
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/suggestions", tags=["suggestions"])


class CreateSuggestionRequest(BaseModel):
    type: SuggestionType
    title: str
    description: str
    priority: int = 1
    context_data: Optional[dict] = None
    action_label: Optional[str] = None
    action_data: Optional[dict] = None
    suggested_time: Optional[str] = None
    expires_at: Optional[datetime] = None

    @field_validator('title')
    @classmethod
    def validate_title(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError('Title cannot be empty')
        return v.strip()

    @field_validator('description')
    @classmethod
    def validate_description(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError('Description cannot be empty')
        return v.strip()

    @field_validator('priority')
    @classmethod
    def validate_priority(cls, v: int) -> int:
        if v < 0 or v > 5:
            raise ValueError('Priority must be between 0 and 5')
        return v


class UpdateSuggestionRequest(BaseModel):
    status: Optional[SuggestionStatus] = None
    was_helpful: Optional[bool] = None


#------This Function gets suggestions---------
@router.get("/")
async def get_suggestions(
    status: Optional[SuggestionStatus] = None,
    type: Optional[SuggestionType] = None,
    limit: int = 10,
    uid: str = Depends(get_current_user_uid),
):
    query_filters = [Suggestion.user_uid == uid]

    if status:
        query_filters.append(Suggestion.status == status)
    if type:
        query_filters.append(Suggestion.type == type)

    suggestions = (
        await Suggestion.find(*query_filters)
        .sort([("created_at", -1)])
        .limit(limit)
        .to_list()
    )

    return [_serialize_suggestion(s) for s in suggestions]


#------This Function gets active suggestions---------
@router.get("/active")
async def get_active_suggestions(
    limit: int = 5,
    uid: str = Depends(get_current_user_uid),
):
    suggestions = (
        await Suggestion.find(
            Suggestion.user_uid == uid,
            Suggestion.status == SuggestionStatus.ACTIVE,
        )
        .sort([("priority", -1), ("created_at", -1)])
        .limit(limit)
        .to_list()
    )

    
    for suggestion in suggestions:
        suggestion.shown_count += 1
        suggestion.updated_at = datetime.utcnow()
        await suggestion.save()

    return [_serialize_suggestion(s) for s in suggestions]


#------This Function gets suggestion---------
@router.get("/history/stats")
async def get_suggestion_stats(uid: str = Depends(get_current_user_uid)):
    history = await SuggestionHistory.find(SuggestionHistory.user_uid == uid).to_list()

    total = len(history)
    dismissed = len([h for h in history if h.action_taken == "dismissed"])
    completed = len([h for h in history if h.action_taken == "completed"])
    confirmed = len([h for h in history if h.action_taken == "confirmed"])
    helpful = len([h for h in history if h.was_helpful is True])

    return {
        "total_interactions": total,
        "dismissed_count": dismissed,
        "completed_count": completed,
        "confirmed_count": confirmed,
        "helpful_count": helpful,
        "completion_rate": (completed / total * 100) if total > 0 else 0,
        "helpfulness_rate": (helpful / total * 100) if total > 0 else 0,
    }


#------This Function gets suggestion---------
@router.get("/{suggestion_id}")
async def get_suggestion(suggestion_id: str, uid: str = Depends(get_current_user_uid)):
    suggestion = await Suggestion.get(suggestion_id)

    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    if suggestion.user_uid != uid:
        raise HTTPException(status_code=403, detail="Access denied")

    return _serialize_suggestion(suggestion)


#------This Function creates suggestion---------
@router.post("/")
async def create_suggestion(
    body: CreateSuggestionRequest, uid: str = Depends(get_current_user_uid)
):
    suggestion = Suggestion(
        user_uid=uid,
        **body.model_dump(),
    )
    await suggestion.insert()

    return {"status": "created", "suggestion": _serialize_suggestion(suggestion)}


#------This Function updates suggestion---------
@router.patch("/{suggestion_id}")
async def update_suggestion(
    suggestion_id: str,
    body: UpdateSuggestionRequest,
    uid: str = Depends(get_current_user_uid),
):
    suggestion = await Suggestion.get(suggestion_id)

    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    if suggestion.user_uid != uid:
        raise HTTPException(status_code=403, detail="Access denied")

    
    time_to_action = None
    if body.status and body.status != suggestion.status:
        time_to_action = int(
            (datetime.utcnow() - suggestion.created_at).total_seconds()
        )

        if body.status == SuggestionStatus.DISMISSED:
            suggestion.dismissed_at = datetime.utcnow()
        elif body.status == SuggestionStatus.COMPLETED:
            suggestion.completed_at = datetime.utcnow()

        
        history = SuggestionHistory(
            user_uid=uid,
            suggestion_id=suggestion_id,
            suggestion_type=suggestion.type,
            action_taken=body.status.value,
            time_to_action=time_to_action,
            was_helpful=body.was_helpful,
        )
        await history.insert()

    
    if body.status:
        suggestion.status = body.status

    suggestion.updated_at = datetime.utcnow()
    await suggestion.save()

    return {"status": "updated", "suggestion": _serialize_suggestion(suggestion)}


#------This Function dismisses suggestion---------
@router.post("/{suggestion_id}/dismiss")
async def dismiss_suggestion(
    suggestion_id: str, uid: str = Depends(get_current_user_uid)
):
    suggestion = await Suggestion.get(suggestion_id)

    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    if suggestion.user_uid != uid:
        raise HTTPException(status_code=403, detail="Access denied")

    suggestion.status = SuggestionStatus.DISMISSED
    suggestion.dismissed_at = datetime.utcnow()
    suggestion.updated_at = datetime.utcnow()
    await suggestion.save()

    
    history = SuggestionHistory(
        user_uid=uid,
        suggestion_id=suggestion_id,
        suggestion_type=suggestion.type,
        action_taken="dismissed",
        time_to_action=int((datetime.utcnow() - suggestion.created_at).total_seconds()),
    )
    await history.insert()

    return {"status": "dismissed"}


#------This Function completes suggestion---------
@router.post("/{suggestion_id}/complete")
async def complete_suggestion(
    suggestion_id: str,
    was_helpful: bool = True,
    uid: str = Depends(get_current_user_uid),
):
    suggestion = await Suggestion.get(suggestion_id)

    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion not found")

    if suggestion.user_uid != uid:
        raise HTTPException(status_code=403, detail="Access denied")

    suggestion.status = SuggestionStatus.COMPLETED
    suggestion.completed_at = datetime.utcnow()
    suggestion.updated_at = datetime.utcnow()
    await suggestion.save()

    
    history = SuggestionHistory(
        user_uid=uid,
        suggestion_id=suggestion_id,
        suggestion_type=suggestion.type,
        action_taken="completed",
        time_to_action=int((datetime.utcnow() - suggestion.created_at).total_seconds()),
        was_helpful=was_helpful,
    )
    await history.insert()

    return {"status": "completed"}


#------This Function generates suggestions---------
@router.post("/generate")
async def generate_suggestions(uid: str = Depends(get_current_user_uid)):
    try:
        
        user = await User.find_one(User.firebase_uid == uid)
        if not user:
            logger.warning(f"User not found for uid: {uid}")
            raise HTTPException(status_code=404, detail="User not found")

        
        patient_info = None
        if user.illness:
            patient_info = {
                "condition": user.illness.condition or "",
                "severity": user.illness.severity or "",
                "diagnosis_date": user.illness.diagnosis_date,
                "notes": user.illness.notes or "",
            }
            logger.debug(f"Patient info retrieved for user {uid}: condition={patient_info['condition']}")

        
        medications = await Medication.find(
            Medication.patient_uid == uid, Medication.is_active == True
        ).to_list()

        
        seven_days_ago = datetime.utcnow() - timedelta(days=7)
        recent_journals = (
            await JournalEntry.find(
                JournalEntry.patient_uid == uid,
                JournalEntry.created_at >= seven_days_ago,
            )
            .limit(10)
            .to_list()
        )

        
        suggestions = await suggestion_generator.generate_daily_suggestions(
            user_id=uid,
            medications=medications,
            recent_journals=recent_journals,
            patient_info=patient_info,
        )

        
        saved_suggestions = []
        for suggestion in suggestions:
            await suggestion.insert()
            saved_suggestions.append(_serialize_suggestion(suggestion))

        logger.info(f"Generated {len(saved_suggestions)} suggestions for user {uid}")

        return {
            "status": "generated",
            "count": len(saved_suggestions),
            "suggestions": saved_suggestions,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate suggestions for user {uid}: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"Failed to generate suggestions: {str(e)}"
        )


#------This Function clears old suggestions---------
@router.delete("/")
async def clear_old_suggestions(uid: str = Depends(get_current_user_uid)):
    result = await Suggestion.find(
        Suggestion.user_uid == uid,
        In(Suggestion.status, [SuggestionStatus.DISMISSED, SuggestionStatus.COMPLETED]),
    ).delete()

    return {"status": "cleared", "deleted_count": result.deleted_count if result else 0}


def _serialize_suggestion(suggestion: Suggestion) -> dict:
    return {
        "id": str(suggestion.id),
        "type": suggestion.type.value,
        "title": suggestion.title,
        "description": suggestion.description,
        "status": suggestion.status.value,
        "priority": suggestion.priority,
        "action_label": suggestion.action_label,
        "action_data": suggestion.action_data,
        "context_data": suggestion.context_data,
        "suggested_time": suggestion.suggested_time,
        "shown_count": suggestion.shown_count,
        "created_at": suggestion.created_at.isoformat(),
        "updated_at": suggestion.updated_at.isoformat(),
    }
