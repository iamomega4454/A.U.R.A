
import asyncio
import logging
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from app.services.camera import camera_service
from app.services.discovery import discovery_service
from app.services.backend_client import init_backend_client, get_backend_client
from app.services.microphone import continuous_mic
from app.services.conversation import summarize_conversation
from app.ws_server import start_server, shutdown_streams, _get_local_ip
from app.core.config import settings


GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
CYAN = "\033[96m"
RESET = "\033[0m"
BOLD = "\033[1m"

UPDATE_CHECK_INTERVAL = 300


#------This Function handles the Logging Setup---------
def setup_logging():
    log_level = logging.DEBUG if settings.demo_mode else logging.INFO
    
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[
            logging.StreamHandler(sys.stdout),
        ],
    )
    
    
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("zeroconf").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)


#------This Function displays banner-------
def show_banner():
    print(f"""
{CYAN}{BOLD}╔═══════════════════════════════════════════════════════════╗
║          A . U . R . A    M O D U L E              ║
║                   IoT Device Hub                     ║
╚═══════════════════════════════════════════════════════════╝{RESET}
    """)


#------This Function prints status-------
def print_status(icon, text, color=GREEN):
    print(f"  {icon} {color}{text}{RESET}")


#------This Function prints section-------
def print_section(title):
    print(f"\n{BLUE}{BOLD}── {title} ──{RESET}\n")


