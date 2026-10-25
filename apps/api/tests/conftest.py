import os
import tempfile
from pathlib import Path
from contextlib import suppress


TEST_DATABASE = Path(tempfile.gettempdir()) / "companion-agent-api-tests.db"
for suffix in ("", "-wal", "-shm"):
    with suppress(PermissionError, FileNotFoundError):
        (TEST_DATABASE.parent / f"{TEST_DATABASE.name}{suffix}").unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DATABASE.as_posix()}"


def pytest_sessionfinish(session, exitstatus):
    for suffix in ("", "-wal", "-shm"):
        with suppress(PermissionError, FileNotFoundError):
            (TEST_DATABASE.parent / f"{TEST_DATABASE.name}{suffix}").unlink()
