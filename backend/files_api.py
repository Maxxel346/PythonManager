"""File manager API. All paths are relative to WORKSPACE_DIR."""
import os
import shutil
import io
import zipfile
from pathlib import Path
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse, StreamingResponse
from typing import List

from auth import get_current_user
from models import FileNode, FileWriteRequest, MkdirRequest, RenameRequest, DeleteRequest


def get_workspace_root() -> Path:
    return Path(os.environ["WORKSPACE_DIR"]).resolve()


def safe_resolve(rel_path: str) -> Path:
    """Resolve rel_path relative to workspace root, reject escapes."""
    root = get_workspace_root()
    root.mkdir(parents=True, exist_ok=True)
    rel = (rel_path or "").lstrip("/").strip()
    target = (root / rel).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(status_code=400, detail="Path outside workspace")
    return target


router = APIRouter(prefix="/api/files", tags=["files"])


@router.get("/list", response_model=List[FileNode])
async def list_dir(path: str = "", user=Depends(get_current_user)):
    target = safe_resolve(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")
    root = get_workspace_root()
    items: List[FileNode] = []
    try:
        entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    for p in entries:
        try:
            st = p.stat()
            items.append(FileNode(
                name=p.name,
                path=str(p.relative_to(root)).replace("\\", "/"),
                is_dir=p.is_dir(),
                size=st.st_size if not p.is_dir() else 0,
                modified=datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            ))
        except OSError:
            continue
    return items


@router.get("/read")
async def read_file(path: str = Query(...), user=Depends(get_current_user)):
    target = safe_resolve(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if target.stat().st_size > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large to open in editor (>2MB)")
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Cannot read file: {e}")
    return {"path": path, "content": content}


@router.put("/write")
async def write_file(body: FileWriteRequest, user=Depends(get_current_user)):
    target = safe_resolve(body.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return {"ok": True, "path": body.path, "size": target.stat().st_size}


@router.post("/mkdir")
async def mkdir(body: MkdirRequest, user=Depends(get_current_user)):
    target = safe_resolve(body.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="Already exists")
    target.mkdir(parents=True, exist_ok=False)
    return {"ok": True}


@router.post("/rename")
async def rename(body: RenameRequest, user=Depends(get_current_user)):
    src = safe_resolve(body.from_path)
    dst = safe_resolve(body.to_path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source not found")
    if dst.exists():
        raise HTTPException(status_code=409, detail="Destination exists")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return {"ok": True}


@router.post("/delete")
async def delete(body: DeleteRequest, user=Depends(get_current_user)):
    target = safe_resolve(body.path)
    if target == get_workspace_root():
        raise HTTPException(status_code=400, detail="Cannot delete workspace root")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"ok": True}


@router.post("/upload")
async def upload(
    dest: str = Form(""),
    relative_path: str = Form(""),
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """Upload a single file. If relative_path is provided (from folder upload),
    the file is stored under dest/<relative_path>. Otherwise dest/<filename>."""
    dest_dir = safe_resolve(dest)
    dest_dir.mkdir(parents=True, exist_ok=True)
    if relative_path:
        rel = relative_path.replace("\\", "/").lstrip("/")
        final = safe_resolve(str(Path(dest) / rel)) if dest else safe_resolve(rel)
    else:
        final = safe_resolve(str(Path(dest) / file.filename)) if dest else safe_resolve(file.filename)
    final.parent.mkdir(parents=True, exist_ok=True)
    with final.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
    return {"ok": True, "path": str(final.relative_to(get_workspace_root())).replace("\\", "/")}


@router.get("/download")
async def download(path: str = Query(...), user=Depends(get_current_user)):
    target = safe_resolve(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Not found")
    if target.is_file():
        return FileResponse(str(target), filename=target.name)
    # Zip a folder on-the-fly
    def stream_zip():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(target):
                for f in files:
                    fp = Path(root) / f
                    arc = fp.relative_to(target.parent)
                    zf.write(fp, arcname=str(arc))
        buf.seek(0)
        yield from buf
    return StreamingResponse(
        stream_zip(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{target.name}.zip"'},
    )
