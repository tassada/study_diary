import asyncio
from io import BytesIO
from minio import Minio
from ..config import settings


class MinioStorageGateway:
    def __init__(self) -> None:
        self._client = Minio(
            settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )
        self._bucket = settings.minio_bucket
        self._bucket_ready = False

    async def ensure_bucket(self) -> None:
        if self._bucket_ready:
            return

        def _sync_ensure() -> None:
            if not self._client.bucket_exists(self._bucket):
                self._client.make_bucket(self._bucket)

        await asyncio.to_thread(_sync_ensure)
        self._bucket_ready = True

    async def put_bytes(self, object_key: str, payload: bytes, content_type: str) -> str:
        await self.ensure_bucket()

        def _sync_put() -> None:
            stream = BytesIO(payload)
            self._client.put_object(
                self._bucket,
                object_key,
                stream,
                length=len(payload),
                content_type=content_type,
            )

        await asyncio.to_thread(_sync_put)
        return object_key

    async def get_object_bytes(self, object_key: str) -> tuple[bytes, str]:
        await self.ensure_bucket()

        def _sync_get() -> tuple[bytes, str]:
            response = self._client.get_object(self._bucket, object_key)
            try:
                content = response.read()
                ctype = response.headers.get("Content-Type", "application/octet-stream")
                return content, ctype
            finally:
                response.close()
                response.release_conn()

        return await asyncio.to_thread(_sync_get)


minio_gateway = MinioStorageGateway()
