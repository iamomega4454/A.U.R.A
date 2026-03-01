
import logging
import numpy as np
from typing import List, Dict, Optional, Any
import httpx
from app.core.config import settings
import cv2
import time

logger = logging.getLogger(__name__)

try:
    from insightface.app import FaceAnalysis
    INSIGHTFACE_AVAILABLE = True
    _INSIGHTFACE_IMPORT_ERROR: Optional[str] = None
except ImportError as e:
    FaceAnalysis = Any  # type: ignore[assignment]
    INSIGHTFACE_AVAILABLE = False
    _INSIGHTFACE_IMPORT_ERROR = str(e)
    logger.warning(
        "[FACE-REC] insightface unavailable - face recognition is disabled "
        "(install requirements.optional.txt to enable)"
    )

_face_app: Optional[FaceAnalysis] = None

#------This Function initializes and returns the Face Analysis App----------
def get_face_app() -> FaceAnalysis:
    global _face_app
    if not INSIGHTFACE_AVAILABLE:
        reason = _INSIGHTFACE_IMPORT_ERROR or "insightface package not installed"
        raise RuntimeError(f"InsightFace unavailable: {reason}")

    if _face_app is None:
        logger.info("=" * 60)
        logger.info("[FACE-REC] Initializing InsightFace buffalo_l model...")
        logger.info("[FACE-REC] Note: First run will download ~400MB of model files")
        logger.info("=" * 60)

        start_time = time.time()

        try:
            
            logger.info("[FACE-REC] Creating FaceAnalysis object...")
            _face_app = FaceAnalysis(
                name="buffalo_l",
                providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
            )

            logger.info("[FACE-REC] Preparing model (loading weights into memory)...")
            _face_app.prepare(ctx_id=0, det_size=(640, 640))

            load_time = time.time() - start_time
            logger.info("=" * 60)
            logger.info(f"[FACE-REC] Model loaded successfully in {load_time:.2f}s")
            logger.info(f"[FACE-REC] Detection size: 640x640")
            logger.info(f"[FACE-REC] Providers: {_face_app.det_model.session.get_providers()}")
            logger.info(f"[FACE-REC] Confidence threshold: {settings.face_confidence_threshold}")
            logger.info("=" * 60)
        except Exception as e:
            logger.error(f"[FACE-REC] Failed to load face recognition model: {e}")
            raise RuntimeError(f"Failed to initialize face recognition: {e}")
            
    return _face_app


def validate_image(frame: np.ndarray) -> tuple[bool, Optional[str]]:
    if frame is None:
        return False, "Image is None"
    
    if not isinstance(frame, np.ndarray):
        return False, f"Expected numpy array, got {type(frame).__name__}"
    
    if frame.size == 0:
        return False, "Image is empty"
    
    if len(frame.shape) < 2:
        return False, f"Invalid image shape: {frame.shape}"
    
    
    if frame.shape[0] < 50 or frame.shape[1] < 50:
        return False, f"Image too small: {frame.shape[1]}x{frame.shape[0]} (minimum 50x50)"
    
    
    max_dimension = 4096
    if frame.shape[0] > max_dimension or frame.shape[1] > max_dimension:
        return False, f"Image too large: {frame.shape[1]}x{frame.shape[0]} (maximum {max_dimension}x{max_dimension})"
    
    return True, None