#------This Function streams ollama pull with progress----------
def stream_ollama_pull(model_name: str) -> bool:
    print(f"  {CYAN}→{RESET} Downloading {model_name}...")
    
    try:
        process = subprocess.Popen(
            ["ollama", "pull", model_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        
        total_layers = 0
        downloaded_layers = 0
        start_time = time.time()
        last_update = time.time()
        
        spinner = ['|', '/', '-', '\\']
        spinner_idx = 0
        
        for line in process.stdout:
            line = line.strip()
            
            if "pulling manifest" in line.lower():
                print(f"  {BLUE}›{RESET} Pulling manifest...")
            elif "downloading" in line.lower():
                if "layer" in line.lower():
                    if "/" in line:
                        try:
                            parts = line.split("/")
                            for p in parts:
                                if "(" in p and ")" in p:
                                    nums = p.replace("(", "").replace(")", "").split("/")
                                    if len(nums) == 2:
                                        total_layers = max(total_layers, int(nums[1]))
                                        downloaded_layers = int(nums[0])
                        except:
                            pass
                    
                    downloaded_layers += 1
                    
                    elapsed = time.time() - start_time
                    speed = downloaded_layers / elapsed if elapsed > 0 else 0
                    
                    spinner_idx = (spinner_idx + 1) % 4
                    
                    if total_layers > 0:
                        percent = (downloaded_layers / total_layers) * 100
                        print(f"\r  {spinner[spinner_idx]} Progress: {percent:.1f}% ({downloaded_layers}/{total_layers} layers) - {speed:.1f} layers/s    ", end="", flush=True)
                    else:
                        print(f"\r  {spinner[spinner_idx]} Downloading... {speed:.1f} layers/s    ", end="", flush=True)
                    
                    last_update = time.time()
                    
            elif "verifying" in line.lower():
                print(f"\n  {BLUE}›{RESET} Verifying checksum...")
            elif "writing" in line.lower():
                print(f"\n  {BLUE}›{RESET} Writing to model storage...")
        
        process.wait()
        print()  
        
        if process.returncode == 0:
            return True
        return False
        
    except Exception as e:
        print(f"\n  {RED}!{RESET} Error: {e}")
        return False


#------This Function pulls model with progress wrapper----------
def pull_model_with_progress(model_name: str) -> bool:
    return stream_ollama_pull(model_name)


#------This Function checks/installs Ollama-------
def check_ollama():
    print_section("Ollama Installation")
    
    try:
        result = subprocess.run(
            ["ollama", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            print_status("●", f"Ollama installed: {CYAN}{result.stdout.strip()}{RESET}")
            
            print(f"\n  {BLUE}›{RESET} Checking gemma3:4b model...")
            model_result = subprocess.run(
                ["ollama", "list"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            
            if "gemma3:4b" in model_result.stdout:
                print_status("●", "gemma3:4b model installed")
            else:
                print_status("●", "gemma3:4b model not found", YELLOW)
                print(f"  {CYAN}→{RESET} Pulling gemma3:4b model...")
                
                if pull_model_with_progress("gemma3:4b"):
                    print_status("●", "gemma3:4b model downloaded successfully")
                else:
                    print_status("●", "Failed to pull model", RED)
                    return False
            
            return True
            
    except FileNotFoundError:
        pass
    except subprocess.TimeoutExpired:
        print_status("●", "Ollama check timed out", RED)
        return False
    except Exception as e:
        print_status("●", f"Error checking Ollama: {e}", RED)
        return False
    
    print_status("●", "Ollama not installed", YELLOW)
    print(f"  {CYAN}→{RESET} Installing Ollama...")
    
    try:
        install_cmd = "curl -fsSL https://ollama.com/install.sh | sh"
        install_result = subprocess.run(
            install_cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        
        if install_result.returncode != 0:
            print_status("●", f"Ollama installation failed", RED)
            print(f"  {RED}!{RESET} {install_result.stderr}")
            return False
        
        print_status("●", "Ollama installed successfully")
        
        print(f"\n  {BLUE}›{RESET} Pulling gemma3:4b model...")
        if pull_model_with_progress("gemma3:4b"):
            print_status("●", "gemma3:4b model downloaded successfully")
        else:
            print_status("●", "Model pull failed - will retry on first use", YELLOW)
        
        return True
        
    except subprocess.TimeoutExpired:
        print_status("●", "Ollama installation timed out", RED)
        return False
    except Exception as e:
        print_status("●", f"Installation error: {e}", RED)
        return False


#------This Function checks InsightFace model-------
def check_models():
    print_section("ML Models")
    
    print(f"  {BLUE}›{RESET} Checking InsightFace/buffalo_l...")
    
    try:
        import insightface
        from insightface.app import FaceAnalysis
        
        app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=0, det_size=(640, 640))
        print_status("●", "buffalo_l face recognition model ready")
        
    except ImportError:
        print_status("●", "InsightFace not installed", YELLOW)
        print(f"  {YELLOW}!{RESET} Will be downloaded on first use (face recognition)")
        
    except Exception as e:
        print_status("●", f"Model not ready: {e}", YELLOW)
        print(f"  {YELLOW}!{RESET} Will be downloaded on first use")


#------This Function checks git for updates-------
def check_for_updates():
    try:
        result = subprocess.run(
            ["git", "fetch", "--dry-run"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        
        if result.stdout or result.stderr:
            return True
        return False
        
    except FileNotFoundError:
        pass
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass
    
    return False


#------This Function pulls git updates-------
def pull_updates():
    try:
        result = subprocess.run(
            ["git", "pull"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        
        if result.returncode == 0:
            print_status("●", "Updates applied successfully")
            return True
        else:
            print_status("●", f"Update failed: {result.stderr}", RED)
            return False
            
    except Exception as e:
        print_status("●", f"Error pulling updates: {e}", RED)
        return False


#------This Function update monitor thread-------
def update_monitor():
    while True:
        time.sleep(UPDATE_CHECK_INTERVAL)
        
        try:
            result = subprocess.run(
                ["git", "fetch", "--dry-run"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            
            if result.stdout or result.stderr:
                print(f"\n\n{YELLOW}{BOLD}═══ UPDATE AVAILABLE ═══{RESET}")
                print_status("●", "New commits detected - updating...")
                
                if pull_updates():
                    print(f"\n{GREEN}{BOLD}Restarting module...{RESET}\n")
                    python = sys.executable
                    subprocess.Popen([python] + sys.argv)
                    sys.exit(0)
                    
        except Exception:
            pass


#------This Function handles the Main Application----------
async def main():
    show_banner()
    
    print(f"{CYAN}Initializing system checks...{RESET}\n")
    
    ollama_ok = check_ollama()
    check_models()
    
    if not settings.validate_required_settings():
        logger = logging.getLogger(__name__)
        logger.error("[AURA] Configuration validation failed. Please check your .env file.")
        logger.error("[AURA] Required settings: PATIENT_UID, BACKEND_URL")
        print(f"\n{RED}✕{RESET} Please configure .env file before starting")
        sys.exit(1)
    
    print_section("Environment Configuration")
    
    backend_url = settings.backend_url
    patient_uid = settings.patient_uid
    
    if backend_url and backend_url != "http://localhost:8000":
        print_status("●", f"BACKEND_URL: {CYAN}{backend_url}{RESET}")
    else:
        print_status("●", "BACKEND_URL not configured", RED)
    
    if patient_uid and patient_uid != "your_patient_uid_here":
        print_status("●", f"PATIENT_UID: {CYAN}{patient_uid[:8]}...{RESET}")
    else:
        print_status("●", "PATIENT_UID not configured", RED)
    
    print(f"\n{BLUE}{BOLD}════════════════════════════════════{RESET}")
    print(f"{BLUE}{BOLD}  Status Summary{RESET}")
    print(f"{BLUE}{BOLD}════════════════════════════════════{RESET}")
    
    print_status("●", "Environment")
    print_status("●" if ollama_ok else "●", "Ollama + Models", GREEN if ollama_ok else YELLOW)
    print_status("●", "Update Monitor (background)")
    
    setup_logging()
    logger = logging.getLogger(__name__)
    
    print_section("Starting Services")
    
    print_status("●", f"Patient UID: {settings.patient_uid[:8]}..." if settings.patient_uid else "NOT SET")
    print_status("●", f"Server port: {settings.http_port}")
    print_status("●", f"Camera index: {settings.camera_index}")
    print_status("●", f"Whisper model: {settings.whisper_model}")
    print_status("●", f"Ollama: {settings.ollama_url} ({settings.ollama_model})")
    print_status("●", f"Backend: {settings.backend_url}")
    print_status("●", f"Demo mode: {settings.demo_mode}")
    print()
    
    logger.info("[AURA] Pre-loading machine learning models...")
    logger.info("[AURA] This may take a few minutes on first run (downloading models)...")
    print()

    try:
        from app.services.face_recognition import get_face_app

        logger.info("[AURA] Loading face recognition model (buffalo_l)...")
        get_face_app()
        print_status("●", "Face recognition model ready")
    except Exception as e:
        logger.error(f"[AURA] Failed to load face recognition model: {e}")
        logger.error(
            "[AURA] Install optional face/audio deps with: "
            "python -m pip install -r requirements.optional.txt"
        )
        if settings.demo_mode:
            logger.warning("[AURA] Continuing in demo mode without face recognition")
        else:
            logger.warning("[AURA] Continuing with face recognition disabled")
            logger.warning(
                "[AURA] Set DEMO_MODE=true if you want full demo-mode behavior"
            )

    
    backend_client = init_backend_client(settings.patient_uid)

    local_ip = _get_local_ip()

    logger.info(f"[AURA] Registering with backend at {settings.backend_url}...")
    print_status("●", f"Registering with backend at {settings.backend_url}...")
    registered = await backend_client.register(local_ip, settings.http_port)
    
    if not registered:
        logger.warning("[AURA] Failed to register with backend")
        print_status("●", "Failed to register with backend", YELLOW)
        print(f"  {YELLOW}!{RESET} Module will continue running but some features may not work")
    else:
        await backend_client.start_heartbeat()
        print_status("●", f"Heartbeat task started (every {settings.heartbeat_interval}s)")

    camera_service.start()
    print_status("●", "Camera started (always-on mode)")

    async def on_summarize(transcripts):
        logger.info(f"[AURA] Summarization triggered with {len(transcripts)} transcripts")
        try:
            summary = await summarize_conversation(
                transcripts=transcripts,
                patient_uid=settings.patient_uid,
            )
            if summary:
                logger.info(f"[AURA] Summary generated: {summary[:80]}...")
            else:
                logger.warning("[AURA] Failed to generate summary")
        except Exception as e:
            logger.error(f"[AURA] Error in summarization callback: {e}")
    
    from app.services.microphone import ContinuousMicrophone
    continuous_microphone = ContinuousMicrophone(
        on_summarize=on_summarize,
        event_loop=asyncio.get_running_loop(),
    )
    continuous_microphone.start()
    print_status("●", "Continuous microphone started (10-minute summarization)")

    discovery_service.start()
    print_status("●", "mDNS discovery broadcasting")

    
    server_runner = await start_server()
    print_status("●", f"Unified HTTP+WS server running on 0.0.0.0:{settings.http_port}")
    print_status("●", f"Video stream available at: http://{local_ip}:{settings.http_port}/video_feed")

    
    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    
    def signal_handler():
        logger.info("[AURA] Shutdown signal received")
        stop.set()
    
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)

    print(f"\n{BLUE}{BOLD}════════════════════════════════════{RESET}")
    print_status("●", "Module ready. Waiting for connections...")
    print(f"{BLUE}{BOLD}════════════════════════════════════{RESET}\n")
    
    await stop.wait()

    print("\n" + YELLOW + "Shutting down..." + RESET)

    await backend_client.stop_heartbeat()

    await shutdown_streams()

    camera_service.stop()

    continuous_microphone.stop()

    discovery_service.stop()

    await server_runner.cleanup()
    
    print_status("●", "Goodbye")


if __name__ == "__main__":
    monitor_thread = threading.Thread(target=update_monitor, daemon=True)
    monitor_thread.start()
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n" + BLUE + "»" + RESET + " Module stopped by user")
    except Exception as e:
        logging.error(f"[AURA] Fatal error: {type(e).__name__}: {e}")
        sys.exit(1)
