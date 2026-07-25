from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

GATEWAY_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(GATEWAY_DIR))
os.environ["TOOLBOX_DATA"] = tempfile.mkdtemp(prefix="toolbox-tenant-")

import store  # noqa: E402
from adapters import AdapterError, resolve_input_ref  # noqa: E402


class TenantIsolationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        store.init_db()

    def upload(self, workspace_id: str, user_id: str) -> str:
        file_id = store.new_id()
        folder = store.FILES_DIR / file_id
        folder.mkdir(parents=True)
        source = folder / "input.mp4"
        source.write_bytes(b"video")
        store.register_file(
            file_id,
            workspace_id,
            user_id,
            source.name,
            source.stat().st_size,
        )
        return file_id

    def test_files_jobs_and_chained_artifacts_are_workspace_scoped(self) -> None:
        file_id = self.upload("workspace-a", "user-a")
        self.assertTrue(resolve_input_ref(file_id, "workspace-a").is_file())
        with self.assertRaises(AdapterError):
            resolve_input_ref(file_id, "workspace-b")

        job = store.create_job(
            "workspace-a",
            "user-a",
            "matting",
            {},
            {"video": file_id},
        )
        artifact = store.output_dir(job["id"]) / "result.mp4"
        artifact.write_bytes(b"result")

        scoped_job = store.get_job(job["id"], "workspace-a")
        self.assertIsNotNone(scoped_job)
        self.assertEqual(scoped_job["workspace_id"], "workspace-a")
        self.assertIsNone(store.get_job(job["id"], "workspace-b"))
        self.assertEqual(len(store.list_jobs("workspace-a")), 1)
        self.assertEqual(store.list_jobs("workspace-b"), [])
        self.assertTrue(
            resolve_input_ref(
                f"job:{job['id']}/result.mp4",
                "workspace-a",
            ).is_file()
        )
        with self.assertRaises(AdapterError):
            resolve_input_ref(
                f"job:{job['id']}/result.mp4",
                "workspace-b",
            )

    def test_product_workers_claim_each_queued_job_once(self) -> None:
        jobs = [
            store.create_job("workspace-a", "user-a", "product_cutout", {}, {})
            for _ in range(3)
        ]
        claimed: list[str] = []
        lock = threading.Lock()

        def claim() -> None:
            job = store.claim_next_queued("product_cutout")
            if job:
                with lock:
                    claimed.append(job["id"])

        threads = [threading.Thread(target=claim) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(set(claimed), {job["id"] for job in jobs})
        self.assertEqual(len(claimed), len(set(claimed)))


if __name__ == "__main__":
    unittest.main()
