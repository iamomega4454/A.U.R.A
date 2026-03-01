
import asyncio
import logging
import os
import platform
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, Any

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

_system_info: Dict[str, Any] = {}


#------This Class handles the System Hardware Detection---------
def detect_hardware() -> Dict[str, Any]:
    info = {
        "platform": platform.system(),
        "architecture": platform.machine(),
        "processor": platform.processor(),
        "is_raspberry_pi": False,
        "pi_model": None,
        "cpu_cores": os.cpu_count() or 1,
        "has_gpu": False,
        "gpu_info": None,
    }
    
    if Path("/proc/device-tree/model").exists():
        try:
            with open("/proc/device-tree/model", "r") as f:
                model = f.read().strip()
                if "Raspberry Pi" in model:
                    info["is_raspberry_pi"] = True
                    if "Pi 5" in model:
                        info["pi_model"] = "5"
                    elif "Pi 4" in model:
                        info["pi_model"] = "4"
                    elif "Pi 3" in model:
                        info["pi_model"] = "3"
                    elif "Pi 2" in model:
                        info["pi_model"] = "2"
        except Exception:
            pass
    
    try:
        result = subprocess.run(
            ["vcgencmd", "get_config", "int"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            info["has_gpu"] = True
            info["gpu_info"] = "Broadcom VideoCore"
    except FileNotFoundError:
        pass
    
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            info["has_gpu"] = True
            info["gpu_info"] = result.stdout.strip()
    except FileNotFoundError:
        pass
    
    return info


#------This Function checks system resources---------
def check_system_resources() -> Dict[str, Any]:
    resources = {
        "disk_space_gb": 0,
        "memory_total_gb": 0,
        "memory_available_gb": 0,
        "cpu_usage_percent": 0,
        "ok": True,
    }
    
    try:
        result = subprocess.run(
            ["df", "-BG", "/"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")
            if len(lines) > 1:
                match = re.search(r"(\d+)G", lines[1])
                if match:
                    resources["disk_space_gb"] = int(match.group(1))
                    resources["ok"] = resources["disk_space_gb"] >= 2
    except Exception:
        pass
    
    try:
        result = subprocess.run(
            ["free", "-g"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")
            if len(lines) > 1:
                parts = lines[1].split()
                if len(parts) >= 2:
                    resources["memory_total_gb"] = int(parts[1])
                    resources["memory_available_gb"] = int(parts[6])
    except Exception:
        pass
    
    try:
        result = subprocess.run(
            ["top", "-bn1"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            for line in result.stdout.split("\n"):
                if "Cpu(s)" in line:
                    match = re.search(r"(\d+\.\d+)\s*id", line)
                    if match:
                        idle = float(match.group(1))
                        resources["cpu_usage_percent"] = round(100 - idle, 1)
                    break
    except Exception:
        pass
    
    return resources


#------This Function checks/installs pip---------
def check_pip():
    print_section("Python Package Manager")
    
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            current_version = result.stdout.strip().split()[1]
            print_status("●", f"pip installed: {CYAN}{current_version}{RESET}")
            return True
    except Exception as e:
        print_status("●", f"pip check failed: {e}", YELLOW)
    return False


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


#------This Function displays banner with system info-------
def show_banner(system_info: Dict[str, Any] = None):
    pi_info = ""
    if system_info and system_info.get("is_raspberry_pi"):
        model = system_info.get("pi_model", "unknown")
        gpu = " + GPU" if system_info.get("has_gpu") else ""
        pi_info = f" [Raspberry Pi {model}{gpu}]"
    
    print(f"""
{CYAN}{BOLD}╔═══════════════════════════════════════════════════════════╗
║          A . U . R . A    M O D U L E   2026{pi_info}          ║
║                   IoT Device Hub                             ║
╚═══════════════════════════════════════════════════════════╝{RESET}
    """)


#------This Function prints status-------
def print_status(icon, text, color=GREEN):
    print(f"  {icon} {color}{text}{RESET}")


#------This Function prints section-------
def print_section(title):
    print(f"\n{BLUE}{BOLD}── {title} ──{RESET}\n")


#------This Function checks/installs PyAudio----------
def check_pyaudio():
    print_section("Audio Dependencies")
    
    try:
        import pyaudio
        print_status("●", f"PyAudio installed")
        return True
    except ImportError:
        print_status("●", "PyAudio not installed", YELLOW)
    
    print(f"  {CYAN}→{RESET} Installing PyAudio...")
    
    try:
        if sys.platform == "darwin":
            subprocess.run(["brew", "install", "portaudio"], check=True)
        elif sys.platform == "linux":
            if Path("/etc/arch-release").exists():
                print("  {BLUE}›{RESET} Detected Arch Linux")
                subprocess.run(["sudo", "pacman", "-S", "--noconfirm", "portaudio"], check=False)
            elif Path("/etc/fedora-release").exists():
                print("  {BLUE}›{RESET} Detected Fedora")
                subprocess.run(["sudo", "dnf", "install", "-y", "portaudio-devel"], check=False)
            elif Path("/etc/debian_version").exists() or Path("/etc/ubuntu_version").exists():
                print("  {BLUE}›{RESET} Detected Debian/Ubuntu")
                subprocess.run(["sudo", "apt-get", "install", "-y", "portaudio19-dev"], check=False)
            else:
                print("  {BLUE}›{RESET} Unknown distro, trying pip...")
        
        subprocess.run([sys.executable, "-m", "pip", "install", "pyaudio"], check=True)
        print_status("●", "PyAudio installed successfully")
        return True
        
    except Exception as e:
        print_status("●", f"PyAudio installation failed: {e}", RED)
        print(f"  {RED}!{RESET} Microphone will run in demo mode")
        return False


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
        
        message_counts = {}
        last_message = None
        last_count = 0
        
        for line in process.stdout:
            line = line.strip()
            
            if "pulling manifest" in line.lower():
                msg = "Pulling manifest..."
                if msg != last_message:
                    if last_message and last_count > 1:
                        print(f"  {BLUE}›{RESET} {last_message}(x{last_count})")
                    print(f"  {BLUE}›{RESET} {msg}")
                    last_message = msg
                    last_count = 1
                else:
                    last_count += 1
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
                msg = "Verifying checksum..."
                if msg != last_message:
                    if last_message and last_count > 1:
                        print(f"  {BLUE}›{RESET} {last_message}(x{last_count})")
                    print(f"  {BLUE}›{RESET} {msg}")
                    last_message = msg
                    last_count = 1
                else:
                    last_count += 1
            elif "writing" in line.lower():
                msg = "Writing to model storage..."
                if msg != last_message:
                    if last_message and last_count > 1:
                        print(f"  {BLUE}›{RESET} {last_message}(x{last_count})")
                    print(f"  {BLUE}›{RESET} {msg}")
                    last_message = msg
                    last_count = 1
                else:
                    last_count += 1
        
        if last_message and last_count > 1:
            print(f"  {BLUE}›{RESET} {last_message}(x{last_count})")
            
        process.wait()
        print()  
        
        if process.returncode == 0:
            print_status("●", f"{model_name} downloaded successfully")
            return True
        return False
        
    except Exception as e:
        print(f"\n  {RED}!{RESET} Error: {e}")
        return False


#------This Function pulls model with progress wrapper----------
def pull_model_with_progress(model_name: str) -> bool:
    return stream_ollama_pull(model_name)


#------This Function updates Ollama model automatically----------
def update_ollama_model(model_name: str) -> bool:
    print(f"  {CYAN}→{RESET} Updating {model_name}...")
    
    try:
        process = subprocess.Popen(
            ["ollama", "pull", model_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        
        start_time = time.time()
        for line in process.stdout:
            line = line.strip()
            if "already up to date" in line.lower():
                print_status("●", f"{model_name} is up to date")
                process.terminate()
                return True
            elif "downloading" in line.lower():
                elapsed = time.time() - start_time
                print(f"\r  {CYAN}▓{RESET} Downloading... {elapsed:.1f}s    ", end="", flush=True)
        
        process.wait()
        print()
        
        if process.returncode == 0:
            print_status("●", f"{model_name} updated successfully")
            return True
        return False
        
    except Exception as e:
        print(f"\n  {RED}!{RESET} Update error: {e}")
        return False


#------This Function checks/installs Ollama with auto-update--------
def check_ollama():
    print_section("Ollama Installation")
    
    check_pip()
    
    try:
        result = subprocess.run(
            ["ollama", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            print_status("●", f"Ollama installed: {CYAN}{result.stdout.strip()}{RESET}")
            
            print(f"\n  {BLUE}›{RESET} Checking {settings.ollama_model} model...")
            model_result = subprocess.run(
                ["ollama", "list"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            
            model_found = settings.ollama_model.split(":")[0] in model_result.stdout
            
            if model_found:
                print_status("●", f"{settings.ollama_model} model installed")
                
                if settings.auto_update_models:
                    print(f"\n  {BLUE}›{RESET} Checking for model updates...")
                    if update_ollama_model(settings.ollama_model):
                        print_status("●", f"{settings.ollama_model} is up to date")
            else:
                print_status("●", f"{settings.ollama_model} model not found", YELLOW)
                print(f"  {CYAN}→{RESET} Pulling {settings.ollama_model} model...")
                
                if pull_model_with_progress(settings.ollama_model):
                    print_status("●", f"{settings.ollama_model} model downloaded successfully")
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
    
    max_retries = 3
    retry_count = 0
    
    while retry_count < max_retries:
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
                retry_count += 1
                if retry_count < max_retries:
                    print(f"  {YELLOW}→{RESET} Retrying in 5 seconds... ({retry_count}/{max_retries})")
                    time.sleep(5)
                    continue
                return False
            
            print_status("●", "Ollama installed successfully")
            
            print(f"\n  {BLUE}›{RESET} Pulling {settings.ollama_model} model...")
            if pull_model_with_progress(settings.ollama_model):
                print_status("●", f"{settings.ollama_model} model downloaded successfully")
            else:
                print_status("●", "Model pull failed - will retry on first use", YELLOW)
            
            return True
            
        except subprocess.TimeoutExpired:
            print_status("●", "Ollama installation timed out", RED)
            retry_count += 1
            if retry_count < max_retries:
                print(f"  {YELLOW}→{RESET} Retrying in 10 seconds... ({retry_count}/{max_retries})")
                time.sleep(10)
                continue
            return False
        except Exception as e:
            print_status("●", f"Installation error: {e}", RED)
            retry_count += 1
            if retry_count < max_retries:
                print(f"  {YELLOW}→{RESET} Retrying in 5 seconds... ({retry_count}/{max_retries})")
                time.sleep(5)
                continue
            return False
    
    return False


#------This Function checks InsightFace model----------
def check_models() -> bool:
    print_section("ML Models")
    
    print(f"  {BLUE}›{RESET} Checking InsightFace/buffalo_l...")
    
    try:
        import insightface
        from insightface.app import FaceAnalysis
        
        print(f"  {CYAN}→{RESET} Initializing buffalo_l model (first run may download weights)...")
        app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=0, det_size=(640, 640))
        print_status("●", "buffalo_l face recognition model ready")
        return True
        
    except ImportError:
        print_status("●", "InsightFace not installed", YELLOW)
        print(f"  {CYAN}→{RESET} Installing InsightFace and dependencies...")
        
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "insightface", "onnxruntime"],
                check=True,
                timeout=120,
            )
            print_status("●", "InsightFace installed successfully")
            
            print(f"  {CYAN}→{RESET} Initializing buffalo_l model...")
            from insightface.app import FaceAnalysis
            app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
            app.prepare(ctx_id=0, det_size=(640, 640))
            print_status("●", "buffalo_l face recognition model ready")
            return True
            
        except Exception as e:
            print_status("●", f"InsightFace installation failed: {e}", RED)
            print(f"  {RED}!{RESET} Face recognition will be disabled")
            return False
        
    except Exception as e:
        print_status("●", f"Model not ready: {e}", YELLOW)
        print(f"  {CYAN}→{RESET} Attempting to reinstall and setup...")
        
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "insightface", "onnxruntime"],
                check=True,
                timeout=180,
            )
            print(f"  {CYAN}→{RESET} Reinitializing buffalo_l model...")
            from insightface.app import FaceAnalysis
            app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
            app.prepare(ctx_id=0, det_size=(640, 640))
            print_status("●", "buffalo_l face recognition model ready")
            return True
        except Exception as e2:
            print_status("●", f"Setup failed: {e2}", RED)
            print(f"  {RED}!{RESET} Face recognition will be disabled")
            return False


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
    global _system_info
    
    _system_info = detect_hardware()
    show_banner(_system_info)
    
    print(f"{CYAN}Initializing system checks...{RESET}\n")
    
    print_section("System Information")
    print_status("●", f"Platform: {CYAN}{_system_info['platform']}{RESET}")
    print_status("●", f"Architecture: {CYAN}{_system_info['architecture']}{RESET}")
    print_status("●", f"CPU Cores: {CYAN}{_system_info['cpu_cores']}{RESET}")
    
    if _system_info.get("is_raspberry_pi"):
        print_status("●", f"Hardware: {CYAN}Raspberry Pi {_system_info['pi_model']}{RESET}")
        print_status("●", f"GPU: {CYAN}{_system_info.get('gpu_info', 'None')}{RESET}")
    else:
        print_status("●", f"Processor: {CYAN}{_system_info.get('processor', 'Unknown')[:50]}{RESET}")
        print_status("●", f"GPU: {CYAN}{_system_info.get('gpu_info', 'None')}{RESET}")
    
    print()
    resources = check_system_resources()
    print_section("System Resources")
    print_status("●", f"Disk Space: {CYAN}{resources['disk_space_gb']} GB{RESET}")
    print_status("●", f"Memory: {CYAN}{resources['memory_available_gb']} GB available / {resources['memory_total_gb']} GB total{RESET}")
    print_status("●", f"CPU Usage: {CYAN}{resources['cpu_usage_percent']}%{RESET}")
    
    if not resources["ok"]:
        print_status("●", "Low disk space! At least 2GB recommended", YELLOW)
    
    check_pyaudio()
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
    print_status("●", f"Whisper model: {settings.whisper_model} ({settings.whisper_model_size})")
    print_status("●", f"Ollama: {settings.ollama_url} ({settings.ollama_model})")
    print_status("●", f"Streaming: {settings.ollama_streaming}")
    print_status("●", f"VAD: {settings.enable_vad}")
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
