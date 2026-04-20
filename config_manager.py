"""
config_manager.py  –  DewPoint POS
Gestión segura de credenciales de base de datos.

La URL de la master DB se almacena CIFRADA en config.dat, un archivo externo
que vive JUNTO al ejecutable (nunca dentro del .exe).

Flujo:
  1. El desarrollador ejecuta setup_config.py UNA VEZ → genera config.dat
  2. El instalador distribuye DewPoint_POS.exe + config.dat juntos
  3. Esta app lee y descifra config.dat en tiempo de ejecución

Sin config.dat la app no puede conectarse y muestra un error claro.
"""
import os
import sys
import base64
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# ── Clave de cifrado derivada internamente ───────────────────────────────────
# Se almacena como bytes literales (no como string) para dificultar extracción
# trivial de bytecode. La protección real requiere obfuscar el .exe con PyArmor.
_PASSPHRASE = bytes([
    0x44, 0x77, 0x50, 0x74, 0x5F, 0x53, 0x65, 0x63,
    0x72, 0x33, 0x74, 0x4F, 0x5F, 0x32, 0x30, 0x32,
    0x34, 0x23, 0x4E, 0x33, 0x6F, 0x6E,
])
_SALT = bytes([
    0x44, 0x42, 0x5F, 0x53, 0x61, 0x6C, 0x74, 0x5F,
    0x44, 0x77, 0x50, 0x6F, 0x69, 0x6E, 0x74, 0x76, 0x31,
])


def _derive_key() -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_SALT,
        iterations=200_000,
    )
    return base64.urlsafe_b64encode(kdf.derive(_PASSPHRASE))


def _config_path() -> str:
    """
    Ruta a config.dat.
    - En producción (.exe): está bundleado dentro del ejecutable,
      PyInstaller lo extrae a sys._MEIPASS al arrancar.
    - En desarrollo: mismo directorio que este script.
    """
    if getattr(sys, 'frozen', False):
        base = sys._MEIPASS
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, 'config.dat')


def get_master_url() -> str:
    """
    Lee y descifra la URL de la master DB desde config.dat.

    Raises:
        FileNotFoundError: si config.dat no existe.
        ValueError: si el archivo está corrupto o fue manipulado.
    """
    path = _config_path()
    if not os.path.exists(path):
        raise FileNotFoundError(
            "Archivo de configuración no encontrado.\n"
            f"Ruta esperada: {path}\n\n"
            "Ejecuta setup_config.py para generar config.dat y colócalo "
            "en la misma carpeta que DewPoint_POS.exe."
        )
    try:
        with open(path, 'rb') as f:
            encrypted = f.read()
        return Fernet(_derive_key()).decrypt(encrypted).decode('utf-8')
    except InvalidToken:
        raise ValueError(
            "El archivo config.dat está corrupto o fue modificado.\n"
            "Regenera config.dat ejecutando setup_config.py."
        )
    except Exception as exc:
        raise ValueError(f"Error al leer config.dat: {exc}")


def create_config(master_url: str) -> None:
    """
    Cifra master_url y la guarda en config.dat.
    Usar SOLO desde setup_config.py (herramienta del desarrollador).
    """
    if not master_url.startswith("postgresql://"):
        raise ValueError("La URL debe comenzar con postgresql://")
    encrypted = Fernet(_derive_key()).encrypt(master_url.encode('utf-8'))
    path = _config_path()
    with open(path, 'wb') as f:
        f.write(encrypted)
    print(f"[OK] config.dat generado en: {path}")