def detect_and_crop_faces(frame: np.ndarray) -> List[Dict]:
    if not INSIGHTFACE_AVAILABLE:
        logger.warning("[FACE-REC] Face detection skipped - insightface unavailable")
        return []
    
    is_valid, error = validate_image(frame)
    if not is_valid:
        logger.warning(f"[FACE-REC] Invalid image: {error}")
        return []
    
    start_time = time.time()
    
    try:
        app = get_face_app()
        faces = app.get(frame)
    except Exception as e:
        logger.error(f"[FACE-REC] Face detection error: {e}")
        return []
    
    detect_time = time.time() - start_time
    logger.debug(f"[FACE-REC] Detected {len(faces)} face(s) in {detect_time * 1000:.1f}ms")

    cropped_faces = []
    for i, face in enumerate(faces):
        try:
            bbox = face.bbox.astype(int)
            x1, y1, x2, y2 = bbox

            
            frame_height, frame_width = frame.shape[:2]
            x1 = max(0, min(x1, frame_width - 1))
            y1 = max(0, min(y1, frame_height - 1))
            x2 = max(0, min(x2, frame_width - 1))
            y2 = max(0, min(y2, frame_height - 1))
            
            
            if x2 <= x1 or y2 <= y1:
                logger.warning(f"[FACE-REC] Invalid bbox for face #{i + 1}, skipping")
                continue

            face_width = x2 - x1
            face_height = y2 - y1
            if (
                face_width < settings.face_min_bbox_size
                or face_height < settings.face_min_bbox_size
            ):
                logger.debug(
                    f"[FACE-REC] Face #{i + 1} too small ({face_width}x{face_height}), skipping"
                )
                continue

            
            padding = 20
            x1_crop = max(0, x1 - padding)
            y1_crop = max(0, y1 - padding)
            x2_crop = min(frame.shape[1], x2 + padding)
            y2_crop = min(frame.shape[0], y2 + padding)

            cropped = frame[y1_crop:y2_crop, x1_crop:x2_crop]

            
            if cropped.size > 0:
                gray = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
                blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
                if blur_score < settings.face_min_blur_variance:
                    logger.debug(
                        f"[FACE-REC] Face #{i + 1} too blurry (variance={blur_score:.1f}), skipping"
                    )
                    continue

                cropped_resized = cv2.resize(cropped, (112, 112))
                logger.debug(
                    f"[FACE-REC]   Face #{i + 1}: bbox=({x1},{y1},{x2},{y2}) "
                    f"size={face_width}x{face_height}px blur={blur_score:.1f}"
                )

                cropped_faces.append(
                    {
                        "bbox": np.array([x1, y1, x2, y2]),  
                        "cropped": cropped_resized,
                        "embedding": face.normed_embedding,  
                        "blur_score": blur_score,
                    }
                )
        except Exception as e:
            logger.warning(f"[FACE-REC] Error processing face #{i + 1}: {e}")
            continue

    return cropped_faces


def compare_embeddings_vectorized(
    query_embeddings: np.ndarray, stored_embeddings: np.ndarray
) -> np.ndarray:
    
    if query_embeddings.size == 0 or stored_embeddings.size == 0:
        return np.array([])
    
    
    return np.dot(query_embeddings, stored_embeddings.T)


async def fetch_relatives(patient_uid: str, auth_token: str) -> tuple[List[Dict], Optional[str]]:
    if not patient_uid:
        return [], "Missing patient_uid"
    
    try:
        async with httpx.AsyncClient(timeout=settings.backend_timeout) as client:
            headers = {}
            if auth_token:
                token = auth_token.strip()
                if token.lower().startswith("bearer "):
                    headers["Authorization"] = token
                else:
                    headers["Authorization"] = f"Bearer {token}"

            resp = await client.get(
                f"{settings.backend_url}/relatives/",
                headers=headers,
            )

            if resp.status_code == 200:
                return resp.json(), None
            elif resp.status_code == 401:
                return [], "Authentication failed"
            elif resp.status_code == 404:
                return [], "Relatives endpoint not found"
            else:
                return [], f"API error: {resp.status_code}"

    except httpx.ConnectError:
        return [], "Cannot connect to backend"
    except httpx.TimeoutException:
        return [], "Backend request timeout"
    except Exception as e:
        return [], f"API error: {type(e).__name__}"


async def identify_person(
    frame: np.ndarray, patient_uid: str, auth_token: str = ""
) -> List[dict]:
    logger.info("[FACE-REC] Starting face recognition...")
    total_start = time.time()

    
    is_valid, error = validate_image(frame)
    if not is_valid:
        logger.warning(f"[FACE-REC] Invalid input image: {error}")
        return []

    
    try:
        detected_faces = detect_and_crop_faces(frame)
    except Exception as e:
        logger.error(f"[FACE-REC] Face detection failed: {e}")
        return []
    
    if not detected_faces:
        logger.info("[FACE-REC] No faces detected in frame")
        return []

    
    api_start = time.time()
    relatives_data, api_error = await fetch_relatives(patient_uid, auth_token)
    api_time = time.time() - api_start
    
    if api_error:
        logger.warning(f"[FACE-REC] API error: {api_error}")
        
        return [
            {
                "name": "unknown",
                "relationship": "",
                "confidence": 0.0,
                "bbox": face["bbox"].tolist(),
                "error": api_error,
            }
            for face in detected_faces
        ]
    
    logger.debug(
        f"[FACE-REC] Fetched {len(relatives_data)} relatives in {api_time * 1000:.1f}ms"
    )

    if not relatives_data:
        
        logger.info("[FACE-REC] No relatives in database - all faces marked as unknown")
        return [
            {
                "name": "unknown",
                "relationship": "",
                "confidence": 0.0,
                "bbox": face["bbox"].tolist(),
            }
            for face in detected_faces
        ]

    
    try:
        query_embeddings = np.array(
            [face["embedding"] for face in detected_faces]
        )  
    except Exception as e:
        logger.error(f"[FACE-REC] Failed to build query embeddings: {e}")
        return []

    
    relative_embedding_map: List[int] = []  
    all_stored_embeddings: List[np.ndarray] = []

    for rel_idx, rel in enumerate(relatives_data):
        face_embeddings = rel.get("face_embeddings", [])
        for emb in face_embeddings:
            try:
                emb_array = np.array(emb)
                if emb_array.shape == (512,):  
                    all_stored_embeddings.append(emb_array)
                    relative_embedding_map.append(rel_idx)
            except Exception as e:
                logger.warning(f"[FACE-REC] Invalid embedding for relative {rel_idx}: {e}")
                continue

    if not all_stored_embeddings:
        
        logger.info("[FACE-REC] No valid face embeddings found in database")
        return [
            {
                "name": "unknown",
                "relationship": "",
                "confidence": 0.0,
                "bbox": face["bbox"].tolist(),
            }
            for face in detected_faces
        ]

    stored_embeddings = np.array(all_stored_embeddings)  
    logger.debug(
        f"[FACE-REC] Comparing {len(detected_faces)} faces against {len(all_stored_embeddings)} embeddings"
    )

    
    compare_start = time.time()
    try:
        similarity_matrix = compare_embeddings_vectorized(
            query_embeddings, stored_embeddings
        )  
    except Exception as e:
        logger.error(f"[FACE-REC] Embedding comparison failed: {e}")
        return [
            {
                "name": "unknown",
                "relationship": "",
                "confidence": 0.0,
                "bbox": face["bbox"].tolist(),
                "error": "comparison_failed",
            }
            for face in detected_faces
        ]
    
    compare_time = time.time() - compare_start
    logger.debug(f"[FACE-REC] Vectorized comparison done in {compare_time * 1000:.1f}ms")

    
    confidence_threshold = settings.face_confidence_threshold
    margin_threshold = settings.face_match_margin
    logger.debug(f"[FACE-REC] Matching results (threshold={confidence_threshold}):")
    
    results: List[dict] = []
    for face_idx, face in enumerate(detected_faces):
        try:
            
            similarities = similarity_matrix[face_idx]  

            relative_scores: Dict[int, float] = {}
            for emb_idx, emb_score in enumerate(similarities):
                rel_idx = relative_embedding_map[emb_idx]
                score_value = float(emb_score)
                current_max = relative_scores.get(rel_idx)
                if current_max is None or score_value > current_max:
                    relative_scores[rel_idx] = score_value

            if not relative_scores:
                results.append(
                    {
                        "name": "unknown",
                        "relationship": "",
                        "confidence": 0.0,
                        "bbox": face["bbox"].tolist(),
                    }
                )
                continue

            sorted_rel_scores = sorted(
                relative_scores.items(),
                key=lambda item: item[1],
                reverse=True,
            )
            best_relative_idx, best_score = sorted_rel_scores[0]
            second_best_score = sorted_rel_scores[1][1] if len(sorted_rel_scores) > 1 else 0.0
            score_margin = float(best_score - second_best_score)

            if best_score >= confidence_threshold and score_margin >= margin_threshold:
                
                matched_relative = relatives_data[best_relative_idx]
                photos = matched_relative.get("photos") or []

                logger.info(
                    f"[FACE-REC]   Face #{face_idx + 1}: IDENTIFIED as '{matched_relative['name']}' "
                    f"({matched_relative.get('relationship', 'unknown')}) - "
                    f"confidence: {best_score:.3f} margin: {score_margin:.3f}"
                )

                results.append(
                    {
                        "person_id": matched_relative.get("id", ""),
                        "person_name": matched_relative["name"],
                        "name": matched_relative["name"],
                        "relationship": matched_relative.get("relationship", ""),
                        "photo_count": len(photos),
                        "confidence": round(best_score, 3),
                        "match_margin": round(score_margin, 3),
                        "blur_score": round(float(face.get("blur_score", 0.0)), 1),
                        "bbox": face["bbox"].tolist(),
                    }
                )
            else:
                
                logger.debug(
                    f"[FACE-REC]   Face #{face_idx + 1}: UNKNOWN "
                    f"(score={best_score:.3f}, margin={score_margin:.3f})"
                )
                results.append(
                    {
                        "name": "unknown",
                        "relationship": "",
                        "confidence": round(best_score, 3),
                        "match_margin": round(score_margin, 3),
                        "blur_score": round(float(face.get("blur_score", 0.0)), 1),
                        "bbox": face["bbox"].tolist(),
                    }
                )
        except Exception as e:
            logger.error(f"[FACE-REC] Error matching face #{face_idx + 1}: {e}")
            results.append(
                {
                    "name": "unknown",
                    "relationship": "",
                    "confidence": 0.0,
                    "bbox": face["bbox"].tolist(),
                    "error": "matching_error",
                }
            )

    total_time = time.time() - total_start
    logger.info(
        f"[FACE-REC] Recognition complete: {len(results)} face(s) processed in {total_time * 1000:.1f}ms"
    )

    return results
